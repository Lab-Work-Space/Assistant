import { describe, expect, it, vi } from 'vitest';
import { canonical } from '../config/store.js';
import type { AdminCard } from '../db/repos/adminCards.js';
import { fakeServerWorld, fakeServerWriter, NOW, serverConsts, serverData } from '../discord/server/server-fixture.js';
import { C, U, fakeWriter, id } from '../discord/test-helpers.js';
import { SecondConfirm } from './confirm.js';
import { ASSISTANT_REPO, CODE_CONFIRM_TTL_MS, type CodeService } from './code-service.js';
import { ExecutorService } from './service.js';
import type { TierConfig } from './tiers.js';

/** Gate 1 self-code on the executor: code cards are Bot Admin only, owner-only for protected paths (OD-5), shown with a 30 minute prompt bound to the head and bundle. */
const CARD_ID = 'e'.repeat(32);
const MGR_ROLE = id(60);
const MGR = id(62);
const ROOM = id(70);
const CFG: TierConfig = { managerId: MGR_ROLE, moderatorId: null, modRoomId: ROOM };
const HEAD = 'b'.repeat(40);
const SHA = 'c'.repeat(64);
const PAYLOAD = { jobId: 'J-0123456789abcdef', repo: ASSISTANT_REPO, base: 'a'.repeat(40), head: HEAD, bundleSha256: SHA, requesterId: '1'.repeat(18) };

function rig(o: { stored?: AdminCard | null; ownerOnly?: boolean; owner?: string | null; code?: boolean } = {}) {
  const audits: { actor: string; action: string; outcome?: string | null }[] = [];
  const sent: { userId: string; channelId: string; token: string; text: string }[] = [];
  const real = new SecondConfirm({ port: { send: async (p) => (sent.push(p), 'dm') }, audit: async (e) => void audits.push(e), log: { error() {} }, now: () => NOW, token: () => 'a1'.repeat(16) });
  const d = serverData();
  d.roles.push({ id: MGR_ROLE, name: 'Manager', position: 6, managed: false, botId: null, permissions: 0n });
  d.members.set(MGR, { id: MGR, isBot: false, roleIds: [MGR_ROLE], isOwner: false, username: 'mgr', nick: null, timeoutUntil: null });
  d.channels.set(ROOM, { id: ROOM, name: 'mod-room', type: 0, parentId: null, isThread: false, overwrites: [] });
  const code = {
    propose: vi.fn(async () => ({ ok: true as const, payload: PAYLOAD, items: [{ label: 'Code change (Assistant)', old: 'main aaaa', neu: 'head bbbb', risk: true }], snapshot: { canon: canonical(PAYLOAD) } })),
    check: vi.fn(async (_c: unknown, by: string) => (o.ownerOnly && by !== (o.owner === undefined ? U.admin : o.owner) ? { ok: false as const, why: 'only the owner' } : { ok: true as const, summary: 'CODE CHANGE: x', ownerOnly: o.ownerOnly === true, bind: { head: HEAD, bundleSha256: SHA } })),
    apply: vi.fn(async () => ({ kind: 'done' as const, ok: true, lines: ['Applied.'], applied: 1, total: 1 })),
    rollback: vi.fn(async () => ({ ok: true, lines: ['rolled back'] })),
  };
  const svc = new ExecutorService({
    world: fakeServerWorld(d), permWriter: fakeWriter(), serverWriter: fakeServerWriter(), cards: { claimForExecution: async () => o.stored ?? null },
    exec: { push: async () => undefined, getState: async () => null, setState: async () => undefined, clearState: async () => undefined, recordArchive: async () => undefined } as never,
    rate: { check: async () => null }, consts: () => serverConsts(), recheck: async () => [], disabled: () => null, welcomeRoleIds: async () => [], tiers: async () => CFG,
    audit: async (e) => void audits.push(e), log: { error() {} }, now: () => NOW, ...(o.code === false ? {} : { code: code as unknown as CodeService }),
    ownerUserId: o.owner === undefined ? U.admin : o.owner, confirm: real,
  });
  const click = async (userId = U.admin) => real.onClick({ token: 'a1'.repeat(16), userId });
  return { svc, code, audits, sent, click, real };
}
const card = (over: Partial<AdminCard> = {}): AdminCard => ({
  seq: 1, id: CARD_ID, proposerId: U.admin, kind: 'code', tainted: false, channelId: C.setting, messageId: 'm', status: 'confirmed', outcome: null,
  createdAt: new Date(NOW), expiresAt: new Date(NOW + 900_000), via: 'praw', origin: 'discord', decidedBy: U.admin, executedAt: null,
  payload: PAYLOAD, snapshot: { canon: canonical(PAYLOAD), tier: 'bot_admin' }, ...over,
});

describe('propose (family code)', () => {
  it('a Bot Admin gets the card; a Manager, a stranger, a second operation and a missing code root are refused before CodeService runs', async () => {
    const x = rig();
    expect(await x.svc.propose('code', [PAYLOAD], { userId: U.admin, namedIds: [] })).toMatchObject({ ok: true, snapshot: { tier: 'bot_admin' } });
    expect(await x.svc.propose('code', [PAYLOAD], { userId: MGR, namedIds: [] })).toMatchObject({ ok: false, error: expect.stringContaining('Bot Admins only') });
    expect(await x.svc.propose('code', [PAYLOAD], { userId: U.eve, namedIds: [] })).toMatchObject({ ok: false });
    expect(await x.svc.propose('code', [PAYLOAD, PAYLOAD], { userId: U.admin, namedIds: [] })).toMatchObject({ ok: false });
    expect(x.code.propose).toHaveBeenCalledTimes(1);
    expect(await rig({ code: false }).svc.propose('code', [PAYLOAD], { userId: U.admin, namedIds: [] })).toMatchObject({ ok: false, error: expect.stringContaining('off') });
  });
});

describe('apply (kind code)', () => {
  it('asks LW Admin for a 30 minute second confirmation that shows the facts, and nothing runs before the click', async () => {
    const x = rig({ stored: card() });
    expect(await x.svc.apply(CARD_ID)).toMatchObject({ kind: 'awaiting' });
    expect(x.sent[0]!.text).toMatch(/valid 30 minutes/);
    expect(x.sent[0]!.text).toContain('CODE CHANGE: x');
    expect(CODE_CONFIRM_TTL_MS).toBe(30 * 60_000);
    expect(x.code.apply).not.toHaveBeenCalled();
    expect(await x.click()).toMatchObject({ final: true, text: 'Applied.' });
    expect(x.code.apply).toHaveBeenCalledWith(expect.anything(), U.admin, { head: HEAD, bundleSha256: SHA });
    expect(await x.click()).toMatchObject({ text: expect.stringContaining('expired or was already used') });
    expect(x.code.apply).toHaveBeenCalledTimes(1);
  });
  it('the prompt is still alive after 6 minutes (longer than the deploy TTL) and gone after 30', async () => {
    const x = rig({ stored: card() });
    await x.svc.apply(CARD_ID);
    (x.real as unknown as { d: { now: () => number } }).d.now = () => NOW + 6 * 60_000;
    expect((await x.click()).text).toBe('Applied.');
    const y = rig({ stored: card() });
    await y.svc.apply(CARD_ID);
    (y.real as unknown as { d: { now: () => number } }).d.now = () => NOW + 30 * 60_000 + 1;
    expect((await y.click()).text).toMatch(/expired/);
  });
  it('OD-5: for a protected-path change, a Bot Admin decider who is not the owner never gets a prompt; the owner does, and the click is re-judged', async () => {
    const notOwner = rig({ stored: card(), ownerOnly: true, owner: U.eve });
    expect(await notOwner.svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: 'only the owner' });
    expect(notOwner.sent).toHaveLength(0);
    const owner = rig({ stored: card(), ownerOnly: true, owner: U.admin });
    expect(await owner.svc.apply(CARD_ID)).toMatchObject({ kind: 'awaiting' });
    // the owner id changed in the executor's env between prompt and click (restart): the click is refused
    (owner.svc as unknown as { d: { ownerUserId: string } }).d.ownerUserId = U.eve;
    expect(await owner.click()).toMatchObject({ final: true, text: expect.stringContaining('only the owner') });
    expect(owner.code.apply).not.toHaveBeenCalled();
  });
  it('refuses a non-Bot-Admin decider, a mod-room card, a missing decider and a tier change', async () => {
    for (const c of [card({ decidedBy: MGR }), card({ channelId: ROOM }), card({ decidedBy: null }), card({ snapshot: { canon: canonical(PAYLOAD), tier: 'manager' } })]) {
      const x = rig({ stored: c });
      expect((await x.svc.apply(CARD_ID)).kind).toBe('refused');
      expect(x.code.check).not.toHaveBeenCalled();
    }
  });
  it('a CodeService refusal (forged row, bundle swap, base moved) is audited and never reaches the second confirmation', async () => {
    const x = rig({ stored: card() });
    x.code.check.mockResolvedValueOnce({ ok: false, why: 'the stored bundle does not match the digest on the card' } as never);
    expect(await x.svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: expect.stringContaining('digest') });
    expect(x.sent).toHaveLength(0);
    expect(x.audits.at(-1)).toMatchObject({ action: 'admin.exec' });
  });
  it('a refusal at the click (the bundle changed after it was shown) is reported', async () => {
    const x = rig({ stored: card() });
    await x.svc.apply(CARD_ID);
    x.code.apply.mockResolvedValueOnce({ kind: 'refused', why: 'the bundle changed after it was shown' } as never);
    expect(await x.click()).toMatchObject({ final: true, text: expect.stringContaining('bundle changed after it was shown') });
  });
});

describe('codeRollback', () => {
  it('Bot Admin only, judged on the live member', async () => {
    const x = rig();
    expect(await x.svc.codeRollback(U.admin)).toEqual({ ok: true, lines: ['rolled back'] });
    expect(await x.svc.codeRollback(MGR)).toMatchObject({ ok: false });
    expect(await x.svc.codeRollback(U.eve)).toMatchObject({ ok: false });
    expect(x.code.rollback).toHaveBeenCalledTimes(1);
    expect(await rig({ code: false }).svc.codeRollback(U.admin)).toMatchObject({ ok: false });
  });
});

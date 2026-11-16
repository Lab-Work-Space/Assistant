import { describe, expect, it, vi } from 'vitest';
import { canonical } from '../config/store.js';
import type { AdminCard } from '../db/repos/adminCards.js';
import { fakeServerWorld, fakeServerWriter, NOW, serverConsts, serverData } from '../discord/server/server-fixture.js';
import { C, U, fakeWriter, id } from '../discord/test-helpers.js';
import type { DeployService } from './deploy.js';
import { SecondConfirm } from './confirm.js';
import { ExecutorService } from './service.js';
import { fakeConfirm } from './test-helpers.js';
import type { TierConfig } from './tiers.js';

/** Gate 1 V22 on the executor: deploy cards are Bot Admin only (proposer, decider, channel), live-judged, and reach DeployService only after every tier check. */
const CARD_ID = 'd'.repeat(32);
const MGR_ROLE = id(60);
const MGR = id(62);
const ROOM = id(70);
const CFG: TierConfig = { managerId: MGR_ROLE, moderatorId: null, modRoomId: ROOM };
const SHA = 'a'.repeat(40);
const OP = { op: 'add', repo: 'blog', category: 'apps', sha: SHA };

type Port = { send: (p: { userId: string; channelId: string; token: string; text: string }) => Promise<'dm' | 'channel' | null> };
function rig(o: { stored?: AdminCard | null; deploy?: boolean; confirm?: 'fake' | 'real' | 'none'; port?: Port } = {}) {
  const audits: { actor: string; action: string; outcome?: string | null }[] = [];
  const sent: { userId: string; channelId: string; token: string; text: string }[] = [];
  const fc = fakeConfirm();
  const real = new SecondConfirm({ port: o.port ?? { send: async (p) => (sent.push(p), 'dm') }, audit: async (e) => void audits.push(e), log: { error() {} }, now: () => NOW, token: () => 'a1'.repeat(16) });
  const d = serverData();
  d.roles.push({ id: MGR_ROLE, name: 'Manager', position: 6, managed: false, botId: null, permissions: 0n });
  d.members.set(MGR, { id: MGR, isBot: false, roleIds: [MGR_ROLE], isOwner: false, username: 'mgr', nick: null, timeoutUntil: null });
  d.channels.set(ROOM, { id: ROOM, name: 'mod-room', type: 0, parentId: null, isThread: false, overwrites: [] });
  const deploy = {
    propose: vi.fn(async (_raw: unknown, _u: string) => ({ ok: true as const, payload: OP, items: [{ label: 'Deploy new site', old: '-', neu: 'x', risk: true }], snapshot: { canon: canonical(OP) } })),
    check: vi.fn(async () => ({ ok: true as const, summary: 'Deploy new site: x' })),
    apply: vi.fn(async () => ({ kind: 'done' as const, ok: true, applied: 1, total: 1, lines: ['queued'] })),
    read: vi.fn(async () => ({ ok: true as const, text: 'rows' })),
  };
  const mode = o.confirm ?? 'fake';
  const svc = new ExecutorService({
    world: fakeServerWorld(d), permWriter: fakeWriter(), serverWriter: fakeServerWriter(), cards: { claimForExecution: async () => o.stored ?? null },
    exec: { push: async () => undefined, getState: async () => null, setState: async () => undefined, clearState: async () => undefined, recordArchive: async () => undefined } as never,
    rate: { check: async () => null }, consts: () => serverConsts(), recheck: async () => [], disabled: () => null, welcomeRoleIds: async () => [], tiers: async () => CFG,
    audit: async (e) => void audits.push(e), log: { error() {} }, now: () => NOW, ...(o.deploy === false ? {} : { deploy: deploy as unknown as DeployService }),
    ...(mode === 'fake' ? { confirm: fc.confirm } : mode === 'real' ? { confirm: real } : {}),
  });
  /** What a Bot Admin's click on LW Admin's button does. */
  const click = async (userId = U.admin) => real.onClick({ token: 'a1'.repeat(16), userId });
  return { svc, deploy, audits, fc, real, sent, click };
}
const card = (over: Partial<AdminCard> = {}): AdminCard => ({
  seq: 1, id: CARD_ID, proposerId: U.admin, kind: 'deploy', tainted: false, channelId: C.setting, messageId: 'm', status: 'confirmed', outcome: null,
  createdAt: new Date(NOW), expiresAt: new Date(NOW + 900_000), via: 'praw', origin: 'discord', decidedBy: U.admin, executedAt: null,
  payload: OP, snapshot: { canon: canonical(OP), tier: 'bot_admin' }, ...over,
});

describe('propose (family deploy)', () => {
  it('a Bot Admin gets the card; the tier rides in the snapshot', async () => {
    const x = rig();
    expect(await x.svc.propose('deploy', [{ op: 'add', repo: 'blog', category: 'apps' }], { userId: U.admin, namedIds: [] })).toMatchObject({ ok: true, snapshot: { tier: 'bot_admin' } });
    expect(x.deploy.propose).toHaveBeenCalledWith({ op: 'add', repo: 'blog', category: 'apps' }, U.admin);
  });
  it('a Manager (or anyone below Bot Admin) is refused before the VPS is touched', async () => {
    const x = rig();
    expect(await x.svc.propose('deploy', [{ op: 'add', repo: 'blog', category: 'apps' }], { userId: MGR, namedIds: [] })).toMatchObject({ ok: false, error: expect.stringContaining('Bot Admins only') });
    expect(await x.svc.propose('deploy', [{ op: 'add', repo: 'blog', category: 'apps' }], { userId: U.eve, namedIds: [] })).toMatchObject({ ok: false });
    expect(x.deploy.propose).not.toHaveBeenCalled();
  });
  it('exactly one operation per card, and off without a deploy key', async () => {
    const x = rig();
    expect(await x.svc.propose('deploy', [{}, {}], { userId: U.admin, namedIds: [] })).toMatchObject({ ok: false });
    const off = rig({ deploy: false });
    expect(await off.svc.propose('deploy', [{ op: 'add' }], { userId: U.admin, namedIds: [] })).toMatchObject({ ok: false, error: expect.stringContaining('no deploy key') });
  });
});

describe('apply (kind deploy)', () => {
  it('a confirmed Bot Admin card in #setting reaches DeployService.apply', async () => {
    const x = rig({ stored: card() });
    expect(await x.svc.apply(CARD_ID)).toMatchObject({ kind: 'awaiting' });
    expect(x.deploy.apply).not.toHaveBeenCalled(); // nothing before LW Admin's own click
    expect(await x.fc.click()).toMatchObject({ kind: 'done', ok: true });
    expect(x.deploy.apply).toHaveBeenCalledTimes(1);
  });
  it('refuses when the decider is not a Bot Admin, the proposer lost the role, or the channel is the mod room', async () => {
    for (const c of [card({ decidedBy: MGR }), card({ proposerId: MGR, decidedBy: MGR, channelId: ROOM, snapshot: { canon: canonical(OP), tier: 'manager' } }), card({ channelId: ROOM })]) {
      const x = rig({ stored: c });
      expect((await x.svc.apply(CARD_ID)).kind).toBe('refused');
      expect(x.deploy.apply).not.toHaveBeenCalled();
    }
  });
  it('refuses a card with no recorded decider and a tier that changed since the proposal', async () => {
    expect((await rig({ stored: card({ decidedBy: null }) }).svc.apply(CARD_ID)).kind).toBe('refused');
    const x = rig({ stored: card({ snapshot: { canon: canonical(OP), tier: 'manager' } }) });
    expect(await x.svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: expect.stringContaining('changed since the proposal') });
  });
  it('a DeployService refusal becomes an audited refusal; no key means refused', async () => {
    const x = rig({ stored: card() });
    x.deploy.check.mockResolvedValueOnce({ ok: false, why: 'the stored operation differs from the one that was shown' } as never);
    expect(await x.svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: expect.stringContaining('differs') });
    expect(x.audits.at(-1)).toMatchObject({ action: 'admin.exec' });
    expect(x.fc.queue).toHaveLength(0); // a doomed card never reaches the second confirmation
    expect(await rig({ stored: card(), deploy: false }).svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: expect.stringContaining('no deploy key') });
  });
});

describe('deployRead', () => {
  it('Bot Admin only, judged on the live member', async () => {
    const x = rig();
    expect(await x.svc.deployRead(U.admin, { kind: 'status' })).toEqual({ ok: true, text: 'rows' });
    expect(await x.svc.deployRead(MGR, { kind: 'status' })).toMatchObject({ ok: false });
    expect(await x.svc.deployRead(U.eve, { kind: 'status' })).toMatchObject({ ok: false });
    expect(x.deploy.read).toHaveBeenCalledTimes(1);
  });
});


describe('OD-G2-1: the second confirmation comes from LW Admin itself', () => {
  it('a forged confirmed row alone never applies: without a click on LW Admin\'s own button nothing reaches the VPS', async () => {
    const x = rig({ stored: card(), confirm: 'real' });
    expect(await x.svc.apply(CARD_ID)).toMatchObject({ kind: 'awaiting', lines: [expect.stringContaining('DMs')] });
    expect(x.sent).toHaveLength(1);
    expect(x.sent[0]).toMatchObject({ userId: U.admin, channelId: C.setting });
    expect(x.sent[0]!.text).toContain('Deploy new site: x');
    expect(x.deploy.apply).not.toHaveBeenCalled();
    expect(x.audits.map((a) => a.outcome)).toEqual(expect.arrayContaining([expect.stringContaining('requested card:')]));
  });
  it('the click of the same user runs the card once; a second click does nothing', async () => {
    const x = rig({ stored: card(), confirm: 'real' });
    await x.svc.apply(CARD_ID);
    expect(await x.click()).toMatchObject({ final: true, text: expect.stringContaining('queued') });
    expect(x.deploy.apply).toHaveBeenCalledTimes(1);
    expect(await x.click()).toMatchObject({ final: true, text: expect.stringContaining('expired or was already used') });
    expect(x.deploy.apply).toHaveBeenCalledTimes(1);
    expect(x.audits.map((a) => a.outcome)).toEqual(expect.arrayContaining([expect.stringContaining('confirmed card:'), expect.stringContaining('applied card:')]));
  });
  it('another user\'s click (visible in the channel fallback) is refused and does not consume the prompt', async () => {
    const x = rig({ stored: card(), confirm: 'real' });
    await x.svc.apply(CARD_ID);
    expect(await x.click(U.eve)).toMatchObject({ final: false });
    expect(x.deploy.apply).not.toHaveBeenCalled();
    expect(await x.click(U.admin)).toMatchObject({ final: true });
    expect(x.deploy.apply).toHaveBeenCalledTimes(1);
  });
  it('a click after the 5 minutes is refused', async () => {
    const x = rig({ stored: card(), confirm: 'real' });
    await x.svc.apply(CARD_ID);
    (x.real as unknown as { d: { now: () => number } }).d.now = () => NOW + 5 * 60_000 + 1;
    expect(await x.click()).toMatchObject({ final: true, text: expect.stringContaining('expired') });
    expect(x.deploy.apply).not.toHaveBeenCalled();
  });
  it('a clicker who lost the Bot Admin role in the meantime is refused', async () => {
    const x = rig({ stored: card(), confirm: 'real' });
    await x.svc.apply(CARD_ID);
    expect(await x.click(MGR)).toMatchObject({ final: false }); // wrong user first (not the confirmer)
    const y = rig({ stored: card({ proposerId: U.eve, decidedBy: U.eve }), confirm: 'real' });
    expect(await y.svc.apply(CARD_ID)).toMatchObject({ kind: 'refused' }); // a non-admin confirmer never even gets a prompt
    expect(y.sent).toHaveLength(0);
  });
  it('DMs closed: the prompt goes to the card\'s channel; neither works: the card is refused', async () => {
    const sentTo: string[] = [];
    const ch = rig({ stored: card(), confirm: 'real', port: { send: async (p) => (sentTo.push(p.channelId), 'channel') } });
    expect(await ch.svc.apply(CARD_ID)).toMatchObject({ kind: 'awaiting', lines: [expect.stringContaining('in this channel')] });
    expect(sentTo).toEqual([C.setting]);
    const none = rig({ stored: card(), confirm: 'real', port: { send: async () => null } });
    expect(await none.svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: expect.stringContaining('could not send') });
    expect(none.deploy.apply).not.toHaveBeenCalled();
  });
  it('without the second confirmation component, a deploy card is refused (fail closed)', async () => {
    const x = rig({ stored: card(), confirm: 'none' });
    expect(await x.svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: expect.stringContaining('second confirmation') });
    expect(x.deploy.apply).not.toHaveBeenCalled();
  });
  it('the second pass re-checks everything: a card the DeployService now refuses is refused at the click', async () => {
    const x = rig({ stored: card(), confirm: 'real' });
    await x.svc.apply(CARD_ID);
    x.deploy.apply.mockResolvedValueOnce({ kind: 'refused', why: 'another deploy is still running on the VPS' } as never);
    expect(await x.click()).toMatchObject({ final: true, text: expect.stringContaining('another deploy is still running') });
  });
});

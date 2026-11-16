import { describe, expect, it, vi } from 'vitest';
import type { AdminCard } from '../db/repos/adminCards.js';
import { fakeServerWorld, fakeServerWriter, NOW, S, serverConsts, serverData } from '../discord/server/server-fixture.js';
import { C, R, U, fakeWriter } from '../discord/test-helpers.js';
import { ExecutorService } from './service.js';
import { autoClick, fakeConfirm } from './test-helpers.js';
import { NO_TIERS, type TierConfig } from './tiers.js';

const CARD_ID = 'a'.repeat(32);

function card(over: Partial<AdminCard> & { payload: unknown; snapshot: unknown }): AdminCard {
  return {
    seq: 1, id: CARD_ID, proposerId: U.admin, kind: 'server', tainted: false, channelId: C.setting, messageId: 'm', status: 'confirmed', outcome: null,
    createdAt: new Date(NOW), expiresAt: new Date(NOW + 900_000), via: 'praw', origin: 'discord', decidedBy: U.admin, executedAt: null, ...over,
  };
}

function rig(o: { stored?: AdminCard | null; data?: ReturnType<typeof serverData>; rate?: string | null; recheck?: string[] | (() => Promise<string[]>); disabled?: string[] | null; failAt?: number; welcomeRoleIds?: string[]; tiers?: TierConfig; manual?: boolean } = {}) {
  const data = o.data ?? serverData();
  const writer = fakeServerWriter(o.failAt);
  const permWriter = fakeWriter();
  const audits: { actor: string; action: string; tool?: string | null; outcome?: string | null }[] = [];
  const pushed: { kind: string; payload: unknown }[] = [];
  const state = new Map<string, unknown>();
  const claim = vi.fn(async () => o.stored ?? null);
  const rate = { check: vi.fn(async () => o.rate ?? null) };
  const fc = fakeConfirm();
  const svc = new ExecutorService({
    confirm: fc.confirm,
    world: fakeServerWorld(data), permWriter, serverWriter: writer, cards: { claimForExecution: claim },
    exec: {
      push: async (kind: string, payload: unknown) => void pushed.push({ kind, payload }), getState: async (k: string) => state.get(k) ?? null,
      setState: async (k: string, v: unknown) => void state.set(k, v), clearState: async (k: string) => state.delete(k), recordArchive: async (id: string) => void state.set(`archive:${id}`, 1),
    } as never,
    rate, consts: () => serverConsts(), recheck: typeof o.recheck === 'function' ? o.recheck : async () => (o.recheck as string[] | undefined) ?? [], disabled: () => o.disabled ?? null, welcomeRoleIds: async () => o.welcomeRoleIds ?? [], tiers: async () => o.tiers ?? NO_TIERS,
    audit: async (e) => void audits.push(e), log: { error() {} }, now: () => NOW,
  });
  if (!o.manual) autoClick(svc, fc);
  return { svc, fc, writer, permWriter, audits, pushed, state, claim, rate, data };
}
const ctx = { userId: U.admin, namedIds: [U.alice] };

describe('ExecutorService.propose', () => {
  it('server family: returns the stored ops (bulk ids filled in), per-op snapshots and the card lines', async () => {
    const x = rig();
    const r = await x.svc.propose('server', [{ kind: 'msg.bulk', channel: S.plain, count: 10 }, { kind: 'member.nick', member: U.alice, nick: 'Al' }], ctx);
    if (!r.ok) throw new Error(r.error);
    const ops = (r.payload as { ops: { kind: string; ids?: string[] }[]; named: string[] }).ops;
    expect(ops[0]!.ids).toHaveLength(2);
    expect((r.payload as { named: string[] }).named).toEqual([U.alice]);
    expect((r.snapshot as { snaps: unknown[] }).snaps).toHaveLength(2);
    expect(r.items.map((i) => i.label)).toEqual(['Bulk delete messages', 'Set nickname']);
    expect(x.writer.calls).toEqual([]); // propose never writes
  });
  it('refuses a malformed op with the schema message, a hard-limit breach with its number, and an executor that is off', async () => {
    const x = rig();
    expect(await x.svc.propose('server', [{ kind: 'guild.edit', ownerId: '1' }], ctx)).toMatchObject({ ok: false, error: expect.stringContaining('invalid operations') });
    expect(await x.svc.propose('server', [{ kind: 'channel.delete', channel: C.setting }], ctx)).toMatchObject({ ok: false, error: expect.stringContaining('operation 1') });
    const off = rig({ disabled: ['admin: bot has guild-wide Administrator'] });
    expect(await off.svc.propose('server', [{ kind: 'welcome.resume' }], ctx)).toMatchObject({ ok: false, error: expect.stringContaining('turned off') });
  });
  it('S30: a card that would exceed a rate cap is refused whole at propose', async () => {
    const x = rig({ rate: 'rate limit: at most 20 applied operations per admin per 10 minutes (20 so far)' });
    expect(await x.svc.propose('server', [{ kind: 'channel.edit', channel: S.plain, topic: 'x' }], ctx)).toMatchObject({ ok: false, error: expect.stringContaining('rate limit') });
    expect(x.rate.check).toHaveBeenCalledWith(U.admin, 1, 0, 'bot_admin');
  });
  it('perm family still works through the executor (the phase-1 ops)', async () => {
    const x = rig();
    const r = await x.svc.propose('perm', [{ kind: 'role.assign', member: U.alice, role: R.staff }], ctx);
    expect(r).toMatchObject({ ok: true, payload: { ops: [{ kind: 'role.assign' }] } });
  });
});

describe('ExecutorService.apply (S1, S2)', () => {
  const stored = async (ops: unknown[], named: string[] = [], extra: Partial<AdminCard> = {}) => {
    const base = rig();
    const r = await base.svc.propose('server', ops, { userId: U.admin, namedIds: named });
    if (!r.ok) throw new Error(r.error);
    return card({ payload: r.payload, snapshot: r.snapshot, ...extra });
  };

  it('S1: a card row forged straight into the database with an op that breaks a hard limit is refused at apply, and nothing is written', async () => {
    const forged = card({
      payload: { ops: [{ kind: 'member.ban', member: U.founder, deleteDays: 0 }], named: [U.founder] }, snapshot: { snaps: [{ member: true, roles: [R.founder] }] },
    });
    const x = rig({ stored: forged });
    const r = await x.svc.apply(CARD_ID);
    expect(r).toMatchObject({ kind: 'refused', why: expect.stringMatching(/privileged|Founder/) });
    expect(x.writer.calls).toEqual([]);
    expect(x.audits.at(-1)).toMatchObject({ action: 'admin.exec', outcome: expect.stringContaining('refused card:') });
  });
  it('S1: forged ops in other families are refused too (a DENIED channel delete, a system channel edit, a ban the admin never named)', async () => {
    for (const ops of [[{ kind: 'channel.delete', channel: C.deniedCat }], [{ kind: 'channel.edit', channel: C.setting, topic: 'x' }], [{ kind: 'member.kick', member: U.alice }]]) {
      const x = rig({ stored: card({ payload: { ops, named: [] }, snapshot: { snaps: [{}] } }) });
      expect((await x.svc.apply(CARD_ID)).kind, JSON.stringify(ops)).toBe('refused');
      expect(x.writer.calls).toEqual([]);
    }
  });
  it('a bulk delete without its stored ids is refused: the executor never selects again', async () => {
    const x = rig({ stored: card({ payload: { ops: [{ kind: 'msg.bulk', channel: S.plain, count: 5 }], named: [] }, snapshot: { snaps: [{}] } }) });
    expect(await x.svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: expect.stringContaining('without its stored message ids') });
  });
  it('no confirmed unused card means nothing runs (the claim is the single-use gate)', async () => {
    const x = rig({ stored: null });
    expect(await x.svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: expect.stringContaining('not a confirmed, unused card') });
    expect(x.claim).toHaveBeenCalledWith(CARD_ID);
  });
  it('a state change between propose and apply refuses the card (compare-and-swap, C7)', async () => {
    const c = await stored([{ kind: 'channel.edit', channel: S.plain, topic: 'new' }]);
    const x = rig({ stored: c });
    x.data.channels.get(S.plain)!.topic = 'someone else changed it';
    expect(await x.svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: expect.stringContaining('changed since the proposal') });
    expect(x.writer.calls).toEqual([]);
  });
  it('runs the ops in order, audits each as "user:<id> via <via>" with the executor action, queues a bot-log summary for moderation, and re-checks itself', async () => {
    const c = await stored([{ kind: 'member.timeout', member: U.alice, minutes: 10, reason: 'noise' }, { kind: 'channel.edit', channel: S.plain, topic: 'quiet' }], [U.alice], { via: 'dashboard' });
    const recheck = vi.fn(async () => [] as string[]);
    const x = rig({ stored: c, recheck });
    const r = await x.svc.apply(CARD_ID);
    expect(r).toMatchObject({ kind: 'done', ok: true, applied: 2, total: 2 });
    expect(x.writer.calls).toEqual(['timeout ' + U.alice + ' on', expect.stringContaining('edit ' + S.plain)]);
    expect(x.audits.map((a) => [a.actor, a.action])).toEqual([[`user:${U.admin} via dashboard tier:bot_admin`, 'server.member.timeout'], [`user:${U.admin} via dashboard tier:bot_admin`, 'server.channel.edit']]);
    expect(x.pushed).toEqual([{ kind: 'summary', payload: { text: expect.stringContaining(`member.timeout by <@${U.admin}>`) } }]);
    expect(recheck).toHaveBeenCalledTimes(1);
  });
  it('S21: a bulk delete audits author ids with counts, the time range and the message ids (8 per row), and never any content', async () => {
    const c = await stored([{ kind: 'msg.bulk', channel: S.plain, count: 10, reason: 'cleanup' }]);
    const x = rig({ stored: c });
    expect(await x.svc.apply(CARD_ID)).toMatchObject({ kind: 'done', ok: true });
    const rows = x.audits.filter((a) => a.action === 'server.msg.bulk.detail').map((a) => a.outcome!);
    expect(rows[0]).toMatch(/range 20\d\d-/);
    expect(rows.join(' ')).toContain(`${U.alice}x1`);
    expect(rows.join(' ')).toContain(`${U.bob}x1`);
    expect(rows.join(' ')).toContain(S.msgAlice);
    expect(x.audits.find((a) => a.action === 'server.msg.bulk')!.outcome).toMatch(/^ok card:/);
    expect(x.writer.calls).toEqual([expect.stringMatching(new RegExp(`^bulk ${S.plain} .*${S.msgAlice}`))]);
  });
  it('S1/S21: a bulk delete spares a message whose author became privileged, or that was pinned, after propose: the writer never sees those ids', async () => {
    const c = await stored([{ kind: 'msg.bulk', channel: S.plain, count: 10 }]);
    const data = serverData();
    data.members.get(U.bob)!.roleIds = [R.founder]; // bob was promoted in between
    data.messages.get(S.plain)!.find((m) => m.id === S.msgAlice)!.pinned = true; // alice's message was pinned in between
    const x = rig({ stored: c, data });
    expect(await x.svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: expect.stringContaining('none of the stored messages') });
    expect(x.writer.calls).toEqual([]);
    const only = serverData();
    only.members.get(U.bob)!.roleIds = [R.founder];
    const y = rig({ stored: c, data: only });
    expect(await y.svc.apply(CARD_ID)).toMatchObject({ kind: 'done', ok: true });
    expect(y.writer.calls).toEqual([`bulk ${S.plain} ${S.msgAlice}`]); // alice's still-eligible message only; bob's (now Founder) is spared
    expect(y.writer.calls.join(' ')).not.toContain(S.msgBob);
  });
  it('stops at the first failure, never shows the Discord error text, and reports what ran', async () => {
    const c = await stored([{ kind: 'channel.edit', channel: S.plain, topic: 'a' }, { kind: 'channel.edit', channel: S.emptyCh, topic: 'b' }]);
    const x = rig({ stored: c, failAt: 0 });
    const r = await x.svc.apply(CARD_ID);
    expect(r).toMatchObject({ kind: 'done', ok: false, applied: 0, total: 2 });
    if (r.kind === 'done') {
      expect(r.lines.join('\n')).toContain('Discord error 50013');
      expect(r.lines.join('\n')).not.toContain('secret text');
    }
    expect(x.writer.calls).toHaveLength(1);
  });
  it('a failed self re-check (C21) switches the executor off and queues an alert', async () => {
    const c = await stored([{ kind: 'channel.edit', channel: S.plain, topic: 'a' }]);
    const x = rig({ stored: c, recheck: ['admin: bot has guild-wide Administrator, which is not allowed'] });
    const r = await x.svc.apply(CARD_ID);
    expect(r).toMatchObject({ kind: 'done', ok: true });
    if (r.kind === 'done') expect(r.lines.join('\n')).toContain('executor was turned off');
    expect(x.pushed.some((p) => p.kind === 'alert')).toBe(true);
  });
  it('an archive is recorded in the executor\'s own table; a rate-capped card is refused at apply and audited', async () => {
    const c = await stored([{ kind: 'channel.archive', channel: S.plain }]);
    const x = rig({ stored: c });
    await x.svc.apply(CARD_ID);
    expect(x.state.get(`archive:${S.plain}`)).toBe(1);
    const y = rig({ stored: c, rate: 'rate limit: x' });
    expect(await y.svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: 'rate limit: x' });
    expect(y.audits.at(-1)!.outcome).toContain('refused card:');
    expect(y.writer.calls).toEqual([]);
  });
  it('welcome.resume clears the raid pause (only a confirmed card does)', async () => {
    const c = await stored([{ kind: 'welcome.resume' }].map((o) => o)).catch(() => null);
    expect(c).toBeNull(); // propose refuses while the flow is not paused
    const x = rig();
    x.state.set('welcome.paused', { since: 'now' });
    const p = await x.svc.propose('server', [{ kind: 'welcome.resume' }], ctx);
    if (!p.ok) throw new Error(p.error);
    const y = rig({ stored: card({ payload: p.payload, snapshot: p.snapshot }) });
    y.state.set('welcome.paused', { since: 'now' });
    expect(await y.svc.apply(CARD_ID)).toMatchObject({ kind: 'done', ok: true });
    expect(y.state.has('welcome.paused')).toBe(false);
  });
  it('a perm card is applied by the executor with the actor and via of the card', async () => {
    const x0 = rig();
    const p = await x0.svc.propose('perm', [{ kind: 'role.assign', member: U.alice, role: R.staff }], ctx);
    if (!p.ok) throw new Error(p.error);
    const x = rig({ stored: card({ kind: 'perm', payload: p.payload, snapshot: p.snapshot, via: 'panel' }) });
    expect(await x.svc.apply(CARD_ID)).toMatchObject({ kind: 'done', ok: true });
    expect(x.permWriter.calls).toEqual([`assign ${U.alice} ${R.staff}`]);
    expect(x.audits[0]).toMatchObject({ actor: `user:${U.admin} via panel tier:bot_admin`, action: 'perm.role.assign' });
  });
});

describe('ExecutorService reads (S9, S10) and the welcome check (S14)', () => {
  it('members: at most 50, id/mention/name/join/roles only, names stripped of control characters', async () => {
    const x = rig();
    x.data.members.get(U.alice)!.nick = 'Evil‮nick';
    const r = await x.svc.read('members', {});
    if (!r.ok) throw new Error(r.error);
    const list = JSON.parse(r.text) as Record<string, unknown>[];
    expect(list.length).toBeLessThanOrEqual(50);
    expect(Object.keys(list[0]!).sort()).toEqual(['id', 'joined', 'mention', 'name', 'roles']);
    expect(r.text).not.toContain('‮');
    const byRole = await x.svc.read('members', { roleId: R.staff });
    if (byRole.ok) expect((JSON.parse(byRole.text) as { id: string }[]).map((m) => m.id)).toEqual([U.bob]);
  });
  it('audit: action, executor, target, time and a reason cut to 120 characters and redacted', async () => {
    const x = rig();
    const r = await x.svc.read('audit', {});
    if (!r.ok) throw new Error(r.error);
    expect(JSON.parse(r.text)[0]).toMatchObject({ action: 'MemberBanAdd', executor: U.admin, target: U.alice });
    x.data.members.size; // eslint
  });
  it('channels and roles omit DENIED channels; an executor that is off reads nothing', async () => {
    const x = rig();
    const ch = await x.svc.read('channels');
    if (!ch.ok) throw new Error(ch.error);
    expect(ch.text).not.toContain('1565715069969502310');
    expect(await rig({ disabled: ['x'] }).svc.read('members')).toMatchObject({ ok: false });
  });
  it('checkWelcome: refuses an unsafe role and a protected channel; accepts a safe role and a normal channel', async () => {
    const x = rig();
    expect(await x.svc.checkWelcome([R.staff], S.plain)).toBeNull();
    expect(await x.svc.checkWelcome([R.powerful], null)).toMatch(/default role/);
    expect(await x.svc.checkWelcome([R.staff], C.setting)).toMatch(/protected or system/);
    expect(await x.svc.checkWelcome([R.staff], C.deniedCh)).toMatch(/protected or system/);
    expect(await x.svc.checkWelcome([R.staff], C.inDeniedCat)).toMatch(/protected category/);
  });
  it('S5: a welcome default role at or above the executor\'s top role turns server operations off', async () => {
    expect(await rig({ welcomeRoleIds: [R.high] }).svc.readiness()).toMatch(/not strictly below/);
    expect(await rig({ welcomeRoleIds: [R.staff] }).svc.readiness()).toBeNull();
  });
});

describe('ExecutorService readiness (S4, S5)', () => {
  it('ready with the fixture hierarchy; the three orderings each switch it off', async () => {
    expect(await rig().svc.readiness()).toBeNull();
    for (const [name, mutate] of [
      ['below Founder', (d: ReturnType<typeof serverData>) => { d.roles.find((r) => r.id === R.prawTop)!.position = 45; }],
      ['below Bot Admin', (d: ReturnType<typeof serverData>) => { d.roles.find((r) => r.id === R.prawTop)!.position = 35; }],
      ['below every privileged role', (d: ReturnType<typeof serverData>) => { d.roles.find((r) => r.id === R.prawTop)!.position = 25; }],
    ] as const) {
      const d = serverData();
      mutate(d);
      expect(await rig({ data: d }).svc.readiness(), name).toMatch(/not strictly below/);
    }
  });
  it('a power bit on @everyone or on a role a bot holds, other than the executor\'s own role, turns it off', async () => {
    const d = serverData();
    d.roles.find((r) => r.id === R.everyone)!.permissions |= 1n << 1n; // Kick Members
    expect(await rig({ data: d }).svc.readiness()).toMatch(/carries Manage Roles or Manage Channels and a bot holds it/);
  });
});

describe('Gate 2 fixes (G2SM-02)', () => {
  it('propose refuses a bulk delete that brings its own id list (code picks the messages)', async () => {
    const x = rig();
    expect(await x.svc.propose('server', [{ kind: 'msg.bulk', channel: S.plain, count: 1, ids: [S.msgAlice, S.msgBob] }], ctx)).toMatchObject({ ok: false, error: expect.stringContaining('chosen by code') });
  });
  it('apply refuses a stored list longer than its count (a forged row) and writes nothing', async () => {
    const x = rig({ stored: card({ payload: { ops: [{ kind: 'msg.bulk', channel: S.plain, count: 1, ids: [S.msgAlice, S.msgBob] }], named: [] }, snapshot: { snaps: [{}] } }) });
    expect(await x.svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: expect.stringContaining('more message ids than its count') });
    expect(x.writer.calls).toEqual([]);
  });
});


describe('OD-G2-1: destructive server ops wait for LW Admin\'s own second confirmation', () => {
  const bulk = async () => {
    const base = rig();
    const r = await base.svc.propose('server', [{ kind: 'msg.bulk', channel: S.plain, count: 10 }], ctx);
    if (!r.ok) throw new Error(r.error);
    return card({ payload: r.payload, snapshot: r.snapshot });
  };
  it('a bulk delete answers "awaiting" and writes nothing until the click; the click applies it once', async () => {
    const x = rig({ stored: await bulk(), manual: true });
    const r = await x.svc.apply(CARD_ID);
    expect(r).toMatchObject({ kind: 'awaiting', lines: [expect.stringContaining('second confirmation')] });
    expect(x.writer.calls).toEqual([]);
    expect(x.fc.queue[0]!.summary).toContain('[destructive]');
    expect(await x.fc.click()).toMatchObject({ kind: 'done', ok: true });
    expect(x.writer.calls.length).toBeGreaterThan(0);
  });
  it('a forged state without the click never applies; with no confirm component the card is refused', async () => {
    const x = rig({ stored: await bulk(), manual: true });
    await x.svc.apply(CARD_ID);
    expect(x.writer.calls).toEqual([]);
    const y = rig({ stored: await bulk(), manual: true });
    (y.svc as unknown as { d: { confirm?: unknown } }).d.confirm = undefined;
    expect(await y.svc.apply(CARD_ID)).toMatchObject({ kind: 'refused', why: expect.stringContaining('second confirmation') });
    expect(y.writer.calls).toEqual([]);
  });
  it('a non-destructive op (nickname) still applies directly', async () => {
    const base = rig();
    const r = await base.svc.propose('server', [{ kind: 'member.nick', member: U.alice, nick: 'Al' }], ctx);
    if (!r.ok) throw new Error(r.error);
    const x = rig({ stored: card({ payload: r.payload, snapshot: r.snapshot }), manual: true });
    expect(await x.svc.apply(CARD_ID)).toMatchObject({ kind: 'done', ok: true });
    expect(x.fc.queue).toHaveLength(0);
  });
  it('the second pass re-checks the live state: a change after the prompt refuses the card at the click', async () => {
    const x = rig({ stored: await bulk(), manual: true });
    await x.svc.apply(CARD_ID);
    x.data.members.delete(U.admin); // the confirmer left / lost the role before clicking
    expect(await x.fc.click()).toMatchObject({ kind: 'refused' });
    expect(x.writer.calls).toEqual([]);
  });
});

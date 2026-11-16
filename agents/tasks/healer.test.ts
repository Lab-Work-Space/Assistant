import { describe, expect, it, vi } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import type { BlockedCandidate, HealDay } from '../../db/repos/heal.js';
import type { BlockReason, Task } from '../../db/repos/tasks.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { Healer, PER_TICK, RETRY_FIRST_MS, RETRY_LATER_MS, TRANSIENT_MAX_MS, WAKE_GAP_MS } from './healer.js';

const HQ: ActorRef = { kind: 'head', dept: 'hq' };
const CTO: ActorRef = { kind: 'head', dept: 'software' };
const CFO: ActorRef = { kind: 'head', dept: 'finance' };
// Monday 2026-11-09 10:00 Asia/Bangkok (03:00Z)
const NOW = Date.parse('2026-11-09T03:00:00Z');
const MIN = 60_000;

let seq = 0;
const task = (o: Partial<Task> = {}): Task => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, title: 'Build', description: '', deptId: 'software', owner: CTO, requester: HQ, parentId: null, rootId: '', depth: 0,
  status: 'blocked', threadId: 't', turnsUsed: 0, costUsd: 0, estCostUsd: null, blockedReason: 'error', origin: 'delegated', channelId: null, sourceUserId: null, tainted: false, ...o,
} as Task);
const cand = (o: Partial<Task>, ageMs: number): BlockedCandidate => {
  const t = task(o);
  if (!t.rootId) t.rootId = t.id;
  return { task: t, updatedAt: new Date(NOW - ageMs) };
};

const EMPTY_DAY: HealDay = { retries: 0, unblocked: 0, wakes: 0, resolveRetry: 0, resolveCancel: 0, autoclosed: 0, cancels: [], tainted: [] };

function mk(rows: BlockedCandidate[], o: {
  cfg?: Record<string, unknown>; halted?: boolean; off?: boolean; tasks?: Task[]; autoretries?: Record<string, number>; wakes?: Record<string, number>; lastWake?: Record<string, number>;
  decider?: Record<string, number>; pending?: Record<string, number>; claimFails?: boolean; day?: HealDay; now?: number; healing?: string[]; wakeResult?: 'started' | 'open_tasks' | 'skipped'; claimed?: boolean;
  held?: (a: ActorRef) => boolean; counts?: { open: number; review: number; blocked: number }; holdUntil?: number | null;
} = {}) {
  const cfg = new FakeConfig((o.cfg ?? {}) as never);
  const byId = new Map([...rows.map((r) => r.task), ...(o.tasks ?? [])].map((t) => [t.id, t]));
  const claims: { action: string; taskId?: string | null; tool?: string | null; outcome?: string | null }[] = [];
  const retries: { id: string; resetTurns: boolean }[] = [];
  const wakes: Parameters<ConstructorParameters<typeof Healer>[0]['wake']>[0][] = [];
  const posts: { title?: string; body: string }[] = [];
  const log = { error: vi.fn() };
  const dailyClaims: string[] = [];
  const d = {
    repo: {
      blockedCandidates: async () => rows,
      claim: async (e: (typeof claims)[number]) => { if (o.claimFails) throw new Error('db down'); claims.push(e); },
      autoretries: async (id: string) => o.autoretries?.[id] ?? 0,
      wakes: async (id: string) => o.wakes?.[id] ?? 0,
      lastWakeAt: async (id: string) => (o.lastWake?.[id] !== undefined ? new Date(o.lastWake[id]!) : null),
      deciderToday: async (k: string) => o.decider?.[k] ?? 0,
      day: async () => o.day ?? EMPTY_DAY,
    },
    tasks: { get: async (id: string) => byId.get(id) ?? null, countOpenChildren: async () => 0 },
    retry: async (id: string, x: { resetTurns: boolean }) => { retries.push({ id, ...x }); return { ok: true as const, task: byId.get(id)!, reason: 'error' as BlockReason }; },
    wake: async (a: (typeof wakes)[number]) => { wakes.push(a); return o.wakeResult ?? 'started'; },
    isHealing: (id: string) => (o.healing ?? []).includes(id),
    canRun: () => !o.halted,
    cfg, calendar: { isOffDay: () => ({ off: o.off === true }) } as never,
    pendingApprovals: async (id: string) => o.pending?.[id] ?? 0,
    daily: { claim: async (day: string) => { dailyClaims.push(day); return o.claimed !== true; } },
    post: async (p: { title?: string; body: string }) => void posts.push(p),
    secrets: [] as string[], now: () => o.now ?? NOW, log,
    ...(o.held ? { held: async (a: ActorRef) => o.held!(a) } : {}),
    ...(o.counts ? { openCounts: async () => o.counts! } : {}),
    ...(o.holdUntil !== undefined ? { holdUntil: () => o.holdUntil! } : {}),
  };
  const h = new Healer(d as never);
  return { h, cfg, claims, retries, wakes, posts, log, dailyClaims };
}

describe('HEAL-1 Healer: retry', () => {
  it('error: no retry before 30 min, retry at exactly 30 min (claim row first), not at 29:59', async () => {
    const a = cand({}, RETRY_FIRST_MS - 1000);
    const b = cand({}, RETRY_FIRST_MS);
    const m = mk([a, b]);
    await m.h.tick();
    expect(m.retries).toEqual([{ id: b.task.id, resetTurns: false }]);
    expect(m.claims).toEqual([{ actor: 'system:healer', action: 'task.autoretry', taskId: b.task.id, tool: 'error', outcome: 'claim #1 error' }]);
  });
  it('error attempt 2 waits for 2 h (boundary), then a third time is a wake (retries used up)', async () => {
    const a = cand({}, RETRY_LATER_MS - 1000);
    const b = cand({}, RETRY_LATER_MS);
    const m = mk([a, b], { autoretries: { [a.task.id]: 1, [b.task.id]: 1 } });
    await m.h.tick();
    expect(m.retries.map((r) => r.id)).toEqual([b.task.id]);
    expect(m.claims[0]!.outcome).toBe('claim #2 error');
    const c = cand({}, 3 * 3_600_000);
    const m2 = mk([c], { autoretries: { [c.task.id]: 2 } });
    await m2.h.tick();
    expect(m2.retries).toEqual([]);
    expect(m2.wakes).toHaveLength(1);
    expect(m2.wakes[0]).toMatchObject({ why: 'gave up after automatic retries', n: 1 });
  });
  it('turns: one retry with the turn counter reset, afterwards a wake', async () => {
    const a = cand({ blockedReason: 'turns' }, 31 * MIN);
    const m = mk([a]);
    await m.h.tick();
    expect(m.retries).toEqual([{ id: a.task.id, resetTurns: true }]);
    expect(m.claims[0]!.outcome).toBe('claim #1 turns reset_turns');
    const b = cand({ blockedReason: 'turns' }, 3 * 3_600_000);
    const m2 = mk([b], { autoretries: { [b.task.id]: 1 } });
    await m2.h.tick();
    expect(m2.retries).toEqual([]);
    expect(m2.wakes[0]).toMatchObject({ why: 'gave up after automatic retries' });
  });
  it('a transient block older than 24 h is woken, never retried (the 9 live rows: 2 error older than 24 h)', async () => {
    const a = cand({}, TRANSIENT_MAX_MS + 1000);
    const m = mk([a]);
    await m.h.tick();
    expect(m.retries).toEqual([]);
    expect(m.claims).toEqual([]);
    expect(m.wakes).toHaveLength(1);
    expect(m.wakes[0]).toMatchObject({ why: 'blocked for more than 24 hours', decider: HQ, runTask: null });
  });
  it('maxRetries 0 sends error straight to the wake path', async () => {
    const a = cand({}, 31 * MIN);
    const m = mk([a], { cfg: { 'heal.maxRetries': 0 } });
    await m.h.tick();
    expect(m.retries).toEqual([]);
    expect(m.wakes).toHaveLength(1);
  });
  it('only error, turns, owner and NULL are touched: halt, budget and approval are never acted on (even if a row of them were read)', async () => {
    const rows = (['halt', 'budget', 'approval'] as const).map((r) => cand({ blockedReason: r }, 5 * 3_600_000));
    const m = mk(rows);
    await m.h.tick();
    expect(m.retries).toEqual([]);
    expect(m.wakes).toEqual([]);
    expect(m.claims).toEqual([]);
  });
  it('a pending approval on the task excludes it from both paths', async () => {
    const a = cand({}, 31 * MIN);
    const b = cand({ blockedReason: 'owner' }, 5 * MIN);
    const m = mk([a, b], { pending: { [a.task.id]: 1, [b.task.id]: 2 } });
    await m.h.tick();
    expect(m.retries).toEqual([]);
    expect(m.wakes).toEqual([]);
  });
  it('a parent or root that ended sends an error block to the wake path with that reason', async () => {
    const parent = task({ status: 'cancelled', owner: CFO });
    const a = cand({ parentId: parent.id, rootId: parent.id }, 31 * MIN);
    const m = mk([a], { tasks: [parent] });
    await m.h.tick();
    expect(m.retries).toEqual([]);
    expect(m.wakes[0]).toMatchObject({ why: 'its parent or root task has ended' });
  });
  it('claim-first: a failing claim write means no retry and no wake; the error is logged by name only', async () => {
    const a = cand({}, 31 * MIN);
    const m = mk([a], { claimFails: true });
    await m.h.tick();
    expect(m.retries).toEqual([]);
    expect(m.log.error).toHaveBeenCalledWith({ errName: 'Error' }, 'heal retry claim failed');
  });
  it('a refused retry (tree ended between read and move) leaves its claim row', async () => {
    const a = cand({}, 31 * MIN);
    const m = mk([a]);
    (m.h as unknown as { d: { retry: unknown } }).d.retry = async () => ({ ok: false, code: 'E_TREE_ENDED' });
    await m.h.tick();
    expect(m.claims).toHaveLength(1);
  });
});

describe('HEAL-1 Healer: tick limits and switches', () => {
  it('acts on at most 3 rows per tick; rows that are not actionable do not count', async () => {
    const wait = cand({}, 5 * MIN); // too young: not actionable
    const rows = [wait, ...Array.from({ length: 5 }, () => cand({}, 40 * MIN))];
    const m = mk(rows);
    await m.h.tick();
    expect(m.retries).toHaveLength(PER_TICK);
    expect(m.retries.map((r) => r.id)).toEqual(rows.slice(1, 4).map((r) => r.task.id));
  });
  it('heal.enabled off, a config read error, halted, an off day: nothing happens', async () => {
    const make = () => [cand({}, 40 * MIN), cand({ blockedReason: 'owner' }, 40 * MIN)];
    const off = mk(make(), { cfg: { 'heal.enabled': false } });
    await off.h.tick();
    const err = mk(make());
    err.cfg.throwOn.add('heal.enabled');
    await err.h.tick();
    const halted = mk(make(), { halted: true });
    await halted.h.tick();
    const offDay = mk(make(), { off: true });
    await offDay.h.tick();
    for (const m of [off, err, halted, offDay]) {
      expect(m.retries).toEqual([]);
      expect(m.wakes).toEqual([]);
      expect(m.claims).toEqual([]);
      expect(m.posts).toEqual([]);
    }
  });
  it('overlapping ticks are refused by the running flag', async () => {
    const m = mk([cand({}, 40 * MIN)]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    (m.h as unknown as { d: { repo: { blockedCandidates: unknown } } }).d.repo.blockedCandidates = async () => { await gate; return []; };
    const first = m.h.tick();
    await m.h.tick(); // returns at once
    expect(m.retries).toEqual([]);
    release();
    await first;
  });
  it('a failing step is logged by name and the next tick runs again', async () => {
    const m = mk([]);
    (m.h as unknown as { d: { repo: { blockedCandidates: unknown } } }).d.repo.blockedCandidates = async () => { throw new TypeError('boom'); };
    await m.h.tick();
    expect(m.log.error).toHaveBeenCalledWith({ errName: 'TypeError' }, 'heal scan failed');
    await m.h.tick();
    expect(m.log.error).toHaveBeenCalledTimes(2);
  });
});

describe('HEAL-1 Healer: wake path and decider', () => {
  it('owner and legacy NULL reasons wake at once (no retry), the 7 live rows', async () => {
    const rows = [cand({ blockedReason: 'owner' }, 5 * MIN), cand({ blockedReason: null }, 5 * MIN)];
    const m = mk(rows);
    await m.h.tick();
    expect(m.retries).toEqual([]);
    expect(m.wakes).toHaveLength(2);
    expect(m.wakes.map((w) => w.n)).toEqual([1, 1]);
  });
  it('parent owner decides when the parent is open; runTask is the parent', async () => {
    for (const status of ['todo', 'doing', 'review'] as const) {
      const parent = task({ owner: CFO, status, deptId: 'finance' });
      const a = cand({ blockedReason: 'owner', parentId: parent.id, rootId: parent.id }, 5 * MIN);
      const m = mk([a], { tasks: [parent] });
      await m.h.tick();
      expect(m.wakes[0]).toMatchObject({ decider: CFO, runTask: { id: parent.id } });
    }
  });
  it('CEO fallback: parent done, blocked, a persona-owned parent or one with no thread', async () => {
    const mkParent = (o: Partial<Task>) => task({ owner: CFO, status: 'doing', deptId: 'finance', ...o });
    for (const p of [mkParent({ status: 'done' }), mkParent({ status: 'blocked' }), mkParent({ owner: { kind: 'persona', personaId: 'sa' } }), mkParent({ threadId: null })]) {
      const a = cand({ blockedReason: 'owner', parentId: p.id, rootId: p.id }, 5 * MIN);
      const m = mk([a], { tasks: [p] });
      await m.h.tick();
      expect(m.wakes[0], `parent ${p.status}`).toMatchObject({ decider: HQ, runTask: null });
    }
  });
  it('a task whose parent owner is the task owner is decided by the CEO; a CEO-owned task is not woken and is listed for the owner', async () => {
    const parent = task({ owner: CTO, status: 'doing' });
    const own = cand({ blockedReason: 'owner', parentId: parent.id, rootId: parent.id }, 5 * MIN); // owner CTO = parent owner CTO
    const m = mk([own], { tasks: [parent] });
    await m.h.tick();
    expect(m.wakes[0]).toMatchObject({ decider: HQ, runTask: null });
    const ceoOwn = cand({ blockedReason: 'owner', owner: HQ, deptId: 'hq' }, 5 * MIN);
    const m2 = mk([ceoOwn]);
    await m2.h.tick();
    expect(m2.wakes).toEqual([]);
    expect(await m2.h.needs(EMPTY_DAY)).toEqual([expect.objectContaining({ id: ceoOwn.task.id, why: 'the CEO owns it' })]);
  });
  it('a parent in awaiting_approval is skipped: no wake, no row', async () => {
    const parent = task({ owner: CFO, status: 'awaiting_approval' });
    const a = cand({ blockedReason: 'owner', parentId: parent.id, rootId: parent.id }, 5 * MIN);
    const m = mk([a], { tasks: [parent] });
    await m.h.tick();
    expect(m.wakes).toEqual([]);
    expect(m.claims).toEqual([]);
  });
  it('caps: per task (2), 30 min gap (boundary), per decider per day (10th runs, 11th waits and is listed), and a wake already running', async () => {
    const a = cand({ blockedReason: 'owner' }, 5 * MIN);
    const capped = mk([a], { wakes: { [a.task.id]: 2 } });
    await capped.h.tick();
    expect(capped.wakes).toEqual([]);
    expect((await capped.h.needs(EMPTY_DAY))[0]).toMatchObject({ why: 'wake limit reached' });

    const gapA = cand({ blockedReason: 'owner' }, 5 * MIN);
    const gap = mk([gapA], { wakes: { [gapA.task.id]: 1 }, lastWake: { [gapA.task.id]: NOW - WAKE_GAP_MS + 1000 } });
    await gap.h.tick();
    expect(gap.wakes).toEqual([]);
    const gapB = cand({ blockedReason: 'owner' }, 5 * MIN);
    const gapOk = mk([gapB], { wakes: { [gapB.task.id]: 1 }, lastWake: { [gapB.task.id]: NOW - WAKE_GAP_MS } });
    await gapOk.h.tick();
    expect(gapOk.wakes).toHaveLength(1);
    expect(gapOk.wakes[0]!.n).toBe(2);

    const tenth = mk([cand({ blockedReason: 'owner' }, 5 * MIN)], { decider: { 'head:hq': 9 } });
    await tenth.h.tick();
    expect(tenth.wakes).toHaveLength(1);
    const eleventh = mk([cand({ blockedReason: 'owner' }, 5 * MIN)], { decider: { 'head:hq': 10 } });
    await eleventh.h.tick();
    expect(eleventh.wakes).toEqual([]);
    expect((await eleventh.h.needs(EMPTY_DAY))[0]).toMatchObject({ why: 'daily wake limit reached' });

    const busyRow = cand({ blockedReason: 'owner' }, 5 * MIN);
    const busy = mk([busyRow], { healing: [busyRow.task.id] });
    await busy.h.tick();
    expect(busy.wakes).toEqual([]);
  });
  it('the wake limit and daily limit read the live config', async () => {
    const a = cand({ blockedReason: 'owner' }, 5 * MIN);
    const m = mk([a], { wakes: { [a.task.id]: 4 }, cfg: { 'heal.maxWakesPerTask': 5 } });
    await m.h.tick();
    expect(m.wakes).toHaveLength(1);
  });
  it('open-task limit full: nothing started, the task is listed for the owner; a later start clears it', async () => {
    const a = cand({ blockedReason: 'owner' }, 5 * MIN);
    const m = mk([a], { wakeResult: 'open_tasks' });
    await m.h.tick();
    expect((await m.h.needs(EMPTY_DAY))[0]).toMatchObject({ why: 'open-task limit full' });
    expect(m.claims).toEqual([]);
  });
  it('the wake counter n is the next claim number (wakes so far + 1) and the decider key is not an input of the model', async () => {
    const a = cand({ blockedReason: 'owner' }, 5 * MIN);
    const m = mk([a], { wakes: { [a.task.id]: 1 } });
    await m.h.tick();
    expect(m.wakes[0]!.n).toBe(2);
  });
});

describe('HEAL-1 Healer: daily summary (HL-C20)', () => {
  const at = (h: number, min = 0) => Date.parse(`2026-11-09T${String(h - 7).padStart(2, '0')}:${String(min).padStart(2, '0')}:00Z`); // Bangkok = UTC+7
  const busy: HealDay = { retries: 2, unblocked: 1, wakes: 1, resolveRetry: 1, resolveCancel: 1, autoclosed: 0, cancels: [{ taskId: 'c0ffee00-0000-4000-8000-000000000001', title: 'Old *idea* @everyone', decider: 'head:finance' }], tainted: [{ taskId: 'deadbeef-0000-4000-8000-000000000002', title: 'Person task' }] };

  it('posts once per day at or after 18:00 local when something happened; counts, the cancel and the R_TAINTED task listed, no note text', async () => {
    const m = mk([], { now: at(18), day: busy });
    await m.h.tick();
    await m.h.tick();
    expect(m.posts).toHaveLength(1);
    const body = m.posts[0]!.body;
    expect(m.posts[0]!.title).toBe('Heal summary');
    expect(body).toContain('Automatic retries: 2 (1 no longer blocked)');
    expect(body).toContain('Decisions: 1 retried, 1 cancelled');
    expect(body).toContain('c0ffee00');
    expect(body).toContain('deadbeef');
    expect(body).toContain('by head:finance');
    expect(body).not.toMatch(/@everyone/); // defanged by escapeCardText
    expect(m.dailyClaims).toEqual(['2026-11-09']);
  });
  it('17:59 local: nothing; an empty day: nothing posted and the day is NOT claimed (a later event can still be reported)', async () => {
    const early = mk([], { now: at(17, 59), day: busy });
    await early.h.tick();
    expect(early.posts).toEqual([]);
    expect(early.dailyClaims).toEqual([]);
    const empty = mk([], { now: at(18, 30) });
    await empty.h.tick();
    expect(empty.posts).toEqual([]);
    expect(empty.dailyClaims).toEqual([]);
  });
  it('another process already claimed the day: no post', async () => {
    const m = mk([], { now: at(18), day: busy, claimed: true });
    await m.h.tick();
    expect(m.posts).toEqual([]);
  });
  it('lists the CEO-own and over-cap tasks with escaped, cut titles; titles cut at 60; at most 15 listed with "and n more"', async () => {
    const rows = Array.from({ length: 17 }, () => cand({ blockedReason: 'owner', owner: HQ, deptId: 'hq', title: 'x'.repeat(100) }, 5 * MIN));
    const m = mk(rows, { now: at(19) });
    await m.h.tick();
    const body = m.posts[0]!.body;
    expect(body).toContain('Needs the owner:');
    expect(body).toContain('- and 2 more');
    expect(body.split('\n').filter((l) => l.startsWith('- `')).every((l) => l.includes('x'.repeat(59) + '…'))).toBe(true);
  });
  it('heal off, halted or an off day: no summary', async () => {
    for (const o of [{ cfg: { 'heal.enabled': false } }, { halted: true }, { off: true }]) {
      const m = mk([], { now: at(18), day: busy, ...o });
      await m.h.tick();
      expect(m.posts).toEqual([]);
    }
  });
  it('a failing post is logged by name, the day stays claimed (no repeat)', async () => {
    const m = mk([], { now: at(18), day: busy });
    (m.h as unknown as { d: { post: unknown } }).d.post = async () => { throw new RangeError('x'); };
    await m.h.tick();
    expect(m.log.error).toHaveBeenCalledWith({ errName: 'RangeError' }, 'heal summary post failed');
    await m.h.tick();
    expect(m.dailyClaims).toHaveLength(1);
  });
});

describe('OPS-HOLD Healer', () => {
  const at = (h: number) => Date.parse(`2026-11-09T${String(h - 7).padStart(2, '0')}:00:00Z`);
  it('skips retry and wake for a held owner/decider without claiming anything; others in the same scan still act', async () => {
    const held = cand({ owner: CTO }, RETRY_FIRST_MS);
    const free = cand({ owner: CFO }, RETRY_FIRST_MS);
    const woken = cand({ owner: CTO, blockedReason: 'owner' }, 5 * MIN);
    const m = mk([held, woken, free], { held: (a) => a.kind === 'head' && (a.dept === 'software' || a.dept === 'hq') });
    await m.h.tick();
    expect(m.retries.map((r) => r.id)).toEqual([free.task.id]);
    expect(m.claims.map((c) => c.taskId)).toEqual([free.task.id]);
    expect(m.wakes).toEqual([]);
  });
  it('once the hold is gone the same blocked task is retried (the skip is not remembered)', async () => {
    let on = true;
    const a = cand({}, RETRY_FIRST_MS);
    const m = mk([a], { held: () => on });
    await m.h.tick();
    expect(m.retries).toEqual([]);
    on = false;
    await m.h.tick();
    expect(m.retries.map((r) => r.id)).toEqual([a.task.id]);
  });
  const busy: HealDay = { retries: 1, unblocked: 0, wakes: 0, resolveRetry: 0, resolveCancel: 0, autoclosed: 0, cancels: [], tainted: [] };
  it('R1-02: the summary shows "Reviews closed by code today: n", and a day with only such closes still posts', async () => {
    const m = mk([], { now: at(18), day: { ...busy, retries: 0, autoclosed: 3 } });
    await m.h.tick();
    expect(m.posts[0]!.body).toContain('Reviews closed by code today: 3');
  });
  it('the daily summary carries "Open tasks: n/cap (review r, blocked b)" and the hold while it lasts', async () => {
    const m = mk([], { now: at(18), day: busy, counts: { open: 12, review: 11, blocked: 1 }, holdUntil: at(23) });
    await m.h.tick();
    const body = m.posts[0]!.body;
    expect(body).toContain('Open tasks: 12/20 (review 11, blocked 1)');
    expect(body).toMatch(/Claude quota hold: Claude-backed bots wait until <t:\d+:R>/);
  });
  it('a quiet day with a hold still posts; a quiet day without one does not; no hold line when none', async () => {
    const quiet = mk([], { now: at(18), counts: { open: 3, review: 0, blocked: 0 }, holdUntil: at(23) });
    await quiet.h.tick();
    expect(quiet.posts).toHaveLength(1);
    const none = mk([], { now: at(18), counts: { open: 3, review: 0, blocked: 0 } });
    await none.h.tick();
    expect(none.posts).toEqual([]);
    const dayOnly = mk([], { now: at(18), day: busy, counts: { open: 3, review: 0, blocked: 0 }, holdUntil: null });
    await dayOnly.h.tick();
    expect(dayOnly.posts[0]!.body).not.toMatch(/hold/);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { newRunState, type HealCode, type ToolContext } from '../../tools/types.js';
import { resolveBlocked, resolveBlockedInput } from '../../tools/builtin/resolveBlocked.js';
import { MemTasks } from '../test-helpers.js';
import { isHumanOrigin } from '../scheduler/scheduler.js';
import { createHealActions, deciderOf, HEAL_REFUSALS, HEALABLE, instructionFrame, isPersonOrigin, stamp } from './heal-actions.js';
import type { Task } from '../../db/repos/tasks.js';

const HQ: ActorRef = { kind: 'head', dept: 'hq' };
const CTO: ActorRef = { kind: 'head', dept: 'software' };
const CFO: ActorRef = { kind: 'head', dept: 'finance' };
const SA: ActorRef = { kind: 'persona', personaId: 'system-analyst' };
const HUMAN = { kind: 'human', userId: '1570000000000000042' } as const;
const NOW = Date.parse('2026-11-09T03:05:00Z');

async function world(o: { cfg?: Record<string, unknown>; halted?: boolean; pending?: number; claimFails?: boolean; retryRows?: number; wakeRuns?: string[]; childOrigin?: Task['origin']; childReason?: Task['blockedReason']; childOwner?: ActorRef; parentOwner?: ActorRef; parentStatus?: Task['status']; rootOrigin?: Task['origin'] } = {}) {
  const tasks = new MemTasks();
  const root = await tasks.create({ title: 'Root', deptId: 'hq', owner: HQ, requester: HUMAN, origin: o.rootOrigin ?? 'slash', status: 'doing', threadId: 'r' });
  const parent = await tasks.create({ title: 'Parent', deptId: 'finance', owner: o.parentOwner ?? CFO, requester: HQ, origin: 'delegated', parentId: root.id, status: o.parentStatus ?? 'doing', threadId: 'p' });
  const child = await tasks.create({ title: 'Child', description: 'first line\nmore', deptId: 'software', owner: o.childOwner ?? CTO, requester: CFO, origin: o.childOrigin ?? 'delegated', parentId: parent.id, status: 'blocked', threadId: 'c', tainted: false });
  await tasks.update(child.id, { blockedReason: o.childReason === undefined ? 'owner' : (o.childReason as never) });
  if (o.childReason === null) (tasks.rows.get(child.id) as Task).blockedReason = null;
  const events: [string, unknown][] = [];
  const audits: { action: string; outcome?: string | null; tool?: string | null; actor: string; taskId?: string | null }[] = [];
  const claims: typeof audits = [];
  const cfg = new FakeConfig((o.cfg ?? {}) as never);
  const revoked: string[] = [];
  const log = { error: vi.fn() };
  const port = createHealActions({
    tasks, cfg, isHalted: () => o.halted === true, pendingApprovals: async () => o.pending ?? 0, now: () => NOW, log,
    bus: { emit: async (n: string, p: unknown) => void events.push([n, p]) } as never,
    audit: async (e) => void audits.push(e as never),
    repo: {
      claim: async (e) => { if (o.claimFails) throw new Error('db down'); claims.push(e as never); },
      resolveRetries: async () => o.retryRows ?? 0,
      wakeRunTasks: async () => o.wakeRuns ?? [],
    },
    revokeRoot: async (id) => void revoked.push(id), secrets: ['sk-LITERAL-SECRET-1234'],
  });
  const resolve = (over: Partial<Parameters<typeof port.resolve>[0]> = {}) => port.resolve({ actor: CFO, callerTaskId: parent.id, tainted: false, taskId: child.id, action: 'retry', instruction: 'use the staging key', ...over });
  return { tasks, root, parent, child, events, audits, claims, resolve, revoked, log, cfg };
}

describe('HEAL-1 deciderOf', () => {
  it('parent owner when the parent is open and has a thread; CEO path otherwise; none for the CEO own task', async () => {
    const w = await world();
    expect(await deciderOf(w.child, { tasks: w.tasks })).toMatchObject({ path: 'parent', actor: CFO, runnable: true });
    await w.tasks.update(w.parent.id, { status: 'awaiting_approval' });
    expect(await deciderOf(w.child, { tasks: w.tasks })).toMatchObject({ path: 'parent', actor: CFO, runnable: false });
    await w.tasks.update(w.parent.id, { status: 'done' });
    expect(await deciderOf(w.child, { tasks: w.tasks })).toEqual({ path: 'ceo', actor: HQ, runTask: null, runnable: true });
    const ceoOwn = { ...w.child, owner: HQ, parentId: null };
    expect(await deciderOf(ceoOwn, { tasks: w.tasks })).toEqual({ path: 'none' });
  });
  it('an own task whose parent owner is the same head goes to the CEO', async () => {
    const w = await world({ childOwner: CFO });
    expect(await deciderOf(w.child, { tasks: w.tasks })).toMatchObject({ path: 'ceo' });
  });
  it('person-origin list is the scheduler list; healable reasons are owner, error, turns', () => {
    for (const o of ['chat', 'slash', 'voice', 'delegated', 'schedule', 'watch', 'reminder', 'poll', 'import'] as const) expect(isPersonOrigin(o)).toBe(isHumanOrigin(o));
    expect([...HEALABLE]).toEqual(['owner', 'error', 'turns']);
  });
});

describe('HEAL-1 resolve_blocked port: refusals (table: every code, in order)', () => {
  const cases: { code: HealCode; setup: Parameters<typeof world>[0]; over?: (w: Awaited<ReturnType<typeof world>>) => Parameters<Awaited<ReturnType<typeof world>>['resolve']>[0]; before?: (w: Awaited<ReturnType<typeof world>>) => Promise<void> }[] = [
    { code: 'R_DISABLED', setup: { cfg: { 'heal.enabled': false } } },
    { code: 'R_HALTED', setup: { halted: true } },
    { code: 'R_NOT_HEAD', setup: {}, over: () => ({ actor: SA }) },
    { code: 'R_NOT_FOUND', setup: {}, over: () => ({ taskId: '00000000-0000-4000-8000-00000000dead' }) },
    { code: 'R_NOT_BLOCKED', setup: {}, before: async (w) => void (await w.tasks.update(w.child.id, { status: 'todo' })) },
    { code: 'R_NOT_HEALABLE', setup: { childReason: 'budget' } },
    { code: 'R_NOT_HEALABLE', setup: { childReason: 'approval' } },
    { code: 'R_NOT_HEALABLE', setup: { childReason: 'halt' } },
    { code: 'R_NOT_DECIDER', setup: {}, over: () => ({ actor: CTO }) }, // a head that is not the decider (here the task owner)
    { code: 'R_NOT_DECIDER', setup: {}, over: () => ({ actor: HQ }) }, // the CEO while a parent owner decides
    { code: 'R_NOT_HERE', setup: {}, over: () => ({ callerTaskId: null }) },
    { code: 'R_NOT_HERE', setup: {}, over: (w) => ({ callerTaskId: w.root.id }) }, // the decider in an unrelated conversation
    { code: 'R_PENDING', setup: { pending: 1 } },
    { code: 'R_RETRY_CAP', setup: { retryRows: 2 } },
    { code: 'R_TURNS', setup: { childReason: 'turns' }, before: async (w) => void (await w.tasks.update(w.child.id, { turnsUsed: 99 })) },
    { code: 'R_OPEN_CHILDREN', setup: {}, over: () => ({ action: 'cancel', reason: 'no longer needed', instruction: undefined }), before: async (w) => void (await w.tasks.create({ title: 'grand', deptId: 'software', owner: SA, requester: CTO, origin: 'delegated', parentId: w.child.id, status: 'todo' })) },
    { code: 'R_TAINTED', setup: { childOrigin: 'chat' }, over: () => ({ action: 'cancel', reason: 'no longer needed', instruction: undefined, tainted: true }) },
  ];
  for (const c of cases) {
    it(`${c.code}: fixed text, audit refused:${c.code}${c.setup && Object.keys(c.setup).length ? ` (${JSON.stringify(c.setup)})` : ''}`, async () => {
      const w = await world(c.setup);
      await c.before?.(w);
      const over = c.over ? c.over(w) : {};
      const r = await w.resolve(over as never);
      expect(r).toEqual({ ok: false, code: c.code });
      expect(w.audits.at(-1) ?? w.claims.at(-1)).toMatchObject({ action: 'task.heal.resolve', outcome: `refused:${c.code}` }); // R_TAINTED is a claim row (G2-04)
      expect(HEAL_REFUSALS[c.code].length).toBeGreaterThan(10);
      expect(w.events).toEqual([]);
      expect(w.tasks.rows.get(w.child.id)!.status).toBe((c.code === 'R_NOT_BLOCKED') ? 'todo' : 'blocked');
    });
  }
  it('R_TREE_ENDED: the CEO decides (parent ended) from a decide task named in a wake claim, and the tree ended under the child (root cancelled)', async () => {
    const w = await world({ wakeRuns: ['11111111-1111-4111-8111-111111111111'] });
    await w.tasks.update(w.parent.id, { status: 'done' });
    await w.tasks.update(w.root.id, { status: 'cancelled' });
    const r = await w.resolve({ actor: HQ, callerTaskId: '11111111-1111-4111-8111-111111111111' });
    expect(r).toEqual({ ok: false, code: 'R_TREE_ENDED' });
    expect(w.claims).toHaveLength(1); // the claim stays even though the move was refused (HL-C10)
    expect(w.audits.at(-1)).toMatchObject({ outcome: 'refused:R_TREE_ENDED' });
  });
  it('G2-04: the cancel row and the R_TAINTED row are claims written before any state change; a failed claim is R_ERROR and moves nothing', async () => {
    const c = await world({ claimFails: true });
    expect(await c.resolve({ action: 'cancel', reason: 'gone' })).toEqual({ ok: false, code: 'R_ERROR' });
    expect(c.tasks.rows.get(c.child.id)!.status).toBe('blocked');
    expect(c.events).toEqual([]);
    const t = await world({ claimFails: true, childOrigin: 'chat' });
    expect(await t.resolve({ action: 'cancel', reason: 'gone', tainted: true })).toEqual({ ok: false, code: 'R_ERROR' });
    expect(t.tasks.rows.get(t.child.id)!.status).toBe('blocked');
    const ok = await world({ childOrigin: 'chat' });
    // claim-first: at claim time the task is still blocked
    const seen: string[] = [];
    const orig = ok.tasks.update.bind(ok.tasks);
    ok.tasks.update = async (id, p, e) => (p.status === 'cancelled' ? (seen.push(String(ok.claims.length)), orig(id, p, e)) : orig(id, p, e));
    expect(await ok.resolve({ action: 'cancel', reason: 'fine' })).toEqual({ ok: true, action: 'cancel' });
    expect(seen).toEqual(['1']);
    const tt = await world({ childOrigin: 'chat' });
    expect(await tt.resolve({ action: 'cancel', reason: 'x', tainted: true })).toEqual({ ok: false, code: 'R_TAINTED' });
    expect(tt.claims).toEqual([expect.objectContaining({ outcome: 'refused:R_TAINTED' })]);
    expect(tt.audits).toEqual([]);
  });
  it('R_STALE: a retry or cancel that loses the guarded UPDATE', async () => {
    const w = await world();
    const orig = w.tasks.update.bind(w.tasks);
    w.tasks.update = async (id, p, e) => (p.status === 'todo' || p.status === 'cancelled' ? null : orig(id, p, e));
    expect(await w.resolve()).toEqual({ ok: false, code: 'R_STALE' });
    expect(await w.resolve({ action: 'cancel', reason: 'gone' })).toEqual({ ok: false, code: 'R_STALE' });
  });
  it('a config read error counts as off (R_DISABLED)', async () => {
    const w = await world();
    w.cfg.throwOn.add('heal.enabled');
    expect(await w.resolve()).toEqual({ ok: false, code: 'R_DISABLED' });
  });
  it('a sibling tree and a persona-owned decider are refused (R_NOT_DECIDER / R_NOT_HEAD); a `none` task refuses every caller', async () => {
    const w = await world();
    const other = await w.tasks.create({ title: 'Other root', deptId: 'finance', owner: CFO, requester: HUMAN, origin: 'slash', status: 'doing', threadId: 'o' });
    expect(await w.resolve({ callerTaskId: other.id })).toEqual({ ok: false, code: 'R_NOT_HERE' });
    const ceoTask = await w.tasks.create({ title: 'CEO task', deptId: 'hq', owner: HQ, requester: HUMAN, origin: 'slash', status: 'blocked', threadId: 'q' });
    await w.tasks.update(ceoTask.id, { blockedReason: 'owner' });
    for (const actor of [HQ, CFO, CTO]) expect(await w.resolve({ actor, taskId: ceoTask.id, callerTaskId: ceoTask.id })).toEqual({ ok: false, code: 'R_NOT_DECIDER' });
  });
  it('a failed claim write (retry) means no move: R_ERROR', async () => {
    const w = await world({ claimFails: true });
    expect(await w.resolve()).toEqual({ ok: false, code: 'R_ERROR' });
    expect(w.tasks.rows.get(w.child.id)!.status).toBe('blocked');
    expect(w.log.error).toHaveBeenCalledWith({ errName: 'Error' }, 'resolve_blocked claim failed');
  });
  it('the refusal texts never echo model text and all 16 codes have one', () => {
    expect(Object.keys(HEAL_REFUSALS)).toHaveLength(16);
    expect(HEAL_REFUSALS.R_TAINTED).toBe('a person asked for that task; it cannot be cancelled from a run that read outside text. Retry it or leave it for the owner');
    expect(HEAL_REFUSALS.R_NOT_HEALABLE).toBe('that block needs the owner');
  });
});

describe('HEAL-1 resolve_blocked port: retry and cancel', () => {
  it('retry from the parent: claim row first, frame appended in the same UPDATE, task -> todo, task.changed then task.ready, no extra row', async () => {
    const w = await world();
    const r = await w.resolve({ instruction: 'use the staging key sk-LITERAL-SECRET-1234\nand <@123> @everyone' });
    expect(r).toEqual({ ok: true, action: 'retry' });
    expect(w.claims).toEqual([{ actor: 'head:finance', action: 'task.heal.resolve', taskId: w.child.id, tool: w.parent.id, outcome: 'retry' }]);
    const row = w.tasks.rows.get(w.child.id)!;
    expect(row.status).toBe('todo');
    expect(row.description.startsWith('first line\nmore')).toBe(true);
    expect(row.description).toContain('\n\n---\nInstruction from head of finance after the block (2026-11-09 10:05): use the staging key');
    expect(row.description).not.toContain('sk-LITERAL-SECRET-1234');
    expect(row.description).not.toMatch(/\n.*and <@/); // one line
    expect(row.description).not.toContain('@everyone');
    expect(w.events.map((e) => e[0])).toEqual(['task.changed', 'task.ready']);
    expect(w.audits).toEqual([]);
    expect(row.tainted).toBe(false);
  });
  it('a tainted decider run taints the child (copied forward, HL-C11)', async () => {
    const w = await world();
    await w.resolve({ tainted: true });
    expect(w.tasks.rows.get(w.child.id)!.tainted).toBe(true);
  });
  it('the frame is cut to 1000 characters of instruction; the total description stays within 6000 and the first line survives (HL-C14)', async () => {
    const w = await world();
    (w.tasks.rows.get(w.child.id) as Task).description = 'SOURCE LINE\n' + 'z'.repeat(7000);
    await w.resolve({ instruction: 'i'.repeat(1000) });
    const d = w.tasks.rows.get(w.child.id)!.description;
    expect(d.length).toBeLessThanOrEqual(6000);
    expect(d.startsWith('SOURCE LINE\n')).toBe(true);
    expect(d.endsWith('i'.repeat(1000))).toBe(true);
    const frame = instructionFrame(CFO, 'j'.repeat(5000), NOW, 'Asia/Bangkok', []);
    expect(frame.length).toBeLessThan(1000 + 100);
  });
  it('cancel by the decider: blocked -> cancelled, task.changed carries the masked reason as the summary, audit cancel; a root also revokes its web grants', async () => {
    const w = await world();
    const r = await w.resolve({ action: 'cancel', reason: 'not needed sk-LITERAL-SECRET-1234', instruction: undefined });
    expect(r).toEqual({ ok: true, action: 'cancel' });
    expect(w.tasks.rows.get(w.child.id)!.status).toBe('cancelled');
    expect(w.events).toHaveLength(1);
    expect(w.events[0]![1]).toMatchObject({ from: 'blocked', to: 'cancelled' });
    expect(JSON.stringify(w.events[0]![1])).not.toContain('sk-LITERAL-SECRET-1234');
    expect(w.claims).toEqual([{ actor: 'head:finance', action: 'task.heal.resolve', taskId: w.child.id, tool: w.parent.id, outcome: 'cancel' }]);
    expect(w.audits).toEqual([]);
    expect(w.revoked).toEqual([]);
    // a root: the CEO (no parent) cancels its decide-task target
    const root = await w.tasks.create({ title: 'Own root', deptId: 'software', owner: CTO, requester: HQ, origin: 'delegated', status: 'blocked', threadId: 'z' });
    await w.tasks.update(root.id, { blockedReason: 'owner' });
    const decide = '22222222-2222-4222-8222-222222222222';
    const w2 = { ...w };
    const port2 = createHealActions({
      tasks: w.tasks, cfg: w.cfg, isHalted: () => false, pendingApprovals: async () => 0, bus: { emit: async () => undefined } as never, audit: async () => undefined,
      repo: { claim: async () => undefined, resolveRetries: async () => 0, wakeRunTasks: async () => [decide] }, revokeRoot: async (id, by) => void w2.revoked.push(`${id}:${by}`),
    });
    expect(await port2.resolve({ actor: HQ, callerTaskId: decide, tainted: false, taskId: root.id, action: 'cancel', reason: 'abandoned' })).toEqual({ ok: true, action: 'cancel' });
    expect(w.revoked).toEqual([`${root.id}:system:heal`]);
  });
  it('tainted cancel matrix (HL-C6): only tainted + person origin is refused', async () => {
    const out: Record<string, boolean> = {};
    for (const origin of ['chat', 'slash', 'delegated'] as const) {
      for (const tainted of [true, false]) {
        const w = await world({ childOrigin: origin });
        const r = await w.resolve({ action: 'cancel', reason: 'no longer needed', instruction: undefined, tainted });
        out[`${origin}/${tainted ? 'tainted' : 'clean'}`] = r.ok;
        if (!r.ok) expect(r.code).toBe('R_TAINTED');
      }
    }
    expect(out).toEqual({ 'chat/tainted': false, 'chat/clean': true, 'slash/tainted': false, 'slash/clean': true, 'delegated/tainted': true, 'delegated/clean': true });
  });
  it('retry from a tainted run stays allowed on a person task (taint is copied)', async () => {
    const w = await world({ childOrigin: 'chat' });
    expect(await w.resolve({ tainted: true })).toEqual({ ok: true, action: 'retry' });
  });
  it('retry cap: with maxWakesPerTask 2 the third retry is R_RETRY_CAP (HL-C8)', async () => {
    const w = await world({ retryRows: 1 });
    expect((await w.resolve()).ok).toBe(true);
    const w2 = await world({ retryRows: 2 });
    expect(await w2.resolve()).toEqual({ ok: false, code: 'R_RETRY_CAP' });
  });
  it('legacy NULL reason is healable and reads as owner; the CEO path works from a decide task named in a wake claim', async () => {
    const w = await world({ childReason: null, wakeRuns: ['33333333-3333-4333-8333-333333333333'] });
    await w.tasks.update(w.parent.id, { status: 'blocked' }); // CEO path (a blocked parent is not open)
    const r = await w.resolve({ actor: HQ, callerTaskId: '33333333-3333-4333-8333-333333333333' });
    expect(r.ok).toBe(true);
  });
});

describe('HEAL-1 resolve_blocked tool', () => {
  it('declares no kind and never needs approval (SA-1 C1, HL-C9)', () => {
    expect(resolveBlocked.kind).toBeUndefined();
    expect(resolveBlocked.requiresApproval({ taskId: 'x', action: 'cancel', reason: 'r' } as never, {} as never)).toBe(false);
    expect(resolveBlocked.untrustedOutput).toBeUndefined();
  });
  it('zod: strict, retry needs an instruction, cancel needs a reason, id shape, lengths', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(resolveBlockedInput.safeParse({ taskId: id, action: 'retry' }).success).toBe(false);
    expect(resolveBlockedInput.safeParse({ taskId: id, action: 'cancel' }).success).toBe(false);
    expect(resolveBlockedInput.safeParse({ taskId: id, action: 'retry', instruction: 'ok' }).success).toBe(true);
    expect(resolveBlockedInput.safeParse({ taskId: id.toUpperCase(), action: 'cancel', reason: 'r' }).data?.taskId).toBe(id);
    expect(resolveBlockedInput.safeParse({ taskId: id, action: 'retry', instruction: 'x'.repeat(1001) }).success).toBe(false);
    expect(resolveBlockedInput.safeParse({ taskId: id, action: 'cancel', reason: 'x'.repeat(301) }).success).toBe(false);
    expect(resolveBlockedInput.safeParse({ taskId: 'nope', action: 'cancel', reason: 'r' }).success).toBe(false);
    for (const extra of ['actor', 'callerTaskId', 'tainted', 'personStarted']) expect(resolveBlockedInput.safeParse({ taskId: id, action: 'cancel', reason: 'r', [extra]: true }).success).toBe(false);
  });
  it('the tool passes the run taint and the task id from the context, maps a refusal to the fixed text, and is unavailable without the port', async () => {
    const seen: unknown[] = [];
    const run = newRunState();
    run.markTainted();
    const ctx = { actor: CFO, task: { id: 'p1', tainted: false }, tainted: () => run.tainted(), run, heal: { resolve: async (r: unknown) => { seen.push(r); return { ok: false, code: 'R_TAINTED' }; } } } as unknown as ToolContext;
    const input = resolveBlockedInput.parse({ taskId: '11111111-1111-4111-8111-111111111111', action: 'cancel', reason: 'r' });
    const res = await resolveBlocked.run(input, ctx);
    expect(res).toEqual({ content: HEAL_REFUSALS.R_TAINTED, isError: true });
    expect(seen[0]).toMatchObject({ actor: CFO, callerTaskId: 'p1', tainted: true, action: 'cancel', reason: 'r' });
    expect((await resolveBlocked.run(input, { ...ctx, heal: undefined } as ToolContext)).isError).toBe(true);
    const clean = { ...ctx, task: { id: 'p1', tainted: true }, tainted: () => false } as unknown as ToolContext;
    await resolveBlocked.run(input, clean);
    expect(seen[1]).toMatchObject({ tainted: true }); // the task row's taint counts too
  });
  it('stamp is the local wall clock', () => {
    expect(stamp(Date.parse('2026-11-09T17:30:00Z'), 'Asia/Bangkok')).toBe('2026-11-10 00:30');
  });
});

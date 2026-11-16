import { describe, expect, it } from 'vitest';
import type { Task } from '../../db/repos/tasks.js';
import { DESCRIPTION_MAX, retryBlocked } from './retry.js';

const task = (o: Partial<Task> = {}): Task => ({
  id: 't1', title: 't', description: 'first line\nrest', deptId: 'hq', owner: { kind: 'head', dept: 'hq' }, requester: { kind: 'head', dept: 'hq' } as never, parentId: null, rootId: 't1', depth: 0,
  status: 'blocked', threadId: null, turnsUsed: 0, costUsd: 0, estCostUsd: null, blockedReason: 'error', origin: 'delegated', channelId: null, sourceUserId: null, tainted: false, ...o,
} as Task);

function mk(rows: Task[], o: { halted?: boolean; cap?: number; stale?: boolean } = {}) {
  const map = new Map(rows.map((r) => [r.id, r]));
  const events: [string, unknown][] = [];
  const updates: { id: string; patch: Record<string, unknown>; expected?: string }[] = [];
  const d = {
    tasks: {
      get: async (id: string) => map.get(id) ?? null,
      update: async (id: string, patch: Record<string, unknown>, expected?: string) => { updates.push({ id, patch, ...(expected ? { expected } : {}) }); return o.stale ? null : { ...map.get(id)!, ...patch } as Task; },
    },
    bus: { emit: async (n: string, p: unknown) => void events.push([n, p]) } as never,
    isHalted: () => o.halted === true,
    turnsCap: () => o.cap ?? 10,
  };
  return { d, events, updates };
}

describe('HEAL-1 retryBlocked', () => {
  it('moves blocked -> todo, emits task.changed then task.ready, writes no audit', async () => {
    const m = mk([task()]);
    const r = await retryBlocked(m.d, 't1', { resetTurns: false });
    expect(r).toMatchObject({ ok: true, reason: 'error', task: { status: 'todo' } });
    expect(m.updates).toEqual([{ id: 't1', patch: { status: 'todo' }, expected: 'blocked' }]);
    expect(m.events.map((e) => e[0])).toEqual(['task.changed', 'task.ready']);
    expect(m.events[0]![1]).toMatchObject({ from: 'blocked', to: 'todo' });
    expect(m.events[1]![1]).toEqual({ taskId: 't1' });
  });
  it('refusals in order, none emits: not found, halted, not blocked, tree ended, turns, stale', async () => {
    expect(await retryBlocked(mk([]).d, 'x', { resetTurns: false })).toEqual({ ok: false, code: 'E_NOT_FOUND' });
    expect(await retryBlocked(mk([task()], { halted: true }).d, 't1', { resetTurns: false })).toMatchObject({ ok: false, code: 'E_HALTED' });
    const nb = mk([task({ status: 'doing' })]);
    expect(await retryBlocked(nb.d, 't1', { resetTurns: false })).toMatchObject({ ok: false, code: 'E_NOT_BLOCKED', status: 'doing' });
    const te = mk([task({ parentId: 'p', rootId: 'r' }), task({ id: 'p', status: 'done' }), task({ id: 'r', status: 'doing' })]);
    expect(await retryBlocked(te.d, 't1', { resetTurns: false })).toMatchObject({ ok: false, code: 'E_TREE_ENDED' });
    const re = mk([task({ rootId: 'r' }), task({ id: 'r', status: 'cancelled' })]);
    expect(await retryBlocked(re.d, 't1', { resetTurns: false })).toMatchObject({ ok: false, code: 'E_TREE_ENDED' });
    const tu = mk([task({ blockedReason: 'turns', turnsUsed: 10 })], { cap: 10 });
    expect(await retryBlocked(tu.d, 't1', { resetTurns: false })).toMatchObject({ ok: false, code: 'E_TURNS', reason: 'turns' });
    const st = mk([task()], { stale: true });
    expect(await retryBlocked(st.d, 't1', { resetTurns: false })).toMatchObject({ ok: false, code: 'E_STALE' });
    for (const m of [nb, te, re, tu, st]) expect(m.events).toEqual([]);
  });
  it('resetTurns clears the turn count and lets a turns-blocked task through', async () => {
    const m = mk([task({ blockedReason: 'turns', turnsUsed: 10 })], { cap: 10 });
    expect(await retryBlocked(m.d, 't1', { resetTurns: true })).toMatchObject({ ok: true });
    expect(m.updates[0]!.patch).toEqual({ status: 'todo', turnsUsed: 0 });
  });
  it('a NULL reason reads as owner', async () => {
    expect(await retryBlocked(mk([task({ blockedReason: null })]).d, 't1', { resetTurns: false })).toMatchObject({ ok: true, reason: 'owner' });
  });
  it('append and taint go in the same guarded UPDATE; the original part is trimmed from its end so the first line survives', async () => {
    const long = `first line\n${'x'.repeat(DESCRIPTION_MAX)}`;
    const m = mk([task({ description: long })]);
    await retryBlocked(m.d, 't1', { resetTurns: false, append: '\n\n---\nInstruction: do it', taint: true });
    const p = m.updates[0]!.patch as { description: string; tainted: boolean };
    expect(p.description.length).toBe(DESCRIPTION_MAX);
    expect(p.description.startsWith('first line\n')).toBe(true);
    expect(p.description.endsWith('Instruction: do it')).toBe(true);
    expect(p.tainted).toBe(true);
    expect(m.updates[0]!.expected).toBe('blocked');
  });
  it('taint never clears and is not re-written when already set', async () => {
    const m = mk([task({ tainted: true })]);
    await retryBlocked(m.d, 't1', { resetTurns: false, taint: false });
    expect(m.updates[0]!.patch).toEqual({ status: 'todo' });
  });
});

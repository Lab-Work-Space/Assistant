import { describe, expect, it } from 'vitest';
import { smallRig } from '../../knowledge/test-helpers.js';
import { FakeProvider } from '../../providers/index.js';
import { createReflector, REFLECT_NOTES_PER_DEPT_PER_DAY } from './reflect.js';
import { CTO, MemNotes, MemTasks, auditSpy } from '../test-helpers.js';

async function rig(script: { text?: string }[], over: { claimed?: boolean; today?: number } = {}) {
  const p = new FakeProvider(script, 'claude');
  const s = smallRig([p]);
  const notes = new MemNotes();
  const claims = new Set<string>(over.claimed ? ['t1'] : []);
  const spy = auditSpy();
  const state = { claimReflection: async (id: string) => (claims.has(id) ? false : (claims.add(id), true)) };
  const store = { add: notes.add.bind(notes), reflectedToday: async () => over.today ?? notes.rows.filter((n) => n.source === 'reflect').length };
  const reflect = createReflector({ small: s.d, notes: store as never, state, audit: spy.audit });
  const task = await new MemTasks().create({ id: 't1', title: 'Fix login', description: 'DESC-WITH-OTHER-USERS-WORDS', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
  return { reflect, p, notes, s, spy, task: { ...task, status: 'done' as const } };
}
const go = (r: Awaited<ReturnType<typeof rig>>, over: { tainted?: boolean; task?: object } = {}) =>
  r.reflect({ actor: CTO, task: { ...r.task, ...over.task } as never, finalAnswer: 'We fixed the login redirect. FINAL', tainted: over.tainted ?? false });

describe('reflect (flow A, K4, K15)', () => {
  it('writes up to 3 notes of at most 400 chars, source reflect, charged to the task tree budget', async () => {
    const r = await rig([{ text: JSON.stringify(['Login uses OAuth', 'x'.repeat(500), 'Fact three', 'Fact four ignored']) }]);
    expect(await go(r)).toBe(0.001);
    expect(r.notes.rows.map((n) => n.body)).toEqual(['Login uses OAuth', 'Fact three']); // the 500-char one is refused, the fourth is cut
    expect(r.notes.rows.every((n) => n.source === 'reflect' && n.taskId === 't1' && n.deptId === 'software')).toBe(true);
    expect((r.s.log.reqs[0] as { taskId?: string }).taskId).toBe('t1');
    expect(r.spy.entries.some((e) => e.action === 'knowledge.reflect')).toBe(true);
  });

  it('SPEND-1 SP-14: the reflection names itself `reflect` in the spend rollup', async () => {
    const r = await rig([{ text: '["A fact"]' }]);
    await go(r);
    expect((r.s.log.reqs[0] as { attribution?: unknown }).attribution).toMatchObject({ tool: 'reflect' });
  });

  it('inherits the taint of the run (K4) and never lets the model decide it', async () => {
    const clean = await rig([{ text: '["A clean fact"]' }]);
    await go(clean, { tainted: false });
    expect(clean.notes.rows[0]!.tainted).toBe(false);
    const dirty = await rig([{ text: '[{"text":"x","tainted":false}]' }, { text: '["A fact"]' }]);
    await go(dirty, { tainted: true });
    expect(dirty.notes.rows).toEqual([]); // a non-string item is refused as bad output
    const dirty2 = await rig([{ text: '["A fact"]' }]);
    await go(dirty2, { tainted: true });
    expect(dirty2.notes.rows[0]!.tainted).toBe(true);
  });

  it('sees only the title, status, result and final answer, wrapped untrusted, with no tools and a hard output cap', async () => {
    const r = await rig([{ text: '[]' }]);
    await go(r);
    const req = r.p.calls[0]!;
    const sent = JSON.stringify(req.messages);
    expect(sent).toContain('Fix login');
    expect(sent).toContain('FINAL');
    expect(sent).not.toContain('DESC-WITH-OTHER-USERS-WORDS');
    expect(sent).toMatch(/untrusted-[0-9a-f]+/);
    expect(req.tools).toEqual([]);
    expect(req.maxTokens).toBeLessThanOrEqual(300);
    expect(req.model).toBe('claude-sonnet-5-5');
  });

  it('caps the input at ~1,500 tokens', async () => {
    const r = await rig([{ text: '[]' }]);
    await r.reflect({ actor: CTO, task: r.task as never, finalAnswer: 'y'.repeat(50_000), tainted: false });
    expect(JSON.stringify(r.p.calls[0]!.messages).length).toBeLessThan(5_500);
  });

  it('runs once per task, skips a not-done task, a full daily quota and a refused budget, and does not fail the run on garbage', async () => {
    const r = await rig([{ text: '["one fact"]' }, { text: '["another fact"]' }]);
    await go(r);
    expect(await go(r)).toBe(0);
    expect(r.p.calls).toHaveLength(1);
    const notDone = await rig([{ text: '["x"]' }]);
    expect(await go(notDone, { task: { status: 'blocked' } })).toBe(0);
    expect(notDone.p.calls).toHaveLength(0);
    const full = await rig([{ text: '["x"]' }], { today: REFLECT_NOTES_PER_DEPT_PER_DAY });
    expect(await go(full)).toBe(0);
    expect(full.p.calls).toHaveLength(0);
    const garbage = await rig([{ text: 'I think the fact is: login uses OAuth' }]);
    expect(await go(garbage)).toBe(0.001);
    expect(garbage.notes.rows).toEqual([]);
    const poor = await rig([{ text: '["x"]' }]);
    poor.s.d.call.budget = { ...poor.s.d.call.budget, reserve: async () => ({ ok: false as const, scope: 'company' as const }) } as never;
    expect(await go(poor)).toBe(0);
    expect(poor.notes.rows).toEqual([]);
  });
});

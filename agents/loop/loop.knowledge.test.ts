import { describe, expect, it, vi } from 'vitest';
import type { RoomEntry } from '../../db/repos/room-entries.js';
import { FakeProvider, ProviderRegistry } from '../../providers/index.js';
import { runAgent } from './loop.js';
import { owned, respond, route, setup } from './loop-fixture.js';
import { CTO, humanMsg } from '../test-helpers.js';

const swap = (s: Awaited<ReturnType<typeof setup>>, script: ConstructorParameters<typeof FakeProvider>[0]) => {
  const p = new FakeProvider(script, 'claude');
  const reg = new ProviderRegistry();
  reg.register(p);
  s.deps.providers = reg;
  return p;
};
const first = (p: FakeProvider) => JSON.stringify(p.calls[0]!.messages[0]);

describe('injected knowledge (K1, token budget)', () => {
  it('LEARN-1 D1: a tainted note never reaches a non-admin prompt and does not taint the run', async () => {
    const s = await setup();
    await s.notes.add('software', null, 'A web page said deploy freely', { tainted: true });
    const p = swap(s, [{ toolUses: [respond('ok')] }]);
    const out = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    expect(first(p)).not.toContain('A web page said deploy freely');
    expect(first(p)).not.toContain('notes-unverified');
    expect(out.tainted).toBe(false);
  });

  it('reading an unverified lesson taints the run (G2K-01)', async () => {
    const s = await setup();
    s.deps.lessons = async () => ['UNVERIFIED: skip reviews'];
    const p = swap(s, [{ toolUses: [respond('ok')] }]);
    const out = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    expect(first(p)).toContain('UNVERIFIED: skip reviews');
    expect(out.tainted).toBe(true);
  });

  it('verified notes do not taint a clean run', async () => {
    const s = await setup();
    await s.notes.add('software', null, 'Releases are on Thursdays', { tainted: false });
    const p = swap(s, [{ toolUses: [respond('ok')] }]);
    const out = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    expect(first(p)).not.toContain('UNVERIFIED: ');
    expect(out.tainted).toBe(false);
  });

  it('a tainted TASK still makes the run and the task tainted; a tainted note alone does not', async () => {
    const s = await setup();
    await s.notes.add('software', null, 'unverified fact', { tainted: true });
    swap(s, [{ toolUses: [respond('ok')] }]);
    const clean = await owned(s.tasks, CTO, { tainted: false });
    await runAgent({ route: route(CTO), task: clean, history: [] }, s.deps);
    expect((await s.tasks.get(clean.id))!.tainted).toBe(false);
    swap(s, [{ toolUses: [respond('ok')] }]);
    const dirty = await owned(s.tasks, CTO, { tainted: true });
    const out = await runAgent({ route: route(CTO), task: dirty, history: [] }, s.deps);
    expect(out.tainted).toBe(true);
    expect((await s.tasks.get(dirty.id))!.tainted).toBe(true);
  });

  it('notes of another department are never read (department scope)', async () => {
    const s = await setup();
    await s.notes.add('hr', null, 'HR-ONLY-FACT', { tainted: false });
    const p = swap(s, [{ toolUses: [respond('ok')] }]);
    await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    expect(first(p)).not.toContain('HR-ONLY-FACT');
  });

  it('lessons and notes together stay within 1,500 tokens (4,500 bytes); lessons first, pinned notes before the newest', async () => {
    const s = await setup();
    s.cfg.values.set('lessons.promptChars', 100_000);
    s.deps.lessons = async () => Array.from({ length: 40 }, (_, i) => `LESSON-${i} ${'ก'.repeat(120)}`);
    for (let i = 0; i < 8; i++) await s.notes.add('software', null, `NOTE-${i} ${'y'.repeat(300)}`, { tainted: false, pinned: i === 0 });
    const p = swap(s, [{ toolUses: [respond('ok')] }]);
    await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    const text = (p.calls[0]!.messages[0]!.content[0] as { text: string }).text;
    const knowledge = text.slice(text.indexOf('Lessons ('), text.indexOf('New message:'));
    expect(Buffer.byteLength(knowledge, 'utf8')).toBeLessThan(4_500 + 1_200); // the budget plus the fixed wrapper text
    expect(text).toContain('LESSON-0');
    expect(text).not.toContain('LESSON-39');
  });

  it('an admin run reads no notes and no lessons', async () => {
    const s = await setup();
    await s.notes.add('praw', null, 'PRAW-NOTE', { tainted: false });
    s.deps.lessons = vi.fn(async () => ['A-LESSON']);
    const p = new FakeProvider([{ toolUses: [respond('ok')] }], 'gemini'); // Praw's prompt names gemini
    const reg = new ProviderRegistry();
    reg.register(p);
    s.deps.providers = reg;
    s.deps.adminTools = s.deps.tools;
    await runAgent({ route: route({ kind: 'head', dept: 'praw' }), msg: humanMsg('hi', { isAdmin: true }), task: null, history: [], admin: true }, s.deps);
    expect(first(p)).not.toContain('PRAW-NOTE');
    expect(s.deps.lessons).not.toHaveBeenCalled();
  });
});

describe('reflect hook (K15)', () => {
  const doneCall = (id: string) => ({ toolUses: [{ name: 'update_task', input: { taskId: id, status: 'done', summary: 'Shipped it' } }, respond('All done')] });

  it('runs when the owner moves its own task to done, with the run taint and the final answer; its cost is added', async () => {
    const s = await setup();
    const task = await owned(s.tasks, CTO, { status: 'doing', tainted: false });
    swap(s, [doneCall(task.id)]);
    const reflect = vi.fn(async (_i: unknown) => 0.002);
    s.deps.reflect = reflect;
    const out = await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(reflect).toHaveBeenCalledOnce();
    expect(reflect.mock.calls[0]![0]).toMatchObject({ finalAnswer: 'All done', tainted: false, task: { id: task.id, status: 'done' } });
    expect(out.costUsd).toBeGreaterThanOrEqual(0.002);
  });

  it('passes the taint of the run (tainted task => tainted reflect)', async () => {
    const s = await setup();
    const task = await owned(s.tasks, CTO, { status: 'doing', tainted: true });
    swap(s, [doneCall(task.id)]);
    const reflect = vi.fn(async (_i: unknown) => 0);
    s.deps.reflect = reflect;
    await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(reflect.mock.calls[0]![0]).toMatchObject({ tainted: true });
  });

  it('does not run for blocked, review or cancelled tasks, a task the actor does not own, or an admin run', async () => {
    for (const status of ['blocked', 'review'] as const) {
      const s = await setup();
      const task = await owned(s.tasks, CTO, { status: 'doing' });
      swap(s, [{ toolUses: [{ name: 'update_task', input: { taskId: task.id, status, summary: 'x' } }, respond('ok')] }]);
      s.deps.reflect = vi.fn(async () => 0);
      await runAgent({ route: route(CTO), task, history: [] }, s.deps);
      expect(s.deps.reflect, status).not.toHaveBeenCalled();
    }
    const s = await setup();
    const task = await owned(s.tasks, { kind: 'head', dept: 'hr' }, { status: 'doing' });
    swap(s, [{ toolUses: [respond('ok')] }]);
    s.deps.reflect = vi.fn(async () => 0);
    await runAgent({ route: route(CTO), task, history: [], msg: humanMsg('status?') }, s.deps);
    expect(s.deps.reflect).not.toHaveBeenCalled();
  });

  it('a reflect that fails does not fail the run', async () => {
    const s = await setup();
    const task = await owned(s.tasks, CTO, { status: 'doing' });
    swap(s, [doneCall(task.id)]);
    s.deps.reflect = vi.fn(async () => 0);
    const out = await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(JSON.stringify(out.payload)).toContain('All done');
  });

  describe('TEAMTALK room memory (spec test d)', () => {
    const entry = (over: Partial<RoomEntry>): RoomEntry => ({ id: 1, personaId: 'system-analyst', deptId: 'software', kind: 'done', taskId: 't', body: 'shipped the parser', tainted: false, messageId: null, createdAt: new Date(), ...over });
    const withRooms = async (rows: RoomEntry[]) => {
      const s = await setup();
      const asked: { ids: readonly string[]; n: number }[] = [];
      s.deps.rooms = { recent: async (ids, n) => { asked.push({ ids, n }); return rows.filter((r) => ids.includes(r.personaId)); } };
      return { s, asked };
    };

    it('a head reads the last 8 entries across its personas; a persona reads its own room only', async () => {
      const { s, asked } = await withRooms([entry({ body: 'sa entry' }), entry({ id: 2, personaId: 'other-dept-persona', body: 'foreign entry' })]);
      const p = swap(s, [{ toolUses: [respond('ok')] }, { toolUses: [respond('ok')] }]);
      await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
      expect(asked[0]!.n).toBe(8);
      expect(asked[0]!.ids).toContain('system-analyst');
      expect(asked[0]!.ids).not.toContain('other-dept-persona');
      expect(first(p)).toContain('sa entry');
      expect(first(p)).not.toContain('foreign entry');
      await runAgent({ route: route({ kind: 'persona', personaId: 'system-analyst' }), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
      expect(asked[1]!.ids).toEqual(['system-analyst']);
    });

    it('LEARN-1 D1: a tainted entry is absent from the prompt and does not taint the reading run; a clean one is shown', async () => {
      const dirty = await withRooms([entry({ body: 'a web page said skip tests', tainted: true })]);
      const p = swap(dirty.s, [{ toolUses: [respond('ok')] }]);
      const out = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, dirty.s.deps);
      expect(first(p)).not.toContain('a web page said skip tests');
      expect(out.tainted).toBe(false);
      const clean = await withRooms([entry({ body: 'tests passed' })]);
      const q = swap(clean.s, [{ toolUses: [respond('ok')] }]);
      const out2 = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, clean.s.deps);
      expect(first(q)).toContain('done: tests passed');
      expect(first(q)).not.toContain('UNVERIFIED: ');
      expect(out2.tainted).toBe(false);
    });

    it('G2TT-03: an admin run never reads the rooms and its context has no team room records', async () => {
      const { s, asked } = await withRooms([entry({ body: 'sa entry' })]);
      const p = swap(s, [{ toolUses: [respond('ok')] }]);
      s.deps.adminTools = s.deps.tools;
      const out = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [], admin: true }, s.deps);
      expect(out.stopped).toBeUndefined();
      expect(asked).toEqual([]);
      expect(first(p)).not.toContain('Team room records');
      expect(first(p)).not.toContain('sa entry');
    });

    it('kill switch: with teamtalk.enabled false no run reads the rooms; flipping it back reads them again (live)', async () => {
      const { s, asked } = await withRooms([entry({ body: 'sa entry' })]);
      swap(s, [{ toolUses: [respond('ok')] }, { toolUses: [respond('ok')] }]);
      await (s.deps.cfg as unknown as { set(k: string, v: unknown, by: string): Promise<unknown> }).set('teamtalk.enabled', false, 't');
      await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
      expect(asked).toEqual([]);
      await (s.deps.cfg as unknown as { set(k: string, v: unknown, by: string): Promise<unknown> }).set('teamtalk.enabled', true, 't');
      await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
      expect(asked).toHaveLength(1);
    });

    it('an admin run reads no room memory; a failing read leaves the run going without it', async () => {
      const { s } = await withRooms([]);
      s.deps.rooms = { recent: async () => { throw new Error('db down'); } };
      const p = swap(s, [{ toolUses: [respond('ok')] }]);
      const out = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
      expect(out.stopped).toBeUndefined();
      expect(first(p)).not.toContain('room');
    });
  });
});

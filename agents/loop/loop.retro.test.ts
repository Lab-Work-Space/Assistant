import { describe, expect, it } from 'vitest';
import type { RoomEntry } from '../../db/repos/room-entries.js';
import { FakeProvider, ProviderRegistry, type FakeTurn } from '../../providers/index.js';
import { CTO, humanMsg } from '../test-helpers.js';
import { runAgent, RETRO_TOOLS, type AgentTrigger } from './loop.js';
import { respond, route, setup } from './loop-fixture.js';

const entry = (over: Partial<RoomEntry>): RoomEntry => ({ id: 1, personaId: 'system-analyst', deptId: 'software', kind: 'done', taskId: 't', body: 'x', tainted: false, messageId: null, createdAt: new Date(0), ...over });

/** One head run over seeded context. `script` is the model's turns. */
async function go(script: FakeTurn[], trigger: Partial<AgentTrigger>) {
  const s = await setup();
  await s.notes.add('software', null, 'CLEAN-NOTE', { tainted: false });
  await s.notes.add('software', null, 'TAINTED-NOTE', { tainted: true });
  s.deps.lessons = async () => ['CLEAN-LESSON', 'UNVERIFIED: PLANTED-LESSON'];
  s.deps.rooms = { recent: async () => [entry({ id: 1, body: 'CLEAN-ROOM' }), entry({ id: 2, body: 'TAINTED-ROOM', tainted: true })] };
  const p = new FakeProvider(script, 'claude');
  const reg = new ProviderRegistry();
  reg.register(p);
  s.deps.providers = reg;
  const task = await s.tasks.create({ title: 'Weekly retro 2026-W45', description: 'x', deptId: 'software', owner: CTO, requester: CTO, origin: 'delegated', tainted: false, status: 'doing' });
  const before = (await s.tasks.listByStatus('todo')).length + (await s.tasks.listByStatus('doing')).length;
  const out = await runAgent({ route: { actor: CTO, reason: 'task_owner', taskId: task.id }, msg: humanMsg('facts', { author: { id: 'system:retro', name: 'retro', kind: 'head' }, origin: 'chat' }), task, history: [], ...trigger } as AgentTrigger, s.deps);
  const after = (await s.tasks.listByStatus('todo')).length + (await s.tasks.listByStatus('doing')).length;
  return { s, p, out, created: after - before };
}
const first = (p: FakeProvider) => JSON.stringify(p.calls[0]!.messages);

describe('GROW-1 retro run in the loop (GW-C1, GW-C3)', () => {
  it('GW-C3: a tainted note, an UNVERIFIED lesson and a tainted room entry are absent from the prompt, the clean ones stay, and the run is untainted', async () => {
    const r = await go([{ toolUses: [respond('summary')] }], { retro: true });
    const t = first(r.p);
    for (const gone of ['TAINTED-NOTE', 'PLANTED-LESSON', 'TAINTED-ROOM']) expect(t, gone).not.toContain(gone);
    for (const kept of ['CLEAN-NOTE', 'CLEAN-LESSON', 'CLEAN-ROOM']) expect(t, kept).toContain(kept);
    expect(r.out.tainted).toBe(false);
  });
  it('control (LEARN-1 D1): without trigger.retro the tainted note and room entry are absent too; only the UNVERIFIED lesson (retro-only filter) is still in the prompt and taints the run', async () => {
    const r = await go([{ toolUses: [respond('summary')] }], {});
    const t = first(r.p);
    for (const gone of ['TAINTED-NOTE', 'TAINTED-ROOM']) expect(t, gone).not.toContain(gone);
    expect(t).toContain('PLANTED-LESSON');
    expect(r.out.tainted).toBe(true);
  });
  it('GW-C1: only RETRO_TOOLS are offered', async () => {
    const r = await go([{ toolUses: [respond('summary')] }], { retro: true });
    const names = (r.p.calls[0]!.tools ?? []).map((t) => t.name);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(RETRO_TOOLS, n).toContain(n);
    expect(names).not.toContain('create_task');
    expect(names).not.toContain('forward_to');
    expect(names).not.toContain('warroom_say');
  });
  it('GW-C1: create_task, forward_to and warroom_say called BY NAME are refused at dispatch and no task is created', async () => {
    const r = await go([
      { toolUses: [{ name: 'create_task', input: { title: 'sneaky', description: 'sneaky task body', deptId: 'software' } }, { name: 'forward_to', input: { to: 'hq', text: 'x' } }, { name: 'warroom_say', input: { text: 'x' } }] },
      { toolUses: [respond('done')] },
    ], { retro: true });
    const results = JSON.stringify(r.p.calls[1]!.messages);
    expect(results.match(/is not allowed for you/g)?.length).toBe(3);
    expect(r.s.spy.entries.filter((e) => e.action === 'tool' && e.outcome === 'denied').map((e) => e.tool).sort()).toEqual(['create_task', 'forward_to', 'warroom_say']);
    expect(r.created).toBe(0);
  });
  it('control: the same create_task in a plain run is dispatched (the refusal is the retro filter, not a missing tool)', async () => {
    const r = await go([
      { toolUses: [{ name: 'create_task', input: { title: 'real task', description: 'a real task body here', deptId: 'software' } }] },
      { toolUses: [respond('done')] },
    ], {});
    expect(JSON.stringify(r.p.calls[1]!.messages)).not.toContain('is not allowed for you');
  });
  it('GW-C1: the warroom_say filter now also holds at dispatch for a non-retro run with noWarroomSay', async () => {
    const r = await go([{ toolUses: [{ name: 'warroom_say', input: { text: 'x' } }] }, { toolUses: [respond('done')] }], { noWarroomSay: true });
    expect(JSON.stringify(r.p.calls[1]!.messages)).toContain('is not allowed for you');
  });
});

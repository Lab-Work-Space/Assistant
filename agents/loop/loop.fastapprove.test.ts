import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolPlugin } from '../../tools/types.js';
import { FakeProvider, ProviderRegistry, type FakeTurn } from '../../providers/index.js';
import { CTO, prompts } from '../test-helpers.js';
import { runAgent } from './loop.js';
import { owned, route, setup } from './loop-fixture.js';

/** AA-C15 (C9): the AI approver can decide a filed approval before the loop re-reads the task; the turn then ends instead of the run going on. */
const write: ToolPlugin<unknown> = {
  name: 'add_reminder', description: 'w', inputSchema: z.object({}).loose(), kind: 'write', requiresApproval: () => false,
  run: async () => ({ content: 'ran' }),
};

async function rig(landed: 'awaiting_approval' | 'todo' | null) {
  const copy = new Map(prompts);
  const d = copy.get('heads/software')!;
  copy.set('heads/software', { ...d, meta: { ...d.meta, tools: [...d.meta.tools, write.name] } });
  const s = await setup({ prompts: copy });
  s.deps.tools.register(write);
  const task = await owned(s.tasks, CTO);
  s.approvals.request.mockImplementation(async () => {
    if (landed) await s.tasks.update(task.id, { status: landed });
    return { id: 7 } as never;
  });
  return { s, task };
}
const script = (s: { deps: { providers: unknown } }, turns: FakeTurn[]) => {
  const reg = new ProviderRegistry();
  const p = new FakeProvider(turns, 'claude');
  reg.register(p);
  (s.deps as { providers: unknown }).providers = reg;
  return p;
};
const turns: FakeTurn[] = [{ toolUses: [{ name: 'add_reminder', input: {} }] }, { toolUses: [{ name: 'respond', input: { type: 'report', body: 'FINAL REPORT that would end the task' } }] }];

describe('loop: a filed approval that is already approved ends the turn', () => {
  it('task row todo after the tool batch: no second model call, no final report, fixed text and the footer', async () => {
    const { s, task } = await rig('todo');
    const p = script(s, turns);
    const out = await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(p.calls).toHaveLength(1);
    expect(out.payload.body).not.toContain('FINAL REPORT');
    expect(out.payload.body).toContain('⏳ รออนุมัติ: add_reminder (การ์ด #7)');
  });
  it('task row awaiting_approval (a card is waiting): ends as before', async () => {
    const { s, task } = await rig('awaiting_approval');
    const p = script(s, turns);
    await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(p.calls).toHaveLength(1);
  });
  it('an approval that landed nowhere (the row untouched) lets the run go on to its answer, as before (F1)', async () => {
    const { s, task } = await rig(null);
    const p = script(s, turns);
    const out = await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(p.calls).toHaveLength(2);
    expect(out.payload.body).toContain('FINAL REPORT');
  });
});

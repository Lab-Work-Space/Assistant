import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolPlugin } from '../tools/types.js';
import { awaitingFooter, awaitingText } from '../tools/registry.js';
import { runAgent } from './loop/loop.js';
import { FakeProvider, ProviderRegistry, type FakeTurn } from '../providers/index.js';
import { owned, route, setup } from './loop/loop-fixture.js';
import { CTO, prompts } from './test-helpers.js';

const write: ToolPlugin<unknown> = {
  name: 'add_reminder', description: 'w', inputSchema: z.object({}).loose(), kind: 'write', requiresApproval: () => false,
  run: async () => ({ content: 'ran' }),
};

async function rig() {
  const copy = new Map(prompts);
  const d = copy.get('heads/software')!;
  copy.set('heads/software', { ...d, meta: { ...d.meta, tools: [...d.meta.tools, write.name] } });
  const s = await setup({ prompts: copy });
  s.deps.tools.register(write);
  // the card is stored but the task row is left as it is, so the run goes on to a final answer
  s.approvals.request.mockImplementation(async () => ({ id: 7 }) as never);
  return s;
}
const script = (s: { deps: { providers: unknown } }, turns: FakeTurn[]) => {
  const reg = new ProviderRegistry();
  const p = new FakeProvider(turns, 'claude');
  reg.register(p);
  (s.deps as { providers: unknown }).providers = reg;
  return p;
};

describe('F1 awaiting approval is never reported as done', () => {
  it('the tool result is the fixed text with the card number', async () => {
    const s = await rig();
    const task = await owned(s.tasks, CTO);
    const p = script(s, [{ toolUses: [{ name: 'add_reminder', input: {} }] }, { toolUses: [{ name: 'respond', input: { type: 'chat', body: 'I set the reminder' } }] }]);
    await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    const result = p.calls[1]!.messages.at(-1)!.content[0]!;
    expect(result).toMatchObject({ type: 'tool_result', content: awaitingText(7, null) });
    expect((result as { content: string }).content).toBe('NOT DONE YET: waiting for approval of card #7 in the approvals channel. Tell the user it is waiting for approval; do not say it is done.');
  });

  it('the card channel is named from the code-chosen id only', async () => {
    const s = await rig();
    s.deps.approvalChannel = async () => '1565667791938387969';
    const task = await owned(s.tasks, CTO);
    const p = script(s, [{ toolUses: [{ name: 'add_reminder', input: {} }] }, { toolUses: [{ name: 'respond', input: { type: 'chat', body: 'x' } }] }]);
    await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect((p.calls[1]!.messages.at(-1)!.content[0] as { content: string }).content).toContain('card #7 in <#1565667791938387969>.');
    s.deps.approvalChannel = async () => '<#1> @everyone';
    const p2 = script(s, [{ toolUses: [{ name: 'add_reminder', input: {} }] }, { toolUses: [{ name: 'respond', input: { type: 'chat', body: 'x' } }] }]);
    await runAgent({ route: route(CTO), task: await owned(s.tasks, CTO), history: [] }, s.deps);
    expect((p2.calls[1]!.messages.at(-1)!.content[0] as { content: string }).content).toContain('in the approvals channel.');
  });

  it('the footer is added by code even when the model says it is done', async () => {
    const s = await rig();
    const task = await owned(s.tasks, CTO);
    script(s, [{ toolUses: [{ name: 'add_reminder', input: {} }] }, { toolUses: [{ name: 'respond', input: { type: 'chat', body: 'I set the reminder' } }] }]);
    const out = await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(out.payload.body).toBe(`I set the reminder\n\n${awaitingFooter({ tool: 'add_reminder', card: 7 })}`);
    expect(out.payload.body).toContain('⏳ รออนุมัติ: add_reminder (การ์ด #7)');
  });

  it('the footer is added to a plain text answer too', async () => {
    const s = await rig();
    const task = await owned(s.tasks, CTO);
    script(s, [{ toolUses: [{ name: 'add_reminder', input: {} }] }, { text: 'set!' }]);
    const out = await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(out.payload.body).toContain('set!');
    expect(out.payload.body).toMatch(/⏳ รออนุมัติ: add_reminder \(การ์ด #7\)$/);
  });

  it('no footer when no write is pending', async () => {
    const s = await rig();
    const task = await owned(s.tasks, CTO);
    script(s, [{ toolUses: [{ name: 'respond', input: { type: 'chat', body: 'plain answer' } }] }]);
    const out = await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(out.payload.body).toBe('plain answer');
  });

  it('a silent NO_REPLY stays silent; the footer name comes from code and is sanitised', async () => {
    const s = await rig();
    script(s, [{ toolUses: [{ name: 'add_reminder', input: {} }] }, { toolUses: [{ name: 'respond', input: { type: 'chat', body: 'NO_REPLY' } }] }]);
    const out = await runAgent({ route: route(CTO), task: await owned(s.tasks, CTO), history: [] }, s.deps);
    expect(out.payload.body).toBe('NO_REPLY');
    expect(awaitingFooter({ tool: 'a b<@1>', card: null })).toBe('⏳ รออนุมัติ: ab1');
  });
});

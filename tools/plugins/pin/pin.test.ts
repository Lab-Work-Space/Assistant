import { describe, expect, it, vi } from 'vitest';
import { approvedToolContext, type AgentDeps } from '../../../agents/loop/loop.js';
import type { Task } from '../../../db/repos/tasks.js';
import { FakeConfig } from '../../../governance/test-helpers.js';
import { toGeminiSchema } from '../../../providers/gemini/convert.js';
import { FakeDiscordPort } from '../../../tests/fakes/discordPort.js';
import type { ToolSource } from '../../types.js';
import type { PluginDeps } from '../deps.js';
import { webRig } from '../web/test-helpers.js';
import { pinGroup } from './index.js';

const PRAW = { kind: 'head', dept: 'praw' } as const;
const DENIED = '1565715069969502310';
const M1 = '1570000000000000001';
const M2 = '1570000000000000002';
const M3 = '1570000000000000003';
const src = (o: Partial<ToolSource> = {}): ToolSource => ({ channelId: '1569000000000000001', threadId: null, messageId: M1, userId: 'u1', attachments: [], ...o });

function setup() {
  const port = new FakeDiscordPort();
  port.messages.set(M1, '1569000000000000001');
  port.messages.set(M2, '1569000000000000002'); // another channel
  port.messages.set(M3, '1569000000000000009'); // a thread under the first channel
  const deps = { env: {}, cfg: new FakeConfig(), log: { warn: vi.fn() }, clock: () => 0, port } as unknown as PluginDeps;
  const g = pinGroup(deps);
  if ('disabled' in g) throw new Error(g.disabled);
  return { g, port, rig: (c = {}) => webRig(g.tools, { actor: PRAW, direct: true, origin: 'chat', source: src(), ...c }) };
}

describe('pin_message', () => {
  it('is a write tool whose input carries no channel', () => {
    const { g } = setup();
    expect(g.tools.map((t) => [t.name, t.kind])).toEqual([['pin_message', 'write']]);
    const shape = g.tools[0]!.inputSchema as unknown as { shape: Record<string, unknown> };
    expect(Object.keys(shape.shape)).toEqual(['messageId', 'where']); // where: a precheck pin (P3), never a free channel choice
    expect(() => toGeminiSchema(g.tools[0]!.inputSchema as never)).not.toThrow();
  });

  it('pin › pins in the origin channel only; message from another channel refused; denied channel refused', async () => {
    const t = setup();
    const { reg, c } = await t.rig();
    // default: the trigger message, in the trigger channel
    expect((await reg.run('pin_message', {}, c)).isError).toBeFalsy();
    expect(t.port.pins).toEqual([{ actor: PRAW, channelId: '1569000000000000001', messageId: M1 }]);
    // a model-chosen id from another channel is never found in the origin channel
    const other = await reg.run('pin_message', { messageId: M2 }, c);
    expect(other.isError).toBe(true);
    expect(other.content).toMatch(/not found in this channel/i);
    // a channel id in the input is ignored (zod strips it): the pin still targets the origin channel
    await reg.run('pin_message', { messageId: M2, channelId: '1569000000000000002' }, c);
    expect(t.port.pins).toHaveLength(1);
    // in a thread the pin goes to the thread
    const th = await t.rig({ source: src({ threadId: '1569000000000000009', messageId: M3 }) });
    expect((await th.reg.run('pin_message', {}, th.c)).isError).toBeFalsy();
    expect(t.port.pins.at(-1)).toMatchObject({ channelId: '1569000000000000009', messageId: M3 });
    // denied channel (and a thread under it)
    for (const s of [src({ channelId: DENIED }), src({ channelId: DENIED, threadId: '1569000000000000009' })]) {
      const d = await t.rig({ source: s });
      const r = await d.reg.run('pin_message', { messageId: M1 }, d.c);
      expect(r.isError).toBe(true);
      expect(r.content).toMatch(/off-limits/i);
    }
    expect(t.port.pins).toHaveLength(2);
  });

  it('pin › missing permission → clear tool error', async () => {
    const t = setup();
    t.port.pinDenied.add('1569000000000000001');
    const { reg, c } = await t.rig();
    const r = await reg.run('pin_message', {}, c);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Pin Messages/);
    expect(r.content).toMatch(/channel overwrite/i);
  });

  it('no trigger message and no id → clear error; tainted run needs approval', async () => {
    const t = setup();
    const none = await t.rig({ source: src({ messageId: null }) });
    expect((await none.reg.run('pin_message', {}, none.c)).content).toMatch(/messageId/);
    const tainted = await t.rig({ tainted: () => true });
    expect((await tainted.reg.run('pin_message', {}, tainted.c)).content).toMatch(/^NOT DONE YET: waiting for approval of/);
    expect(t.port.pins).toHaveLength(0);
  });

  it('I4: the precheck pins messageId and channel; the approved replay (real approvedToolContext, no trigger) pins exactly that', async () => {
    const t = setup();
    const CH = '1569000000000000001';
    const TH = '1569000000000000777'; // the conversation thread created for the approval
    const tainted = await t.rig({ tainted: () => true, source: src({ messageId: M1 }) });
    expect((await tainted.reg.run('pin_message', {}, tainted.c)).content).toMatch(/^NOT DONE YET: waiting for approval of/);
    const stored = (tainted.approvals.request.mock.calls as unknown as [{ tool: { input: unknown }; reason: string }][])[0]![0];
    expect(stored.tool.input).toEqual({ messageId: M1, where: CH });
    expect(stored.reason).toContain(M1);
    expect(t.port.pins).toHaveLength(0);
    // replay: the context is built like the scheduler's, from the task row (channel + thread, no message id)
    const replay = (task: Partial<Task>) => approvedToolContext(PRAW, { ...(tainted.c.task as Task), owner: PRAW, origin: 'chat', channelId: CH, threadId: TH, ...task }, {
      org: tainted.c.org, tasks: tainted.c.tasks, approvals: tainted.c.approvals, limits: tainted.c.limits, notes: tainted.c.notes, bus: tainted.c.bus, audit: tainted.c.audit,
    } as unknown as AgentDeps);
    const rc = replay({});
    expect(rc.source).toMatchObject({ channelId: CH, threadId: TH, messageId: null });
    const ok = await tainted.reg.runApproved('pin_message', stored.tool.input, rc);
    expect(ok.isError).toBeFalsy();
    expect(t.port.pins).toEqual([{ actor: PRAW, channelId: CH, messageId: M1 }]);
    // a stored channel that is not this task's conversation is refused; so is a task whose channel became denied
    const moved = await tainted.reg.runApproved('pin_message', stored.tool.input, replay({ channelId: '1569000000000000002', threadId: '1569000000000000888' }));
    expect(moved.isError).toBe(true);
    expect(moved.content).toMatch(/nothing was pinned/);
    const denied = await tainted.reg.runApproved('pin_message', { messageId: M1, where: DENIED }, replay({ channelId: DENIED, threadId: null }));
    expect(denied.content).toMatch(/off-limits/);
    // a live run cannot aim the pin elsewhere through the pin field
    const live = await t.rig();
    const aimed = await live.reg.run('pin_message', { messageId: M2, where: '1569000000000000002' }, live.c);
    expect(aimed.content).toMatch(/nothing was pinned/);
    expect(t.port.pins).toHaveLength(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { ActorRef } from '../company/types.js';
import { Limits } from '../governance/limits.js';
import type { Task } from '../db/repos/tasks.js';
import { FakeConfig } from '../governance/test-helpers.js';
import { FakeProvider, ProviderRegistry, type FakeTurn } from '../providers/index.js';
import { FakeDiscordPort } from '../tests/fakes/discordPort.js';
import { isDirectHumanRun } from '../tools/direct.js';
import type { ToolContext, ToolPlugin } from '../tools/types.js';
import { z } from 'zod';
import { createConversation, isTopLevelConversation } from './conversation.js';
import { owned, route, setup } from './loop/loop-fixture.js';
import { runAgent, type AgentDeps, type AgentOutcome, type AgentTrigger } from './loop/loop.js';
import { Scheduler } from './scheduler/scheduler.js';
import { CTO, MemTasks, humanMsg, newBus, noApprovedTools, prompts, quiet, seededOrg } from './test-helpers.js';

const PRAW: ActorRef = { kind: 'head', dept: 'praw' };
const CHAN = '1565682159375749161';
const mk = (marketing: object = { assignee: { kind: 'head', dept: 'marketing' } }) =>
  ({ name: 'create_task', input: { title: 'Plan the launch', description: 'Draft a plan', estCostUsd: 0.1, ...marketing } });
const done: FakeTurn = { toolUses: [{ name: 'respond', input: { type: 'chat', body: 'ok' } }] };

async function rig(actor: ActorRef = PRAW, extra: ToolPlugin<unknown>[] = []) {
  const ref = `heads/${(actor as { dept: string }).dept}`;
  const copy = new Map(prompts);
  const d = copy.get(ref)!;
  copy.set(ref, { ...d, meta: { ...d.meta, tools: [...new Set([...d.meta.tools, 'create_task', 'respond', 'update_task', ...extra.map((t) => t.name)])] } });
  const s = await setup({ prompts: copy });
  for (const t of extra) s.deps.tools.register(t);
  const port = new FakeDiscordPort();
  const userSlot = vi.fn(() => true);
  const conv = createConversation({ tasks: s.tasks, port, limits: s.deps.limits, bus: s.bus, userSlot });
  const open = vi.spyOn(conv, 'open');
  s.deps.conversation = conv;
  s.deps.canMemberView = async () => true;
  return { ...s, port, conv, open, userSlot };
}
function script(s: { deps: AgentDeps }, turns: FakeTurn[], gemini = true) {
  const reg = new ProviderRegistry();
  reg.register(new FakeProvider(turns, gemini ? 'gemini' : 'claude'));
  s.deps.providers = reg;
}
const run = (s: { deps: AgentDeps }, msg = humanMsg('ฝากทีม Marketing วางแผนเปิดตัว'), actor: ActorRef = PRAW) =>
  runAgent({ route: route(actor), msg, task: null, history: [] }, s.deps);

describe('conversation', () => {
  it('plain chat with no create_task creates no task', async () => {
    const s = await rig();
    script(s, [done]);
    await run(s);
    expect(s.open).not.toHaveBeenCalled();
    expect(s.tasks.rows.size).toBe(0);
    expect(s.port.threads).toHaveLength(0);
  });

  it('create_task from human chat opens exactly one conversation task and parents the child to it', async () => {
    const s = await rig();
    script(s, [{ toolUses: [mk()] }, done]);
    await run(s, humanMsg('ฝากทีม Marketing วางแผนเปิดตัว\nรายละเอียด', { channelId: CHAN }));
    const rows = [...s.tasks.rows.values()];
    expect(rows).toHaveLength(2);
    const conv = rows.find((t) => t.depth === 0)!;
    const child = rows.find((t) => t.depth === 1)!;
    expect(conv).toMatchObject({
      deptId: 'praw', owner: PRAW, requester: { kind: 'human', userId: '42' }, status: 'doing', origin: 'chat',
      channelId: CHAN, threadId: CHAN, originMessageId: expect.any(String), title: 'ฝากทีม Marketing วางแผนเปิดตัว', sourceUserId: '42',
    });
    expect(conv.description).toContain('รายละเอียด');
    expect(s.port.threads).toEqual([]); // F5: a top-level typed message makes no thread
    expect(child).toMatchObject({ parentId: conv.id, rootId: conv.id, owner: { kind: 'head', dept: 'marketing' }, requester: PRAW, origin: 'delegated' });
  });

  it('F5: a top-level typed message to Praw opens no thread (thread id = channel id) and the answer replies to the message; slash keeps its thread', async () => {
    const s = await rig();
    const m = humanMsg('please do it', { channelId: CHAN });
    script(s, [{ toolUses: [mk()] }, done]);
    await run(s, m);
    const conv = [...s.tasks.rows.values()].find((t) => t.depth === 0)!;
    expect(s.port.threads).toEqual([]);
    expect(conv).toMatchObject({ threadId: CHAN, channelId: CHAN, originMessageId: m.id });
    expect(isTopLevelConversation(conv)).toBe(true);
    const slash = await rig();
    script(slash, [{ toolUses: [mk()] }, done]);
    await run(slash, humanMsg('x', { origin: 'slash' }));
    expect(slash.port.threads).toHaveLength(1);
    expect([...slash.tasks.rows.values()].find((t) => t.depth === 0)!.threadId).toBe('thread-1');
  });

  it('WS6: the conversation task records the origin category read from Discord by code, and the child inherits it', async () => {
    const s = await rig();
    s.port.categories.set(CHAN, '1570000000000000100');
    script(s, [{ toolUses: [mk()] }, done]);
    await run(s, humanMsg('plan it', { channelId: CHAN }));
    const rows = [...s.tasks.rows.values()];
    expect(rows.find((t) => t.depth === 0)!.originCategoryId).toBe('1570000000000000100');
    expect(rows.find((t) => t.depth === 1)!.originCategoryId).toBe('1570000000000000100');
  });

  it('a message already in a thread uses that thread and its parent channel', async () => {
    const s = await rig();
    script(s, [{ toolUses: [mk()] }, done]);
    await run(s, humanMsg('hello', { channelId: 'th-9', threadId: 'th-9', parentChannelId: CHAN }));
    const conv = [...s.tasks.rows.values()].find((t) => t.depth === 0)!;
    expect(conv).toMatchObject({ threadId: 'th-9', channelId: CHAN });
    expect(s.port.threads).toHaveLength(0);
  });

  it('second create_task in the same run reuses it', async () => {
    const s = await rig();
    script(s, [{ toolUses: [mk(), mk()] }, done]);
    await run(s);
    const rows = [...s.tasks.rows.values()];
    expect(rows.filter((t) => t.depth === 0)).toHaveLength(1);
    expect(rows.filter((t) => t.depth === 1)).toHaveLength(2);
    expect(s.open).toHaveBeenCalledTimes(1);
    expect(s.port.threads).toHaveLength(0);
  });

  it('bot-originated or non-praw runs never open one', async () => {
    const bot = await rig();
    script(bot, [{ toolUses: [mk()] }, done]);
    const msg = humanMsg('report', { author: { id: 'b', name: 'sa', kind: 'persona', actor: { kind: 'persona', personaId: 'system-analyst' } } });
    await run(bot, msg);
    // WS13: a non-Praw head opens one only for a person's message that routed by mention / dept_channel / goal_channel; a warroom or task_owner route never does.
    const cto = await rig(CTO);
    script(cto, [{ toolUses: [mk({ assignee: { kind: 'head', dept: 'hq' } })] }, done], false);
    await runAgent({ route: { actor: CTO, reason: 'warroom' }, msg: humanMsg('hi'), task: null, history: [] }, cto.deps);
    for (const s of [bot, cto]) expect(s.open).not.toHaveBeenCalled();
    for (const s of [bot, cto]) expect([...s.tasks.rows.values()].filter((t) => t.deptId === 'praw')).toHaveLength(0);
  });

  it('a run that already has a task never opens one', async () => {
    const s = await rig();
    script(s, [{ toolUses: [mk()] }, done]);
    const task = await owned(s.tasks, PRAW, { origin: 'chat' });
    await runAgent({ route: route(PRAW), msg: humanMsg('go'), task, history: [] }, s.deps);
    expect(s.open).not.toHaveBeenCalled();
    expect([...s.tasks.rows.values()].find((t) => t.depth === 1)?.parentId).toBe(task.id);
  });

  it('the conversation task counts against the D2 open-task cap and the per-user counter', async () => {
    const s = await rig();
    const msg = humanMsg('hi');
    s.cfg.values.set('limits.openTasks', 0);
    await expect(s.conv.open({ actor: PRAW, msg })).rejects.toThrow(/too many open tasks/);
    expect(s.tasks.rows.size).toBe(0);
    expect(s.port.threads).toHaveLength(0);

    const s2 = await rig();
    s2.userSlot.mockReturnValue(false);
    await expect(s2.conv.open({ actor: PRAW, msg })).rejects.toThrow(/too many/);
    expect(s2.userSlot).toHaveBeenCalledWith('42');
    expect(s2.tasks.rows.size).toBe(0);

    // through create_task: refused cleanly, no child
    const s3 = await rig();
    s3.userSlot.mockReturnValue(false);
    script(s3, [{ toolUses: [mk()] }, done]);
    await run(s3);
    expect(s3.tasks.rows.size).toBe(0);
  });

  it("its origin is the trigger's origin and a voice conversation is never direct", async () => {
    const seen: ToolContext[] = [];
    const probe: ToolPlugin<unknown> = { name: 'probe', description: 'p', inputSchema: z.object({}).loose(), requiresApproval: () => false, run: async (_i, c) => (seen.push(c), { content: 'ok' }) };
    for (const origin of ['chat', 'slash', 'voice'] as const) {
      const s = await rig(PRAW, [probe]);
      script(s, [{ toolUses: [mk(), { name: 'probe', input: {} }] }, done]);
      await run(s, humanMsg('x', { origin }));
      const conv = [...s.tasks.rows.values()].find((t) => t.depth === 0)!;
      expect(conv.origin).toBe(origin);
      const trigger = { kind: 'human_message' as const, userId: '42', origin };
      expect(isDirectHumanRun({ origin, actor: PRAW, task: conv, trigger })).toBe(origin !== 'voice');
      expect(seen.at(-1)!.direct).toBe(origin !== 'voice');
    }
  });
});

describe('Scheduler conversation close (PF6)', () => {
  const chat = (): AgentOutcome => ({ payload: { type: 'chat', body: 'ok' }, costUsd: 0, turns: 1 });
  const praw = humanMsg('<@1> hi', { id: '1570000000000000555', mentionedHeads: ['praw'] });

  type Sched = { scheduler: Scheduler; tasks: MemTasks; port: FakeDiscordPort; bus: ReturnType<typeof newBus>; calls: AgentTrigger[] };
  async function sched(runFn: (t: AgentTrigger, d: AgentDeps, ctx: Sched) => Promise<AgentOutcome>, isHalted: () => boolean = () => false): Promise<Sched> {
    const cfg = new FakeConfig();
    const s = await setup();
    const tasks = Object.assign(s.tasks, { findByThread: async () => null });
    const port = new FakeDiscordPort();
    const bus = newBus();
    const limits = new Limits(cfg, tasks);
    const conversation = createConversation({ tasks, port, limits, bus });
    const calls: AgentTrigger[] = [];
    const self = {} as Sched;
    const scheduler = new Scheduler({
      agent: {} as AgentDeps, run: async (t, d) => (calls.push(t), runFn(t, d, self)), port, org: await seededOrg(), tasks, limits,
      halt: { isHalted }, cfg, bus, log: quiet, conversation, approvedTools: noApprovedTools,
    });
    scheduler.attach();
    Object.assign(self, { scheduler, tasks, port, bus, calls });
    return self;
  }
  const root = (t: { rows: Map<string, Task> }) => [...t.rows.values()].find((x) => x.depth === 0)!;
  const child = (tasks: MemTasks, parentId: string) =>
    tasks.create({ title: 'c', deptId: 'marketing', owner: { kind: 'head', dept: 'marketing' }, requester: PRAW, origin: 'delegated', parentId });

  it('after the run the task is review while a child is open, done when none', async () => {
    const withChild = await sched(async (_t, d, c) => {
      const conv = await d.conversation!.open({ actor: PRAW, msg: praw });
      await child(c.tasks, conv.id);
      return chat();
    });
    await withChild.scheduler.onMessage(praw);
    await withChild.scheduler.idle();
    expect(root(withChild.tasks).status).toBe('review');

    const none = await sched(async (_t, d) => (await d.conversation!.open({ actor: PRAW, msg: praw }), chat()));
    await none.scheduler.onMessage(praw);
    await none.scheduler.idle();
    expect(root(none.tasks).status).toBe('done');
  });

  it('does not touch a conversation task that is awaiting_approval, blocked or cancelled', async () => {
    for (const status of ['awaiting_approval', 'blocked', 'cancelled'] as const) {
      const c = await sched(async (_t, d, x) => {
        const conv = await d.conversation!.open({ actor: PRAW, msg: praw });
        await x.tasks.update(conv.id, { status });
        return chat();
      });
      await c.scheduler.onMessage(praw);
      await c.scheduler.idle();
      expect(root(c.tasks).status).toBe(status);
    }
  });

  it('a child that finishes before the run ends still gets its roll-up run, and the roll-up closes the task', async () => {
    const statusDuringRollup: string[] = [];
    const c = await sched(async (t, d, x) => {
      if (t.task) {
        statusDuringRollup.push((await x.tasks.get(t.task.id))!.status);
        return chat();
      }
      const conv = await d.conversation!.open({ actor: PRAW, msg: praw });
      const ch = await child(x.tasks, conv.id);
      const finished = (await x.tasks.update(ch.id, { status: 'done' }))!;
      await x.bus.emit('task.changed', { task: finished, from: 'todo', to: 'done', summary: 'all done' });
      await new Promise((r) => setTimeout(r, 20)); // the roll-up job queues behind this run on the task lock
      return chat();
    });
    await c.scheduler.onMessage(praw);
    await c.scheduler.idle();
    expect(c.calls).toHaveLength(2);
    expect(statusDuringRollup).toEqual(['doing']);
    expect(root(c.tasks).status).toBe('done');
    // F5: the conversation lives in the channel itself, so a finished child is not announced there (WS13); the roll-up answer replies to the person
    expect(c.port.posts.filter((p) => p.payload.title === 'Subtask done')).toHaveLength(0);
    expect(c.port.posts.find((p) => p.payload.body === 'ok' && p.opts?.replyToId === praw.id)?.target).toEqual({ channelId: praw.channelId });
  });

  it('F5: the Praw answer to a top-level typed message replies to that message in the channel', async () => {
    const c = await sched(async () => chat());
    await c.scheduler.onMessage(praw);
    await c.scheduler.idle();
    const answer = c.port.posts.find((p) => p.payload.body === 'ok')!;
    expect(answer.target).toEqual({ channelId: praw.channelId });
    expect(answer.opts?.replyToId).toBe(praw.id);
    expect(c.port.threads).toEqual([]);
  });

  it('roll-up with another child still open leaves the task in review', async () => {
    const c = await sched(async (t, d, x) => {
      if (t.task) return chat();
      const conv = await d.conversation!.open({ actor: PRAW, msg: praw });
      const a = await child(x.tasks, conv.id);
      await child(x.tasks, conv.id);
      const finished = (await x.tasks.update(a.id, { status: 'done' }))!;
      await x.bus.emit('task.changed', { task: finished, from: 'todo', to: 'done', summary: 's' });
      return chat();
    });
    await c.scheduler.onMessage(praw);
    await c.scheduler.idle();
    expect(c.calls).toHaveLength(2);
    expect(root(c.tasks).status).toBe('review');
  });

  it('last open child cancelled: the review conversation task is closed without a run', async () => {
    const c = await sched(async (_t, d, x) => {
      const conv = await d.conversation!.open({ actor: PRAW, msg: praw });
      const ch = await child(x.tasks, conv.id);
      const gone = (await x.tasks.update(ch.id, { status: 'cancelled' }))!;
      await x.bus.emit('task.changed', { task: gone, from: 'todo', to: 'cancelled' });
      await new Promise((r) => setTimeout(r, 20));
      return chat();
    });
    await c.scheduler.onMessage(praw);
    await c.scheduler.idle();
    expect(c.calls).toHaveLength(1);
    expect(root(c.tasks).status).toBe('done');
  });

  it('cancelling the last open child of a task already in review closes it, no run', async () => {
    const c = await sched(async (_t, d, x) => {
      const conv = await d.conversation!.open({ actor: PRAW, msg: praw });
      await child(x.tasks, conv.id);
      return chat();
    });
    await c.scheduler.onMessage(praw);
    await c.scheduler.idle();
    expect(root(c.tasks).status).toBe('review');
    const ch = [...c.tasks.rows.values()].find((t) => t.depth === 1)!;
    const gone = (await c.tasks.update(ch.id, { status: 'cancelled' }))!;
    await c.bus.emit('task.changed', { task: gone, from: 'todo', to: 'cancelled' });
    await c.scheduler.idle();
    expect(root(c.tasks).status).toBe('done');
    expect(c.calls).toHaveLength(1);
  });

  it('a roll-up skipped because the company is halted still leaves no review task behind; sweepReview closes stragglers without a run', async () => {
    let halted = false;
    const c = await sched(async (_t, d, x) => {
      const conv = await d.conversation!.open({ actor: PRAW, msg: praw });
      const ch = await child(x.tasks, conv.id);
      halted = true;
      const finished = (await x.tasks.update(ch.id, { status: 'done' }))!;
      await x.bus.emit('task.changed', { task: finished, from: 'todo', to: 'done', summary: 's' });
      await new Promise((r) => setTimeout(r, 20));
      return chat();
    }, () => halted);
    await c.scheduler.onMessage(praw);
    await c.scheduler.idle();
    expect(c.calls).toHaveLength(1); // no roll-up run
    expect(root(c.tasks).status).toBe('done');

    // a straggler already in review with nothing open (e.g. from before this fix)
    const stuck = await c.tasks.create({ title: 's', deptId: 'praw', owner: PRAW, requester: { kind: 'human', userId: '42' }, origin: 'chat', status: 'review' });
    halted = false;
    await c.scheduler.sweepReview();
    expect((await c.tasks.get(stuck.id))!.status).toBe('done');
    expect(c.calls).toHaveLength(1);
  });

  it('runOwner afterRun: doing conversation task with no children is done; with an open child is review', async () => {
    for (const withChild of [false, true]) {
      const c = await sched(async (t, _d, x) => {
        await x.tasks.update(t.task!.id, { status: 'doing' });
        if (withChild) await child(x.tasks, t.task!.id);
        return chat();
      });
      const conv = await c.tasks.create({ title: 'r', deptId: 'praw', owner: PRAW, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'th-r', channelId: praw.channelId });
      await c.scheduler.onTaskReady(conv.id);
      await c.scheduler.idle();
      expect((await c.tasks.get(conv.id))!.status).toBe(withChild ? 'review' : 'done');
    }
  });

  it('a human follow-up in the thread of a review conversation task runs as doing and closes it again', async () => {
    const seen: string[] = [];
    const c = await sched(async (t, _d, x) => (seen.push((await x.tasks.get(t.task!.id))!.status), chat()));
    const conv = await c.tasks.create({ title: 'r', deptId: 'praw', owner: PRAW, requester: { kind: 'human', userId: '42' }, origin: 'chat', status: 'review', threadId: 'th-r', channelId: praw.channelId });
    (c.tasks as unknown as { findByThread: (id: string) => Promise<Task | null> }).findByThread = async (id) => (id === 'th-r' ? (await c.tasks.get(conv.id)) : null);
    await c.scheduler.onMessage(humanMsg('and one more thing', { channelId: 'th-r', threadId: 'th-r', parentChannelId: praw.channelId, mentionedHeads: ['praw'] }));
    await c.scheduler.idle();
    expect(seen).toEqual(['doing']);
    expect((await c.tasks.get(conv.id))!.status).toBe('done');
  });

  it('a second open in the same run returns the first task', async () => {
    const c = await sched(async (_t, d) => {
      const a = await d.conversation!.open({ actor: PRAW, msg: praw });
      const b = await d.conversation!.open({ actor: PRAW, msg: praw });
      expect(b.id).toBe(a.id);
      return chat();
    });
    await c.scheduler.onMessage(praw);
    await c.scheduler.idle();
    expect([...c.tasks.rows.values()]).toHaveLength(1);
  });
});

describe('conversation in a forum post (Teamwork D)', () => {
  it('the task opened for a human post uses the post as its thread and the forum as its channel; no new thread is created', async () => {
    const port = new FakeDiscordPort();
    const tasks = new MemTasks();
    const conv = createConversation({ tasks, port, limits: new Limits(new FakeConfig(), tasks), bus: newBus() });
    const msg = humanMsg('plan the launch', { id: 'post-1', channelId: 'post-1', threadId: 'post-1', parentChannelId: 'forum-praw' });
    const task = await conv.open({ actor: PRAW, msg });
    expect(task).toMatchObject({ threadId: 'post-1', channelId: 'forum-praw' });
    expect(port.threads).toEqual([]);
  });
});

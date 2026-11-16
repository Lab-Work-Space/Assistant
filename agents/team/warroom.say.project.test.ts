import { describe, expect, it } from 'vitest';
import { AI_WARROOM_CHANNEL_ID as WR } from '../../company/channels.js';
import type { ActorRef, IncomingMessage } from '../../company/types.js';
import type { Task } from '../../db/repos/tasks.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeDiscordPort } from '../../tests/fakes/discordPort.js';
import { createConversation } from '../conversation.js';
import type { AgentDeps, AgentOutcome, AgentTrigger } from '../loop/loop.js';
import { SAY_ROLLUP_PROJECT_INSTRUCTION, Scheduler } from '../scheduler/scheduler.js';
import { MemTasks, newBus, noApprovedTools, quiet, seededOrg } from '../test-helpers.js';

const A = (dept: string): ActorRef => ({ kind: 'head', dept } as ActorRef);
const CTO = A('software');
const FIN = A('finance');
const chat = (body = 'ok'): AgentOutcome => ({ payload: { type: 'chat', body }, costUsd: 0, turns: 1 });
const CHAN = '1565682159375749161';

async function mk(o: { projectOf?: ((id: string) => Promise<{ id: number } | null>) | 'none'; sayWaitMs?: number } = {}) {
  const cfg = new FakeConfig({ 'warroom.stallTurns': 1000, 'warroom.turnsPerThreadPerHour': 1000, 'warroom.turnsPerHour': 1000 });
  const tasks = Object.assign(new MemTasks(), { findByThread: async (_id: string): Promise<Task | null> => null });
  const port = new FakeDiscordPort();
  port.snowflakes = true;
  const bus = newBus();
  const limits = new Limits(cfg, tasks);
  const calls: AgentTrigger[] = [];
  const agent = {} as AgentDeps;
  const scheduler = new Scheduler({
    agent, run: async (t) => (calls.push(t), chat('Decided.')), port, org: await seededOrg(), tasks, limits, halt: { isHalted: () => false }, cfg, bus, log: quiet,
    conversation: createConversation({ tasks, port, limits, bus }), approvedTools: noApprovedTools, now: () => 5_000_000, ...(o.sayWaitMs ? { sayWaitMs: o.sayWaitMs } : {}),
    ...(o.projectOf === 'none' ? {} : { autopilot: { projectOf: async (id: string) => (typeof o.projectOf === 'function' ? o.projectOf(id) : { id: 3 }) } }),
  });
  scheduler.attach();
  const parent = await tasks.create({ title: 'Project: x', deptId: 'hq', owner: A('hq'), requester: { kind: 'human', userId: '1' }, origin: 'delegated', status: 'doing' });
  const task = await tasks.create({ title: 'work', deptId: 'software', owner: CTO, requester: A('hq'), origin: 'delegated', status: 'doing', parentId: parent.id, channelId: CHAN, threadId: '1570000000000000555' });
  return { scheduler, tasks, port, bus, calls, agent, task };
}
const echo = (id: string, mentioned: string[] = ['finance']): IncomingMessage => ({
  id, channelId: WR, parentChannelId: null, threadId: null, author: { id: 'bot-x', name: 'bot', kind: 'head', actor: CTO },
  content: '@CFO budget?', mentionedHeads: mentioned as never, isAdmin: false, attachments: [], origin: 'chat',
});
const rolled = (r: { calls: AgentTrigger[] }) => r.calls.filter((c) => c.noWarroomSay);

describe('AUTO-1 warroom roll-up for a task of an active project (SA-1 3.9, C15)', () => {
  it('a project task that asked another head waits (rollup true) and the roll-up run gets the project instruction; the task is never closed by it', async () => {
    const r = await mk();
    const say = await r.agent.warroomSay!.say({ actor: CTO, text: '@CFO budget?', task: r.task, tainted: false });
    expect(say).toEqual({ ok: true, rollup: true });
    const id = r.port.posts.find((p) => p.target.channelId === WR)!.id;
    await r.scheduler.onMessage(echo(id));
    // the CFO's own run answers through noteSayReply (the scheduler calls it after a routed run)
    (r.scheduler as unknown as { noteSayReply(m: IncomingMessage, a: ActorRef, o: AgentOutcome): void }).noteSayReply(echo(id), FIN, chat('Budget is 1M'));
    await r.scheduler.idle();
    expect(rolled(r)).toHaveLength(1);
    const run = rolled(r)[0]!;
    expect(run.instruction).toBe(SAY_ROLLUP_PROJECT_INSTRUCTION);
    expect(run.msg!.content).toBe('@CFO replied in #ai-warroom: Budget is 1M');
    expect(run.route.actor).toEqual(CTO);
    expect((await r.tasks.get(r.task.id))!.status).toBe('doing'); // only a conversation is reopened and closed
    r.scheduler.stop();
  });

  it('heads that did not answer are named by handle; with no answer at all the old text stays', async () => {
    const r = await mk({ sayWaitMs: 15 });
    await r.agent.warroomSay!.say({ actor: CTO, text: '@CFO and @R&D budget?', task: r.task, tainted: false });
    const id = r.port.posts.find((p) => p.target.channelId === WR)!.id;
    (r.scheduler as unknown as { noteSayReply(m: IncomingMessage, a: ActorRef, o: AgentOutcome): void }).noteSayReply(echo(id, ['finance', 'rnd']), FIN, chat('Budget is 1M'));
    await new Promise((res) => setTimeout(res, 60));
    await r.scheduler.idle();
    expect(rolled(r)).toHaveLength(1);
    expect(rolled(r)[0]!.msg!.content).toBe('@CFO replied in #ai-warroom: Budget is 1M\n(no reply in time from: @R&D)');
    const q = await mk({ sayWaitMs: 15 });
    await q.agent.warroomSay!.say({ actor: CTO, text: '@CFO budget?', task: q.task, tainted: false });
    await new Promise((res) => setTimeout(res, 60));
    await q.scheduler.idle();
    expect(rolled(q)[0]!.msg!.content).toBe('(no head replied in #ai-warroom in time)');
  });

  it('a task that is not in a project, no autopilot dep, or a lookup that throws: rollup false (today\'s behaviour)', async () => {
    for (const projectOf of [async () => null, 'none' as const, async () => { throw new Error('x'); }]) {
      const r = await mk({ projectOf });
      expect(await r.agent.warroomSay!.say({ actor: CTO, text: '@CFO budget?', task: r.task, tainted: false })).toEqual({ ok: true, rollup: false });
      r.scheduler.stop();
    }
  });
});

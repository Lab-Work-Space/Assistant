import { describe, expect, it, vi } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import type { Task } from '../../db/repos/tasks.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeDiscordPort } from '../../tests/fakes/discordPort.js';
import type { AgentDeps, AgentOutcome, AgentTrigger } from '../loop/loop.js';
import { isHumanOrigin, Scheduler } from './scheduler.js';
import { CTO, MemTasks, humanMsg, newBus, noApprovedTools, seededOrg } from '../test-helpers.js';

const SOFTWARE_WORK = '1565682159375749161';
const HQ: ActorRef = { kind: 'head', dept: 'hq' };
const SA: ActorRef = { kind: 'persona', personaId: 'system-analyst' };
const PRAW: ActorRef = { kind: 'head', dept: 'praw' };
const chat = (body: string): AgentOutcome => ({ payload: { type: 'chat', body }, costUsd: 0, turns: 1 });

/** A scheduler whose calendar is a switch: `day.off` true = off day. */
type Tasks = MemTasks & { findByThread(id: string): Promise<Task | null> };
const memTasks = (): Tasks => {
  const tasks = new MemTasks() as Tasks;
  tasks.findByThread = async (id) => [...tasks.rows.values()].find((t) => t.threadId === id) ?? null;
  return tasks;
};

/** `tasks` shared between two schedulers simulates a restart; `halt.on` switches a halt. */
async function mk(o: { tasks?: Tasks; halt?: { on: boolean } } = {}) {
  const cfg = new FakeConfig();
  const tasks = o.tasks ?? memTasks();
  const port = new FakeDiscordPort();
  const bus = newBus();
  const day = { off: true };
  const runs: AgentTrigger[] = [];
  const errors: object[] = [];
  const run = vi.fn(async (t: AgentTrigger) => { runs.push(t); return chat('ok'); });
  const s = new Scheduler({
    agent: {} as AgentDeps, approvedTools: noApprovedTools, run, port, org: await seededOrg(), tasks, limits: new Limits(cfg, tasks),
    halt: { isHalted: () => o.halt?.on ?? false }, cfg, bus, log: { error: (o: object) => void errors.push(o) }, now: () => 1_000_000,
    calendar: { isOffDay: () => (day.off ? { off: true, reason: 'weekday' } : { off: false }) },
  });
  s.attach();
  return { s, port, tasks, bus, runs, run, day, errors };
}

const toCto = (content = 'hi', over = {}) => humanMsg(`<@111> ${content}`, { mentionedHeads: ['software'], ...over });
const botInThread = (thread: string, from: ActorRef) =>
  humanMsg(`<@111> over to you`, { mentionedHeads: ['software'], channelId: thread, threadId: thread, parentChannelId: SOFTWARE_WORK, author: { id: 'bot-x', name: 'x', kind: from.kind, actor: from } as never });

describe('Scheduler on an off day', () => {
  it('classifies chat, slash and voice as human origins; every other origin waits', () => {
    expect((['chat', 'slash', 'voice'] as const).every(isHumanOrigin)).toBe(true);
    expect((['delegated', 'schedule', 'watch', 'reminder', 'poll', 'import'] as const).some(isHumanOrigin)).toBe(false);
  });

  it('a human message still runs and is answered', async () => {
    const t = await mk();
    await t.s.onMessage(toCto());
    await t.s.idle();
    expect(t.runs).toHaveLength(1);
    expect(t.port.posts.at(-1)).toMatchObject({ actor: CTO, payload: { body: 'ok' } });
  });

  it('ask (slash, voice) still runs', async () => {
    const t = await mk();
    const out = await t.s.ask(humanMsg('what time is it', { id: 'interaction:1', mentionedHeads: ['praw'] }), { deliver: false, origin: 'voice' });
    expect(out?.payload.body).toBe('ok');
  });

  it('a human goal (origin slash) runs its CEO owner', async () => {
    const t = await mk();
    await t.s.onMessage(humanMsg('Grow revenue', { channelId: '1565651009076985956' }));
    await t.s.idle();
    expect(t.runs).toEqual([expect.objectContaining({ route: expect.objectContaining({ actor: HQ, reason: 'task_owner' }) })]);
  });

  it.each(['delegated', 'schedule', 'import'] as const)('a %s task gets its thread but waits in todo; it runs when re-scheduled on a workday', async (origin) => {
    const t = await mk();
    const task = await t.tasks.create({ title: 'Later', deptId: 'software', owner: SA, requester: CTO, origin });
    await t.bus.emit('task.created', { task });
    await t.s.idle();
    expect(t.port.threads).toHaveLength(1);
    expect(t.run).not.toHaveBeenCalled();
    expect((await t.tasks.get(task.id))!.status).toBe('todo');
    await t.s.onTaskReady(task.id); // recovery while still off: nothing
    await t.s.idle();
    expect(t.run).not.toHaveBeenCalled();
    t.day.off = false;
    await t.s.onTaskReady(task.id); // the day-turn recovery
    await t.s.idle();
    expect(t.runs).toEqual([expect.objectContaining({ route: { actor: SA, reason: 'task_owner', taskId: task.id } })]);
  });

  it('a roll-up waits for the workday and keeps the conversation open; dayTurned while still off releases nothing', async () => {
    const t = await mk();
    const parent = await t.tasks.create({ title: 'Parent', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'th-p', status: 'doing' });
    const child = await t.tasks.create({ title: 'Child', deptId: 'software', owner: SA, requester: CTO, origin: 'delegated', parentId: parent.id, status: 'done' });
    await t.bus.emit('task.changed', { task: child, from: 'doing', to: 'done', summary: 'all good' });
    await t.s.idle();
    expect(t.port.posts.filter((p) => p.payload.title === 'Subtask done')).toHaveLength(1); // the notice is not held back
    expect(t.run).not.toHaveBeenCalled();
    t.s.dayTurned();
    await t.s.idle();
    expect(t.run).not.toHaveBeenCalled();
    t.day.off = false;
    t.s.dayTurned();
    await t.s.idle();
    expect(t.runs).toEqual([expect.objectContaining({ route: expect.objectContaining({ actor: CTO, reason: 'task_owner', taskId: parent.id }) })]);
    t.s.dayTurned(); // released once
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(1);
  });

  it('a bot message in a delegated task thread waits for the workday; in a human-origin task thread it runs', async () => {
    const t = await mk();
    await t.tasks.create({ title: 'Delegated', deptId: 'software', owner: CTO, requester: HQ, origin: 'delegated', threadId: 'th-d', status: 'doing' });
    await t.tasks.create({ title: 'Human', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'th-h', status: 'doing' });
    await t.s.onMessage(botInThread('th-d', HQ));
    await t.s.idle();
    expect(t.run).not.toHaveBeenCalled();
    await t.s.onMessage(botInThread('th-h', HQ));
    await t.s.idle();
    expect(t.runs.map((r) => r.route.taskId)).toHaveLength(1);
    t.day.off = false;
    t.s.dayTurned();
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(2);
  });

  it('a day that turns while halted keeps the held roll-up; it runs exactly once after the resume', async () => {
    const halt = { on: false };
    const t = await mk({ halt });
    const parent = await t.tasks.create({ title: 'Parent', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'th-p', status: 'doing' });
    const child = await t.tasks.create({ title: 'Child', deptId: 'software', owner: SA, requester: CTO, origin: 'delegated', parentId: parent.id, status: 'done' });
    await t.bus.emit('task.changed', { task: child, from: 'doing', to: 'done', summary: 'ok' });
    await t.s.idle();
    halt.on = true;
    t.day.off = false;
    t.s.dayTurned(); // the day turns during the halt
    await t.s.idle();
    expect(t.run).not.toHaveBeenCalled();
    halt.on = false;
    t.s.dayTurned(); // resume -> recovery
    await t.s.idle();
    t.s.dayTurned();
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(1);
  });

  it('a restart on an off day: the conversation task stays in review, and the first workday recovery rolls up its last done child', async () => {
    const tasks = memTasks();
    const first = await mk({ tasks });
    const parent = await tasks.create({ title: 'Chat', deptId: 'praw', owner: PRAW, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'th-c', channelId: 'c-praw', status: 'review' });
    const child = await tasks.create({ title: 'Child', deptId: 'software', owner: CTO, requester: PRAW, origin: 'delegated', parentId: parent.id, status: 'done' });
    await first.bus.emit('task.changed', { task: child, from: 'doing', to: 'done', summary: 'ok' });
    await first.s.idle();
    first.s.stop(); // the held roll-up is lost with the process

    const t = await mk({ tasks });
    await t.s.sweepReview(); // boot recovery on the off day
    await t.s.idle();
    expect((await tasks.get(parent.id))!.status).toBe('review');
    expect(t.run).not.toHaveBeenCalled();
    t.day.off = false;
    await t.s.sweepReview(); // the day-turn recovery
    await t.s.idle();
    expect(t.runs).toEqual([expect.objectContaining({ route: expect.objectContaining({ actor: PRAW, reason: 'task_owner', taskId: parent.id }) })]);
    expect(t.runs[0]!.msg?.content).toContain('"Child"');
    expect((await tasks.get(parent.id))!.status).toBe('done');
    await t.s.sweepReview();
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(1);
  });

  it('a workday recovery closes a review conversation task whose last ended child was cancelled, without a run', async () => {
    const t = await mk();
    const parent = await t.tasks.create({ title: 'Chat', deptId: 'praw', owner: PRAW, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'th-c', channelId: 'c-praw', status: 'review' });
    await t.tasks.create({ title: 'Child', deptId: 'software', owner: CTO, requester: PRAW, origin: 'delegated', parentId: parent.id, status: 'cancelled' });
    await t.s.sweepReview();
    expect((await t.tasks.get(parent.id))!.status).toBe('review'); // still the off day
    t.day.off = false;
    await t.s.sweepReview();
    await t.s.idle();
    expect((await t.tasks.get(parent.id))!.status).toBe('done');
    expect(t.run).not.toHaveBeenCalled();
  });

  it('a full hold drops the roll-up with a log line; the workday recovery re-derives it instead of leaving the task in review', async () => {
    const t = await mk();
    const parent = await t.tasks.create({ title: 'Chat', deptId: 'praw', owner: PRAW, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'th-c', channelId: 'c-praw', status: 'review' });
    const child = await t.tasks.create({ title: 'Child', deptId: 'software', owner: CTO, requester: PRAW, origin: 'delegated', parentId: parent.id, status: 'done' });
    (t.s as unknown as { heldForWorkday: (() => void)[] }).heldForWorkday.push(...Array.from({ length: 1000 }, () => () => undefined));
    await t.bus.emit('task.changed', { task: child, from: 'doing', to: 'done', summary: 'ok' });
    await t.s.idle();
    expect(t.errors).toEqual([expect.objectContaining({ taskId: child.id })]);
    t.day.off = false;
    await t.s.sweepReview();
    await t.s.idle();
    expect(t.runs).toEqual([expect.objectContaining({ route: expect.objectContaining({ actor: PRAW, taskId: parent.id }) })]);
    expect((await t.tasks.get(parent.id))!.status).toBe('done');
  });

  it('stop drops held work; nothing runs after it', async () => {
    const t = await mk();
    const parent = await t.tasks.create({ title: 'Parent', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'th-p', status: 'doing' });
    const child = await t.tasks.create({ title: 'Child', deptId: 'software', owner: SA, requester: CTO, origin: 'delegated', parentId: parent.id, status: 'done' });
    await t.bus.emit('task.changed', { task: child, from: 'doing', to: 'done', summary: 'ok' });
    await t.s.idle();
    t.s.stop();
    t.day.off = false;
    t.s.dayTurned();
    await t.s.idle();
    expect(t.run).not.toHaveBeenCalled();
  });
});

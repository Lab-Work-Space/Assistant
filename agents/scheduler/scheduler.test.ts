import { describe, expect, it, vi } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import type { Task } from '../../db/repos/tasks.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeDiscordPort } from '../../tests/fakes/discordPort.js';
import type { AgentDeps, AgentOutcome, AgentTrigger } from '../loop/loop.js';
import { Scheduler } from './scheduler.js';
import { CTO, MemTasks, humanMsg, newBus, noApprovedTools, quiet, seededOrg } from '../test-helpers.js';

import { AI_WARROOM_CHANNEL_ID } from '../../company/channels.js';
const SOFTWARE_WORK = '1565682159375749161';
const SA_DIRECT = '1565670817646256178'; // #🤖-ai-system-analyst
const chat = (body: string): AgentOutcome => ({ payload: { type: 'chat', body }, costUsd: 0, turns: 1 });

async function mk(o: { org?: Awaited<ReturnType<typeof seededOrg>>; halted?: () => boolean; run?: (t: AgentTrigger) => Promise<AgentOutcome>; cfg?: FakeConfig; record?: (id: string, channelId: string, tainted: boolean, userId: string | null) => Promise<void> } = {}) {
  const cfg = o.cfg ?? new FakeConfig();
  const tasks = new MemTasks() as MemTasks & { findByThread(id: string): Promise<Task | null> };
  tasks.findByThread = async (id) => [...tasks.rows.values()].find((t) => t.threadId === id) ?? null;
  const port = new FakeDiscordPort();
  const bus = newBus();
  let clock = 1_000_000;
  const runs: AgentTrigger[] = [];
  const run = vi.fn(async (t: AgentTrigger) => {
    runs.push(t);
    return o.run ? o.run(t) : chat('ok');
  });
  const s = new Scheduler({
    agent: {} as AgentDeps,
    approvedTools: noApprovedTools,
    run,
    port,
    org: o.org ?? await seededOrg(),
    tasks,
    limits: new Limits(cfg, tasks),
    halt: { isHalted: o.halted ?? (() => false) },
    cfg,
    bus,
    log: quiet,
    now: () => clock,
    ...(o.record ? { provenance: { record: o.record } } : {}),
  });
  s.attach();
  return { s, port, tasks, bus, runs, run, advance: (ms: number) => (clock += ms) };
}

const toCto = (content = 'hi', over = {}) => humanMsg(`<@111> ${content}`, { mentionedHeads: ['software'], ...over });

describe('SPEND-1 S15: one stop alert path for a department', () => {
  it('a dept governance.paused makes no scheduler alert (SpendOverrides posts the only one); the other scopes still alert', async () => {
    const t = await mk();
    await t.bus.emit('governance.paused', { scope: 'dept', dept: 'hq', day: '2026-11-01', estUsd: 1 });
    await t.s.idle();
    expect(t.port.posts.filter((p) => p.payload.title === 'Budget used up' || p.payload.title === 'Department budget used up')).toHaveLength(0);
    await t.bus.emit('governance.paused', { scope: 'company', day: '2026-11-08' });
    await t.s.idle();
    expect(t.port.posts.filter((p) => p.payload.title === 'Budget used up')).toHaveLength(1);
  });

  it('budgetPausedAlert for a dept never reads like the bot or UTC fall-through', async () => {
    const { budgetPausedAlert } = await import('./notices.js');
    const a = budgetPausedAlert({ scope: 'dept', dept: 'hq', day: '2026-11-01' });
    expect(a.body).toContain('2026-11');
    expect(a.body).toContain('#⚙️-setting');
    expect(a.body).not.toMatch(/UTC|\/budget set bot|daily budget of/);
    expect(a.title).toBe('Department budget used up');
  });
});

describe('Scheduler', () => {
  it('6th human trigger in 10 min is not run', async () => {
    const t = await mk();
    for (let i = 0; i < 7; i++) await t.s.onMessage(toCto(`m${i}`));
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(5);
    const notices = t.port.posts.filter((p) => p.payload.title === 'Slow down');
    expect(notices).toHaveLength(1); // one notice per window, the 7th is ignored silently
    expect(notices[0]!.target).toEqual({ channelId: SOFTWARE_WORK });

    t.advance(10 * 60 * 1000 + 1);
    await t.s.onMessage(toCto('later'));
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(6);
  });

  it('one human message takes one rate slot however many routes it makes (final #9)', async () => {
    const t = await mk();
    const both = (i: number) => humanMsg(`<@111> <@112> m${i}`, { mentionedHeads: ['software', 'marketing'] });
    for (let i = 0; i < 6; i++) await t.s.onMessage(both(i));
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(10); // 5 messages x 2 heads; the 6th message is refused as a whole
    const notices = t.port.posts.filter((p) => p.payload.title === 'Slow down');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ actor: CTO, target: { channelId: SOFTWARE_WORK } });
  });

  it('the limit is per human user', async () => {
    const t = await mk();
    for (let i = 0; i < 5; i++) await t.s.onMessage(toCto(`a${i}`));
    await t.s.onMessage(toCto('b', { author: { id: '77', name: 'other', kind: 'human' } }));
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(6);
  });

  it('a message id is handled once', async () => {
    const t = await mk();
    const m = toCto();
    await t.s.onMessage(m);
    await t.s.onMessage(m);
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(1);
  });

  it('posts the reply in the source channel as the routed actor', async () => {
    const t = await mk();
    await t.s.onMessage(toCto());
    await t.s.idle();
    expect(t.port.posts).toEqual([expect.objectContaining({ actor: CTO, target: { channelId: SOFTWARE_WORK }, payload: { type: 'chat', body: 'ok' } })]);
  });

  it('posts nothing when the run stopped because of a halt', async () => {
    const t = await mk({ run: async () => ({ ...chat('Halted'), stopped: 'halted' }) });
    await t.s.onMessage(toCto());
    await t.s.idle();
    expect(t.port.posts).toEqual([]);
  });

  it('while halted nothing is run', async () => {
    const t = await mk({ halted: () => true });
    await t.s.onMessage(toCto());
    await t.s.idle();
    expect(t.run).not.toHaveBeenCalled();
  });

  it('re-checks halt after waiting for a concurrency slot', async () => {
    let halted = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const cfg = new FakeConfig({ 'limits.concurrency': 1 });
    const t = await mk({
      cfg,
      halted: () => halted,
      run: async (tr) => {
        if (tr.msg?.content.includes('first')) await gate;
        return chat('ok');
      },
    });
    await t.s.onMessage(toCto('first'));
    await t.s.onMessage(toCto('second'));
    await vi.waitFor(() => expect(t.run).toHaveBeenCalledTimes(1));
    halted = true;
    release();
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(1);
  });

  it('runs one job at a time per task', async () => {
    let active = 0;
    let maxActive = 0;
    const t = await mk({
      run: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setImmediate(r));
        active--;
        return chat('ok');
      },
    });
    const task = await t.tasks.create({ title: 'T', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'th-1' });
    for (let i = 0; i < 3; i++) await t.s.onMessage(humanMsg(`more ${i}`, { channelId: 'th-1', threadId: 'th-1', parentChannelId: SOFTWARE_WORK, author: { id: '42', name: 'x', kind: 'human' } })); // the root requester (WS13)
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(3);
    expect(t.runs.every((r) => r.task?.id === task.id)).toBe(true);
    expect(maxActive).toBe(1);
  });

  it('task.created for a persona opens a thread "#<id> <title>" in its direct room, logs it and runs the owner', async () => {
    const t = await mk();
    const SA: ActorRef = { kind: 'persona', personaId: 'system-analyst' };
    const task = await t.tasks.create({ title: 'Write the spec', deptId: 'software', owner: SA, requester: CTO, origin: 'delegated' });
    await t.bus.emit('task.created', { task });
    await t.s.idle();
    expect(t.port.threads).toEqual([{ dept: 'software', channelId: SA_DIRECT, name: `#${task.id.slice(0, 8)} Write the spec`, id: 'thread-1' }]);
    expect((await t.tasks.get(task.id))!.threadId).toBe('thread-1');
    expect(t.port.tasks.map((x) => x.id)).toEqual([task.id]);
    expect(t.port.directs).toEqual([{ from: CTO, to: SA, text: expect.stringContaining('Write the spec') }]);
    expect(t.runs).toEqual([expect.objectContaining({ route: { actor: SA, reason: 'task_owner', taskId: task.id } })]);
    expect(t.port.historyReaders.at(-1)).toEqual({ channelId: 'thread-1', reader: SA }); // HIST-1: runOwner reads as the owner
    expect(t.port.posts.at(-1)).toMatchObject({ actor: SA, target: { channelId: SA_DIRECT, threadId: 'thread-1' } });
    expect((await t.tasks.get(task.id))!.channelId).toBe(SA_DIRECT);
  });

  it('Part B: the thread card is posted once at creation and then edited in place on every change; the #tasks card is upserted, never posted twice', async () => {
    const t = await mk();
    const task = await t.tasks.create({ title: 'Ship it', deptId: 'software', owner: CTO, requester: CTO, origin: 'delegated' });
    await t.bus.emit('task.created', { task });
    await t.s.idle();
    const cards = () => t.port.posts.filter((p) => p.payload.type === 'task');
    expect(cards()).toHaveLength(1);
    const cur = (await t.tasks.get(task.id))!;
    await t.bus.emit('task.changed', { task: { ...cur, status: 'blocked' }, from: 'doing', to: 'blocked' });
    await t.bus.emit('task.changed', { task: { ...cur, status: 'done' }, from: 'blocked', to: 'done' });
    await t.s.idle();
    expect(cards()).toHaveLength(1); // no new card in the thread
    expect(t.port.cardEdits.map((e) => e.id)).toEqual(Array(t.port.cardEdits.length).fill(t.port.cardIds.get(task.id)));
    expect(t.port.cardEdits.length).toBeGreaterThanOrEqual(2);
  });

  it('Part B: a task that has a thread but no card (older task, boot recovery) gets no new card from a change', async () => {
    const t = await mk();
    const task = await t.tasks.create({ title: 'Old', deptId: 'software', owner: CTO, requester: CTO, origin: 'delegated', threadId: 'thread-old' });
    await t.bus.emit('task.changed', { task, from: 'doing', to: 'todo' });
    await t.s.idle();
    expect(t.port.posts.filter((p) => p.target.threadId === 'thread-old')).toEqual([]);
    expect(t.port.cardEdits).toEqual([]);
    expect(t.port.tasks.map((x) => x.id)).toEqual([task.id]); // still upserted in #tasks
  });

  it('Part B: every change touches the summary board', async () => {
    const t = await mk();
    const touch = vi.fn();
    (t.s as unknown as { d: { board?: { touch(): void } } }).d.board = { touch };
    const task = await t.tasks.create({ title: 'x', deptId: 'software', owner: CTO, requester: CTO, origin: 'delegated' });
    await t.bus.emit('task.changed', { task, from: 'todo', to: 'doing' });
    await t.s.idle();
    expect(touch).toHaveBeenCalledTimes(1);
  });

  it('a created task that awaits approval gets its thread but is not run', async () => {
    const t = await mk();
    const task = await t.tasks.create({ title: 'Big', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat', status: 'awaiting_approval' });
    await t.bus.emit('task.created', { task });
    await t.s.idle();
    expect(t.port.threads).toHaveLength(1);
    expect(t.run).not.toHaveBeenCalled();
  });

  it('a human post in #🎯-company-goals becomes a root task owned by the CEO', async () => {
    const t = await mk();
    await t.s.onMessage(humanMsg('Grow revenue 20% this quarter', { channelId: '1565651009076985956' }));
    await t.s.idle();
    const [task] = [...t.tasks.rows.values()];
    expect(task).toMatchObject({ title: 'Grow revenue 20% this quarter', deptId: 'hq', owner: { kind: 'head', dept: 'hq' }, requester: { kind: 'human', userId: '42' }, depth: 0 });
    expect(t.port.threads).toEqual([expect.objectContaining({ dept: 'hq', channelId: '1565652605290414160' })]);
    expect(t.runs).toEqual([expect.objectContaining({ route: { actor: { kind: 'head', dept: 'hq' }, reason: 'task_owner', taskId: task!.id } })]);
  });

  it('Teamwork D: a goal posted in the goals forum uses its post as the task thread, and the CEO answers in the post', async () => {
    const t = await mk();
    const GOALS_FORUM = '1565652418383847514';
    await t.s.onMessage(humanMsg('Grow revenue 20%', { id: 'gp1', channelId: 'gp1', threadId: 'gp1', parentChannelId: GOALS_FORUM }));
    await t.s.idle();
    const [task] = [...t.tasks.rows.values()];
    expect(task).toMatchObject({ deptId: 'hq', owner: { kind: 'head', dept: 'hq' }, threadId: 'gp1', channelId: GOALS_FORUM });
    expect(t.port.threads).toEqual([]); // no second thread in the hq work channel
    expect(t.port.posts.at(-1)).toMatchObject({ actor: { kind: 'head', dept: 'hq' }, target: { channelId: GOALS_FORUM, threadId: 'gp1' } });
  });

  it('Teamwork D: a follow-up in the goal post runs the goal task and the answer lands in the post', async () => {
    const t = await mk();
    const GOALS_FORUM = '1565652418383847514';
    await t.s.onMessage(humanMsg('Grow revenue 20%', { id: 'gp1', channelId: 'gp1', threadId: 'gp1', parentChannelId: GOALS_FORUM }));
    await t.s.idle();
    const [task] = [...t.tasks.rows.values()];
    await t.tasks.update(task!.id, { status: 'doing' });
    t.runs.length = 0;
    await t.s.onMessage(humanMsg('also include APAC', { id: 'gp2', channelId: 'gp1', threadId: 'gp1', parentChannelId: GOALS_FORUM }));
    await t.s.idle();
    expect(t.tasks.rows.size).toBe(1); // not a second goal
    expect(t.runs).toEqual([expect.objectContaining({ route: { actor: { kind: 'head', dept: 'hq' }, reason: 'task_owner', taskId: task!.id } })]);
    expect(t.port.posts.at(-1)).toMatchObject({ target: { channelId: GOALS_FORUM, threadId: 'gp1' } });
  });

  it('Teamwork D: a goal reply in a goals forum post is not a new goal when it is not the starter post', async () => {
    const t = await mk();
    await t.s.onMessage(humanMsg('late reply', { id: 'm7', channelId: 'gp9', threadId: 'gp9', parentChannelId: '1565652418383847514' }));
    await t.s.idle();
    expect(t.tasks.rows.size).toBe(0);
  });

  it('Teamwork D: a human post in a mapped department forum runs that head and the reply lands in the post', async () => {
    const t = await mk({ org: await seededOrg({ mapped: { 'forum-sw': 'software' } }) });
    await t.s.onMessage(humanMsg('How do we version the API?', { id: 'p1', channelId: 'p1', threadId: 'p1', parentChannelId: 'forum-sw' }));
    await t.s.idle();
    expect(t.runs).toEqual([expect.objectContaining({ route: { actor: CTO, reason: 'dept_channel' } })]);
    expect(t.port.posts).toEqual([expect.objectContaining({ actor: CTO, target: { channelId: 'forum-sw', threadId: 'p1' } })]);
    await t.s.onMessage(humanMsg('and the SDK?', { id: 'p2', channelId: 'p1', threadId: 'p1', parentChannelId: 'forum-sw' }));
    await t.s.idle();
    expect(t.port.posts.at(-1)).toMatchObject({ actor: CTO, target: { channelId: 'forum-sw', threadId: 'p1' } });
  });

  it('Teamwork D: a post in an unmapped forum is ignored', async () => {
    const t = await mk();
    await t.s.onMessage(humanMsg('hello?', { id: 'p1', channelId: 'p1', threadId: 'p1', parentChannelId: 'forum-nobody' }));
    await t.s.idle();
    expect(t.run).not.toHaveBeenCalled();
  });

  it('/goal tasks are slash and remember who set the goal', async () => {
    const t = await mk();
    await t.s.onMessage(humanMsg('Grow revenue', { channelId: '1565651009076985956' }));
    await t.s.idle();
    expect([...t.tasks.rows.values()][0]).toMatchObject({ origin: 'slash', sourceUserId: '42' });
  });

  it('a persona never posts outside its direct room: the post is made by its head', async () => {
    const t = await mk();
    const SA: ActorRef = { kind: 'persona', personaId: 'system-analyst' };
    // a task from before the rule: persona-owned, thread already open in the software work channel
    const task = await t.tasks.create({ title: 'Old', deptId: 'software', owner: SA, requester: CTO, origin: 'delegated', threadId: 'th-old' });
    await t.s.onMessage(humanMsg('go on', { channelId: 'th-old', threadId: 'th-old', parentChannelId: SOFTWARE_WORK }));
    await t.s.idle();
    expect(t.port.posts.filter((p) => p.actor.kind === 'persona')).toEqual([]);
    expect(task.channelId).toBeNull();
  });

  it('a task delegated into the ai-warroom opens its thread there, posted by the owning head, and is recorded with its taint', async () => {
    const rec: [string, string, boolean][] = [];
    const t = await mk({ record: async (id, ch, tainted) => void rec.push([id, ch, tainted]) });
    const task = await t.tasks.create({ title: 'Cross', deptId: 'software', owner: CTO, requester: { kind: 'head', dept: 'hq' }, origin: 'delegated', channelId: AI_WARROOM_CHANNEL_ID, tainted: true });
    await t.bus.emit('task.created', { task });
    await t.s.idle();
    expect(t.port.threads).toEqual([expect.objectContaining({ dept: 'software', channelId: AI_WARROOM_CHANNEL_ID })]);
    expect(t.port.posts.at(-1)).toMatchObject({ actor: CTO, target: { channelId: AI_WARROOM_CHANNEL_ID, threadId: 'thread-1' } });
    expect(rec.length).toBeGreaterThan(0);
    expect(rec.every(([, ch, tainted]) => ch === 'thread-1' && tainted)).toBe(true); // provenance is per message id, whatever the channel
  });

  it('task with channelId posts its thread in that channel, not the dept work channel', async () => {
    const t = await mk();
    const task = await t.tasks.create({ title: 'Elsewhere', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat', channelId: 'other-chan' });
    await t.bus.emit('task.created', { task });
    await t.s.idle();
    expect(t.port.threads).toEqual([expect.objectContaining({ dept: 'software', channelId: 'other-chan' })]);
    expect(t.port.posts.at(-1)).toMatchObject({ target: { channelId: 'other-chan', threadId: 'thread-1' } });
  });

  async function childDone(parentStatus: Task['status']) {
    const t = await mk();
    const parent = await t.tasks.create({ title: 'Parent', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'th-p', status: parentStatus });
    const SA: ActorRef = { kind: 'persona', personaId: 'system-analyst' };
    const child = await t.tasks.create({ title: 'Child', deptId: 'software', owner: SA, requester: CTO, origin: 'delegated', parentId: parent.id, status: 'done' });
    await t.bus.emit('task.changed', { task: child, from: 'doing', to: 'done', summary: 'all good' });
    await t.s.idle();
    const notices = t.port.posts.filter((p) => p.payload.title === 'Subtask done');
    return { t, notices };
  }

  it('a child done while the parent awaits approval still posts the notice, but runs nothing', async () => {
    const { t, notices } = await childDone('awaiting_approval');
    expect(notices).toEqual([expect.objectContaining({ actor: CTO, target: { channelId: SOFTWARE_WORK, threadId: 'th-p' } })]);
    expect(notices[0]!.payload.body).toContain('all good');
    expect(t.run).not.toHaveBeenCalled();
  });

  it('a child done under a finished parent posts the notice without a roll-up run', async () => {
    const { t, notices } = await childDone('done');
    expect(notices).toHaveLength(1);
    expect(t.run).not.toHaveBeenCalled();
  });

  it('a child done under a working parent rolls up to the requester', async () => {
    const { t, notices } = await childDone('doing');
    expect(notices).toHaveLength(1);
    expect(t.runs).toEqual([expect.objectContaining({ route: expect.objectContaining({ actor: CTO, reason: 'task_owner' }) })]);
    expect(t.port.historyReaders.at(-1)).toEqual({ channelId: 'th-p', reader: CTO }); // HIST-1: the roll-up reads as the requester that answers
  });

  it('G2-04: a reply is recorded with the taint of the run that produced it; a missing flag counts as tainted', async () => {
    const rec: [string, string, boolean][] = [];
    const record = async (id: string, ch: string, tainted: boolean) => void rec.push([id, ch, tainted]);
    const clean = await mk({ record, run: async () => ({ ...chat('ok'), tainted: false }) });
    await clean.s.onMessage(toCto());
    await clean.s.idle();
    const dirty = await mk({ record, run: async () => ({ ...chat('ok'), tainted: true }) });
    await dirty.s.onMessage(toCto());
    await dirty.s.idle();
    const unknown = await mk({ record });
    await unknown.s.onMessage(toCto());
    await unknown.s.idle();
    expect(rec).toEqual([['msg-1', SOFTWARE_WORK, false], ['msg-1', SOFTWARE_WORK, true], ['msg-1', SOFTWARE_WORK, true]]);
  });

  it('G2-04: every message of a split reply is recorded with the run\'s taint', async () => {
    const rec: [string, boolean][] = [];
    const t = await mk({ record: async (id, _ch, tainted) => void rec.push([id, tainted]), run: async () => ({ ...chat('long'), tainted: true }) });
    const post = t.port.post.bind(t.port);
    t.port.post = async (actor, target, payload, opts) => {
      const first = await post(actor, target, payload, opts);
      opts?.onSent?.([first, 'msg-b', 'msg-c']); // the real port reports every chunk it sent
      return first;
    };
    await t.s.onMessage(toCto());
    await t.s.idle();
    expect(new Map(rec)).toEqual(new Map([['msg-1', true], ['msg-b', true], ['msg-c', true]]));
  });

  it('R-01: a reply is recorded with the person it answered', async () => {
    const rec: [boolean, string | null][] = [];
    const t = await mk({ record: async (_id, _ch, tainted, user) => void rec.push([tainted, user]), run: async () => ({ ...chat('ok'), tainted: false, triggerUserId: '42' }) });
    await t.s.onMessage(toCto());
    await t.s.idle();
    expect(rec).toEqual([[false, '42']]);
  });

  it('G2-04: a tainted child taints its parent and the notice it posts; a clean child does not', async () => {
    for (const childTainted of [true, false]) {
      const rec: [string, string, boolean][] = [];
      const t = await mk({ record: async (id, ch, tainted) => void rec.push([id, ch, tainted]) });
      const parent = await t.tasks.create({ title: 'Parent', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'th-p', status: 'doing', tainted: false });
      const child = await t.tasks.create({ title: 'Child', deptId: 'software', owner: { kind: 'persona', personaId: 'system-analyst' }, requester: CTO, origin: 'delegated', parentId: parent.id, status: 'done', tainted: childTainted });
      await t.bus.emit('task.changed', { task: child, from: 'doing', to: 'done', summary: 'all good' });
      await t.s.idle();
      expect((await t.tasks.get(parent.id))!.tainted).toBe(childTainted);
      expect(rec[0]).toEqual(['msg-1', 'th-p', childTainted]);
    }
  });

  async function childEnded(to: 'cancelled' | 'blocked', parentStatus: Task['status'] = 'doing', reason: Task['blockedReason'] = null) {
    const t = await mk();
    const parent = await t.tasks.create({ title: 'Parent', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'th-p', status: parentStatus });
    const SA: ActorRef = { kind: 'persona', personaId: 'system-analyst' };
    const child = await t.tasks.create({ title: 'Child', deptId: 'software', owner: SA, requester: CTO, origin: 'delegated', parentId: parent.id, status: to });
    await t.tasks.update(child.id, { blockedReason: reason });
    await t.bus.emit('task.changed', { task: (await t.tasks.get(child.id))!, from: 'awaiting_approval', to });
    await t.s.idle();
    return t;
  }

  it.each(['cancelled', 'blocked'] as const)('a %s child posts a notice in the parent thread and tells the requester, with no roll-up run (final #4)', async (to) => {
    const t = await childEnded(to);
    const notices = t.port.posts.filter((p) => p.target.threadId === 'th-p');
    expect(notices).toEqual([expect.objectContaining({ actor: CTO, target: { channelId: SOFTWARE_WORK, threadId: 'th-p' } })]);
    expect(notices[0]!.payload.title).toBe(to === 'cancelled' ? 'Subtask cancelled' : 'Subtask blocked');
    expect(notices[0]!.payload.body).toContain('"Child"');
    expect(t.port.directs).toEqual([expect.objectContaining({ from: { kind: 'persona', personaId: 'system-analyst' }, to: CTO })]);
    expect(t.port.tasks).toHaveLength(1); // mirrored to #📋-tasks
    expect(t.run).not.toHaveBeenCalled();
  });

  it('a child blocked by a halt is mirrored but posts no notice (it resumes on /resume)', async () => {
    const t = await childEnded('blocked', 'doing', 'halt');
    expect(t.port.tasks).toHaveLength(1);
    expect(t.port.posts).toEqual([]);
    expect(t.port.directs).toEqual([]);
  });

  it.each([
    [true, { status: 'blocked', blockedReason: 'halt' }],
    [false, { status: 'todo', blockedReason: null }],
  ] as const)('an owner run stopped as halted parks its doing task (really halted: %s)', async (really, want) => {
    let halted = false;
    const t = await mk({
      halted: () => halted,
      run: async (tr) => {
        await t.tasks.update(tr.task!.id, { status: 'doing' });
        halted = really; // a real halt, or only an hq pause (the loop sees both as halted)
        return { ...chat('x'), stopped: 'halted' };
      },
    });
    const task = await t.tasks.create({ title: 'T', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'th-z' });
    const changed: unknown[] = [];
    t.bus.on('task.changed', (e) => void changed.push({ from: e.from, to: e.to }));
    await t.s.onTaskReady(task.id);
    await t.s.idle();
    expect(await t.tasks.get(task.id)).toMatchObject(want);
    expect(changed).toEqual([{ from: 'doing', to: want.status }]);
  });

  it('the slow-down notice for a persona route is posted by that department head', async () => {
    const t = await mk();
    const direct = '1565670817646256178'; // #🤖-ai-system-analyst
    for (let i = 0; i < 6; i++) await t.s.onMessage(humanMsg(`q${i}`, { channelId: direct }));
    await t.s.idle();
    const notice = t.port.posts.find((p) => p.payload.title === 'Slow down');
    expect(notice).toMatchObject({ actor: CTO, target: { channelId: direct } });
  });

  it.each(['done', 'cancelled', 'awaiting_approval'] as const)('a message in the thread of a %s task runs nothing and posts nothing', async (status) => {
    const t = await mk();
    await t.tasks.create({ title: 'T', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'th-x', status });
    await t.s.onMessage(humanMsg('more?', { channelId: 'th-x', threadId: 'th-x', parentChannelId: SOFTWARE_WORK }));
    await t.s.idle();
    expect(t.run).not.toHaveBeenCalled();
    expect(t.port.posts).toEqual([]);
  });
});

const toPraw = (content = 'hi', over = {}) => humanMsg(`<@113> ${content}`, { mentionedHeads: ['praw'], ...over });
const slow = (t: Awaited<ReturnType<typeof mk>>) => t.port.posts.filter((p) => p.payload.title === 'Slow down');

describe('Scheduler: Praw limits (R8, P15)', () => {
  it('21st praw request in 10 min refused with one notice, 22nd silent', async () => {
    const t = await mk();
    for (let i = 0; i < 22; i++) await t.s.onMessage(toPraw(`m${i}`));
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(20);
    expect(slow(t)).toHaveLength(1);
    expect(slow(t)[0]!.payload.body).toContain('20');
    t.advance(10 * 60 * 1000 + 1);
    await t.s.onMessage(toPraw('later'));
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(21);
  });

  it('a head (software) keeps D13: 6th human run in 10 min refused', async () => {
    const t = await mk();
    for (let i = 0; i < 6; i++) await t.s.onMessage(toCto(`m${i}`));
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(5);
    expect(slow(t)).toHaveLength(1);
  });

  it('praw-only message is exempt from humanRunsPer10Min', async () => {
    const t = await mk();
    for (let i = 0; i < 10; i++) await t.s.onMessage(toPraw(`m${i}`));
    await t.s.onMessage(toCto('head')); // D13 untouched by the ten praw messages
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(11);
    expect(slow(t)).toEqual([]);
  });

  it('message to praw and software counts in both limits', async () => {
    const t = await mk();
    const both = (i: number) => humanMsg(`<@113> <@111> m${i}`, { mentionedHeads: ['praw', 'software'] });
    for (let i = 0; i < 5; i++) await t.s.onMessage(both(i));
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(10);
    // D13 is spent (5) but praw has 15 left: the next both-message reaches praw only.
    await t.s.onMessage(both(5));
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(11);
    expect(t.runs.at(-1)!.route.actor).toEqual({ kind: 'head', dept: 'praw' });
    expect(slow(t)).toHaveLength(1);
    // The praw counter counted all 6: 14 more praw-only messages are allowed, the 15th is refused.
    for (let i = 0; i < 15; i++) await t.s.onMessage(toPraw(`p${i}`));
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(11 + 14);
  });

  it('the praw limit is per human user and follows limits.prawPerUser10Min', async () => {
    const t = await mk({ cfg: new FakeConfig({ 'limits.prawPerUser10Min': 2 }) });
    for (let i = 0; i < 3; i++) await t.s.onMessage(toPraw(`m${i}`));
    await t.s.onMessage(toPraw('other', { author: { id: '77', name: 'o', kind: 'human' } }));
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(3);
  });

  it('praw concurrency cap queues or refuses the run beyond the cap (P15)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = await mk({ cfg: new FakeConfig({ 'limits.prawConcurrency': 1 }), run: async () => (await gate, chat('ok')) });
    await t.s.onMessage(toPraw('a'));
    await t.s.onMessage(toPraw('b', { author: { id: '77', name: 'o', kind: 'human' } }));
    await vi.waitFor(() => expect(t.run).toHaveBeenCalledTimes(1));
    expect(t.port.posts.some((p) => p.payload.title === 'Busy')).toBe(true); // refused with a notice, not run
    release();
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(1);
    await t.s.onMessage(toPraw('c')); // the slot is free again
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(2);
  });

  const PRAW = { kind: 'head', dept: 'praw' } as const;
  const prawTask = (t: Awaited<ReturnType<typeof mk>>, thread: string) =>
    t.tasks.create({ title: 'T', deptId: 'praw', owner: PRAW, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: thread, channelId: SOFTWARE_WORK });

  it('a praw task run waits for a cap slot and starts after release (never refused)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let first = true;
    const t = await mk({
      cfg: new FakeConfig({ 'limits.prawConcurrency': 1 }),
      run: async () => {
        if (first) { first = false; await gate; }
        return chat('ok');
      },
    });
    await t.s.onMessage(toPraw('a'));
    await vi.waitFor(() => expect(t.run).toHaveBeenCalledTimes(1));
    const task = await prawTask(t, 'th-q');
    void t.s.onTaskReady(task.id);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.run).toHaveBeenCalledTimes(1); // waiting for the slot
    expect(t.port.posts.some((p) => p.payload.title === 'Busy')).toBe(false);
    release();
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(2);
  });

  it('a halt while a praw task run waits for the cap releases the waiter without running it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let halted = false;
    const t = await mk({ halted: () => halted, cfg: new FakeConfig({ 'limits.prawConcurrency': 1 }), run: async () => (await gate, chat('ok')) });
    await t.s.onMessage(toPraw('a'));
    await vi.waitFor(() => expect(t.run).toHaveBeenCalledTimes(1));
    const task = await prawTask(t, 'th-h');
    const job = t.s.onTaskReady(task.id);
    await new Promise((r) => setTimeout(r, 20));
    halted = true;
    await t.bus.emit('halt.changed', { halted: true, by: 'x' });
    await job;
    await new Promise((r) => setTimeout(r, 20));
    release();
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(1);
  });

  it('Busy is posted at most once per channel per minute and the refused message refunds its praw slot', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = await mk({ cfg: new FakeConfig({ 'limits.prawConcurrency': 1, 'limits.prawPerUser10Min': 2 }), run: async () => (await gate, chat('ok')) });
    await t.s.onMessage(toPraw('a', { author: { id: '1', name: 'a', kind: 'human' } }));
    await vi.waitFor(() => expect(t.run).toHaveBeenCalledTimes(1));
    const busy = () => t.port.posts.filter((p) => p.payload.title === 'Busy');
    for (let i = 0; i < 5; i++) await t.s.onMessage(toPraw(`b${i}`));
    await vi.waitFor(() => expect(busy()).toHaveLength(1));
    await t.s.onMessage(toPraw('c'));
    await new Promise((r) => setTimeout(r, 20));
    expect(busy()).toHaveLength(1); // deduped within 60 s
    t.advance(61_000);
    await t.s.onMessage(toPraw('d'));
    await vi.waitFor(() => expect(busy()).toHaveLength(2));
    release();
    await t.s.idle();
    // user 42 sent 7 refused messages with a limit of 2: refunds mean no slot was burned and no Slow down was posted.
    for (let i = 0; i < 2; i++) {
      await t.s.onMessage(toPraw(`ok${i}`));
      await t.s.idle();
    }
    expect(slow(t)).toEqual([]);
    expect(t.run).toHaveBeenCalledTimes(3);
  });

  it('praw concurrency does not limit other departments', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = await mk({ cfg: new FakeConfig({ 'limits.prawConcurrency': 1 }), run: async () => (await gate, chat('ok')) });
    await t.s.onMessage(toPraw('a'));
    await t.s.onMessage(toCto('b', { author: { id: '77', name: 'o', kind: 'human' } }));
    await vi.waitFor(() => expect(t.run).toHaveBeenCalledTimes(2));
    release();
    await t.s.idle();
  });

  it('interaction from another guild, a denied channel or a foreign bot is dropped', async () => {
    const t = await mk();
    await t.s.onMessage(toPraw('x', { channelId: '1565715069969502310' })); // denied channel
    await t.s.onMessage(toPraw('y', { author: { id: 'f', name: 'f', kind: 'foreign_bot' } }));
    await t.s.idle();
    expect(t.run).not.toHaveBeenCalled();
    expect(t.port.posts).toEqual([]);
    // another guild: ClientManager drops it before the scheduler (discord/clients.test.ts "drops other guilds" and "only from the guild").
  });
});

describe('Scheduler.ask (R7)', () => {
  const synth = (id: string, over = {}) => humanMsg('what time is it', { id, mentionedHeads: ['praw'], origin: 'slash', ...over });

  it('ask resolves with the outcome; deliver false posts nothing', async () => {
    const t = await mk({ run: async () => chat('the answer') });
    const out = await t.s.ask(synth('interaction:1'), { deliver: false });
    expect(out?.payload.body).toBe('the answer');
    expect(t.port.posts).toEqual([]);
    expect(t.runs[0]!.route.actor).toEqual({ kind: 'head', dept: 'praw' });
  });

  it('deliver defaults to true and posts as praw in the source channel', async () => {
    const t = await mk();
    const out = await t.s.ask(synth('interaction:2'));
    expect(out).not.toBeNull();
    expect(t.port.posts).toHaveLength(1);
    expect(t.port.posts[0]!.actor).toEqual({ kind: 'head', dept: 'praw' });
  });

  it('same message id twice is deduped, distinct interaction ids are not', async () => {
    const t = await mk();
    expect(await t.s.ask(synth('interaction:a'), { deliver: false })).not.toBeNull();
    expect(await t.s.ask(synth('interaction:a'), { deliver: false })).toBeNull();
    expect(await t.s.ask(synth('interaction:b'), { deliver: false })).not.toBeNull();
    expect(t.run).toHaveBeenCalledTimes(2);
  });

  it('origin comes from the option, not the message; default slash', async () => {
    const t = await mk();
    await t.s.ask(synth('interaction:o1', { origin: 'voice' }), { deliver: false });
    await t.s.ask(synth('voice:o2', { origin: 'slash' }), { deliver: false, origin: 'voice' });
    expect(t.runs.map((r) => r.msg!.origin)).toEqual(['slash', 'voice']);
  });

  it('null when halted', async () => {
    const t = await mk({ halted: () => true });
    expect(await t.s.ask(synth('interaction:h'), { deliver: false })).toBeNull();
    expect(t.run).not.toHaveBeenCalled();
  });

  it('not charged twice: preCharged true takes no slot, default takes one', async () => {
    const t = await mk({ cfg: new FakeConfig({ 'limits.prawPerUser10Min': 2 }) });
    await t.s.ask(synth('interaction:p1'), { deliver: false, preCharged: true });
    await t.s.ask(synth('interaction:p2'), { deliver: false, preCharged: true });
    expect(await t.s.ask(synth('interaction:p3'), { deliver: false })).not.toBeNull(); // nothing was charged yet
    await t.s.ask(synth('interaction:p4'), { deliver: false });
    expect(await t.s.ask(synth('interaction:p5'), { deliver: false })).toBeNull(); // 2 uncharged-by-caller asks took 2 slots
    expect(t.run).toHaveBeenCalledTimes(4);
  });

  it('over the praw cap: null, no run, the slot is refunded, no Busy post in the channel', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = await mk({ cfg: new FakeConfig({ 'limits.prawConcurrency': 1, 'limits.prawPerUser10Min': 2 }), run: async () => (await gate, chat('ok')) });
    const first = t.s.ask(synth('interaction:c1'), { deliver: false });
    await vi.waitFor(() => expect(t.run).toHaveBeenCalledTimes(1));
    expect(await t.s.ask(synth('interaction:c2'), { deliver: false })).toBeNull();
    expect(t.port.posts).toEqual([]);
    release();
    await first;
    // c2's slot was refunded: two more asks fit in the limit of 2 (c1 holds one)
    expect(await t.s.ask(synth('interaction:c3'), { deliver: false })).not.toBeNull();
  });

  it('jobCapacity › submitted job roots count against Praw capacity until they hold a slot, then it recovers', async () => {
    const cfg = new FakeConfig({ 'limits.prawConcurrency': 3 });
    const t = await mk({ cfg });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const create = t.port.createThread.bind(t.port);
    t.port.createThread = async (...a: Parameters<typeof create>) => { await gate; return create(...a); };
    expect(await t.s.jobCapacity()).toBe(3);
    const root = (i: number) => ({
      title: `job ${i}`, description: 'd', deptId: 'praw' as const, owner: { kind: 'head', dept: 'praw' } as ActorRef, requester: { kind: 'head', dept: 'praw' } as ActorRef,
      origin: 'schedule' as const, channelId: SOFTWARE_WORK, sourceUserId: 'u1', status: 'todo' as const, depth: 0,
    });
    for (let i = 0; i < 3; i++) expect(await t.s.submitTask(root(i))).not.toBeNull();
    expect(await t.s.jobCapacity()).toBe(0); // thread setup is blocked: the roots are invisible to the Praw cap but still pending
    release();
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(3);
    expect(await t.s.jobCapacity()).toBe(3);
  });

  it('jobCapacity › is 0 while halted', async () => {
    let halted = true;
    const t = await mk({ halted: () => halted });
    expect(await t.s.jobCapacity()).toBe(0);
    halted = false;
    expect(await t.s.jobCapacity()).toBeGreaterThan(0);
  });
});

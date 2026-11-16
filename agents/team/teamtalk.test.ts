import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCalendar } from '../../company/calendar.js';
import type { ActorRef } from '../../company/types.js';
import { handlesIn } from '../../company/handles.js';
import type { Task } from '../../db/repos/tasks.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { CH, roundTrip } from '../../tests/fakes/roundtrip.js';
import { FakeDiscordPort } from '../../tests/fakes/discordPort.js';
import { historyTaints, ownUserOf } from '../context.js';
import type { AgentDeps, AgentOutcome, AgentTrigger } from '../loop/loop.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { TeamTalk } from './teamtalk.js';
import { CTO, MemRoomEntries, MemTasks, newBus, noApprovedTools, seededOrg } from '../test-helpers.js';
import type { IncomingMessage } from '../../company/types.js';

const GUILD = '1565649426943442944';
const SOFTWARE_WORK = '1565682159375749161';
const SA_DIRECT = '1565670817646256178';
const HQ_WORK = '1565652605290414160';
const SA: ActorRef = { kind: 'persona', personaId: 'system-analyst' };
const HQ: ActorRef = { kind: 'head', dept: 'hq' };
const human = { kind: 'human', userId: '42' } as const;
const TH1 = '1570000000000009001'; // the first thread the (snowflake) fake port opens
const TM = '1570000000000000703';
const TG = '1570000000000000702';
const TP = '1570000000000000700';
const SECRET = 'sk-PLANTED-secret-Zq81xK77';
const SAT = Date.parse('2026-11-07T03:00:00Z');
const chat = (body: string, extra: Partial<AgentOutcome> = {}): AgentOutcome => ({ payload: { type: 'chat', body }, costUsd: 0, turns: 1, ...extra });
const quiet = { error: () => undefined, warn: () => undefined };
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

type Rec = { id: string; channelId: string; tainted: boolean; userId: string | null; answer: boolean };

async function mk(o: { enabled?: () => boolean; halted?: () => boolean; run?: (t: AgentTrigger, w: Awaited<ReturnType<typeof mkBase>>) => Promise<AgentOutcome>; secrets?: string[]; now?: number; offDay?: boolean } = {}) {
  const w = await mkBase(o);
  return w;
}
async function mkBase(o: { enabled?: () => boolean; halted?: () => boolean; run?: (t: AgentTrigger, w: never) => Promise<AgentOutcome>; secrets?: string[]; now?: number; offDay?: boolean }) {
  const cfg = new FakeConfig(o.offDay ? { 'schedule.offDays': [0, 6], 'schedule.holidays': [] } : {});
  const tasks = new MemTasks() as MemTasks & { findByThread(id: string): Promise<Task | null> };
  tasks.findByThread = async (id) => [...tasks.rows.values()].find((t) => t.threadId === id) ?? null;
  const port = new FakeDiscordPort();
  port.snowflakes = true;
  const bus = newBus();
  const org = await seededOrg();
  const rooms = new MemRoomEntries();
  const records: Rec[] = [];
  const record = async (id: string, channelId: string, tainted: boolean, userId: string | null, answer = false) => void records.push({ id, channelId, tainted, userId, answer });
  const halt = { isHalted: o.halted ?? (() => false) };
  let clock = o.now ?? 1_000_000;
  const tt = new TeamTalk({ port, tasks, rooms, org, halt, ...(o.enabled ? { enabled: o.enabled } : {}), secrets: o.secrets ?? [], guildId: GUILD, log: quiet, provenance: { record }, now: () => clock });
  const runs: AgentTrigger[] = [];
  const self: { w?: unknown } = {};
  const run = vi.fn(async (t: AgentTrigger) => {
    runs.push(t);
    return o.run ? o.run(t, self.w as never) : chat('ok');
  });
  const s = new Scheduler({
    agent: {} as AgentDeps, approvedTools: noApprovedTools, run, port, org, tasks, limits: new Limits(cfg, tasks), halt, cfg, bus, log: quiet, now: () => clock,
    provenance: { record }, teamtalk: tt, secrets: o.secrets ?? [], ...(o.offDay ? { calendar: createCalendar(cfg) } : {}),
  });
  s.attach();
  // what TaskRepo.claimMessage does for real: the stored id of the handoff line is on the child's row
  port.onHandoff = (taskId, id) => { const r = tasks.rows.get(taskId); if (r) r.handoffMessageId = id; };
  const w = { s, port, tasks, bus, runs, run, rooms, records, tt, org, advance: (ms: number) => (clock += ms) };
  self.w = w;
  return w;
}
type W = Awaited<ReturnType<typeof mk>>;

const mkParent = (w: W, over: Partial<Parameters<MemTasks['create']>[0]> = {}) =>
  w.tasks.create({ title: 'Parent', deptId: 'software', owner: CTO, requester: human, origin: 'chat', threadId: TP, status: 'doing', ...over });
const mkChild = (w: W, parent: Task, over: Partial<Parameters<MemTasks['create']>[0]> = {}) =>
  w.tasks.create({ title: 'Child @CFO', deptId: 'software', owner: SA, requester: CTO, origin: 'delegated', parentId: parent.id, acceptance: 'tests are green', dueOn: '2026-11-20', tainted: false, ...over });
async function started(w: W, over: { parent?: Partial<Parameters<MemTasks['create']>[0]>; child?: Partial<Parameters<MemTasks['create']>[0]> } = {}) {
  const parent = await mkParent(w, over.parent);
  const child = await mkChild(w, parent, over.child);
  await w.bus.emit('task.created', { task: child });
  await w.s.idle();
  return { parent, child };
}
const inParent = (w: W) => w.port.posts.filter((p) => p.target.threadId === TP);
const roomLines = (w: W) => w.port.posts.filter((p) => p.target.channelId === SA_DIRECT && !p.target.threadId);
const bodyOf = (p: { payload: { body: string } }) => p.payload.body;
const where = { channelId: CH.work, threadId: CH.thread };
const parentLike = { id: 'p1', owner: CTO, requester: human, deptId: 'software', parentId: null, rootId: 'p1', depth: 0, status: 'doing', threadId: CH.thread, channelId: null, origin: 'chat', tainted: false } as unknown as Task;

afterEach(() => vi.useRealTimers());

describe('TEAMTALK H1 handoff line (T3, T7, T11, spec a)', () => {
  it('a delegation posts ONE plain handoff line in the parent thread as the parent owner, with the card fields, and uses no extra model turn', async () => {
    const w = await mk();
    const { child } = await started(w);
    const h1 = inParent(w);
    expect(h1).toHaveLength(1);
    expect(h1[0]!.actor).toEqual(CTO);
    expect(h1[0]!.payload).toMatchObject({ type: 'chat', noHandles: true });
    const b = bodyOf(h1[0]!);
    expect(b).toContain(`➜ Handoff #${child.id.slice(0, 8)}: head of software → system-analyst`);
    expect(b).toContain('Ask: Child @CFO');
    expect(b).toContain('Done when: tests are green');
    expect(b).toContain('Due: 2026-11-20   Status: todo');
    expect(b).toContain(`Thread: https://discord.com/channels/${GUILD}/${TH1}`);
    expect(b.length).toBeLessThanOrEqual(600);
    expect(w.runs).toHaveLength(1); // only the owner's own run; the line itself started no model turn
    expect(w.runs[0]!.route.actor).toEqual(SA);
    expect(w.port.directs).toHaveLength(1); // scheduler.test.ts:415: only the one existing #direct line, room lines never use logDirect
  });

  it('without acceptance and due it says "see brief" and "none"', async () => {
    const w = await mk();
    await started(w, { child: { acceptance: null, dueOn: null } });
    expect(bodyOf(inParent(w)[0]!)).toContain('Done when: see brief');
    expect(bodyOf(inParent(w)[0]!)).toContain('Due: none');
  });

  it('every new post has a provenance row (answer false); R-B uses the PARENT task\'s person, the child\'s taint', async () => {
    for (const childTainted of [false, true]) {
      const w = await mk();
      await started(w, { child: { tainted: childTainted } });
      const h1 = inParent(w)[0]!;
      const rec = w.records.find((r) => r.id === w.port.handoffIds.values().next().value)!;
      expect(rec).toMatchObject({ channelId: TP, tainted: childTainted, userId: '42', answer: false });
      expect(h1.id).toBe(rec.id);
      const room = w.records.filter((r) => r.channelId === SA_DIRECT);
      expect(room.length).toBeGreaterThan(0);
      for (const r of w.records.filter((x) => [h1.id, ...roomLines(w).map((p) => p.id)].includes(x.id))) expect(r.answer).toBe(false);
    }
  });

  it('spec (b) / T5: a later person-started run in the parent thread starts clean when the child was clean, and tainted when it was tainted', async () => {
    for (const childTainted of [false, true]) {
      const w = await mk();
      const { parent } = await started(w, { child: { tainted: childTainted } });
      const h1 = inParent(w)[0]!;
      const history: IncomingMessage[] = [{ id: h1.id, channelId: TP, parentChannelId: SOFTWARE_WORK, threadId: TP, author: { id: 'b', name: 'CTO', kind: 'head', actor: CTO }, content: bodyOf(h1), mentionedHeads: [], isAdmin: false, attachments: [], origin: 'chat' }];
      const lookup = async (ids: string[]) => new Map(w.records.filter((r) => ids.includes(r.id)).map((r) => [r.id, { tainted: r.tainted, userId: r.userId }]));
      expect(await historyTaints(history, { own: ownUserOf({ task: parent }) }, lookup)).toBe(childTainted);
    }
  });

  it('zero routes: the handoff line, read back through the real mapper and router, wakes nobody (title and Done when carry @CFO)', async () => {
    const w = await mk();
    await started(w, { child: { acceptance: 'ask @CEO and @CTO' } });
    const h1 = inParent(w)[0]!;
    const r = await roundTrip(CTO, where, h1.payload, { task: parentLike });
    expect(r.routes).toEqual([]);
    expect(handlesIn(String(r.sent.content))).toEqual([]);
  });

  it('a top-level conversation parent gets no handoff line (WS13)', async () => {
    const w = await mk();
    await started(w, { parent: { threadId: SOFTWARE_WORK, channelId: SOFTWARE_WORK, conversation: true } });
    expect(w.port.posts.filter((p) => p.target.channelId === SOFTWARE_WORK && bodyOf(p).startsWith('➜'))).toEqual([]);
    expect(w.port.handoffIds.size).toBe(0);
  });

  it('a persona parent owner posts the handoff line itself (T3: the poster is the owner of the receiving thread)', async () => {
    const w = await mk();
    const parent = await mkParent(w, { owner: SA, threadId: '1570000000000000701', channelId: SA_DIRECT, requester: human });
    const child = await mkChild(w, parent, { owner: CTO, requester: SA });
    await w.bus.emit('task.created', { task: child });
    await w.s.idle();
    const h1 = w.port.posts.find((p) => bodyOf(p).startsWith('➜'))!;
    expect(h1.actor).toEqual(SA);
    expect(h1.target).toEqual({ channelId: SA_DIRECT, threadId: '1570000000000000701' });
  });

  it('T7: a status event that lands before the line exists posts nothing; afterwards status changes only edit', async () => {
    const w = await mk();
    const parent = await mkParent(w);
    const child = await mkChild(w, parent);
    // the status event comes first (a fast owner run): edit-only, so no line and no second line later
    await w.tasks.update(child.id, { status: 'doing' });
    await w.bus.emit('task.changed', { task: (await w.tasks.get(child.id))!, from: 'todo', to: 'doing' });
    await w.s.idle();
    expect(inParent(w)).toEqual([]);
    await w.bus.emit('task.created', { task: child });
    await w.s.idle();
    expect(inParent(w)).toHaveLength(1);
    expect(bodyOf(inParent(w)[0]!)).toContain('Status: doing'); // built from the fresh row
    await w.tasks.update(child.id, { status: 'review' });
    await w.bus.emit('task.changed', { task: (await w.tasks.get(child.id))!, from: 'doing', to: 'review' });
    await w.s.idle();
    expect(inParent(w)).toHaveLength(1);
    expect(w.port.handoffEdits.map((e) => e.status)).toContain('review');
  });

  it('spec (f): on an off day the line shows the hold, no bot run starts, and the first status change edits it', async () => {
    const w = await mk({ offDay: true, now: SAT });
    const { child } = await started(w);
    const lines = () => inParent(w).filter((p) => bodyOf(p).startsWith('➜'));
    expect(bodyOf(lines()[0]!)).toContain('Status: todo (starts next workday)');
    expect(w.run).not.toHaveBeenCalled();
    await w.tasks.update(child.id, { status: 'doing' });
    await w.bus.emit('task.changed', { task: (await w.tasks.get(child.id))!, from: 'todo', to: 'doing' });
    await w.s.idle();
    expect(lines()).toHaveLength(1);
    expect(w.port.handoffEdits.at(-1)!.payload.body).toContain('Status: doing');
    expect(w.port.handoffEdits.at(-1)!.payload.body).not.toContain('starts next workday');
  });

  it('T11: halted, no handoff line, no edit, no room line', async () => {
    const w = await mk({ halted: () => true });
    const { child } = await started(w);
    expect(inParent(w)).toEqual([]);
    expect(roomLines(w)).toEqual([]);
    await w.bus.emit('task.changed', { task: child, from: 'todo', to: 'doing' });
    await w.s.idle();
    expect(w.port.handoffEdits).toEqual([]);
  });

  it('spec (g): a Discord failure while posting never stops the task', async () => {
    const w = await mk();
    w.port.failPost = new Error('Missing Permissions');
    const parent = await mkParent(w);
    const child = await mkChild(w, parent);
    await w.bus.emit('task.created', { task: child });
    await w.s.idle();
    expect(w.run).toHaveBeenCalledTimes(1);
    expect((await w.tasks.get(child.id))!.status).toBe('todo');
  });
});

describe('TEAMTALK H2 task card', () => {
  it('carries Done when, Due and Back to (the parent thread link); a task without them has none of the three', async () => {
    const w = await mk();
    const { child } = await started(w);
    const card = w.port.posts.find((p) => p.payload.type === 'task' && p.target.threadId === TH1)!;
    const names = (card.payload.fields ?? []).map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['Done when', 'Due', 'Back to']));
    expect(card.payload.fields!.find((f) => f.name === 'Back to')!.value).toBe(`https://discord.com/channels/${GUILD}/${TP}`);
    expect(card.payload.fields!.find((f) => f.name === 'Due')!.value).toBe('2026-11-20');
    const w2 = await mk();
    await started(w2, { child: { acceptance: null, dueOn: null } });
    const names2 = (w2.port.posts.find((p) => p.payload.type === 'task')!.payload.fields ?? []).map((f) => f.name);
    expect(names2).not.toContain('Done when');
    expect(names2).not.toContain('Due');
    expect(child.id).toBeTruthy();
  });

  it('T2: the card read back through the real mapper and router wakes nobody (@CFO in title, description and Done when)', async () => {
    const w = await mk();
    await started(w, { child: { acceptance: 'the @CEO agrees', title: 'Plan @CFO', description: 'ask @CTO' } });
    const card = w.port.posts.find((p) => p.payload.type === 'task' && p.target.threadId === TH1)!;
    // the card's thread is the persona room's; the round trip posts it as the persona into the room thread of the real pipeline
    const r = await roundTrip(CTO, where, card.payload, { task: parentLike });
    expect(r.routes).toEqual([]);
    expect(JSON.stringify(r.sent)).not.toMatch(/<@\d/);
  });
});

/** The child's own run reports done through update_task INSIDE its run, then delivers its final report. */
const finishingRun = (childTitle: string, o: { summary: string; report: string; tainted?: boolean }) => async (t: AgentTrigger, w: W): Promise<AgentOutcome> => {
  if (t.route.reason === 'task_owner' && t.task && t.task.title === childTitle && !t.msg) {
    const done = (await w.tasks.update(t.task.id, { status: 'done' }))!;
    await w.bus.emit('task.changed', { task: done, from: 'doing', to: 'done', summary: o.summary });
    await tick(); // the event handler is a separate job; it must wait for this run to finish, not race it
    return chat(o.report, { tainted: o.tainted ?? false });
  }
  return chat('rolled up');
};

describe('TEAMTALK H3 subtask report and H4 roll-up (T1, T3, T5, T6, spec c)', () => {
  it('the report is posted after the owner\'s final report: replies to the handoff line, links the result, noHandles, provenance answer false, as the parent owner', async () => {
    const w = await mk({ run: finishingRun('Child @CFO', { summary: 'parser shipped, ask @CFO', report: 'FINAL REPORT TEXT' }) });
    const { parent, child } = await started(w);
    const report = inParent(w).find((p) => p.payload.title === 'Subtask done')!;
    expect(report.actor).toEqual(CTO);
    expect(report.payload).toMatchObject({ type: 'chat', title: 'Subtask done', noHandles: true });
    const result = w.port.posts.find((p) => p.target.threadId === TH1 && bodyOf(p) === 'FINAL REPORT TEXT')!;
    expect(bodyOf(report)).toContain('"Child @CFO": parser shipped, ask @CFO');
    expect(bodyOf(report)).toContain(`Full result: https://discord.com/channels/${GUILD}/${TH1}/${result.id}`);
    expect(report.opts?.replyToId).toBe(w.port.handoffIds.get(child.id));
    expect((await w.tasks.get(child.id))!.resultMessageId).toBe(result.id);
    expect(w.records.find((r) => r.id === report.id)).toMatchObject({ channelId: TP, tainted: false, userId: ownUserOf({ task: parent }), answer: false });
    // posted AFTER the owner's final report
    expect(w.port.posts.indexOf(report)).toBeGreaterThan(w.port.posts.indexOf(result));
  });

  it('spec (c) / F-1: @CFO in the summary AND the title does not route, end to end through the real mapper and router (the same text without noHandles does)', async () => {
    const w = await mk({ run: finishingRun('Child @CFO', { summary: 'please review @CFO and @CEO', report: 'r' }) });
    await started(w);
    const report = inParent(w).find((p) => p.payload.title === 'Subtask done')!;
    const safe = await roundTrip(CTO, where, report.payload, { task: parentLike });
    expect(safe.routes).toEqual([]);
    expect(handlesIn(String(safe.sent.content))).toEqual([]);
    const { noHandles: _drop, ...old } = report.payload;
    void _drop;
    expect((await roundTrip(CTO, where, old, { task: parentLike })).routes.length).toBeGreaterThan(0); // today's behaviour: F-1
  });

  it('F-1 holds without TeamTalk wired too (the fix is not behind the feature)', async () => {
    const cfg = new FakeConfig();
    const tasks = new MemTasks();
    const port = new FakeDiscordPort();
    const bus = newBus();
    const s = new Scheduler({ agent: {} as AgentDeps, approvedTools: noApprovedTools, run: async () => chat('x'), port, org: await seededOrg(), tasks, limits: new Limits(cfg, tasks), halt: { isHalted: () => false }, cfg, bus, log: quiet });
    s.attach();
    const parent = await tasks.create({ title: 'P', deptId: 'software', owner: CTO, requester: human, origin: 'chat', threadId: TP, status: 'doing' });
    const child = await tasks.create({ title: 'C @CFO', deptId: 'software', owner: SA, requester: CTO, origin: 'delegated', parentId: parent.id, status: 'done' });
    await bus.emit('task.changed', { task: child, from: 'doing', to: 'done', summary: '@CFO' });
    await s.idle();
    expect(port.posts.find((p) => p.payload.title === 'Subtask done')!.payload.noHandles).toBe(true);
  });

  it('T6: the owner\'s final report (first 1500 characters) reaches the roll-up run, and a tainted continuation taints the parent BEFORE it', async () => {
    let parentTaintedAtRollup: boolean | undefined;
    const w = await mk({
      run: async (t, w2) => {
        if (t.route.taskId && t.msg && t.task?.title === 'Parent') {
          parentTaintedAtRollup = (await w2.tasks.get(t.task.id))!.tainted;
          return chat('rolled up');
        }
        return finishingRun('Child @CFO', { summary: 'done', report: `REPORT-${'x'.repeat(2000)}`, tainted: true })(t, w2);
      },
    });
    await started(w);
    const rollup = w.runs.find((t) => t.msg && t.task?.title === 'Parent')!;
    expect(rollup.msg!.content).toContain('The owner\'s final report (first 1500 characters)');
    expect(rollup.msg!.content).toContain('REPORT-');
    expect(rollup.msg!.content.length).toBeLessThan(1500 + 400);
    expect(parentTaintedAtRollup).toBe(true);
  });

  it.each([['thread', { threadId: TP }], ['top-level channel', { threadId: SOFTWARE_WORK, channelId: SOFTWARE_WORK }]] as const)(
    'H4 in a head conversation (%s): the kept report that the roll-up reads carries the final-report excerpt, bounded, and the parent is tainted first', async (_n, parentOver) => {
      let taintedAtRollup: boolean | undefined;
      const w = await mk({
        run: async (t, w2) => {
          if (t.route.taskId && t.msg && t.task?.title === 'Parent') {
            taintedAtRollup = (await w2.tasks.get(t.task.id))!.tainted;
            return chat('rolled up');
          }
          return finishingRun('Child @CFO', { summary: 'S'.repeat(1500), report: `EXCERPT-START ${'r'.repeat(3000)}`, tainted: true })(t, w2);
        },
      });
      await started(w, { parent: { conversation: true, ...parentOver } });
      const rollup = w.runs.find((t) => t.msg && t.task?.title === 'Parent')!;
      expect(rollup.msg!.content).toContain('EXCERPT-START');
      expect(rollup.msg!.content).toContain('The owner\'s final report (first 1500 characters)');
      expect(rollup.msg!.content.length).toBeLessThanOrEqual(2000);
      expect(taintedAtRollup).toBe(true);
    });

  it('T6: without a final report (restart, halt) the roll-up falls back to the summary only, as before', async () => {
    const w = await mk();
    const parent = await mkParent(w);
    const child = await mkChild(w, parent, { status: 'done', threadId: '1570000000000000709', channelId: SA_DIRECT });
    await w.bus.emit('task.changed', { task: child, from: 'doing', to: 'done', summary: 'only the summary' });
    await w.s.idle();
    const rollup = w.runs.find((t) => t.msg && t.task?.title === 'Parent')!;
    expect(rollup.msg!.content).toContain('only the summary');
    expect(rollup.msg!.content).not.toContain('final report');
    const report = inParent(w).find((p) => p.payload.title === 'Subtask done')!;
    expect(bodyOf(report)).not.toContain('Full result');
  });

  it('a mid-level child that finishes INSIDE a roll-up turn still gets its link and its report excerpt in the next level', async () => {
    const w = await mk({
      run: async (t, w2) => {
        if (t.route.taskId && t.msg && t.task?.title === 'Mid') {
          const done = (await w2.tasks.update(t.task.id, { status: 'done' }))!;
          await w2.bus.emit('task.changed', { task: done, from: 'doing', to: 'done', summary: 'mid summary' });
          await tick();
          return chat('MID FINAL REPORT');
        }
        return chat('ok');
      },
    });
    const top = await w.tasks.create({ title: 'Top', deptId: 'hq', owner: HQ, requester: human, origin: 'chat', threadId: '1570000000000000702', channelId: HQ_WORK, status: 'doing' });
    const mid = await w.tasks.create({ title: 'Mid', deptId: 'software', owner: CTO, requester: HQ, origin: 'delegated', parentId: top.id, threadId: '1570000000000000703', channelId: SOFTWARE_WORK, status: 'doing' });
    const leaf = await w.tasks.create({ title: 'Leaf', deptId: 'software', owner: SA, requester: CTO, origin: 'delegated', parentId: mid.id, threadId: '1570000000000000707', channelId: SA_DIRECT, status: 'done' });
    await w.bus.emit('task.changed', { task: leaf, from: 'doing', to: 'done', summary: 'leaf summary' });
    await w.s.idle();
    const midResult = w.port.posts.find((p) => p.target.threadId === TM && bodyOf(p) === 'MID FINAL REPORT')!;
    const report = w.port.posts.find((p) => p.target.threadId === TG && p.payload.title === 'Subtask done')!;
    expect(bodyOf(report)).toContain(`Full result: https://discord.com/channels/${GUILD}/${TM}/${midResult.id}`);
    expect(report.actor).toEqual(HQ);
    const topRollup = w.runs.find((t) => t.msg && t.task?.title === 'Top')!;
    expect(topRollup.msg!.content).toContain('MID FINAL REPORT');
  });

  it('DEFECT-3: the recovery roll-up states only what is known (no claim that a notice is in the thread, no report text)', async () => {
    const w = await mk();
    const parent = await mkParent(w);
    await mkChild(w, parent, { status: 'done', threadId: '1570000000000000709', channelId: SA_DIRECT });
    expect(await (w.s as unknown as { recoverRollup(p: Task): Promise<boolean> }).recoverRollup(parent)).toBe(true);
    await w.s.idle();
    const content = w.runs.find((t) => t.msg && t.task?.title === 'Parent')!.msg!.content;
    expect(content).toContain('finished "Child @CFO"');
    expect(content).not.toContain('the notice is in this thread');
    expect(content).toContain('not available after a restart');
  });

  it('T11: halted, no subtask report is posted and the task state is unchanged', async () => {
    const w = await mk({ halted: () => true });
    const parent = await mkParent(w);
    const child = await mkChild(w, parent, { status: 'done', threadId: '1570000000000000709', channelId: SA_DIRECT });
    await w.bus.emit('task.changed', { task: child, from: 'doing', to: 'done', summary: 's' });
    await w.s.idle();
    expect(inParent(w)).toEqual([]);
  });
});

describe('TEAMTALK room lines (T9, T10, T12, spec a, d)', () => {
  it('a persona-owned delegation writes "New" in its room at the top level, as the persona, and the entry carries the child\'s taint; zero routes', async () => {
    const w = await mk();
    const { child } = await started(w, { child: { tainted: true } });
    const lines = roomLines(w);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.actor).toEqual(SA);
    expect(lines[0]!.payload).toMatchObject({ type: 'chat', noHandles: true });
    expect(bodyOf(lines[0]!)).toContain('📥 New: Child @CFO from head of software · due 2026-11-20');
    expect(bodyOf(lines[0]!)).toContain(`https://discord.com/channels/${GUILD}/${TH1}`);
    expect(bodyOf(lines[0]!).length).toBeLessThanOrEqual(400);
    const [e] = w.rooms.rows;
    expect(e).toMatchObject({ personaId: 'system-analyst', deptId: 'software', kind: 'assigned', taskId: child.id, tainted: true, messageId: lines[0]!.id });
    expect(w.records.find((r) => r.id === lines[0]!.id)).toMatchObject({ channelId: SA_DIRECT, tainted: true, answer: false });
    const r = await roundTrip(SA, { channelId: CH.room }, lines[0]!.payload);
    expect(r.routes).toEqual([]);
  });

  it('a head-owned task writes no room line', async () => {
    const w = await mk();
    const parent = await mkParent(w);
    const child = await mkChild(w, parent, { owner: { kind: 'head', dept: 'hq' }, deptId: 'hq' });
    await w.bus.emit('task.created', { task: child });
    await w.s.idle();
    expect(w.rooms.rows).toHaveLength(0);
    expect(w.port.posts.filter((p) => p.actor.kind === 'persona')).toEqual([]);
  });

  it('done writes "Done: title: summary (<=250) · result link"; blocked and cancelled write their own line; a halt-block writes none', async () => {
    const w = await mk({ run: finishingRun('Child @CFO', { summary: `${'s'.repeat(400)}`, report: 'RESULT' }) });
    const { child } = await started(w);
    const done = roomLines(w).find((p) => bodyOf(p).startsWith('✅ Done:'))!;
    expect(bodyOf(done)).toMatch(/^✅ Done: Child @CFO: s{200,250}…? · https:\/\/discord\.com\/channels\/\d+\/\d+\/\d+$/);
    expect(bodyOf(done).length).toBeLessThanOrEqual(400);
    const w2 = await mk();
    const p2 = await mkParent(w2);
    const c2 = await mkChild(w2, p2, { status: 'blocked', threadId: '1570000000000000709', channelId: SA_DIRECT });
    await w2.tasks.update(c2.id, { blockedReason: 'budget' });
    await w2.bus.emit('task.changed', { task: (await w2.tasks.get(c2.id))!, from: 'doing', to: 'blocked' });
    await w2.tasks.update(c2.id, { status: 'cancelled' });
    await w2.bus.emit('task.changed', { task: (await w2.tasks.get(c2.id))!, from: 'blocked', to: 'cancelled' });
    const c3 = await mkChild(w2, p2, { title: 'Held', status: 'blocked', threadId: '1570000000000000708', channelId: SA_DIRECT });
    await w2.tasks.update(c3.id, { blockedReason: 'halt' });
    await w2.bus.emit('task.changed', { task: (await w2.tasks.get(c3.id))!, from: 'doing', to: 'blocked' });
    await w2.s.idle();
    const bodies = roomLines(w2).map(bodyOf);
    expect(bodies.some((b) => b.startsWith('⛔ Blocked: Child @CFO (budget)'))).toBe(true);
    expect(bodies.some((b) => b.startsWith('🚫 Cancelled: Child @CFO'))).toBe(true);
    expect(bodies.some((b) => b.includes('Held'))).toBe(false);
    expect(child.id).toBeTruthy();
  });

  it('TASKADMIN-1: an owner block writes the reason into the room line (masked, one line); an approval block still writes none', async () => {
    const w = await mk();
    const p = await mkParent(w);
    const c = await mkChild(w, p, { status: 'blocked', threadId: '1570000000000000709', channelId: SA_DIRECT });
    await w.tasks.update(c.id, { blockedReason: 'owner' });
    await w.bus.emit('task.changed', { task: (await w.tasks.get(c.id))!, from: 'doing', to: 'blocked', summary: `need the vendor key ${SECRET}\nplease` });
    await w.s.idle();
    const b = roomLines(w).map(bodyOf).find((x) => x.startsWith('⛔ Blocked: Child @CFO (owner)'))!;
    expect(b).toContain(': need the vendor key');
    expect(b).not.toContain('\n');
  });

  it('T10: a literal secret in a summary is absent from the stored entry and from the room line', async () => {
    const w = await mk({ secrets: [SECRET], run: finishingRun('Child @CFO', { summary: `used key ${SECRET} to deploy`, report: 'r' }) });
    await started(w);
    expect(JSON.stringify(w.rooms.rows)).not.toContain(SECRET);
    expect(JSON.stringify(roomLines(w))).not.toContain(SECRET);
    expect(w.rooms.rows.some((r) => r.kind === 'done')).toBe(true);
  });

  it('spec (d): a tainted child makes tainted entries; a clean child clean ones', async () => {
    for (const tainted of [false, true]) {
      const w = await mk({ run: finishingRun('Child @CFO', { summary: 'ok', report: 'r', tainted: false }) });
      await started(w, { child: { tainted } });
      expect(w.rooms.rows.map((r) => r.tainted)).toEqual(w.rooms.rows.map(() => tainted));
    }
  });

  it('T12: ideas and decisions (3 + 3 per call) become lines with the run taint; the 7th is dropped (counted per task); only for a persona owner', async () => {
    const w = await mk();
    const { child } = await started(w);
    const event = (ideas: string[], decisions: string[], runTainted: boolean) => w.bus.emit('task.changed', { task: child, from: 'todo', to: 'doing', ideas, decisions, runTainted });
    await event(['i1', 'i2', 'i3'], ['d1', 'd2', 'd3'], false);
    await w.s.idle();
    await event(['i4'], ['d4'], true);
    await w.s.idle();
    const notes = w.rooms.rows.filter((r) => r.kind === 'idea' || r.kind === 'decision');
    expect(notes.map((r) => r.body)).toEqual(['i1', 'i2', 'i3', 'd1', 'd2', 'd3']);
    expect(notes.every((r) => !r.tainted)).toBe(true);
    const lines = roomLines(w).map(bodyOf);
    expect(lines.some((l) => /^💡 Idea: i1 · /.test(l))).toBe(true);
    expect(lines.some((l) => l.startsWith('📌 Decision: d3'))).toBe(true);
    expect(lines.some((l) => l.includes('i4'))).toBe(false);
    // a tainted run taints its entries (separate task so the cap does not hide it)
    const c2 = await mkChild(w, (await w.tasks.get(child.parentId!))!, { title: 'Second' });
    await w.bus.emit('task.changed', { task: c2, from: 'todo', to: 'doing', ideas: ['dirty idea'], runTainted: true });
    await w.s.idle();
    expect(w.rooms.rows.find((r) => r.body === 'dirty idea')!.tainted).toBe(true);
    // a head-owned task never writes notes
    const h = await mkChild(w, (await w.tasks.get(child.parentId!))!, { title: 'HeadOwned', owner: HQ, deptId: 'hq' });
    await w.bus.emit('task.changed', { task: h, from: 'todo', to: 'doing', ideas: ['x'], runTainted: false });
    await w.s.idle();
    expect(w.rooms.rows.some((r) => r.body === 'x')).toBe(false);
  });

  it('T12: at most 4 lifecycle lines per task', async () => {
    const w = await mk();
    const { child } = await started(w); // 1 assigned
    for (let i = 0; i < 5; i++) {
      await w.tasks.update(child.id, { status: 'blocked', blockedReason: 'budget' });
      await w.bus.emit('task.changed', { task: (await w.tasks.get(child.id))!, from: 'doing', to: 'blocked' });
      await w.s.idle();
    }
    expect(w.rooms.rows.filter((r) => r.taskId === child.id && ['assigned', 'blocked'].includes(r.kind))).toHaveLength(4);
    // DEFECT-1: the end of the task is still recorded after the counted lines are used up, once
    for (let i = 0; i < 2; i++) {
      await w.tasks.update(child.id, { status: 'done' });
      await w.bus.emit('task.changed', { task: (await w.tasks.get(child.id))!, from: 'doing', to: 'done', summary: 'finally' });
      await w.s.idle();
    }
    expect(w.rooms.rows.filter((r) => r.taskId === child.id && r.kind === 'done')).toHaveLength(1);
  });

  it('T11: halted, no room line is stored or posted', async () => {
    const w = await mk({ halted: () => true });
    await started(w);
    expect(w.rooms.rows).toHaveLength(0);
  });
});

describe('TEAMTALK work board (spec e, T4, T5, T8, T13)', () => {
  const standalone = async (o: { halted?: boolean } = {}) => {
    vi.useFakeTimers();
    const port = new FakeDiscordPort();
    port.snowflakes = true;
    const tasks = new MemTasks();
    const rooms = new MemRoomEntries();
    const org = await seededOrg();
    const records: Rec[] = [];
    let clock = 5_000_000;
    const warns: unknown[] = [];
    const halt = { isHalted: () => o.halted === true };
    const tt = new TeamTalk({ port, tasks, rooms, org, halt, guildId: GUILD, log: { error: () => undefined, warn: (x) => void warns.push(x) }, provenance: { record: async (id, channelId, tainted, userId, answer = false) => void records.push({ id, channelId, tainted, userId, answer }) }, now: () => clock });
    tt.bind({ post: async () => null });
    return { port, tasks, rooms, tt, records, warns, advance: (ms: number) => { clock += ms; return vi.advanceTimersByTimeAsync(ms); } };
  };

  it('is sent once by the persona, edited (never reposted) on later changes, at most once per 60 s per room', async () => {
    const t = await standalone();
    await t.tasks.create({ title: 'Parser @CFO', deptId: 'software', owner: SA, requester: CTO, origin: 'delegated', dueOn: '2026-11-20' });
    t.tt.touchBoard('system-analyst');
    t.tt.touchBoard('system-analyst');
    t.tt.touchBoard('system-analyst');
    await t.advance(0);
    expect(t.port.roomBoardSends).toHaveLength(1);
    expect(t.port.roomBoardSends[0]).toMatchObject({ actor: SA, channelId: SA_DIRECT });
    const body = t.port.roomBoardSends[0]!.payload.body;
    expect(body).toContain('Now (1):');
    expect(body).toContain('Parser @CFO');
    expect(body).toContain('due 2026-11-20');
    expect(body.length).toBeLessThanOrEqual(1900);
    // five quick changes inside the window: nothing yet, then ONE edit when the 60 s are over
    await t.advance(10_000);
    for (let i = 0; i < 5; i++) t.tt.touchBoard('system-analyst');
    await t.advance(49_000);
    expect(t.port.roomBoardEdits).toHaveLength(0);
    await t.advance(1_000);
    expect(t.port.roomBoardEdits).toHaveLength(1);
    expect(t.port.roomBoardSends).toHaveLength(1);
  });

  it('T5: the first send is recorded tainted, for nobody, never an answer', async () => {
    const t = await standalone();
    t.tt.touchBoard('system-analyst');
    await t.advance(0);
    expect(t.records).toEqual([{ id: t.port.roomBoardSends[0]!.id, channelId: SA_DIRECT, tainted: true, userId: null, answer: false }]);
  });

  it('lists Now / Done / Ideas / Decisions from the database, and never goes over 1900 characters', async () => {
    const t = await standalone();
    for (let i = 0; i < 12; i++) await t.tasks.create({ title: `Open task number ${i} ${'y'.repeat(120)}`, deptId: 'software', owner: SA, requester: CTO, origin: 'delegated' });
    const add = (kind: 'done' | 'idea' | 'decision', n: number) => t.rooms.add({ personaId: 'system-analyst', deptId: 'software', kind, taskId: `t${kind}${n}`, body: `${kind} ${n} ${'z'.repeat(250)}`, tainted: false });
    for (let i = 0; i < 7; i++) { await add('done', i); await add('idea', i); await add('decision', i); }
    t.tt.touchBoard('system-analyst');
    await t.advance(0);
    const body = t.port.roomBoardSends[0]!.payload.body;
    expect(body.length).toBeLessThanOrEqual(1900);
    expect(body).toContain('Now (8):'); // at most 8 open tasks
    expect(body).toMatch(/Done \(last 5\)/);
  });

  it('T11: halted, nothing is posted or edited', async () => {
    const t = await standalone({ halted: true });
    t.tt.touchBoard('system-analyst');
    await t.advance(0);
    expect(t.port.roomBoardSends).toEqual([]);
  });

  it('T13: a missing Pin Messages permission is one warning per room; the board keeps working', async () => {
    const t = await standalone();
    t.port.roomBoardPin = 'missing_permission';
    t.tt.touchBoard('system-analyst');
    await t.advance(0);
    t.tt.touchBoard('system-analyst');
    await t.advance(60_000);
    expect(t.warns).toHaveLength(1);
    expect(t.warns[0]).toMatchObject({ channelId: SA_DIRECT, reason: 'missing_permission' });
    expect(t.port.roomBoardEdits).toHaveLength(1);
  });

  it('a board failure is one incident per channel and never throws', async () => {
    const t = await standalone();
    const reports: unknown[] = [];
    (t.tt as unknown as { d: { incidents: unknown } }).d.incidents = { report: (i: unknown) => (reports.push(i), 'id') };
    t.port.roomBoardPin = 'throw';
    for (let i = 0; i < 3; i++) { t.tt.touchBoard('system-analyst'); await t.advance(60_000); }
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ source: 'teamtalk', stage: 'room board', channelId: SA_DIRECT });
  });

  it('spec (a): the board first send, read back through the real mapper and router, wakes nobody', async () => {
    const t = await standalone();
    await t.tasks.create({ title: 'Ask @CFO and @CEO', deptId: 'software', owner: SA, requester: CTO, origin: 'delegated' });
    t.tt.touchBoard('system-analyst');
    await t.advance(0);
    vi.useRealTimers();
    const sent = t.port.roomBoardSends[0]!;
    const r = await roundTrip(SA, { channelId: CH.room }, sent.payload);
    expect(r.routes).toEqual([]);
    expect(handlesIn(String(r.sent.content))).toEqual([]);
  });
});

describe('TEAMTALK kill switch (teamtalk.enabled, read live)', () => {
  it('off: no handoff line, no room line or entry, no board, no card Back to; the owner run and the F-1 safe subtask report still happen', async () => {
    let on = false;
    const w = await mk({ enabled: () => on, run: finishingRun('Child @CFO', { summary: 'done @CFO', report: 'R' }) });
    await started(w);
    expect(w.port.handoffIds.size).toBe(0);
    expect(inParent(w).filter((p) => bodyOf(p).startsWith('➜'))).toEqual([]);
    expect(roomLines(w)).toEqual([]);
    expect(w.rooms.rows).toEqual([]);
    await w.tt.flush();
    expect(w.port.roomBoardSends).toEqual([]);
    const card = w.port.posts.find((p) => p.payload.type === 'task')!;
    expect((card.payload.fields ?? []).map((f) => f.name)).not.toContain('Back to');
    // H3 and the defang stay
    const report = inParent(w).find((p) => p.payload.title === 'Subtask done')!;
    expect(report.payload.noHandles).toBe(true);
    expect((await roundTrip(CTO, where, report.payload, { task: parentLike })).routes).toEqual([]);
  });

  it('flipping it on takes effect for the next delegation without a restart', async () => {
    let on = false;
    const w = await mk({ enabled: () => on });
    await started(w);
    expect(w.port.handoffIds.size).toBe(0);
    on = true;
    const parent = await mkParent(w, { threadId: '1570000000000000800' });
    const child = await mkChild(w, parent, { title: 'Second' });
    await w.bus.emit('task.created', { task: child });
    await w.s.idle();
    expect(w.port.handoffIds.size).toBe(1);
    expect(w.rooms.rows.some((r) => r.kind === 'assigned')).toBe(true);
    await w.tt.flush();
    expect(w.port.roomBoardSends).toHaveLength(1);
  });

  it('on (the default when no switch is wired) behaves as before', async () => {
    const w = await mk();
    await started(w);
    expect(w.port.handoffIds.size).toBe(1);
  });
});

describe('TEAMTALK G2TT-02 secrets are redacted at the source, before any cut', () => {
  const key = 'sk-PLANTED-secret-Zq81xK77abcdefgh';
  it('a secret straddling the 250-character summary cut leaves no partial prefix in the room line, the entry, the handoff line or the report', async () => {
    const summary = `${'a'.repeat(238)} ${key} tail`;
    const w = await mk({ secrets: [key], run: finishingRun(`${'c'.repeat(110)} ${key}`, { summary, report: 'r' }) });
    await started(w, { child: { acceptance: `${'b'.repeat(190)} ${key}`, title: `${'c'.repeat(110)} ${key}` } });
    // everything code cut before the port's own masking: stored entries, room lines, the handoff line and its edits, the roll-up message
    const all = JSON.stringify([w.rooms.rows, roomLines(w).map(bodyOf), w.port.posts.filter((p) => bodyOf(p).startsWith('➜')).map(bodyOf), w.port.handoffEdits.map((x) => x.payload.body), w.runs.filter((t) => t.msg).map((t) => t.msg!.content)]);
    expect(w.rooms.rows.some((r) => r.kind === 'done')).toBe(true);
    expect(all).not.toMatch(/sk-PLANTED|Zq81xK|abcdefgh/);
  });

  it('the board titles are redacted before the cut', async () => {
    vi.useFakeTimers();
    const port = new FakeDiscordPort();
    port.snowflakes = true;
    const tasks = new MemTasks();
    const org = await seededOrg();
    const tt = new TeamTalk({ port, tasks, rooms: new MemRoomEntries(), org, halt: { isHalted: () => false }, secrets: [key], guildId: GUILD, log: quiet });
    tt.bind({ post: async () => null });
    await tasks.create({ title: `${'t'.repeat(70)} ${key}`, deptId: 'software', owner: SA, requester: CTO, origin: 'delegated' });
    tt.touchBoard('system-analyst');
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.stringify(port.roomBoardSends)).not.toMatch(/sk-PLANTED|Zq81|abcdefgh/);
  });
});

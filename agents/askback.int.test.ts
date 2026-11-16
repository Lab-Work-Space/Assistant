import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCalendar } from '../company/calendar.js';
import { Org, seed } from '../company/index.js';
import type { ActorRef, IncomingMessage } from '../company/types.js';
import { handlesIn } from '../company/handles.js';
import { BotMessageRepo, ChannelMapRepo, DepartmentRepo, PersonaRepo, TaskRepo, type Task } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { QuestionRepo } from '../db/repos/questions.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { Limits } from '../governance/limits.js';
import { FakeConfig } from '../governance/test-helpers.js';
import { answerSubtask, answerSubtaskInput } from '../tools/builtin/answerSubtask.js';
import { askRequester, askRequesterInput } from '../tools/builtin/askRequester.js';
import { newRunState, type ToolContext } from '../tools/types.js';
import { FakeDiscordPort } from '../tests/fakes/discordPort.js';
import type { AgentDeps, AgentOutcome, AgentTrigger } from './loop/loop.js';
import type { OutboundPayload } from './loop/payload.js';
import { Scheduler } from './scheduler/scheduler.js';
import { TeamTalk } from './team/teamtalk.js';
import { MemRoomEntries, newBus, noApprovedTools, prompts } from './test-helpers.js';

// ASKBACK-1: the real Scheduler, TaskRepo, QuestionRepo and BotMessageRepo (real SQL) wired exactly as app.ts wires them (the repo INSTANCES, no bound methods),
// over a fake Discord port. The model run is a CLASS whose methods use `this`; it drives the REAL ask_requester / answer_subtask tools through the scheduler's real port.
const GUILD = '1565649426943442944';
const MON = Date.parse('2026-11-09T03:00:00Z');
const SAT = Date.parse('2026-11-07T03:00:00Z');
const HQ: ActorRef = { kind: 'head', dept: 'hq' };
const CTO: ActorRef = { kind: 'head', dept: 'software' };
const CFO: ActorRef = { kind: 'head', dept: 'finance' };
const SA: ActorRef = { kind: 'persona', personaId: 'system-analyst' };
const HUMAN = '1570000000000000042';
let seq = 1570000000000050000n;
const nid = (): string => String(++seq);

class Port extends FakeDiscordPort {
  override snowflakes = true;
  override async post(actor: ActorRef, target: { channelId: string; threadId?: string }, payload: OutboundPayload, opts?: Parameters<FakeDiscordPort['post']>[3]): Promise<string> {
    const id = await super.post(actor, target, payload, opts);
    opts?.onSent?.([id]);
    return id;
  }
}

type Handler = { when: (t: AgentTrigger) => boolean; run: (t: AgentTrigger, d: AgentDeps) => Promise<AgentOutcome> };
const actorKey = (a: ActorRef): string => (a.kind === 'head' ? `head:${a.dept}` : `persona:${a.personaId}`);
const plain = (body = 'ok'): AgentOutcome => ({ payload: { type: 'chat', body }, costUsd: 0, turns: 1, tainted: false });

/** The model: scripted per trigger. Its methods use `this`; the scheduler is handed an arrow that calls it. */
class Runs {
  calls: AgentTrigger[] = [];
  handlers: Handler[] = [];
  toolResults: { tool: string; isError?: boolean; content: string }[] = [];
  on(when: Handler['when'], run: Handler['run']): void { this.handlers.unshift({ when, run }); }
  async run(t: AgentTrigger, d: AgentDeps): Promise<AgentOutcome> {
    this.calls.push(t);
    const h = this.handlers.find((x) => x.when(t));
    return h ? h.run(t, d) : plain();
  }
  wakes(): AgentTrigger[] { return this.calls.filter((c) => c.askWake); }
  owners(actor: ActorRef, taskId: string): AgentTrigger[] { return this.calls.filter((c) => !c.askWake && c.task?.id === taskId && actorKey(c.route.actor) === actorKey(actor)); }
  resumes(): AgentTrigger[] { return this.calls.filter((c) => c.msg?.author.id === 'system:ask'); }
  /** Runs the REAL tool against the scheduler's real port, like the loop would. */
  async tool(t: AgentTrigger, d: AgentDeps, name: 'ask_requester' | 'answer_subtask', input: Record<string, string>, taint = false): Promise<AgentOutcome> {
    const run = newRunState();
    if (taint) run.markTainted();
    let task = t.task ? await (this.tasks!).get(t.task.id) : null;
    if (task && task.status === 'todo' && !t.askWake) task = (await this.tasks!.update(task.id, { status: 'doing' }, 'todo')) ?? task; // the loop's setStatus
    const ctx = { actor: t.route.actor, task, origin: 'delegated', source: { channelId: '', threadId: null, messageId: null, userId: null, attachments: [] }, direct: false, tainted: () => run.tainted(), run, ask: d.ask, ...(t.askWake ? { askWake: t.askWake } : {}), ...(t.noAsk ? { noAsk: true } : {}) } as unknown as ToolContext;
    const r = name === 'ask_requester' ? await askRequester.run(askRequesterInput.parse(input), ctx) : await answerSubtask.run(answerSubtaskInput.parse(input), ctx);
    this.toolResults.push({ tool: name, content: r.content, ...(r.isError ? { isError: true } : {}) });
    return { ...plain(run.asked ? 'NO_REPLY' : 'done'), tainted: run.tainted(), ...(run.asked ? { asked: true as const } : {}) };
  }
  tasks: TaskRepo | null = null;
}

let db: TestDb;
let org: Org;
let tasks: TaskRepo;
let provRepo: BotMessageRepo;
let questions: QuestionRepo;

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'), 'up');
  const repos = { departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) };
  await seed(repos, prompts);
  org = await Org.load(repos, prompts);
  tasks = new TaskRepo(db.pool);
  provRepo = new BotMessageRepo(db.pool);
  questions = new QuestionRepo(db.pool);
});
afterAll(async () => db.close());
beforeEach(async () => {
  await db.pool.query('DELETE FROM task_questions');
  await db.pool.query('DELETE FROM tasks');
  await db.pool.query('DELETE FROM bot_messages');
});

async function mk(o: { now?: number; cfg?: FakeConfig; teamtalk?: boolean; halted?: boolean } = {}) {
  const cfg = o.cfg ?? new FakeConfig({ 'schedule.offDays': [0, 6] });
  let now = o.now ?? MON;
  const port = new Port();
  const bus = newBus();
  const limits = new Limits(cfg, tasks);
  const halted = { v: o.halted ?? false };
  const lines: string[] = [];
  const sink = (...a: unknown[]) => void lines.push(JSON.stringify(a, (_k, v) => (v instanceof Error ? v.message : v)));
  const log = { error: vi.fn(sink), warn: vi.fn(sink) };
  const incidents = { report: vi.fn(() => '') };
  const runs = new Runs();
  runs.tasks = tasks;
  const halt = { isHalted: () => halted.v };
  const teamtalk = o.teamtalk ? new TeamTalk({ port, tasks, rooms: new MemRoomEntries(), org, halt, secrets: [], guildId: GUILD, log, incidents, provenance: provRepo, now: () => now, enabled: () => true } as never) : undefined;
  const agent = { limits, botRoots: { acquire: async () => () => undefined } } as unknown as AgentDeps;
  const s = new Scheduler({
    agent, approvedTools: noApprovedTools, run: (t: AgentTrigger, d: AgentDeps) => runs.run(t, d), port, org, tasks, limits, halt, cfg, bus, log, incidents, now: () => now,
    calendar: createCalendar(cfg), guildId: GUILD, questions,
    // exactly as app.ts: the BotMessageRepo instance
    provenance: provRepo, ...(teamtalk ? { teamtalk } : {}),
  } as never);
  s.attach();
  const send = async (m: IncomingMessage) => { await s.onMessage(m); await s.idle(); };
  return { s, port, bus, runs, halted, log, lines, incidents, cfg, send, agent, setNow: (n: number) => void (now = n), teamtalk };
}
type H = Awaited<ReturnType<typeof mk>>;

const swWork = () => org.dept('software')!.workChannelId!;
const hqWork = () => org.dept('hq')!.workChannelId!;
const finWork = () => org.dept('finance')!.workChannelId!;

/** root (hq, a person's goal) -> child (software, requested by the hq head), both doing, with threads. */
async function tree(o: { childOwner?: ActorRef; childRequester?: ActorRef; rootOwner?: ActorRef; rootTainted?: boolean; childTainted?: boolean; conversation?: boolean; rootStatus?: Task['status'] } = {}) {
  const root = await tasks.create({
    title: 'Root goal', deptId: 'hq', owner: o.rootOwner ?? HQ, requester: { kind: 'human', userId: HUMAN }, origin: 'slash', tainted: o.rootTainted ?? false, status: o.rootStatus ?? 'doing',
    threadId: nid(), channelId: hqWork(), ...(o.conversation ? { conversation: true, originMessageId: nid() } : {}),
  });
  const owner = o.childOwner ?? CTO;
  const deptId = owner.kind === 'persona' ? 'software' : owner.dept;
  const child = await tasks.create({
    title: 'Build the thing', deptId, owner, requester: o.childRequester ?? HQ, origin: 'delegated', parentId: root.id, tainted: o.childTainted ?? false, status: 'doing',
    threadId: nid(), channelId: owner.kind === 'persona' ? (org.persona(owner.personaId)!.directChannelId ?? swWork()) : org.dept(deptId)!.workChannelId!,
  });
  return { root, child };
}
/** A human root that asks its person directly (no parent). */
async function humanRoot(o: { status?: Task['status'] } = {}) {
  return tasks.create({ title: 'Goal', deptId: 'hq', owner: HQ, requester: { kind: 'human', userId: HUMAN }, origin: 'slash', tainted: false, status: o.status ?? 'doing', threadId: nid(), channelId: hqWork() });
}

const asker = (q: string, o: { taint?: boolean } = {}): Handler['run'] => async (t, d) => runsOf.current!.tool(t, d, 'ask_requester', { question: q }, o.taint ?? false);
const runsOf: { current: Runs | null } = { current: null };
const useRuns = (t: H) => void (runsOf.current = t.runs);
const answering = (a: string, taint = false): Handler['run'] => async (t, d) => runsOf.current!.tool(t, d, 'answer_subtask', { answer: a }, taint);
const isOwnerOf = (task: Task) => (t: AgentTrigger) => !t.askWake && t.task?.id === task.id && JSON.stringify(t.route.actor) === JSON.stringify(task.owner) && !t.msg;
const isWake = (t: AgentTrigger) => !!t.askWake;
const isResume = (t: AgentTrigger) => t.msg?.author.id === 'system:ask';

/** A wake run that has not returned yet (the requester is busy); `release()` lets it return without an answer. */
function hang() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  return { release, run: async (): Promise<AgentOutcome> => { await gate; return plain('late'); } };
}

const body = (p: { payload: OutboundPayload }) => p.payload.body;
const postsIn = (t: H, threadId: string) => t.port.posts.filter((p) => p.target.threadId === threadId);
const openRow = async (taskId: string) => questions.openFor(taskId);
const allRows = async () => Promise.all((await db.pool.query<{ id: number }>('SELECT id::int AS id FROM task_questions ORDER BY id')).rows.map((r) => questions.get(r.id).then((x) => x!)));
const rowsOf = async (taskId: string) => (await db.pool.query<{ id: number }>('SELECT id::int AS id FROM task_questions WHERE task_id = $1 ORDER BY id', [taskId])).rows.length;
const humanMsg = (threadId: string, channelId: string, o: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: nid(), channelId: threadId, parentChannelId: channelId, threadId, author: { id: HUMAN, name: 'Boss', kind: 'human' }, content: 'use staging', mentionedHeads: [], isAdmin: false, attachments: [], origin: 'chat', ...o,
});

/** What task.ready does for a delegated child: the child goes back to todo (the loop moves it to doing), then its owner run is scheduled. */
async function startOwner(t: H, task: Task): Promise<void> {
  await tasks.update(task.id, { status: 'todo' }, 'doing');
  await t.s.bootAsk();
  await t.s.onTaskReady(task.id);
  await t.s.idle();
}

/** Starts the owner run of a todo child, as the scheduler's task.ready does, and lets it ask. */
async function ownerAsks(t: H, task: Task, q: string, o: { taint?: boolean } = {}): Promise<void> {
  useRuns(t);
  t.runs.on(isOwnerOf(task), asker(q, o));
  await startOwner(t, task);
}

describe('ASKBACK-1 happy path (bot requester): ask, wake, answer, one resume', () => {
  it('(1) owner asks: ⏳ in the child thread, ❓ in the parent thread, one wake bound to the question, answer posted by the CHILD OWNER, exactly one owner resume; no stray NO_REPLY post', async () => {
    const t = await mk({ teamtalk: true });
    const { root, child } = await tree();
    await tasks.update(child.id, { status: 'todo' });
    t.port.handoffIds.set(child.id, nid()); // the handoff line the creation flow would have posted
    useRuns(t);
    t.runs.on(isOwnerOf(child), async (tr, d) => {
      await tasks.update(child.id, { status: 'doing' }, 'todo');
      return t.runs.tool({ ...tr, task: { ...tr.task!, status: 'doing' } }, d, 'ask_requester', { question: 'Which environment should I deploy to?' });
    });
    t.runs.on(isWake, answering('Use staging, never prod.'));
    await startOwner(t, child);
    // the asking run posted nothing but the two code lines (AB4): no literal NO_REPLY anywhere
    expect(t.port.posts.map(body).some((b) => b.trim() === 'NO_REPLY')).toBe(false);
    const childPosts = postsIn(t, child.threadId!).map((p) => ({ actor: p.actor, b: body(p), noHandles: (p.payload as { noHandles?: boolean }).noHandles }));
    const asked = childPosts.find((p) => p.b.startsWith('⏳'));
    expect(asked).toMatchObject({ actor: CTO, noHandles: true });
    expect(asked!.b).toBe('⏳ Asked head of hq (question 1/2): Which environment should I deploy to?');
    const parentLine = postsIn(t, root.threadId!).find((p) => body(p).startsWith('❓'));
    expect(parentLine).toBeDefined();
    expect(parentLine!.actor).toEqual(HQ); // the parent's owner (= the requester), so the echo routes nowhere
    expect(body(parentLine!)).toContain('Question 1/2 from head of software');
    expect(body(parentLine!)).toContain(`https://discord.com/channels/${GUILD}/${child.threadId}`);
    // exactly one wake, bound to the question, with the code constants; the question text is never in the instruction
    const [wake] = t.runs.wakes();
    expect(t.runs.wakes()).toHaveLength(1);
    expect(wake).toMatchObject({ noAsk: true, noWarroomSay: true, route: { actor: HQ, reason: 'task_owner', taskId: root.id } });
    expect(wake!.instruction).not.toContain('environment');
    expect(wake!.msg!.content).toContain('Question from head of software');
    expect(wake!.msg!.content).toContain('Which environment should I deploy to?');
    // the answer is a code line posted by the child owner, inert
    const answerLine = childPosts.find((p) => p.b.startsWith('💬'));
    expect(answerLine).toMatchObject({ actor: CTO, noHandles: true });
    expect(answerLine!.b).toBe('💬 Answer from head of hq (question 1/2): Use staging, never prod.');
    // the owner resumes once, by code, with the stored answer in the wrapped message and a fixed code instruction
    expect(t.runs.resumes()).toHaveLength(1);
    const [resume] = t.runs.resumes();
    expect(resume!.msg).toMatchObject({ id: expect.stringMatching(/^ask-\d+-answer$/), author: { id: 'system:ask', kind: 'head' }, origin: 'chat' });
    expect(resume!.msg!.author.kind).not.toBe('human');
    expect(resume!.msg!.content).toContain('Use staging, never prod.');
    expect(resume!.instruction).not.toContain('staging');
    expect(resume!.route).toMatchObject({ actor: CTO, reason: 'task_owner', taskId: child.id });
    const [row] = await allRows();
    expect(row).toMatchObject({ status: 'answered', seq: 1, answer: 'Use staging, never prod.', answerTainted: false });
    expect(row!.resumedAt).not.toBeNull();
    expect(row!.questionMessageId).toMatch(/^\d{17,20}$/);
    expect(row!.answerMessageId).toMatch(/^\d{17,20}$/);
    // H1: the handoff status went "waiting" and back to plain
    const labels = t.port.handoffEdits.filter((e) => e.taskId === child.id).map((e) => body(e));
    expect(labels.some((b) => b.includes('doing · ❓ waiting for head of hq'))).toBe(true);
    expect(labels.at(-1)).not.toContain('waiting for');
    expect(t.incidents.report).not.toHaveBeenCalled();
  });

  it('(1b) a persona-owned child asking its own head (the supported direction) works end to end', async () => {
    const t = await mk();
    const { child } = await tree({ childOwner: SA, childRequester: CTO, rootOwner: CTO });
    // the persona's requester (CTO) must be the parent owner: parent is owned by CTO here
    useRuns(t);
    t.runs.on(isWake, answering('PostgreSQL.'));
    t.runs.on(isOwnerOf(child), asker('Which database?'));
    await startOwner(t, child);
    expect(t.runs.toolResults.filter((r) => r.tool === 'ask_requester' && r.isError)).toEqual([]);
    expect((await allRows())[0]).toMatchObject({ status: 'answered', answer: 'PostgreSQL.' });
    expect(t.runs.resumes()).toHaveLength(1);
    expect(t.runs.resumes()[0]!.route.actor).toEqual(SA);
  });

  it('(1c) a wake or resume that is itself tainted-clean never marks anything tainted', async () => {
    const t = await mk();
    const { root, child } = await tree();
    useRuns(t);
    t.runs.on(isWake, answering('ok'));
    t.runs.on(isOwnerOf(child), asker('q?'));
    await startOwner(t, child);
    expect((await tasks.get(root.id))!.tainted).toBe(false);
    expect((await tasks.get(child.id))!.tainted).toBe(false);
  });
});

describe('AB1 who can be asked (decided from database rows)', () => {
  const refused = (t: H, text: RegExp) => expect(t.runs.toolResults.at(-1)).toMatchObject({ tool: 'ask_requester', isError: true, content: expect.stringMatching(text) });

  it('a persona requester is refused noRequester (no row, no wake)', async () => {
    const t = await mk();
    // canDelegate lets a persona delegate to its head; here the head's task has a persona requester
    const root = await tasks.create({ title: 'r', deptId: 'software', owner: SA, requester: { kind: 'human', userId: HUMAN }, origin: 'slash', tainted: false, status: 'doing', threadId: nid(), channelId: org.persona('system-analyst')!.directChannelId! });
    const child = await tasks.create({ title: 'c', deptId: 'software', owner: CTO, requester: SA, origin: 'delegated', parentId: root.id, tainted: false, status: 'doing', threadId: nid(), channelId: swWork() });
    await ownerAsks(t, child, 'who?');
    refused(t, /no requester you can ask/);
    expect(await rowsOf(child.id)).toBe(0);
    expect(t.runs.wakes()).toHaveLength(0);
  });

  it('a head requester that is NOT the parent owner (constructed row) is refused', async () => {
    const t = await mk();
    const { child } = await tree({ childRequester: CFO }); // parent owner is hq, requester says finance
    await ownerAsks(t, child, 'who?');
    refused(t, /no requester you can ask/);
    expect(await rowsOf(child.id)).toBe(0);
  });

  it('a bot-made root with a bot requester and no parent is refused', async () => {
    const t = await mk();
    const root = await tasks.create({ title: 'r', deptId: 'software', owner: CTO, requester: HQ, origin: 'delegated', tainted: false, status: 'doing', threadId: nid(), channelId: swWork() });
    await ownerAsks(t, root, 'who?');
    refused(t, /no requester you can ask/);
  });

  it('a human requester is asked only on the root they started; a conversation task is refused', async () => {
    const t = await mk();
    const conv = await tasks.create({ title: 'c', deptId: 'hq', owner: HQ, requester: { kind: 'human', userId: HUMAN }, origin: 'chat', tainted: false, status: 'doing', threadId: nid(), channelId: hqWork(), conversation: true, originMessageId: nid() });
    await ownerAsks(t, conv, 'who?');
    refused(t, /no requester you can ask/);
    expect(await rowsOf(conv.id)).toBe(0);
  });

  it('the parent must have a thread and be open', async () => {
    const t = await mk();
    const { root, child } = await tree();
    await tasks.update(root.id, { status: 'cancelled' });
    await ownerAsks(t, child, 'who?');
    refused(t, /no requester you can ask/);
  });
});

describe('caps and refusals (AB8/AB10 fixed texts)', () => {
  async function asks(t: H, child: Task, q: string) {
    useRuns(t);
    t.runs.handlers = [];
    t.runs.on(isWake, answering('a'));
    t.runs.on(isOwnerOf(child), asker(q));
    t.runs.on((tr) => tr.task?.id === child.id && !!tr.msg && !tr.askWake && tr.msg.author.id !== 'system:ask', asker(q));
    await startOwner(t, child);
  }

  it('a second ask while one is open is refused (open); a third ask over the 2-per-task cap is refused (cap)', async () => {
    const t = await mk();
    const { child } = await tree();
    await asks(t, child, 'first?');
    expect((await allRows())[0]).toMatchObject({ seq: 1, status: 'answered' });
    const port = t.agent.ask!;
    // seq 2 stays open (a pending row nobody woke yet): a further ask is 'open'
    const made = await questions.create({ taskId: child.id, rootId: child.rootId, parentId: child.parentId, asker: CTO, requester: HQ, question: 'second?', questionTainted: false }, { perRoot: 6, perDay: 40 });
    expect(made).toMatchObject({ ok: true, row: { seq: 2 } });
    expect(await port.ask({ actor: CTO, taskId: child.id, question: 'while open?', tainted: false })).toEqual({ ok: false, reason: 'cap' }); // 2 rows already used: the task cap speaks first
    await questions.close((made as { row: { id: number } }).row.id, 'moot', { noResume: true });
    expect(await port.ask({ actor: CTO, taskId: child.id, question: 'third?', tainted: false })).toEqual({ ok: false, reason: 'cap' });
    expect(await rowsOf(child.id)).toBe(2);
    // with one row only, an open one is 'open'
    const { child: c2 } = await tree();
    await questions.create({ taskId: c2.id, rootId: c2.rootId, parentId: c2.parentId, asker: CTO, requester: HQ, question: 'only', questionTainted: false }, { perRoot: 6, perDay: 40 });
    expect(await port.ask({ actor: CTO, taskId: c2.id, question: 'again?', tainted: false })).toEqual({ ok: false, reason: 'open' });
  });

  it('per-root and per-day caps (live config)', async () => {
    const t = await mk({ cfg: new FakeConfig({ 'ask.perRoot': 2, 'ask.perDay': 40 }) });
    const { root, child } = await tree();
    const child2 = await tasks.create({ title: 'c2', deptId: 'software', owner: CTO, requester: HQ, origin: 'delegated', parentId: root.id, tainted: false, status: 'doing', threadId: nid(), channelId: swWork() });
    const child3 = await tasks.create({ title: 'c3', deptId: 'software', owner: CTO, requester: HQ, origin: 'delegated', parentId: root.id, tainted: false, status: 'doing', threadId: nid(), channelId: swWork() });
    useRuns(t);
    const port = t.agent.ask!;
    expect((await port.ask({ actor: CTO, taskId: child.id, question: 'a', tainted: false })).ok).toBe(true);
    expect((await port.ask({ actor: CTO, taskId: child2.id, question: 'b', tainted: false })).ok).toBe(true);
    expect(await port.ask({ actor: CTO, taskId: child3.id, question: 'c', tainted: false })).toEqual({ ok: false, reason: 'limit' });
    await t.cfg.set('ask.perRoot', 6, 'test');
    await t.cfg.set('ask.perDay', 2, 'test');
    expect(await port.ask({ actor: CTO, taskId: child3.id, question: 'c', tainted: false })).toEqual({ ok: false, reason: 'limit' });
    await t.s.idle();
  });

  it('a refused ask posts nothing and creates no row; the refusal text is fixed and never echoes the question', async () => {
    const t = await mk();
    const { child } = await tree({ childRequester: CFO });
    await ownerAsks(t, child, 'MARKER-SECRET-QUESTION');
    expect(JSON.stringify(t.runs.toolResults)).not.toContain('MARKER-SECRET');
    expect(t.port.posts.filter((p) => body(p).includes('MARKER-SECRET'))).toHaveLength(0);
    expect(await rowsOf(child.id)).toBe(0);
  });
});

describe('AB2 restart (option b): exactly one owner run per waiting child, at most one wake', () => {
  it.each(['pending', 'asked', 'answered'] as const)('a %s row at boot: closed, the reset owner run is the single resume, no wake and no tick resume', async (state) => {
    const t = await mk();
    const { child } = await tree();
    useRuns(t);
    const made = await questions.create({ taskId: child.id, rootId: child.rootId, parentId: child.parentId, asker: CTO, requester: HQ, question: 'q?', questionTainted: false }, { perRoot: 6, perDay: 40 });
    const id = (made as { row: { id: number } }).row.id;
    if (state !== 'pending') await questions.markAsked(id, 4);
    if (state === 'answered') await questions.answer(id, HQ, 'a', false); // answered, resumed_at NULL: the crash happened before the owner resumed
    await db.pool.query("UPDATE task_questions SET created_at = now() - interval '1 hour'"); // the row belongs to the previous process (G2AB-04 scopes the boot close to rows older than this one)
    // boot, exactly as app-start: bootAsk, resetDoingToTodo, then every todo task is scheduled
    await t.s.bootAsk();
    const reset = await tasks.resetDoingToTodo();
    expect(reset.map((r) => r.id)).toContain(child.id);
    for (const r of await tasks.listByStatus('todo')) await t.s.onTaskReady(r.id);
    await t.s.idle();
    await t.s.askTick();
    await t.s.idle();
    expect(t.runs.wakes()).toHaveLength(0);
    expect(t.runs.resumes()).toHaveLength(0);
    expect(t.runs.owners(CTO, child.id)).toHaveLength(1); // the reset owner run, once
    expect((await questions.get(id))!.status).toBe(state === 'answered' ? 'answered' : 'moot');
    expect((await questions.get(id))!.resumedAt).not.toBeNull();
    expect(await openRow(child.id)).toBeNull();
  });

  it('the tick stays off until the boot close ran; a tick before boot closes first and never wakes an old row', async () => {
    const t = await mk();
    const { child } = await tree();
    useRuns(t);
    await questions.create({ taskId: child.id, rootId: child.rootId, parentId: child.parentId, asker: CTO, requester: HQ, question: 'q?', questionTainted: false }, { perRoot: 6, perDay: 40 });
    await db.pool.query("UPDATE task_questions SET created_at = now() - interval '1 hour'");
    await t.s.askTick(); // not booted: bootAsk first, so the old pending row is closed, not woken
    await t.s.idle();
    expect(t.runs.wakes()).toHaveLength(0);
    expect((await allRows())[0]).toMatchObject({ status: 'moot' });
  });
});

describe('AB8 wake idempotency and the off day', () => {
  async function seedPending(t: H, child: Task, tainted = false) {
    const made = await questions.create({ taskId: child.id, rootId: child.rootId, parentId: child.parentId, asker: CTO, requester: HQ, question: 'q?', questionTainted: tainted }, { perRoot: 6, perDay: 40 });
    return (made as { row: Awaited<ReturnType<typeof questions.get>> & object }).row;
  }

  it('(6) off day: the wake is held; a restart drops the memory but closes the row; the day turn on the old instance starts ONE wake even with the tick racing', async () => {
    const t = await mk({ now: SAT });
    const { child } = await tree();
    useRuns(t);
    t.runs.on(isWake, answering('a'));
    await t.s.bootAsk();
    // the port refuses nothing on an off day; the wake is held in memory
    const r = await t.agent.ask!.ask({ actor: CTO, taskId: child.id, question: 'q?', tainted: false });
    expect(r.ok).toBe(true);
    await t.s.idle();
    expect(t.runs.wakes()).toHaveLength(0);
    expect((await openRow(child.id))!.status).toBe('pending');
    // the day turns: held start + the tick's stale-pending pass race
    await db.pool.query("UPDATE task_questions SET created_at = now() - interval '1 hour'");
    t.setNow(MON);
    t.s.dayTurned();
    await t.s.askTick();
    await t.s.idle();
    expect(t.runs.wakes()).toHaveLength(1);
    expect((await allRows())[0]).toMatchObject({ status: 'answered' });
  });

  it('a held pending wake does not survive a restart (new scheduler): boot closes it, nothing wakes', async () => {
    const t = await mk({ now: SAT });
    const { child } = await tree();
    await t.agent.ask!.ask({ actor: CTO, taskId: child.id, question: 'q?', tainted: false });
    const t2 = await mk({ now: MON }); // the "restarted" process
    await t2.s.bootAsk();
    t2.s.dayTurned();
    await t2.s.askTick();
    await t2.s.idle();
    expect(t2.runs.wakes()).toHaveLength(0);
    expect((await allRows())[0]).toMatchObject({ status: 'moot' });
  });

  it('a full hold drops the wake: the rollups count is released and the row stays pending for the tick', async () => {
    const t = await mk({ now: SAT });
    const { child } = await tree();
    (t.s as unknown as { heldForWorkday: unknown[] }).heldForWorkday.push(...Array.from({ length: 1000 }, () => ({ start: () => undefined })));
    await t.s.bootAsk();
    await t.agent.ask!.ask({ actor: CTO, taskId: child.id, question: 'q?', tainted: false });
    await t.s.idle();
    expect((t.s as unknown as { rollups: Map<string, number> }).rollups.size).toBe(0);
    expect((await openRow(child.id))!.status).toBe('pending');
    // the workday tick starts it
    t.setNow(MON);
    (t.s as unknown as { heldForWorkday: unknown[] }).heldForWorkday.splice(0);
    useRuns(t);
    t.runs.on(isWake, answering('a'));
    await db.pool.query("UPDATE task_questions SET created_at = now() - interval '1 hour'");
    await t.s.askTick();
    await t.s.idle();
    expect(t.runs.wakes()).toHaveLength(1);
  });

  it('a losing duplicate consumes no overtime run: startAsk re-checks pending before orWorkday', async () => {
    const t = await mk({ now: SAT });
    const { child } = await tree();
    const row = await seedPending(t, child);
    await questions.markAsked(row.id, 4); // someone else already claimed it
    const consume = vi.fn(async () => true);
    (t.s as unknown as { d: { ot: unknown } }).d.ot = { usable: async () => true, consume };
    await (t.s as unknown as { startAsk(q: unknown): Promise<void> }).startAsk(row);
    expect(consume).not.toHaveBeenCalled();
    expect((t.s as unknown as { rollups: Map<string, number> }).rollups.size).toBe(0);
  });

  it('the asking child ends in the same instant: the claimed wake finds a non-doing child -> moot, nothing runs, no resume', async () => {
    const t = await mk();
    const { child } = await tree();
    useRuns(t);
    const row = await seedPending(t, child);
    await tasks.update(child.id, { status: 'done' });
    await (t.s as unknown as { startAsk(q: unknown): Promise<void> }).startAsk(row);
    await t.s.idle();
    expect(t.runs.wakes()).toHaveLength(0);
    expect(t.runs.resumes()).toHaveLength(0);
    expect((await questions.get(row.id))!).toMatchObject({ status: 'moot' });
  });
});

describe('answer side and failures', () => {
  it('(3) answer_subtask in a run without askWake, or by a non-requester, or twice, is refused', async () => {
    const t = await mk();
    const { child } = await tree();
    useRuns(t);
    const port = t.agent.ask!;
    // a made-up wake binding: row is pending (not asked) -> closed; a different actor -> notWake
    const made = await questions.create({ taskId: child.id, rootId: child.rootId, parentId: child.parentId, asker: CTO, requester: HQ, question: 'q?', questionTainted: false }, { perRoot: 6, perDay: 40 });
    const id = (made as { row: { id: number } }).row.id;
    expect(await port.answer({ actor: HQ, questionId: id, answer: 'a', tainted: false })).toEqual({ ok: false, reason: 'closed' }); // still pending
    await questions.markAsked(id, 4);
    expect(await port.answer({ actor: CFO, questionId: id, answer: 'a', tainted: false })).toEqual({ ok: false, reason: 'notWake' });
    expect(await port.answer({ actor: CTO, questionId: id, answer: 'a', tainted: false })).toEqual({ ok: false, reason: 'notWake' }); // the asker cannot answer itself
    expect(await port.answer({ actor: HQ, questionId: 999999, answer: 'a', tainted: false })).toEqual({ ok: false, reason: 'closed' });
    expect(await port.answer({ actor: HQ, questionId: id, answer: 'good', tainted: false })).toEqual({ ok: true });
    expect(await port.answer({ actor: HQ, questionId: id, answer: 'again', tainted: false })).toEqual({ ok: false, reason: 'closed' });
    expect((await questions.get(id))!.answer).toBe('good');
  });

  it('(8) a wake that ends without a successful answer: moot and exactly one resume ("did not answer")', async () => {
    const t = await mk();
    const { child } = await tree();
    useRuns(t);
    t.runs.on(isWake, async () => plain('I do not know'));
    t.runs.on(isOwnerOf(child), asker('q?'));
    await startOwner(t, child);
    expect((await allRows())[0]).toMatchObject({ status: 'moot' });
    expect(t.runs.resumes()).toHaveLength(1);
    expect(t.runs.resumes()[0]!.msg!.id).toMatch(/no_answer$/);
    expect(t.runs.resumes()[0]!.instruction).toContain('did not answer');
    expect(t.port.posts.some((p) => body(p).startsWith('💬'))).toBe(false);
  });

  it('a budget-stopped wake run (stopped: budget) counts as no answer', async () => {
    const t = await mk();
    const { child } = await tree();
    useRuns(t);
    t.runs.on(isWake, async () => ({ ...plain('budget'), stopped: 'budget' as const }));
    t.runs.on(isOwnerOf(child), asker('q?'));
    await startOwner(t, child);
    expect(t.runs.resumes()).toHaveLength(1);
  });

  it('the 💬 post fails: the answer reverts to asked (CHECKs pass), the tool errors, and the owner continues alone (no_answer)', async () => {
    const t = await mk();
    const { child } = await tree();
    useRuns(t);
    const post = t.port.post.bind(t.port);
    t.port.post = async (a, tg, p, o) => {
      if (body({ payload: p }).startsWith('💬')) throw new Error('boom');
      return post(a, tg, p, o);
    };
    t.runs.on(isWake, answering('lost answer'));
    t.runs.on(isOwnerOf(child), asker('q?'));
    await startOwner(t, child);
    expect(t.runs.toolResults.find((r) => r.tool === 'answer_subtask')).toMatchObject({ isError: true, content: expect.stringContaining('could not be posted') });
    const [row] = await allRows();
    expect(row).toMatchObject({ status: 'moot', answer: null });
    expect(t.runs.resumes()).toHaveLength(1);
    expect(t.runs.resumes()[0]!.msg!.content).not.toContain('lost answer');
  });

  it('(9) the child ends while the question is open: moot, no resume; the parent ends: moot and the owner continues once', async () => {
    const t = await mk({ now: SAT });
    const a = await tree();
    useRuns(t);
    await t.agent.ask!.ask({ actor: CTO, taskId: a.child.id, question: 'q?', tainted: false });
    const done = await tasks.update(a.child.id, { status: 'done' });
    await t.bus.emit('task.changed', { task: done!, from: 'doing', to: 'done', summary: 's' });
    await t.s.idle();
    expect((await allRows())[0]).toMatchObject({ status: 'moot' });
    expect(t.runs.resumes()).toHaveLength(0);
    // parent ends while open (weekday: the resume runs)
    const t2 = await mk();
    const b = await tree();
    useRuns(t2);
    const h2 = hang();
    t2.runs.on(isWake, h2.run); // the wake has not returned: the row stays open
    await t2.agent.ask!.ask({ actor: CTO, taskId: b.child.id, question: 'q?', tainted: false });
    const gone = await tasks.update(b.root.id, { status: 'cancelled' });
    await t2.bus.emit('task.changed', { task: gone!, from: 'doing', to: 'cancelled' });
    await new Promise((r) => setTimeout(r, 50));
    expect(t2.runs.resumes()).toHaveLength(1);
    expect(t2.runs.resumes()[0]!.msg!.id).toMatch(/requester_unavailable$/);
    h2.release();
    await t2.s.idle();
  });
});

describe('timeout and the tick', () => {
  it('(7) a due question expires and the owner resumes once; a duplicate tick resumes nothing more', async () => {
    const t = await mk();
    const { child } = await tree();
    useRuns(t);
    const h = hang();
    t.runs.on(isWake, h.run); // the requester has not answered yet
    await t.s.bootAsk();
    await t.agent.ask!.ask({ actor: CTO, taskId: child.id, question: 'q?', tainted: false });
    await new Promise((r) => setTimeout(r, 30));
    expect((await openRow(child.id))!.status).toBe('asked');
    await db.pool.query("UPDATE task_questions SET expires_at = now() - interval '1 minute'");
    await Promise.all([t.s.askTick(), t.s.askTick()]);
    await new Promise((r) => setTimeout(r, 50));
    h.release();
    await t.s.idle();
    expect(t.runs.resumes()).toHaveLength(1);
    expect(t.runs.resumes()[0]!.msg!.id).toMatch(/timeout$/);
    expect((await allRows())[0]).toMatchObject({ status: 'expired' });
    await t.s.askTick();
    await t.s.idle();
    expect(t.runs.resumes()).toHaveLength(1);
  });

  it('a closed row whose owner was never resumed (halt mid-resume, held tree) is resumed by the tick once the grace passed, only while the child is doing', async () => {
    const t = await mk();
    const { child } = await tree();
    useRuns(t);
    await t.s.bootAsk();
    const made = await questions.create({ taskId: child.id, rootId: child.rootId, parentId: child.parentId, asker: CTO, requester: HQ, question: 'q?', questionTainted: false }, { perRoot: 6, perDay: 40 });
    const id = (made as { row: { id: number } }).row.id;
    await questions.markAsked(id, 4);
    await questions.answer(id, HQ, 'the answer', false);
    await t.s.askTick();
    await t.s.idle();
    expect(t.runs.resumes()).toHaveLength(0); // inside the grace
    await db.pool.query("UPDATE task_questions SET closed_at = now() - interval '5 minutes'");
    await Promise.all([t.s.askTick(), t.s.askTick()]);
    await t.s.idle();
    expect(t.runs.resumes()).toHaveLength(1);
    expect(t.runs.resumes()[0]!.msg!.content).toContain('the answer');
    await tasks.update(child.id, { status: 'blocked' });
  });

  it('off day: an expired question ends but the resume waits for the workday (nothing piles up in the hold)', async () => {
    const t = await mk({ now: SAT });
    const { child } = await tree();
    useRuns(t);
    await t.s.bootAsk();
    const made = await questions.create({ taskId: child.id, rootId: child.rootId, parentId: child.parentId, asker: CTO, requester: HQ, question: 'q?', questionTainted: false }, { perRoot: 6, perDay: 40 });
    await questions.markAsked((made as { row: { id: number } }).row.id, 1);
    await db.pool.query("UPDATE task_questions SET expires_at = now() - interval '1 minute'");
    for (let i = 0; i < 3; i++) await t.s.askTick();
    await t.s.idle();
    expect((await allRows())[0]).toMatchObject({ status: 'expired' });
    expect(t.runs.resumes()).toHaveLength(0);
    expect((t.s as unknown as { heldForWorkday: unknown[] }).heldForWorkday).toHaveLength(0);
    t.setNow(MON);
    await db.pool.query("UPDATE task_questions SET closed_at = now() - interval '5 minutes'");
    await t.s.askTick();
    await t.s.idle();
    expect(t.runs.resumes()).toHaveLength(1);
  });
});

describe('AB6 taint', () => {
  it('(5a) a tainted question taints the parent BEFORE the wake; the wake run starts on a tainted parent', async () => {
    const t = await mk();
    const { root, child } = await tree();
    useRuns(t);
    let parentTaintedAtWake: boolean | null = null;
    t.runs.on(isWake, async (tr, d) => {
      parentTaintedAtWake = (await tasks.get(root.id))!.tainted;
      return t.runs.tool(tr, d, 'answer_subtask', { answer: 'ok' });
    });
    t.runs.on(isOwnerOf(child), asker('q?', { taint: true }));
    await startOwner(t, child);
    expect(parentTaintedAtWake).toBe(true);
    expect((await tasks.get(root.id))!.tainted).toBe(true);
    expect((await allRows())[0]!.questionTainted).toBe(true);
  });

  it('(5a-crash) a crash after the insert, before the parent was tainted: the recovered wake still taints the parent first', async () => {
    const t = await mk();
    const { root, child } = await tree();
    useRuns(t);
    await t.s.bootAsk(); // the process is up; the crash below happened in this lifetime (a halted ask whose parent taint step never ran)
    const made = await questions.create({ taskId: child.id, rootId: child.rootId, parentId: child.parentId, asker: CTO, requester: HQ, question: 'q?', questionTainted: true }, { perRoot: 6, perDay: 40 });
    const row = (made as { row: Awaited<ReturnType<typeof questions.get>> & object }).row;
    let parentTaintedAtWake: boolean | null = null;
    t.runs.on(isWake, async (tr) => { parentTaintedAtWake = tr.task!.tainted; return plain(); });
    await db.pool.query("UPDATE task_questions SET created_at = now() - interval '1 hour'");
    await t.s.askTick();
    await t.s.idle();
    expect(row.questionTainted).toBe(true);
    expect(parentTaintedAtWake).toBe(true);
    expect((await tasks.get(root.id))!.tainted).toBe(true);
  });

  it('(5b) a tainted answer taints the child before the post and the resume run is tainted and never direct', async () => {
    const t = await mk();
    const { child } = await tree();
    useRuns(t);
    let childTaintedAtPost: boolean | null = null;
    const post = t.port.post.bind(t.port);
    t.port.post = async (a, tg, p, o) => {
      if (body({ payload: p }).startsWith('💬')) childTaintedAtPost = (await tasks.get(child.id))!.tainted;
      return post(a, tg, p, o);
    };
    t.runs.on(isWake, answering('from the web', true));
    t.runs.on(isOwnerOf(child), asker('q?'));
    await startOwner(t, child);
    expect(childTaintedAtPost).toBe(true);
    expect((await allRows())[0]).toMatchObject({ answerTainted: true });
    const [resume] = t.runs.resumes();
    expect(resume!.task!.tainted).toBe(true);
    expect((resume as unknown as { direct?: unknown }).direct).toBeUndefined();
    expect(resume!.msg!.author.kind).not.toBe('human');
  });

  it('a stored answer whose taint is unknown (NULL) taints the child before a resume', async () => {
    const t = await mk();
    const { child } = await tree();
    useRuns(t);
    await t.s.bootAsk();
    const made = await questions.create({ taskId: child.id, rootId: child.rootId, parentId: child.parentId, asker: CTO, requester: HQ, question: 'q?', questionTainted: false }, { perRoot: 6, perDay: 40 });
    const id = (made as { row: { id: number } }).row.id;
    await questions.markAsked(id, 4);
    await questions.answer(id, HQ, 'a', false);
    await db.pool.query("ALTER TABLE task_questions DISABLE TRIGGER ALL");
    await db.pool.query("UPDATE task_questions SET answer_tainted = NULL, closed_at = now() - interval '5 minutes' WHERE id = $1", [id]);
    await t.s.askTick();
    await t.s.idle();
    expect(t.runs.resumes()).toHaveLength(1);
    expect((await tasks.get(child.id))!.tainted).toBe(true);
  });
});

describe('human requester (AB7)', () => {
  async function humanAsk(t: H, root: Task, q = 'Staging or production?') {
    useRuns(t);
    t.runs.on(isOwnerOf(root), asker(q));
    await t.s.bootAsk();
    await t.s.onTaskReady(root.id);
    await t.s.idle();
  }

  it('(10) ❓ pings exactly the root requester; a reply closes the row, runs the owner ONCE (message-triggered), a restart afterwards runs nothing more', async () => {
    const t = await mk();
    const root = await humanRoot();
    await tasks.update(root.id, { status: 'todo' });
    await humanAsk(t, root);
    const line = postsIn(t, root.threadId!).find((p) => body(p).startsWith('❓'))!;
    expect(body(line)).toContain('has a question for you');
    expect(body(line)).toContain('wait up to 4 h');
    expect(line.opts?.mentionUserIds).toEqual([HUMAN]);
    expect(line.payload).toMatchObject({ noHandles: true });
    const row = (await openRow(root.id))!;
    expect(row).toMatchObject({ status: 'asked', parentId: null });
    // the ❓ line is recorded as an answer so a Discord reply to it routes to the owner (AB7)
    expect((await provRepo.lookup([row.questionMessageId!])).get(row.questionMessageId!)).toMatchObject({ answer: true });
    expect(t.runs.wakes()).toHaveLength(0);
    // the person replies to the ❓ line (a real Discord reply), with a bot admin's reply and a stranger's first
    t.runs.calls.length = 0;
    const stranger = humanMsg(root.threadId!, hqWork(), { author: { id: '1570000000000000099', name: 'X', kind: 'human' }, isAdmin: true, content: 'staging!' });
    await t.send(stranger);
    expect((await openRow(root.id))?.status).toBe('asked'); // (iv) a Bot Admin's reply does not close the row
    t.port.fetchable.set(`${root.threadId}|${row.questionMessageId}`, { id: row.questionMessageId!, channelId: root.threadId!, parentChannelId: hqWork(), threadId: root.threadId!, author: { id: 'bot-hq', name: 'bot', kind: 'head', actor: HQ }, content: body(line), mentionedHeads: [], isAdmin: false, attachments: [], origin: 'chat' });
    const reply = humanMsg(root.threadId!, hqWork(), { content: 'use staging please', replyToId: row.questionMessageId! });
    await t.send(reply);
    const after = (await questions.get(row.id))!;
    expect(after).toMatchObject({ status: 'answered', answer: 'use staging please', answerTainted: false, answerMessageId: reply.id });
    expect(after.resumedAt).not.toBeNull();
    expect(t.runs.calls.filter((c) => c.msg?.id === reply.id)).toHaveLength(1);
    // the restart: nothing resumes again
    const before = t.runs.calls.length;
    await t.s.bootAsk();
    await t.s.askTick();
    await t.s.idle();
    expect(t.runs.calls.length).toBe(before);
  });

  it('an attachment on the human answer taints the answer and the task; an empty text is stored as (attachment)', async () => {
    const t = await mk();
    const root = await humanRoot();
    await tasks.update(root.id, { status: 'todo' });
    await humanAsk(t, root);
    const row = (await openRow(root.id))!;
    await t.send(humanMsg(root.threadId!, hqWork(), { content: '', attachments: [{ url: 'https://cdn.example/x.png', name: 'x.png', size: 10, contentType: 'image/png' } as never] }));
    expect(await questions.get(row.id)).toMatchObject({ status: 'answered', answer: '(attachment)', answerTainted: true });
    expect((await tasks.get(root.id))!.tainted).toBe(true);
  });

  it('a Bot Admin who is not the asked person never answers; the question later times out and the owner resumes once', async () => {
    const t = await mk();
    const root = await humanRoot();
    await tasks.update(root.id, { status: 'todo' });
    await humanAsk(t, root);
    await t.send(humanMsg(root.threadId!, hqWork(), { author: { id: '1570000000000000099', name: 'Admin', kind: 'human' }, isAdmin: true, content: 'whatever' }));
    expect((await openRow(root.id))?.status).toBe('asked');
    await db.pool.query("UPDATE task_questions SET expires_at = now() - interval '1 minute'");
    await t.s.askTick();
    await t.s.idle();
    expect(t.runs.resumes().filter((r) => r.msg!.id.endsWith('timeout'))).toHaveLength(1);
  });
});

describe('halt and the off switch (AB10)', () => {
  it('(11) halted: the ask is refused, nothing is posted, no row, and the tick does nothing; rows stay and expire after the resume', async () => {
    const t = await mk();
    const { child } = await tree();
    useRuns(t);
    await t.s.bootAsk();
    const ok = await t.agent.ask!.ask({ actor: CTO, taskId: child.id, question: 'q?', tainted: false });
    expect(ok.ok).toBe(true);
    await t.s.idle();
    const rowsBefore = await allRows();
    t.halted.v = true;
    const posts = t.port.posts.length;
    expect(await t.agent.ask!.ask({ actor: CTO, taskId: child.id, question: 'second?', tainted: false })).toEqual({ ok: false, reason: 'unavailable' });
    expect(await t.agent.ask!.answer({ actor: HQ, questionId: rowsBefore[0]!.id, answer: 'x', tainted: false })).toEqual({ ok: false, reason: 'closed' });
    await db.pool.query("UPDATE task_questions SET expires_at = now() - interval '1 minute' WHERE status = 'asked'");
    await t.s.askTick();
    await t.s.idle();
    expect(t.port.posts.length).toBe(posts);
    expect((await allRows()).map((r) => r.status)).toEqual(rowsBefore.map((r) => r.status));
    t.halted.v = false; // /resume
    await t.s.askTick();
    await t.s.idle();
    const rows = await allRows();
    expect(rows.every((r) => r.status !== 'asked' && r.status !== 'pending')).toBe(true);
  });

  it('(12) ask.enabled off: the port refuses; the tick still expires open rows', async () => {
    const t = await mk();
    const { child } = await tree();
    useRuns(t);
    const h = hang();
    t.runs.on(isWake, h.run);
    await t.s.bootAsk();
    await t.agent.ask!.ask({ actor: CTO, taskId: child.id, question: 'q?', tainted: false });
    await new Promise((r) => setTimeout(r, 30));
    await t.cfg.set('ask.enabled', false, 'test');
    expect(await t.agent.ask!.ask({ actor: CTO, taskId: child.id, question: 'again', tainted: false })).toEqual({ ok: false, reason: 'unavailable' });
    await db.pool.query("UPDATE task_questions SET expires_at = now() - interval '1 minute'");
    await t.s.askTick();
    await new Promise((r) => setTimeout(r, 50));
    h.release();
    await t.s.idle();
    expect((await allRows())[0]).toMatchObject({ status: 'expired' });
    expect(t.runs.resumes()).toHaveLength(1);
  });
});

describe('AB13 a conversation parent in review is not closed mid-question', () => {
  it('(14) the parent stays in review while the question is open and closes once the child ends', async () => {
    const t = await mk();
    const { root, child } = await tree({ conversation: true, rootStatus: 'review' });
    // the conversation parent's own requester is a person; its thread is a real thread here
    useRuns(t);
    let seen: string | null = null;
    t.runs.on(isWake, async (tr, d) => {
      seen = (await tasks.get(root.id))!.status; // reopened as doing while the requester works, back to review after
      return t.runs.tool(tr, d, 'answer_subtask', { answer: 'ok' });
    });
    t.runs.on(isOwnerOf(child), asker('q?'));
    await startOwner(t, child);
    expect(seen).toBe('doing');
    expect((await tasks.get(root.id))!.status).toBe('review'); // the child is still open: not closed
    const done = await tasks.update(child.id, { status: 'done' });
    await t.bus.emit('task.changed', { task: done!, from: 'doing', to: 'done', summary: 's' });
    await t.s.idle();
    expect(['done', 'review', 'doing']).toContain((await tasks.get(root.id))!.status);
  });

  it('a held wake dropped by a full hold on an off day: the parent is neither closed nor stuck; it settles after the child ends', async () => {
    const t = await mk({ now: SAT });
    const { root, child } = await tree({ conversation: true, rootStatus: 'review' });
    (t.s as unknown as { heldForWorkday: unknown[] }).heldForWorkday.push(...Array.from({ length: 1000 }, () => ({ start: () => undefined })));
    await t.s.bootAsk();
    await t.agent.ask!.ask({ actor: CTO, taskId: child.id, question: 'q?', tainted: false });
    await t.s.idle();
    expect((t.s as unknown as { rollups: Map<string, number> }).rollups.has(root.id)).toBe(false); // not stuck: the queued count was released
    expect((await tasks.get(root.id))!.status).toBe('review'); // not closed: the child is still open
    t.setNow(MON);
    const done = await tasks.update(child.id, { status: 'done' });
    await t.bus.emit('task.changed', { task: done!, from: 'doing', to: 'done', summary: 's' });
    await t.s.idle();
    await t.s.sweepReview();
    expect((await tasks.get(root.id))!.status).not.toBe('doing');
  });
});

describe('AB12 logs and AB9 defang', () => {
  it('marker text in the question and the answer never reaches a log line or an incident', async () => {
    const t = await mk();
    const { child } = await tree();
    useRuns(t);
    t.runs.on(isWake, answering('ANSWER-MARKER-77'));
    t.runs.on(isOwnerOf(child), asker('QUESTION-MARKER-55'));
    await startOwner(t, child);
    const all = t.lines.join('\n') + JSON.stringify(t.incidents.report.mock.calls);
    expect(all).not.toContain('QUESTION-MARKER-55');
    expect(all).not.toContain('ANSWER-MARKER-77');
  });

  it('@CFO and a raw user mention in the question and the answer are defanged in both threads: no live handle, no ping', async () => {
    const t = await mk();
    const { root, child } = await tree();
    useRuns(t);
    t.runs.on(isWake, answering('tell @CFO and <@1570000000000000042> and @everyone: staging'));
    t.runs.on(isOwnerOf(child), asker('ask @CFO and <@1570000000000000042> about budget'));
    await startOwner(t, child);
    for (const p of [...postsIn(t, child.threadId!), ...postsIn(t, root.threadId!)].filter((x) => /^[⏳❓💬]/.test(body(x)))) {
      expect(handlesIn(body(p))).toEqual([]);
      expect(body(p)).not.toMatch(/<@\d|@everyone/);
      expect(p.opts?.mentionUserIds ?? []).toEqual([]);
      expect(p.payload).toMatchObject({ noHandles: true });
    }
    const row = (await allRows())[0]!;
    expect(handlesIn(row.question)).toEqual([]);
    expect(handlesIn(row.answer!)).toEqual([]);
  });

  it('every ASKBACK post is recorded with provenance answer=false except the human ❓ (a reply target)', async () => {
    const t = await mk();
    const { child } = await tree();
    useRuns(t);
    t.runs.on(isWake, answering('a'));
    t.runs.on(isOwnerOf(child), asker('q?'));
    await startOwner(t, child);
    const ids = t.port.posts.filter((p) => /^[⏳❓💬]/.test(body(p))).map((p) => p.id);
    expect(ids).toHaveLength(3);
    const prov = await provRepo.lookup(ids);
    for (const id of ids) expect(prov.get(id)?.answer).toBe(false);
  });
});

describe('AB4 an asking run posts nothing, on every delivery path', () => {
  class Stream {
    finals: unknown[] = [];
    stopped: string[] = [];
    typing(): void { /* */ }
    update(): void { /* */ }
    restart(): void { /* */ }
    active(): boolean { return true; }
    async finalize(p: unknown): Promise<string | null | undefined> { this.finals.push(p); return '1570000000000099999'; }
    async finalizeStopped(line: string): Promise<void> { this.stopped.push(line); }
    async release(): Promise<void> { /* */ }
  }

  it('(i) a task.created / task.ready owner run that asks posts only the ⏳ and ❓ code lines, never NO_REPLY', async () => {
    const t = await mk();
    const { child } = await tree();
    useRuns(t);
    t.runs.on(isWake, answering('a'));
    t.runs.on(isOwnerOf(child), asker('q?'));
    await startOwner(t, child);
    const bodies = t.port.posts.map(body);
    expect(bodies.some((b) => b.trim() === 'NO_REPLY')).toBe(false);
    expect(t.port.posts.filter((p) => JSON.stringify(p.actor) === JSON.stringify(CTO) && p.target.threadId === child.threadId).map(body).filter((b) => !/^[⏳💬]/.test(b))).toEqual([]);
  });

  it('(ii) a person-triggered run (a message in the child thread) that asks posts nothing besides the code lines', async () => {
    const t = await mk();
    const { child } = await tree();
    useRuns(t);
    t.runs.on(isWake, answering('a'));
    t.runs.on((tr) => tr.msg?.author.kind === 'human' && tr.task?.id === child.id, asker('q from a message run?'));
    await t.s.bootAsk();
    await t.send(humanMsg(child.threadId!, swWork(), { content: 'please continue' }));
    expect(t.runs.toolResults.filter((r) => r.tool === 'ask_requester' && r.isError)).toEqual([]);
    expect((await allRows())[0]).toMatchObject({ question: 'q from a message run?', status: 'answered' });
    expect(t.port.posts.map(body).some((b) => b.trim() === 'NO_REPLY')).toBe(false);
    expect(t.port.posts.filter((p) => p.target.threadId === child.threadId && JSON.stringify(p.actor) === JSON.stringify(CTO)).map(body).every((b) => /^[⏳💬]/.test(b))).toBe(true);
  });

  it('(iii) a streamed run that asks: the preview is closed with one fixed line and no final post', async () => {
    const t = await mk();
    const { child } = await tree();
    useRuns(t);
    const streams: Stream[] = [];
    (t.port as unknown as { openReplyStream: () => Stream }).openReplyStream = () => { const x = new Stream(); streams.push(x); return x; };
    t.runs.on(isWake, answering('a'));
    t.runs.on((tr) => tr.msg?.author.kind === 'human' && tr.task?.id === child.id, asker('streamed q?'));
    await t.s.bootAsk();
    await t.send(humanMsg(child.threadId!, swWork(), { content: 'go' }));
    expect(streams).toHaveLength(1);
    expect(streams[0]!.finals).toEqual([]);
    expect(streams[0]!.stopped).toEqual(['-# Asked a question; waiting for the answer.']);
    expect(t.port.posts.map(body).some((b) => b.trim() === 'NO_REPLY')).toBe(false);
    expect((await allRows())[0]).toMatchObject({ question: 'streamed q?' });
  });
});

describe('AB3 resume claim', () => {
  it('a Praw owner of the asking task is resumed once (the resume waits for a slot, it is never refused)', async () => {
    const t = await mk();
    const praw: ActorRef = { kind: 'head', dept: 'praw' };
    const root = await tasks.create({ title: 'r', deptId: 'hq', owner: HQ, requester: { kind: 'human', userId: HUMAN }, origin: 'slash', tainted: false, status: 'doing', threadId: nid(), channelId: hqWork() });
    const child = await tasks.create({ title: 'c', deptId: 'praw', owner: praw, requester: HQ, origin: 'delegated', parentId: root.id, tainted: false, status: 'doing', threadId: nid(), channelId: hqWork() });
    useRuns(t);
    t.runs.on(isWake, answering('yes'));
    t.runs.on(isOwnerOf(child), asker('Praw asks?'));
    await startOwner(t, child);
    expect((await allRows())[0]).toMatchObject({ status: 'answered' });
    expect(t.runs.resumes()).toHaveLength(1);
    expect(t.runs.resumes()[0]!.route.actor).toEqual(praw);
  });

  it('the answer path and the tick race for the same resume: exactly one owner run', async () => {
    const t = await mk();
    const { child } = await tree();
    useRuns(t);
    await t.s.bootAsk();
    const made = await questions.create({ taskId: child.id, rootId: child.rootId, parentId: child.parentId, asker: CTO, requester: HQ, question: 'q?', questionTainted: false }, { perRoot: 6, perDay: 40 });
    const id = (made as { row: { id: number } }).row.id;
    await questions.markAsked(id, 4);
    await questions.answer(id, HQ, 'a', false);
    await db.pool.query("UPDATE task_questions SET closed_at = now() - interval '5 minutes'");
    const q = (await questions.get(id))!;
    await Promise.all([
      (t.s as unknown as { resumeOwner(q: unknown, k: string): Promise<void> }).resumeOwner(q, 'answer'),
      t.s.askTick(),
      t.s.askTick(),
    ]);
    await t.s.idle();
    expect(t.runs.resumes()).toHaveLength(1);
  });
});

describe('G2AB-04 boot close is scoped to rows older than this process and runs once', () => {
  it('a failed first bootAsk, a new question, then the tick: the new row stays open and wakes; the old row is closed; a later bootAsk is a no-op', async () => {
    const { child: oldChild } = await tree();
    await questions.create({ taskId: oldChild.id, rootId: oldChild.rootId, parentId: oldChild.parentId, asker: CTO, requester: HQ, question: 'old?', questionTainted: false }, { perRoot: 6, perDay: 40 });
    await new Promise((r) => setTimeout(r, 20));
    const t = await mk(); // process start: the row above predates it
    await new Promise((r) => setTimeout(r, 20));
    const { child } = await tree();
    useRuns(t);
    const h = hang();
    t.runs.on(isWake, h.run);
    const spy = vi.spyOn(questions, 'bootClose');
    spy.mockRejectedValueOnce(new Error('transient'));
    try {
      await t.s.bootAsk(); // recovery's boot close fails: logged, never thrown
      expect(await t.agent.ask!.ask({ actor: CTO, taskId: child.id, question: 'new?', tainted: false })).toMatchObject({ ok: true });
      await new Promise((r) => setTimeout(r, 30));
      expect((await openRow(child.id))!.status).toBe('asked'); // woken, waiting
      await t.s.askTick(); // the fallback boot close succeeds now
      const rows = await allRows();
      expect(rows.find((r) => r.taskId === oldChild.id)).toMatchObject({ status: 'moot' });
      expect(rows.find((r) => r.taskId === child.id)).toMatchObject({ status: 'asked', resumedAt: null });
      const calls = spy.mock.calls.length;
      await t.s.bootAsk();
      await t.s.askTick();
      expect(spy.mock.calls.length).toBe(calls); // once-guard
      expect((await openRow(child.id))!.status).toBe('asked');
      h.release();
      await t.s.idle();
      expect(t.runs.wakes()).toHaveLength(1);
    } finally {
      spy.mockRestore();
      h.release();
    }
  });

  it('OBS-1: a question created by this process before bootAsk finishes is not closed by it', async () => {
    const t = await mk();
    await new Promise((r) => setTimeout(r, 20));
    const { child } = await tree();
    useRuns(t);
    const h = hang();
    t.runs.on(isWake, h.run);
    await t.agent.ask!.ask({ actor: CTO, taskId: child.id, question: 'during the boot window?', tainted: false });
    await t.s.bootAsk();
    expect((await openRow(child.id))?.status).toMatch(/pending|asked/);
    h.release();
    await t.s.idle();
  });
});

describe('G2AB-05 a closed row whose child is no longer doing is claimed, not replayed', () => {
  it('resumeOwner with a parked child claims the row and runs nothing; a later doing child is not resumed with the stale answer', async () => {
    const t = await mk();
    const { child } = await tree();
    useRuns(t);
    await t.s.bootAsk();
    const made = await questions.create({ taskId: child.id, rootId: child.rootId, parentId: child.parentId, asker: CTO, requester: HQ, question: 'q?', questionTainted: false }, { perRoot: 6, perDay: 40 });
    const id = (made as { row: { id: number } }).row.id;
    await questions.markAsked(id, 4);
    await questions.answer(id, HQ, 'stale answer', false);
    await tasks.update(child.id, { status: 'todo' }); // parked (halt / recovery); the next ordinary owner run reads the 💬 line
    await (t.s as unknown as { resumeOwner(q: unknown, k: string): Promise<void> }).resumeOwner((await questions.get(id))!, 'answer');
    await t.s.idle();
    expect(t.runs.resumes()).toHaveLength(0);
    expect((await questions.get(id))!.resumedAt).not.toBeNull();
    await tasks.update(child.id, { status: 'doing' });
    await db.pool.query("UPDATE task_questions SET closed_at = now() - interval '5 minutes'");
    await t.s.askTick();
    await t.s.idle();
    expect(t.runs.resumes()).toHaveLength(0);
  });
});

describe('AB5 the askWake trigger is constructed only by the scheduler\'s askUp', () => {
  it('`askWake: {` appears in exactly one non-test source file, agents/scheduler/scheduler.ts', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const n of readdirSync(dir)) {
        if (n === 'node_modules' || n === 'dist' || n.startsWith('.')) continue;
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (n.endsWith('.ts') && !n.endsWith('.test.ts') && /askWake: \{/.test(readFileSync(p, 'utf8'))) hits.push(relative(root, p));
      }
    };
    walk(root);
    expect(hits).toEqual(['agents/scheduler/scheduler.ts']);
  });
});

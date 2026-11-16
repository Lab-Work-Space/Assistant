import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCalendar, localDay } from '../company/calendar.js';
import { Org, seed } from '../company/index.js';
import type { ActorRef } from '../company/types.js';
import { AuditRepo, BotMessageRepo, ChannelMapRepo, DailyRunRepo, DepartmentRepo, HealRepo, PersonaRepo, TaskRepo, type Task } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { createAudit } from '../governance/audit.js';
import { Limits } from '../governance/limits.js';
import { FakeConfig } from '../governance/test-helpers.js';
import { resolveBlocked, resolveBlockedInput } from '../tools/builtin/resolveBlocked.js';
import { newRunState, type ToolContext } from '../tools/types.js';
import { FakeDiscordPort } from '../tests/fakes/discordPort.js';
import { createHealActions } from './tasks/heal-actions.js';
import { Healer } from './tasks/healer.js';
import { retryBlocked } from './tasks/retry.js';
import type { AgentDeps, AgentOutcome, AgentTrigger } from './loop/loop.js';
import type { OutboundPayload } from './loop/payload.js';
import { Scheduler } from './scheduler/scheduler.js';
import { newBus, noApprovedTools, prompts } from './test-helpers.js';

// HEAL-1: the real Scheduler, TaskRepo, HealRepo and audit (real SQL) wired as app.ts wires them, over a fake Discord port. The model is scripted; it drives the REAL
// resolve_blocked tool through the real HealPort.
const SECRETS = ['sk-LITERAL-SECRET-1234'];
const HQ: ActorRef = { kind: 'head', dept: 'hq' };
const CTO: ActorRef = { kind: 'head', dept: 'software' };
const CFO: ActorRef = { kind: 'head', dept: 'finance' };
const HUMAN = '1570000000000000042';
const MIN = 60_000;
let seq = 1570000000000070000n;
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
const plain = (body = 'ok', tainted = false): AgentOutcome => ({ payload: { type: 'chat', body }, costUsd: 0, turns: 1, tainted });

class Runs {
  calls: AgentTrigger[] = [];
  handlers: Handler[] = [];
  results: { tool: string; isError?: boolean; content: string }[] = [];
  on(when: Handler['when'], run: Handler['run']): void { this.handlers.unshift({ when, run }); }
  async run(t: AgentTrigger, d: AgentDeps): Promise<AgentOutcome> {
    this.calls.push(t);
    const h = this.handlers.find((x) => x.when(t));
    return h ? h.run(t, d) : plain();
  }
  wakes(): AgentTrigger[] { return this.calls.filter((c) => c.msg?.author.id === 'system:heal'); }
  /** The REAL resolve_blocked against the scheduler's real port, as the loop would call it. */
  async resolve(t: AgentTrigger, d: AgentDeps, input: Record<string, string>, taint = false): Promise<AgentOutcome> {
    const run = newRunState();
    if (taint) run.markTainted();
    const task = t.task ? await tasks.get(t.task.id) : null;
    const ctx = { actor: t.route.actor, task, origin: 'delegated', source: { channelId: '', threadId: null, messageId: null, userId: null, attachments: [] }, direct: false, tainted: () => run.tainted(), run, heal: d.heal } as unknown as ToolContext;
    const r = await resolveBlocked.run(resolveBlockedInput.parse(input), ctx);
    this.results.push({ tool: 'resolve_blocked', content: r.content, ...(r.isError ? { isError: true } : {}) });
    return plain('done', run.tainted());
  }
}

let db: TestDb;
let org: Org;
let tasks: TaskRepo;
let healRepo: HealRepo;
let auditRepo: AuditRepo;

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'), 'up');
  const repos = { departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) };
  await seed(repos, prompts);
  org = await Org.load(repos, prompts);
  tasks = new TaskRepo(db.pool, SECRETS);
  healRepo = new HealRepo(db.pool, SECRETS);
  auditRepo = new AuditRepo(db.pool);
});
afterAll(async () => db.close());
beforeEach(async () => {
  await db.pool.query('DELETE FROM audit_log');
  await db.pool.query('DELETE FROM daily_runs');
  await db.pool.query('DELETE FROM approvals');
  await db.pool.query('DELETE FROM tasks');
  await db.pool.query('DELETE FROM bot_messages');
});

async function mk(o: { cfg?: Record<string, unknown>; halted?: boolean; claimFails?: boolean; healerNow?: () => number } = {}) {
  const cfg = new FakeConfig({ 'schedule.offDays': [], ...(o.cfg ?? {}) } as never);
  const port = new Port();
  const bus = newBus();
  const limits = new Limits(cfg, tasks);
  const halted = { v: o.halted ?? false };
  const log = { error: vi.fn(), warn: vi.fn() };
  const incidents = { report: vi.fn(() => '') };
  const runs = new Runs();
  const halt = { isHalted: () => halted.v };
  const audit = createAudit(auditRepo, log);
  const heal = o.claimFails ? ({ claim: async () => { throw new Error('db down'); }, blockedNote: (id: string) => healRepo.blockedNote(id) } as unknown as HealRepo) : healRepo;
  const agent = { limits, botRoots: { acquire: async () => () => undefined } } as unknown as AgentDeps;
  agent.heal = createHealActions({
    tasks, repo: healRepo, audit, cfg, isHalted: () => halted.v, pendingApprovals: (id) => tasks.pendingApprovalCount([id]), bus, secrets: SECRETS, log,
  });
  const s = new Scheduler({
    agent, approvedTools: noApprovedTools, run: (t: AgentTrigger, d: AgentDeps) => runs.run(t, d), port, org, tasks, limits, halt, cfg, bus, log, incidents,
    calendar: createCalendar(cfg), heal, secrets: SECRETS, provenance: new BotMessageRepo(db.pool),
  } as never);
  s.attach();
  const posts: OutboundPayload[] = [];
  const healer = new Healer({
    repo: healRepo, tasks, cfg, calendar: createCalendar(cfg), secrets: SECRETS, log, ...(o.healerNow ? { now: o.healerNow } : {}),
    retry: (id, x) => retryBlocked({ tasks, bus, isHalted: () => halted.v, turnsCap: () => cfg.get('limits.turnsPerTask') }, id, x),
    wake: (a) => s.healWake(a), isHealing: (id) => s.isHealing(id), canRun: () => s.canRun(), pendingApprovals: (id) => tasks.pendingApprovalCount([id]),
    daily: new DailyRunRepo(db.pool), post: async (p) => void posts.push(p),
  });
  const tick = async () => { await healer.tick(); await s.idle(); };
  return { s, port, bus, runs, halted, log, cfg, agent, healer, tick, posts };
}
type H = Awaited<ReturnType<typeof mk>>;

const work = (dept: string) => org.dept(dept)!.workChannelId!;

/** root (hq, a person's goal) -> parent (finance, doing) -> child (software, blocked). */
async function tree(o: { childReason?: Task['blockedReason']; childOrigin?: Task['origin']; childTainted?: boolean; parentStatus?: Task['status']; noParent?: boolean; childOwner?: ActorRef; rootOrigin?: Task['origin'] } = {}) {
  const root = await tasks.create({ title: 'Root goal', deptId: 'hq', owner: HQ, requester: { kind: 'human', userId: HUMAN }, origin: o.rootOrigin ?? 'slash', status: 'doing', threadId: nid(), channelId: work('hq'), tainted: false });
  const parent = await tasks.create({
    title: 'Parent work', deptId: 'finance', owner: CFO, requester: HQ, origin: 'delegated', parentId: root.id, status: o.parentStatus ?? 'doing', threadId: nid(), channelId: work('finance'), tainted: false,
  });
  const owner = o.childOwner ?? CTO;
  const child = await tasks.create({
    title: 'Build the thing', description: 'SOURCE LINE\nmore text', deptId: owner.kind === 'head' ? owner.dept : 'software', owner, requester: CFO, origin: o.childOrigin ?? 'delegated', parentId: o.noParent ? null : parent.id,
    status: 'blocked', threadId: nid(), channelId: work('software'), tainted: o.childTainted ?? false,
  });
  if (o.childReason !== null) await tasks.update(child.id, { status: 'blocked', blockedReason: o.childReason ?? 'error', ...((o.childReason ?? 'error') === 'owner' ? { blockedNote: 'I need the staging key sk-LITERAL-SECRET-1234 and access' } : {}) });
  return { root, parent, child };
}
const age = (id: string, ms: number) => db.pool.query("UPDATE tasks SET updated_at = now() - ($2 || ' milliseconds')::interval WHERE id = $1", [id, String(ms)]);
const rows = async (action: string, taskId?: string) => (await db.pool.query<{ outcome: string; tool: string; actor: string }>('SELECT outcome, tool, actor FROM audit_log WHERE action = $1 ' + (taskId ? 'AND task_id = $2 ' : '') + 'ORDER BY id', taskId ? [action, taskId] : [action])).rows;
const statusOf = async (id: string) => (await tasks.get(id))!.status;

function hang() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  return { release, run: async (): Promise<AgentOutcome> => { await gate; return plain('late'); } };
}

describe('HEAL-1 HealRepo (real SQL)', () => {
  it('blockedCandidates: only blocked rows of reason error, turns, owner or NULL, oldest first; never halt, budget, approval; no note on the rows', async () => {
    const a = await tree({ childReason: 'error' });
    const b = await tree({ childReason: 'turns' });
    const c = await tree({ childReason: 'owner' });
    const d = await tree({ childReason: null }); // blocked, reason NULL (legacy)
    const e = await tree({ childReason: 'budget' });
    const f = await tree({ childReason: 'halt' });
    const g = await tree({ childReason: 'approval' });
    await age(a.child.id, 5000); await age(b.child.id, 4000); await age(c.child.id, 3000); await age(d.child.id, 2000);
    const got = await healRepo.blockedCandidates(50);
    expect(got.map((x) => x.task.id)).toEqual([a.child.id, b.child.id, c.child.id, d.child.id]);
    expect(got[3]!.task.blockedReason).toBeNull();
    expect(JSON.stringify(got)).not.toContain('staging key');
    expect(new Set(got.map((x) => x.task.id)).has(e.child.id) || new Set(got.map((x) => x.task.id)).has(f.child.id) || new Set(got.map((x) => x.task.id)).has(g.child.id)).toBe(false);
    expect((await healRepo.blockedCandidates(2))).toHaveLength(2);
  });
  it('blockedNote: masked with the literal list at read time, folded, cut to 300; null without a note', async () => {
    const t = await tree({ childReason: 'owner' });
    const note = (await healRepo.blockedNote(t.child.id))!;
    expect(note.startsWith('I need the staging key ')).toBe(true);
    expect(note).not.toContain('sk-LITERAL-SECRET-1234');
    await db.pool.query("UPDATE tasks SET blocked_note = $2 WHERE id = $1", [t.child.id, `line1\nline2 sk-LITERAL-SECRET-1234 ${'x'.repeat(200)}`]);
    const raw = (await healRepo.blockedNote(t.child.id))!;
    expect(raw.startsWith('line1 line2 ')).toBe(true);
    expect(raw).not.toContain('\n');
    expect(raw).not.toContain('sk-LITERAL-SECRET-1234');
    expect(raw.length).toBeLessThanOrEqual(300);
    expect(await healRepo.blockedNote((await tree({ childReason: 'error' })).child.id)).toBeNull();
    expect(await healRepo.blockedNote('00000000-0000-4000-8000-000000000000')).toBeNull();
  });
  it('claim throws on a bad row; counts read claim rows only (a refused:... row is not a claim); decider-day boundary in the zone; wake run ids parsed', async () => {
    const t = await tree({ childReason: 'owner' });
    const rid = '11111111-1111-4111-8111-111111111111';
    await healRepo.claim({ actor: 'system:healer', action: 'task.heal.wake', taskId: t.child.id, tool: 'head:finance', outcome: `claim #1 ${rid}` });
    await healRepo.claim({ actor: 'system:healer', action: 'task.heal.wake', taskId: t.child.id, tool: 'head:finance', outcome: 'ok #9 legacy' }); // not a claim
    await expect(healRepo.claim({ actor: null as never, action: 'x' })).rejects.toThrow();
    expect(await healRepo.wakes(t.child.id)).toBe(1);
    expect(await healRepo.wakeRunTasks(t.child.id)).toEqual([rid]);
    expect((await healRepo.lastWakeAt(t.child.id))!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(await healRepo.deciderToday('head:finance', 'Asia/Bangkok')).toBe(1);
    expect(await healRepo.deciderToday('head:hq', 'Asia/Bangkok')).toBe(0);
    await db.pool.query("UPDATE audit_log SET ts = (date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') AT TIME ZONE 'Asia/Bangkok') - interval '1 second' WHERE tool = 'head:finance'");
    expect(await healRepo.deciderToday('head:finance', 'Asia/Bangkok')).toBe(0); // yesterday's last second is not today
    await healRepo.claim({ actor: 'head:finance', action: 'task.heal.resolve', taskId: t.child.id, tool: t.parent.id, outcome: 'retry' });
    await healRepo.claim({ actor: 'head:finance', action: 'task.heal.resolve', taskId: t.child.id, tool: t.parent.id, outcome: 'refused:R_STALE' });
    expect(await healRepo.resolveRetries(t.child.id)).toBe(1);
    await healRepo.claim({ actor: 'system:healer', action: 'task.autoretry', taskId: t.child.id, tool: 'error', outcome: 'claim #1 error' });
    expect(await healRepo.autoretries(t.child.id)).toBe(1);
  });
  it('day(): counts, unblocked from task state (not rows), the cancel and R_TAINTED lists', async () => {
    const a = await tree({ childReason: 'error' });
    const b = await tree({ childReason: 'error' });
    for (const x of [a, b]) await healRepo.claim({ actor: 'system:healer', action: 'task.autoretry', taskId: x.child.id, tool: 'error', outcome: 'claim #1 error' });
    await tasks.update(a.child.id, { status: 'todo' }); // no longer blocked
    await healRepo.claim({ actor: 'head:finance', action: 'task.heal.resolve', taskId: b.child.id, tool: b.parent.id, outcome: 'cancel' });
    await healRepo.claim({ actor: 'head:finance', action: 'task.heal.resolve', taskId: a.child.id, tool: a.parent.id, outcome: 'refused:R_TAINTED' });
    await healRepo.claim({ actor: 'head:finance', action: 'task.heal.resolve', taskId: a.child.id, tool: a.parent.id, outcome: 'refused:R_TAINTED' });
    await db.pool.query(`INSERT INTO audit_log (actor, action, task_id, outcome) VALUES ('system','task.review.autoclose',$1,'done'),('system','task.review.autoclose',$1,'done')`, [a.child.id]);
    await db.pool.query(`INSERT INTO audit_log (ts, actor, action, task_id, outcome) VALUES (now() - interval '2 days','system','task.review.autoclose',$1,'done')`, [a.child.id]); // not today
    expect(d0(await healRepo.day('Asia/Bangkok'))).toBe(2); // R1-02
    const d = await healRepo.day('Asia/Bangkok');
    expect(d).toMatchObject({ retries: 2, unblocked: 1, wakes: 0, resolveRetry: 0, resolveCancel: 1 });
    expect(d.cancels).toEqual([{ taskId: b.child.id, title: 'Build the thing', decider: 'head:finance' }]);
    expect(d.tainted).toEqual([{ taskId: a.child.id, title: 'Build the thing' }]);
  });
});

const d0 = (d: { autoclosed: number }): number => d.autoclosed;

describe('HEAL-1 retry path through the real scheduler', () => {
  it('error blocked 31 min: retried by code (claim row first), the scheduler starts it; 29 min is left alone; the second retry comes after 2 h; then a wake, not a third retry', async () => {
    const t = await mk();
    const young = await tree({ childReason: 'error' });
    await age(young.child.id, 29 * MIN);
    await t.tick();
    expect(await statusOf(young.child.id)).toBe('blocked');
    expect(await rows('task.autoretry')).toEqual([]);
    await age(young.child.id, 31 * MIN);
    await t.tick();
    expect(t.runs.calls.filter((c) => c.task?.id === young.child.id)).toHaveLength(1); // task.ready -> runOwner ran it
    expect(await rows('task.autoretry', young.child.id)).toEqual([{ outcome: 'claim #1 error', tool: 'error', actor: 'system:healer' }]);
    // it blocks again; 31 min is too soon for attempt 2
    await tasks.update(young.child.id, { status: 'blocked', blockedReason: 'error' });
    await age(young.child.id, 31 * MIN);
    await t.tick();
    expect(await rows('task.autoretry', young.child.id)).toHaveLength(1);
    await age(young.child.id, 121 * MIN);
    await t.tick();
    expect(await rows('task.autoretry', young.child.id)).toHaveLength(2);
    // third block: retries used up -> the parent owner is woken, no third retry
    await tasks.update(young.child.id, { status: 'blocked', blockedReason: 'error' });
    await age(young.child.id, 3 * 60 * MIN);
    t.runs.on((c) => c.msg?.author.id === 'system:heal', async () => plain('NO_REPLY'));
    await t.tick();
    expect(await rows('task.autoretry', young.child.id)).toHaveLength(2);
    expect(t.runs.wakes()).toHaveLength(1);
    expect(t.runs.wakes()[0]!.task!.id).toBe(young.parent.id);
    expect(t.runs.wakes()[0]!.msg!.content).toContain('gave up after automatic retries');
  });
  it('turns: one retry with the turn counter reset; error older than 24 h is woken, never retried (live rows)', async () => {
    const t = await mk();
    const a = await tree({ childReason: 'turns' });
    await tasks.update(a.child.id, { turnsUsed: 30 });
    await age(a.child.id, 31 * MIN);
    const b = await tree({ childReason: 'error' });
    await age(b.child.id, 26 * 60 * MIN);
    t.runs.on((c) => c.msg?.author.id === 'system:heal', async () => plain('NO_REPLY'));
    await t.tick();
    expect((await tasks.get(a.child.id))!.turnsUsed).toBe(0);
    expect(await rows('task.autoretry', a.child.id)).toEqual([{ outcome: 'claim #1 turns reset_turns', tool: 'turns', actor: 'system:healer' }]);
    expect(await rows('task.autoretry', b.child.id)).toEqual([]);
    expect(await statusOf(b.child.id)).toBe('blocked');
    expect(t.runs.wakes()).toHaveLength(1);
    expect(t.runs.wakes()[0]!.msg!.content).toContain('blocked for more than 24 hours');
  });
  it('heal off, halted: nothing at all', async () => {
    const off = await mk({ cfg: { 'heal.enabled': false } });
    const a = await tree({ childReason: 'error' });
    await age(a.child.id, 31 * MIN);
    await off.tick();
    const halted = await mk({ halted: true });
    await halted.tick();
    expect(await statusOf(a.child.id)).toBe('blocked');
    expect(await rows('task.autoretry')).toEqual([]);
  });
});

describe('HEAL-1 wake path through the real scheduler', () => {
  it('self-blocked child: the parent owner is woken once (wrapped message, fixed instruction, claim row); resolve_blocked retry puts it in todo with the frame and the scheduler starts it', async () => {
    const t = await mk();
    const { parent, child } = await tree({ childReason: 'owner' });
    t.runs.on((c) => c.msg?.author.id === 'system:heal', (tr, d) => t.runs.resolve(tr, d, { taskId: child.id, action: 'retry', instruction: 'use staging; the key is in the vault' }));
    await t.tick();
    const wake = t.runs.wakes();
    expect(wake).toHaveLength(1);
    expect(wake[0]!.task!.id).toBe(parent.id);
    expect(wake[0]!.route).toEqual({ actor: CFO, reason: 'task_owner', taskId: parent.id });
    expect(wake[0]!.msg!.content).toContain(`Blocked task ${child.id} (owner head of software, reason owner)`);
    expect(wake[0]!.msg!.content).toContain('I need the staging key');
    expect(wake[0]!.msg!.content).not.toContain('sk-LITERAL-SECRET-1234');
    expect(wake[0]!.instruction).toContain('resolve_blocked');
    expect(wake[0]!.noAsk).toBeUndefined(); // parent path may ask the person
    expect(t.runs.results).toEqual([{ tool: 'resolve_blocked', content: 'the task is back in todo with your instruction; its owner runs it again' }]);
    const after = (await tasks.get(child.id))!;
    expect(after.description).toContain('SOURCE LINE\nmore text');
    expect(after.description).toContain('Instruction from head of finance after the block');
    expect(after.description).toContain('use staging; the key is in the vault');
    // task.ready started the child
    expect(t.runs.calls.filter((c) => c.task?.id === child.id && !c.msg)).toHaveLength(1);
    expect(await rows('task.heal.wake', child.id)).toEqual([{ outcome: `claim #1 ${parent.id}`, tool: 'head:finance', actor: 'system:healer' }]);
    expect(await rows('task.heal.resolve', child.id)).toEqual([{ outcome: 'retry', tool: parent.id, actor: 'head:finance' }]);
  });
  it('a parent already doing: the wake waits for its lock, runs once after it, and a second tick starts nothing', async () => {
    const t = await mk();
    const { parent, child } = await tree({ childReason: 'owner' });
    await tasks.update(parent.id, { status: 'todo' });
    const h = hang();
    t.runs.on((c) => c.task?.id === parent.id && !c.msg, h.run); // the parent's own run holds the lock
    t.runs.on((c) => c.msg?.author.id === 'system:heal', async () => plain('NO_REPLY'));
    void t.s.onTaskReady(parent.id);
    await vi.waitFor(() => expect(t.runs.calls.filter((c) => c.task?.id === parent.id)).toHaveLength(1));
    await t.healer.tick();
    await new Promise((r) => setTimeout(r, 50));
    expect(t.runs.wakes()).toHaveLength(0); // waiting for the lock
    expect(t.s.isHealing(child.id)).toBe(true);
    expect(await rows('task.heal.wake', child.id)).toHaveLength(1); // the claim is already written (C12)
    await t.healer.tick();
    expect(await rows('task.heal.wake', child.id)).toHaveLength(1); // not queued again
    h.release();
    await t.s.idle();
    expect(t.runs.wakes()).toHaveLength(1);
    expect(t.s.isHealing(child.id)).toBe(false);
    await t.tick();
    expect(t.runs.wakes()).toHaveLength(1); // the 30 min gap
  });
  it('restart does not repeat a wake inside 30 min (a second scheduler on the same database)', async () => {
    const a = await mk();
    const { child } = await tree({ childReason: 'owner' });
    await a.tick();
    expect(a.runs.wakes()).toHaveLength(1);
    const b = await mk();
    await b.tick();
    expect(b.runs.wakes()).toHaveLength(0);
    await db.pool.query("UPDATE audit_log SET ts = now() - interval '31 minutes' WHERE action = 'task.heal.wake'");
    await b.tick();
    expect(b.runs.wakes()).toHaveLength(1); // the second wake of the same task
    await db.pool.query("UPDATE audit_log SET ts = now() - interval '2 hours' WHERE action = 'task.heal.wake'");
    await b.tick();
    expect(b.runs.wakes()).toHaveLength(1); // the per-task cap of 2 is spent
    expect(await rows('task.heal.wake', child.id)).toHaveLength(2);
  });
  it('no parent: the CEO is woken on a new decide task (doing, hq, tainted like the blocked task, noAsk), the run happens once, the decide task is closed done', async () => {
    const t = await mk();
    const { child } = await tree({ childReason: 'owner', noParent: true, childTainted: true });
    t.runs.on((c) => c.msg?.author.id === 'system:heal', (tr, d) => t.runs.resolve(tr, d, { taskId: child.id, action: 'retry', instruction: 'try again with the new brief' }));
    await t.tick();
    expect(t.runs.wakes()).toHaveLength(1);
    const w = t.runs.wakes()[0]!;
    expect(w.route.actor).toEqual(HQ);
    expect(w.noAsk).toBe(true);
    expect(w.instruction).toContain('Do nothing else');
    expect(w.instruction).not.toContain('ask_requester');
    expect(w.task!.title).toBe(`Decide on blocked task ${child.id.slice(0, 8)}`);
    expect(w.task!.tainted).toBe(true);
    // no second (plain owner) run of the decide task from task.created
    expect(t.runs.calls.filter((c) => c.task?.id === w.task!.id)).toHaveLength(1);
    expect((await tasks.get(w.task!.id))!.status).toBe('done');
    expect(await statusOf(child.id)).toBe('todo');
    expect((await tasks.get(child.id))!.tainted).toBe(true); // copied
    const wakeRow = (await rows('task.heal.wake', child.id))[0]!;
    expect(wakeRow.outcome).toBe(`claim #1 ${w.task!.id}`);
    expect(wakeRow.tool).toBe('head:hq');
  });
  it('G2-03: a wake that throws still closes the decide task (no doing leftover, no plain owner run)', async () => {
    const t = await mk();
    const { child } = await tree({ childReason: 'owner', noParent: true });
    t.runs.on((c) => c.msg?.author.id === 'system:heal', async () => { throw new Error('model down'); });
    await t.tick();
    const [wake] = await rows('task.heal.wake', child.id);
    const id = /^claim #1 (.+)$/.exec(wake!.outcome)![1]!;
    expect(['done', 'cancelled']).toContain(await statusOf(id));
    expect(await tasks.listByStatus('doing')).toEqual(expect.not.arrayContaining([expect.objectContaining({ id })]));
    expect(await healRepo.closeOpenDecideTasks()).toEqual([]);
  });
  it('G2-03: a wake that returns early (the blocked task moved meanwhile) closes the decide task cancelled and runs nothing', async () => {
    const t = await mk();
    const { child } = await tree({ childReason: 'owner', noParent: true });
    const snapshot = (await tasks.get(child.id))!;
    await tasks.update(child.id, { status: 'todo' });
    expect(await t.s.healWake({ blocked: snapshot, decider: HQ, runTask: null, n: 1 })).toBe('started');
    await t.s.idle();
    const [wake] = await rows('task.heal.wake', child.id);
    const id = /^claim #1 (.+)$/.exec(wake!.outcome)![1]!;
    expect(await statusOf(id)).toBe('cancelled');
    expect(t.runs.calls.filter((c) => c.task?.id === id)).toHaveLength(0);
  });
  it('G2-03: boot recovery closes an open decide task named in a wake claim (doing or todo) instead of resetting it; other tasks are untouched', async () => {
    const { child, parent } = await tree({ childReason: 'owner', noParent: true });
    const mkDecide = async (title: string, status: Task['status']) => tasks.create({ title, deptId: 'hq', owner: HQ, requester: HQ, origin: 'delegated', status, threadId: nid(), channelId: work('hq') });
    const named = await mkDecide(`Decide on blocked task ${child.id.slice(0, 8)}`, 'doing');
    const namedTodo = await mkDecide(`Decide on blocked task ${child.id.slice(0, 8)}`, 'todo');
    const unnamed = await mkDecide('Decide on blocked task deadbeef', 'doing'); // no claim names it
    await healRepo.claim({ actor: 'system:healer', action: 'task.heal.wake', taskId: child.id, tool: 'head:hq', outcome: `claim #1 ${named.id}` });
    await healRepo.claim({ actor: 'system:healer', action: 'task.heal.wake', taskId: child.id, tool: 'head:hq', outcome: `claim #2 ${namedTodo.id}` });
    await healRepo.claim({ actor: 'system:healer', action: 'task.heal.wake', taskId: child.id, tool: 'head:finance', outcome: `claim #3 ${parent.id}` }); // a parent-path claim names a real task
    const closed = await healRepo.closeOpenDecideTasks();
    expect(closed.map((x) => x.id).sort()).toEqual([named.id, namedTodo.id].sort());
    expect(closed.every((x) => x.status === 'cancelled')).toBe(true);
    const reset = await tasks.resetDoingToTodo();
    expect(reset.map((x) => x.id)).not.toContain(named.id);
    expect(reset.map((x) => x.id)).toContain(unnamed.id);
    expect(reset.map((x) => x.id)).toContain(parent.id); // the parent task is still recovered the normal way
    expect(await statusOf(named.id)).toBe('cancelled');
    expect(await statusOf(namedTodo.id)).toBe('cancelled');
  });
  it('a tainted blocked task taints the (clean) parent before its run starts; a tainted decider retry taints the child', async () => {
    const t = await mk();
    const { parent, child } = await tree({ childReason: 'owner', childTainted: true });
    t.runs.on((c) => c.msg?.author.id === 'system:heal', async (tr, d) => {
      expect((await tasks.get(parent.id))!.tainted).toBe(true);
      expect(tr.task!.tainted).toBe(true);
      return t.runs.resolve(tr, d, { taskId: child.id, action: 'retry', instruction: 'again' }, true);
    });
    await t.tick();
    expect(t.runs.wakes()).toHaveLength(1);
    expect((await tasks.get(child.id))!.tainted).toBe(true);
    const clean = await tree({ childReason: 'owner' });
    t.runs.on((c) => c.msg?.author.id === 'system:heal' && c.task?.id === clean.parent.id, (tr, d) => t.runs.resolve(tr, d, { taskId: clean.child.id, action: 'retry', instruction: 'again' }, true));
    await t.tick();
    expect((await tasks.get(clean.child.id))!.tainted).toBe(true); // the decider read outside text in its run
    expect((await tasks.get(clean.parent.id))!.tainted).toBe(false);
  });
  it('cancel: the child is cancelled, the parent gets the roll-up notice, a root also ends its grants; audit task.heal.resolve cancel', async () => {
    const t = await mk();
    const { parent, child } = await tree({ childReason: 'owner' });
    t.runs.on((c) => c.msg?.author.id === 'system:heal', (tr, d) => t.runs.resolve(tr, d, { taskId: child.id, action: 'cancel', reason: 'abandoned idea' }));
    await t.tick();
    expect(await statusOf(child.id)).toBe('cancelled');
    expect(await rows('task.heal.resolve', child.id)).toEqual([{ outcome: 'cancel', tool: parent.id, actor: 'head:finance' }]);
    expect(t.port.posts.some((p) => p.payload.title === 'Subtask cancelled')).toBe(true);
  });
  it('the CEO own blocked task is never woken: it is listed in the summary; the summary posts once at 18:30 local (not at 17:30) and not again', async () => {
    const day = localDay(Date.now(), 'Asia/Bangkok').date;
    const at = (hhmm: string) => Date.parse(`${day}T${hhmm}:00+07:00`);
    const own = await tasks.create({ title: 'CEO own', deptId: 'hq', owner: HQ, requester: { kind: 'human', userId: HUMAN }, origin: 'slash', status: 'blocked', threadId: nid(), channelId: work('hq') });
    await tasks.update(own.id, { status: 'blocked', blockedReason: 'owner', blockedNote: 'stuck' });
    const early = await mk({ healerNow: () => at('17:30') });
    await early.tick();
    expect(early.runs.wakes()).toHaveLength(0);
    expect(early.posts).toEqual([]);
    expect(await new DailyRunRepo(db.pool).claim(day, 'heal')).toBe(true); // not claimed by the 17:30 tick (then released for the rest of the test)
    await db.pool.query("DELETE FROM daily_runs WHERE kind = 'heal'");
    const t = await mk({ healerNow: () => at('18:30') });
    await t.tick();
    await t.tick();
    expect(t.runs.wakes()).toHaveLength(0);
    expect(await rows('task.heal.wake')).toEqual([]);
    expect(t.posts).toHaveLength(1);
    expect(t.posts[0]!.title).toBe('Heal summary');
    expect(t.posts[0]!.body).toContain(own.id.slice(0, 8));
    expect(t.posts[0]!.body).toContain('the CEO owns it');
    expect(t.posts[0]!.body).not.toContain('stuck'); // never note text
    expect((await db.pool.query("SELECT count(*)::int AS n FROM daily_runs WHERE kind = 'heal'")).rows[0].n).toBe(1);
  });
  it('open-task limit full: no decide task, no claim row; a failed claim write starts nothing (no run, no decide task)', async () => {
    const full = await mk({ cfg: { 'limits.openTasks': 1 } });
    const { child } = await tree({ childReason: 'owner', noParent: true });
    await full.tick();
    expect(full.runs.wakes()).toEqual([]);
    expect(await rows('task.heal.wake')).toEqual([]);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM tasks WHERE title LIKE 'Decide on blocked%'")).rows[0].n).toBe(0);
    const bad = await mk({ claimFails: true });
    await bad.tick();
    expect(bad.runs.wakes()).toEqual([]);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM tasks WHERE title LIKE 'Decide on blocked%'")).rows[0].n).toBe(0);
    expect(await statusOf(child.id)).toBe('blocked');
  });
  it('a retried child of a parent that already rolled up reports again when it finishes', async () => {
    const t = await mk();
    const { parent, child } = await tree({ childReason: 'owner' });
    await tasks.update(parent.id, { status: 'doing' });
    // the block already reached the parent once (the "Subtask blocked" notice), as it does when the owner blocks its own task
    await t.bus.emit('task.changed', { task: (await tasks.get(child.id))!, from: 'doing', to: 'blocked' });
    await t.s.idle();
    expect(t.port.posts.some((p) => p.payload.title === 'Subtask blocked')).toBe(true);
    t.runs.on((c) => c.msg?.author.id === 'system:heal', (tr, d) => t.runs.resolve(tr, d, { taskId: child.id, action: 'retry', instruction: 'go on' }));
    await t.tick();
    expect(await statusOf(child.id)).toBe('todo');
    // the retried child finishes
    await tasks.update(child.id, { status: 'doing' }, 'todo');
    const done = await tasks.update(child.id, { status: 'done' }, 'doing');
    await t.bus.emit('task.changed', { task: done!, from: 'doing', to: 'done', summary: 'built it' });
    await t.s.idle();
    expect(t.runs.calls.filter((c) => c.task?.id === parent.id && c.msg?.content.includes('finished "Build the thing"'))).toHaveLength(1);
  });
});

describe('HEAL-1 resolve_blocked authorisation (real tool, real port, real rows)', () => {
  it('refused: a head that is not the decider, the right head in an unrelated task, a persona caller, a sibling tree; no approval row is created; each refusal leaves a row', async () => {
    const t = await mk();
    const { parent, child, root } = await tree({ childReason: 'owner' });
    const call = async (actor: ActorRef | { kind: 'persona'; personaId: string }, on: Task | null, input?: Record<string, string>) => {
      const ctx = { actor, task: on, tainted: () => false, run: newRunState(), heal: t.agent.heal } as unknown as ToolContext;
      return resolveBlocked.run(resolveBlockedInput.parse(input ?? { taskId: child.id, action: 'retry', instruction: 'go' }), ctx);
    };
    const refusals = [
      await call(CTO, parent), // the owner of the blocked task
      await call(HQ, parent), // not the decider (the parent owner is)
      await call(CFO, root), // the decider from an unrelated task of its conversation
      await call(CFO, null),
      await call({ kind: 'persona', personaId: 'system-analyst' }, parent),
    ];
    expect(refusals.every((r) => r.isError)).toBe(true);
    expect(refusals.map((r) => r.content)).toEqual([
      'you are not the one who decides about that task', 'you are not the one who decides about that task',
      'resolve_blocked works only from the parent task or the decision task of that blocked task',
      'resolve_blocked works only from the parent task or the decision task of that blocked task',
      'resolve_blocked is for department heads only',
    ]);
    expect((await rows('task.heal.resolve', child.id)).map((r) => r.outcome)).toEqual(['refused:R_NOT_DECIDER', 'refused:R_NOT_DECIDER', 'refused:R_NOT_HERE', 'refused:R_NOT_HERE', 'refused:R_NOT_HEAD']);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM approvals')).rows[0].n).toBe(0);
    expect(await statusOf(child.id)).toBe('blocked');
    // the real decider, from its own parent task, works
    expect((await call(CFO, parent)).isError).toBeUndefined();
    expect(await statusOf(child.id)).toBe('todo');
  });
  it('retry cap over the lifetime: a child that re-blocks after each retry gets at most 2, the third is R_RETRY_CAP; budget, approval and halt blocks are never healable; a pending approval refuses', async () => {
    const t = await mk();
    const { parent, child } = await tree({ childReason: 'owner' });
    const call = (taskId: string, action: 'retry' | 'cancel' = 'retry') => {
      const ctx = { actor: CFO, task: parent, tainted: () => false, run: newRunState(), heal: t.agent.heal } as unknown as ToolContext;
      return resolveBlocked.run(resolveBlockedInput.parse(action === 'retry' ? { taskId, action, instruction: 'go' } : { taskId, action, reason: 'no' }), ctx);
    };
    for (let i = 0; i < 2; i++) {
      expect((await call(child.id)).isError).toBeUndefined();
      await tasks.update(child.id, { status: 'blocked', blockedReason: 'owner' });
    }
    expect((await call(child.id)).content).toContain('retried the most times allowed');
    for (const reason of ['budget', 'approval', 'halt'] as const) {
      const x = await tree({ childReason: reason });
      for (const action of ['retry', 'cancel'] as const) {
        const ctx = { actor: CFO, task: x.parent, tainted: () => false, run: newRunState(), heal: t.agent.heal } as unknown as ToolContext;
        const r = await resolveBlocked.run(resolveBlockedInput.parse(action === 'retry' ? { taskId: x.child.id, action, instruction: 'go' } : { taskId: x.child.id, action, reason: 'no' }), ctx);
        expect(r).toEqual({ content: 'that block needs the owner', isError: true });
      }
    }
    const p = await tree({ childReason: 'owner' });
    await db.pool.query("INSERT INTO approvals (task_id, reason, requested_by, status) VALUES ($1, 'r', 'head:software', 'pending')", [p.child.id]);
    const ctx = { actor: CFO, task: p.parent, tainted: () => false, run: newRunState(), heal: t.agent.heal } as unknown as ToolContext;
    expect((await resolveBlocked.run(resolveBlockedInput.parse({ taskId: p.child.id, action: 'cancel', reason: 'no' }), ctx)).content).toBe('that task has a pending approval; wait for the decision');
  });
  it('tainted cancel of a person task is refused and listed; open children refuse a cancel; the real cancel of a clean delegated task works', async () => {
    const t = await mk();
    const { parent, child } = await tree({ childReason: 'owner', childOrigin: 'chat' });
    const ctx = (tainted: boolean) => ({ actor: CFO, task: parent, tainted: () => tainted, run: newRunState(), heal: t.agent.heal }) as unknown as ToolContext;
    const input = resolveBlockedInput.parse({ taskId: child.id, action: 'cancel', reason: 'no' });
    expect((await resolveBlocked.run(input, ctx(true))).content).toContain('a person asked for that task');
    expect((await healRepo.day('Asia/Bangkok')).tainted).toEqual([{ taskId: child.id, title: 'Build the thing' }]);
    await tasks.create({ title: 'grandchild', deptId: 'software', owner: CTO, requester: CTO, origin: 'delegated', parentId: child.id, status: 'todo' });
    expect((await resolveBlocked.run(input, ctx(false))).content).toBe('that task has open subtasks; it cannot be cancelled here');
    await db.pool.query("UPDATE tasks SET status = 'cancelled' WHERE parent_id = $1", [child.id]);
    expect((await resolveBlocked.run(input, ctx(false))).isError).toBeUndefined();
    expect(await statusOf(child.id)).toBe('cancelled');
  });
});

// HEAL-T2 acceptance: the shape of the 9 blocked rows found on the live bot on 2026-11-09 (read-only SELECT, ids dropped): 2 `error` rows 26 h old, 7 rows with a
// NULL reason (11-36 h old). Persona owners, one rnd head with no parent. Nobody typed /task retry.
describe('HEAL-T2 acceptance: the 2026-11-09 blocked rows', () => {
  it('9 live-shaped rows: every one is woken (none retried by code, the 2 old error rows included), nothing needs /task retry, repeated ticks do not re-wake', async () => {
    const t = await mk({ cfg: { 'limits.openTasks': 100 } }); // the fixture builds 27 open rows; the default cap of 20 would (by design, HL-C16) defer the CEO decide task
    const P = (personaId: string): ActorRef => ({ kind: 'persona', personaId }) as ActorRef;
    const specs: { reason: Task['blockedReason']; hours: number; owner: ActorRef; noParent?: boolean }[] = [
      { reason: null, hours: 36, owner: P('research-scientist') },
      { reason: 'error', hours: 26, owner: P('research-scientist') },
      { reason: 'error', hours: 26, owner: P('system-analyst') },
      { reason: null, hours: 13, owner: { kind: 'head', dept: 'rnd' }, noParent: true },
      { reason: null, hours: 11, owner: P('code-reviewer-qa') },
      { reason: null, hours: 11, owner: P('pair-programmer') },
      { reason: null, hours: 11, owner: P('pair-programmer') },
      { reason: null, hours: 11, owner: P('system-analyst') },
      { reason: null, hours: 11, owner: P('system-analyst') },
    ];
    const ids: string[] = [];
    for (const s of specs) {
      const x = await tree({ childReason: s.reason, childOwner: s.owner, ...(s.noParent ? { noParent: true } : {}) });
      await age(x.child.id, s.hours * 60 * MIN);
      ids.push(x.child.id);
    }
    t.runs.on((c) => c.msg?.author.id === 'system:heal', async () => plain('NO_REPLY'));
    for (let i = 0; i < 5; i++) await t.tick(); // 3 rows per tick -> 9 rows inside 3 ticks
    const woken = new Set<string>();
    for (const id of ids) if ((await rows('task.heal.wake', id)).length > 0) woken.add(id);
    expect(ids.filter((id) => !woken.has(id)).map((id) => specs[ids.indexOf(id)]), JSON.stringify(await healRepo.day('Asia/Bangkok'))).toEqual([]);
    for (const id of ids) {
      expect(await rows('task.autoretry', id)).toEqual([]); // error rows older than 24 h are never retried, NULL rows never retried
      expect((await rows('task.heal.wake', id)).length).toBe(1); // the 30 min gap holds: one wake per task
    }
    expect(t.runs.wakes()).toHaveLength(9);
  });
  it('a retried task keeps its forward card and the first description line (HL-C14)', async () => {
    const t = await mk();
    const { child } = await tree({ childReason: 'error' });
    await db.pool.query("UPDATE tasks SET forward_card = 'link' WHERE id = $1", [child.id]);
    await age(child.id, 31 * MIN);
    await t.tick();
    const after = (await tasks.get(child.id))!;
    expect(after.forwardCard).toBe('link');
    expect(after.description!.split('\n')[0]).toBe('SOURCE LINE');
    expect(await rows('task.autoretry', child.id)).toHaveLength(1);
  });
});

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCalendar } from '../company/calendar.js';
import { Org, seed } from '../company/index.js';
import type { ActorRef } from '../company/types.js';
import { AuditRepo, BotMessageRepo, ChannelMapRepo, DepartmentRepo, HealRepo, PersonaRepo, RetroRepo, TaskRepo } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { Limits } from '../governance/limits.js';
import { FakeConfig } from '../governance/test-helpers.js';
import { WeeklyRetro } from '../grow/retro.js';
import { FakeDiscordPort } from '../tests/fakes/discordPort.js';
import { Healer } from './tasks/healer.js';
import { retryBlocked } from './tasks/retry.js';
import type { AgentDeps, AgentOutcome, AgentTrigger } from './loop/loop.js';
import type { OutboundPayload } from './loop/payload.js';
import { Scheduler } from './scheduler/scheduler.js';
import { createAudit } from '../governance/audit.js';
import { DailyRunRepo } from '../db/index.js';
import { newBus, noApprovedTools, prompts } from './test-helpers.js';

// GROW-1 retro run lifecycle: the real Scheduler, TaskRepo, RetroRepo (real SQL) over a fake port; the model run is scripted per case.
const SECRETS: string[] = [];
const MIN = 60_000;
const WEEK = '2026-W46';
const FRIDAY_16 = Date.parse('2026-11-13T16:00:00+07:00');
class Port extends FakeDiscordPort {
  override snowflakes = true;
  override async post(actor: ActorRef, target: { channelId: string; threadId?: string }, payload: OutboundPayload, opts?: Parameters<FakeDiscordPort['post']>[3]): Promise<string> {
    const id = await super.post(actor, target, payload, opts);
    opts?.onSent?.([id]);
    return id;
  }
}
const plain = (body = 'ok'): AgentOutcome => ({ payload: { type: 'chat', body }, costUsd: 0, turns: 1, tainted: false });

let db: TestDb;
let org: Org;
let tasks: TaskRepo;
let retroRepo: RetroRepo;
beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'), 'up');
  const repos = { departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) };
  await seed(repos, prompts);
  org = await Org.load(repos, prompts);
  tasks = new TaskRepo(db.pool, SECRETS);
  retroRepo = new RetroRepo(db.pool);
});
afterAll(async () => db.close());
beforeEach(async () => {
  for (const t of ['audit_log', 'daily_runs', 'approvals', 'retro_runs', 'tasks', 'bot_messages']) await db.pool.query(`DELETE FROM ${t}`);
});

async function mk(o: { halted?: boolean; onRun?: (t: AgentTrigger) => Promise<AgentOutcome> } = {}) {
  const cfg = new FakeConfig({ 'schedule.offDays': [], 'schedule.timezone': 'Asia/Bangkok' } as never);
  const port = new Port();
  const bus = newBus();
  const limits = new Limits(cfg, tasks);
  const halted = { v: o.halted ?? false };
  const log = { error: vi.fn(), warn: vi.fn() };
  const calls: AgentTrigger[] = [];
  const run = async (t: AgentTrigger): Promise<AgentOutcome> => { calls.push(t); return o.onRun ? o.onRun(t) : plain(); };
  const healRepo = new HealRepo(db.pool, SECRETS);
  const s = new Scheduler({
    agent: { limits, botRoots: { acquire: async () => () => undefined } } as unknown as AgentDeps, approvedTools: noApprovedTools, run, port, org, tasks, limits, halt: { isHalted: () => halted.v }, cfg, bus, log,
    incidents: { report: vi.fn(() => '') }, calendar: createCalendar(cfg), heal: healRepo, retro: retroRepo, secrets: SECRETS, provenance: new BotMessageRepo(db.pool), now: () => FRIDAY_16,
  } as never);
  s.attach();
  const claim = async (dept: string, id: string) => { await retroRepo.claim(dept, WEEK, id); return s.retroStart({ dept: dept as never, week: WEEK, taskId: id }); };
  return { s, port, calls, halted, log, cfg, bus, claim, healRepo };
}
const ID = '33333333-3333-3333-3333-333333333333';
const statusOf = async (id: string) => (await tasks.get(id))!.status;
const retroRow = async () => (await db.pool.query('SELECT outcome FROM retro_runs')).rows[0]?.outcome;

describe('GROW-1 Scheduler.retroStart: a code-made `doing` task that is ALWAYS closed (GW-C6, C12)', () => {
  it('the run trigger carries retro, noAsk, noWarroomSay, the warroom pool and the code instruction; the task is created doing (never todo) and ends done; the claim is done', async () => {
    const seen: { status: string; trigger: AgentTrigger }[] = [];
    const t = await mk({ onRun: async (tr) => { seen.push({ status: await statusOf(ID), trigger: tr }); return plain('summary'); } });
    expect(await t.claim('software', ID)).toBe('started');
    await t.s.idle();
    expect(seen).toHaveLength(1);
    const { status, trigger } = seen[0]!;
    expect(status).toBe('doing');
    expect(trigger).toMatchObject({ retro: true, noAsk: true, noWarroomSay: true, pool: 'warroom', route: { actor: { kind: 'head', dept: 'software' }, reason: 'task_owner', taskId: ID } });
    expect(trigger.instruction).toContain('weekly retro');
    expect(trigger.msg).toMatchObject({ id: `retro-software-${WEEK}`, author: { id: 'system:retro', kind: 'head' } });
    expect(trigger.msg!.content).toContain('Weekly retro facts for software, 2026-11-06..2026-11-13 (Asia/Bangkok).');
    expect(await statusOf(ID)).toBe('done');
    expect(await retroRow()).toBe('done');
    expect((await tasks.get(ID))!).toMatchObject({ title: `Weekly retro ${WEEK}`, origin: 'delegated', tainted: false });
    expect(t.port.posts.filter((p) => JSON.stringify(p.payload).includes('summary'))).toHaveLength(1);
  });
  it.each([
    ['blocked by the run (turn cap, error, budget)', async (t: AgentTrigger) => { await tasks.update(t.task!.id, { status: 'blocked', blockedReason: 'error' }); return plain(); }],
    ['awaiting_approval parked by a cap card', async (t: AgentTrigger) => { await tasks.update(t.task!.id, { status: 'awaiting_approval' }); return plain(); }],
    ['the run throws', async () => { throw new Error('provider down'); }],
  ])('%s: the task is closed (done or cancelled), never left open for a healer or a resume; the claim has an outcome', async (_n, onRun) => {
    const t = await mk({ onRun });
    await t.claim('software', ID);
    await t.s.idle();
    expect(['done', 'cancelled']).toContain(await statusOf(ID));
    expect(await retroRow()).toBeTruthy();
    // neither a healer tick nor unblockHalted nor the boot reset schedules a plain owner run on it
    const healer = new Healer({
      repo: t.healRepo, tasks, cfg: t.cfg, calendar: createCalendar(t.cfg), secrets: SECRETS, log: t.log, now: () => FRIDAY_16 + 3 * 60 * MIN,
      retry: (id, x) => retryBlocked({ tasks, bus: t.bus, isHalted: () => false, turnsCap: () => 40 }, id, x),
      wake: (a) => t.s.healWake(a), isHealing: (id) => t.s.isHealing(id), canRun: () => t.s.canRun(), pendingApprovals: (id) => tasks.pendingApprovalCount([id]), daily: new DailyRunRepo(db.pool), post: async () => undefined,
    });
    await healer.tick();
    await tasks.unblockHalted();
    expect(await tasks.resetDoingToTodo()).toEqual([]);
    await t.s.idle();
    expect(t.calls.filter((c) => !c.retro)).toHaveLength(0);
    expect(t.calls.filter((c) => c.retro)).toHaveLength(1);
  });
  it('halted: nothing is created, no run, and the claim row is left for the caller to mark failed', async () => {
    const t = await mk({ halted: true });
    expect(await t.claim('software', ID)).toBe('skipped');
    expect(await tasks.get(ID)).toBeNull();
    expect(t.calls).toHaveLength(0);
  });
  it('a department without a work channel cannot get a thread: the task is cancelled, the claim is failed, no model run', async () => {
    const t = await mk();
    const dept = org.dept('software')!;
    const saved = dept.workChannelId;
    (dept as { workChannelId: string | null }).workChannelId = null;
    try {
      await t.claim('software', ID);
      await t.s.idle();
    } finally {
      (dept as { workChannelId: string | null }).workChannelId = saved;
    }
    expect(await statusOf(ID)).toBe('cancelled');
    expect(await retroRow()).toBe('failed');
    expect(t.calls).toHaveLength(0);
  });
  it('the WeeklyRetro tick drives it: one run for the department, a second tick the same week does nothing, and the next week runs again', async () => {
    const t = await mk();
    let now = FRIDAY_16;
    const mkRetro = () => new WeeklyRetro({
      cfg: t.cfg, calendar: createCalendar(t.cfg), org: { heads: () => [org.dept('software')!] } as never, repo: retroRepo, canRun: () => t.s.canRun(), limits: new Limits(t.cfg, tasks), now: () => now, log: t.log,
      start: (a) => t.s.retroStart({ ...a, dept: a.dept as never }),
    });
    expect(await mkRetro().tick()).toBe('software');
    await t.s.idle();
    expect(await mkRetro().tick()).toBeNull(); // a fresh instance (a restart): the claim row decides
    expect(t.calls.filter((c) => c.retro)).toHaveLength(1);
    now = FRIDAY_16 + 7 * 24 * 60 * MIN;
    expect(await mkRetro().tick()).toBe('software');
    await t.s.idle();
    expect(t.calls.filter((c) => c.retro)).toHaveLength(2);
    expect((await db.pool.query('SELECT week FROM retro_runs ORDER BY week')).rows.map((r) => r.week)).toEqual(['2026-W46', '2026-W47']);
  });
  it('the retro task is not counted as a fact of its own retro, and its title is code text', async () => {
    const t = await mk();
    await t.claim('software', ID);
    await t.s.idle();
    const f = await retroRepo.facts('software');
    expect(f.counts).toEqual([]);
    expect(f.titles).toEqual([]);
  });
});

describe('LEARN-1 Scheduler.retroStart kinds (D4a, LL-C8)', () => {
  const DAY = 'D2026-11-13';
  it.each([
    ['manual', 'Retro 2026-11-13 (manual)', 'started because a Bot Admin asked for it'],
    ['incident', 'Retro 2026-11-13 (incident)', 'started because your department logged several incidents'],
  ] as const)('%s: the D-key title, the kind instruction, retro:true and RETRO_TOOLS-only path; the claim row is finished under the D-key', async (kind, title, why) => {
    const seen: AgentTrigger[] = [];
    const t = await mk({ onRun: async (tr) => { seen.push(tr); return plain('summary'); } });
    expect(await retroRepo.request('software', DAY, kind)).toBe(true);
    expect(await retroRepo.assign('software', DAY, ID)).toBe(true);
    expect(await t.s.retroStart({ dept: 'software' as never, week: DAY, taskId: ID, kind })).toBe('started');
    await t.s.idle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ retro: true, noAsk: true, noWarroomSay: true, pool: 'warroom' });
    expect(seen[0]!.instruction).toContain(why);
    expect(seen[0]!.instruction).toContain('Doing nothing is fine.');
    expect(seen[0]!.msg).toMatchObject({ id: `retro-software-${DAY}` });
    expect(seen[0]!.msg!.content).toContain('Blocked by reason: error 0, turns 0, owner 0, budget 0; cancelled 0.');
    expect((await tasks.get(ID))!).toMatchObject({ title, origin: 'delegated', tainted: false, status: 'done' });
    expect((await db.pool.query('SELECT kind, week, outcome, task_id FROM retro_runs')).rows).toEqual([{ kind, week: DAY, outcome: 'done', task_id: ID }]);
    // the one-skill claim runs on task_id for every kind
    expect(await retroRepo.claimSkill(ID)).toBe('claimed');
  });
  it('the weekly default is unchanged (no kind given): title, instruction, claim', async () => {
    const seen: AgentTrigger[] = [];
    const t = await mk({ onRun: async (tr) => { seen.push(tr); return plain(); } });
    expect(await t.claim('software', ID)).toBe('started');
    await t.s.idle();
    expect(seen[0]!.instruction).toContain('This is your team\'s weekly retro.');
    expect((await tasks.get(ID))!.title).toBe(`Weekly retro ${WEEK}`);
  });
  it('a restart leaves a queued request alone but cancels an assigned one (closeOpenRetroTasks)', async () => {
    await retroRepo.request('software', DAY, 'manual');
    await retroRepo.request('rnd', DAY, 'incident');
    await retroRepo.assign('rnd', DAY, ID);
    await retroRepo.closeOpenRetroTasks();
    expect((await retroRepo.nextRequested()).map((r) => r.deptId)).toEqual(['software']);
  });
});

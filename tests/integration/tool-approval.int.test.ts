import { z } from 'zod';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../../app.js';
import { seed } from '../../company/index.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo } from '../../db/repos/index.js';
import { JobRepo } from '../../db/repos/jobs.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { handleInteraction } from '../../discord/index.js';
import { interaction } from '../../discord/commands/test-helpers.js';
import { PROMPTS_DIR, loadPrompts } from '../../prompts/index.js';
import type { ChatRequest } from '../../providers/index.js';
import type { GroupFactory } from '../../tools/plugins/index.js';
import type { ToolPlugin } from '../../tools/types.js';
import { toolError } from '../../tools/types.js';
import { TaskRepo } from '../../db/repos/tasks.js';
import { canonicalJson, inputDigest } from '../../governance/canonical.js';
import { ActorProvider, BOT_LOG_CHANNEL, CONFIG_CHANNEL, HQ_WORK, boot, humanMsg, mentionOf, migrateUp, resetDb, respond, turn } from './helpers.js';

// R4 PM-C9: the stub tool is not in the catalog (an undeclared name is fail-closed), so this file gives it a test class. Only this seam; DERIVED stays the real one.
vi.mock('../../tools/manifest/catalog.js', async (orig) => {
  const { withTestClasses } = await import('../fakes/tool-classes.js');
  const { WRITE } = await import('../../tools/manifest/types.js');
  return withTestClasses(await orig<typeof import('../../tools/manifest/catalog.js')>(), { stub_write: { ...WRITE, sensitive: false, group: 'test' } });
});

/** R4 end to end: a schedule-origin write waits for approval, the admin approves, the stored call runs once on resume. */
const PRAW_WORK = '1565999999999999001';
let db: TestDb;
let app: App | null = null;
beforeAll(async () => { db = await freshDb(); });
afterEach(async () => { await app?.stop(); app = null; await resetDb(db.pool); await db.pool.query('TRUNCATE scheduled_jobs RESTART IDENTITY'); });
afterAll(async () => { await db.close(); });

/** The fake external system: every call that reached it, and a runtime policy that can start refusing. */
function fakeWrite() {
  const calls: { title: string }[] = [];
  const policy = { denied: new Set<string>() };
  const hooks: { before?: (title: string) => Promise<void> } = {};
  const tool: ToolPlugin<{ title: string }> = {
    name: 'stub_write', description: 'stub write', kind: 'write', inputSchema: z.object({ title: z.string() }), requiresApproval: () => false,
    run: async (i) => {
      await hooks.before?.(i.title);
      if (policy.denied.has(i.title)) return toolError(`refused: ${i.title} is no longer allowed`);
      calls.push(i);
      return { content: `wrote ${i.title}` };
    },
  };
  const group: GroupFactory = () => ({ id: 'stub', tools: [tool as ToolPlugin<any>] });
  return { calls, policy, hooks, group };
}

const textOf = (req: ChatRequest) => JSON.stringify(req.messages[0]);

async function start(script: ConstructorParameters<typeof ActorProvider>[0], fake = fakeWrite()) {
  await migrateUp(db.pool);
  await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, loadPrompts(PROMPTS_DIR));
  await db.pool.query("UPDATE departments SET provider = 'claude', model = 'claude-sonnet-5-5', work_channel_id = $1 WHERE id = 'praw'", [PRAW_WORK]);
  const provider = new ActorProvider(script);
  const t = await boot(db.pool, { provider, groups: [fake.group] });
  app = t.app;
  await new JobRepo(db.pool).add({ guildId: 'g', channelId: PRAW_WORK, userId: '42', prompt: 'post the weekly update', origin: 'schedule', kind: 'daily', hhmm: '09:00', tz: 'Asia/Bangkok', nextRunAt: new Date(Date.now() - 60_000) }, 'unlimited');
  await t.app.services.jobRunner.tick();
  await t.app.services.jobRunner.tick();
  await t.app.services.scheduler.idle();
  const task = (await db.pool.query<{ id: string; status: string }>('SELECT id, status FROM tasks')).rows[0]!;
  return { ...t, provider, fake, task };
}

type Started = Awaited<ReturnType<typeof start>>;
const cards = (t: Started) => t.port.posts.filter((p) => p.target.channelId === CONFIG_CHANNEL && p.payload.type === 'approval');
const press = async (t: Started, approvalId: string | number, action: 'approve' | 'reject' = 'approve') => {
  await handleInteraction(interaction({ kind: 'button', customId: `approval:${approvalId}:${action}`, userId: 'admin1' }), t.app.services.commands);
  await t.app.services.scheduler.idle();
};
const status = async (id: string) => (await db.pool.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [id])).rows[0]!.status;
const executed = async () => (await db.pool.query<{ id: number; executed: boolean }>('SELECT id, executed_at IS NOT NULL AS executed FROM approvals ORDER BY id')).rows;
const toolAudits = async () => (await db.pool.query<{ outcome: string }>("SELECT outcome FROM audit_log WHERE action = 'tool' AND tool = 'stub_write' ORDER BY id")).rows.map((r) => r.outcome);

describe('tool approval resume (R4)', () => {
  it('int › full path: schedule-origin write → awaiting_approval → admin button approve → exactly one call at the fake → owner run reports', async () => {
    let seen = '';
    const t = await start({
      'heads/praw': [turn({ name: 'stub_write', input: { title: 'Weekly' } }), (req) => ((seen = textOf(req)), turn(respond('report', 'Posted the weekly update.')))],
    });
    expect(t.task.status).toBe('awaiting_approval');
    expect(t.fake.calls).toEqual([]);
    const card = cards(t)[0]!;
    expect(card.payload.fields).toContainEqual(expect.objectContaining({ name: 'Input sha256' }));
    await press(t, card.payload.buttons!.approvalId);
    expect(t.fake.calls).toEqual([{ title: 'Weekly' }]);
    expect(seen).toContain('Approved tool results:');
    expect(seen).toMatch(/source=\\"approved-tool\\"/);
    expect(seen).toContain('wrote Weekly');
    expect(t.port.posts.some((p) => p.payload.body === 'Posted the weekly update.')).toBe(true);
    expect(await toolAudits()).toEqual(['awaiting_approval', 'ok']);
    expect(await executed()).toEqual([{ id: 1, executed: true }]);
  });

  it('resume › rewording by the model is irrelevant: the approved input is what ran', async () => {
    const t = await start({
      'heads/praw': [
        turn({ name: 'stub_write', input: { title: 'Approved text' } }),
        // On resume the model "regenerates" the call with other wording: that is a new request, not the approved call.
        turn({ name: 'stub_write', input: { title: 'Reworded text' } }),
      ],
    });
    await press(t, cards(t)[0]!.payload.buttons!.approvalId);
    expect(t.fake.calls).toEqual([{ title: 'Approved text' }]);
    const rows = (await db.pool.query<{ status: string; tool_input: unknown }>('SELECT status, tool_input FROM approvals ORDER BY id')).rows;
    expect(rows).toEqual([{ status: 'approved', tool_input: { title: 'Approved text' } }, { status: 'pending', tool_input: { title: 'Reworded text' } }]);
    expect(await status(t.task.id)).toBe('awaiting_approval');
  });

  it('resume › two scheduler ticks execute it once', async () => {
    const t = await start({ 'heads/praw': [turn({ name: 'stub_write', input: { title: 'Once' } }), turn(respond('report', 'done'))] });
    const id = Number(cards(t)[0]!.payload.buttons!.approvalId);
    const r = await t.app.services.approvals.decide(id, 'approved', { id: 'admin1', isAdmin: true });
    expect(r.ok).toBe(true);
    const { scheduler } = t.app.services;
    await Promise.all([scheduler.onTaskReady(t.task.id), scheduler.onTaskReady(t.task.id), scheduler.onTaskReady(t.task.id)]);
    await scheduler.idle();
    await scheduler.onTaskReady(t.task.id);
    await scheduler.idle();
    expect(t.fake.calls).toEqual([{ title: 'Once' }]);
    expect(t.provider.callsOf('heads/praw')).toHaveLength(2);
  });

  it('resume › rejected and expired approvals execute nothing and the owner is told', async () => {
    let seen = '';
    const t = await start({
      'heads/praw': [
        turn({ name: 'stub_write', input: { title: 'A' } }, { name: 'stub_write', input: { title: 'B' } }, { name: 'stub_write', input: { title: 'C' } }),
        (req) => ((seen = textOf(req)), turn(respond('report', 'done'))),
      ],
    });
    const [a, b, c] = cards(t).map((p) => p.payload.buttons!.approvalId);
    await press(t, a!, 'reject'); // the task waits on C (the last request), so rejecting A does not cancel it
    await db.pool.query("UPDATE approvals SET created_at = now() - interval '100 hours' WHERE id = $1", [Number(b)]);
    expect(await t.app.services.approvals.expireOld()).toBe(1);
    expect(await status(t.task.id)).toBe('awaiting_approval');
    await press(t, c!);
    expect(t.fake.calls).toEqual([{ title: 'C' }]);
    expect(seen).toContain('Approval notices:');
    expect(seen).toMatch(new RegExp(`#${a} \\(stub_write\\) was rejected`));
    expect(seen).toMatch(new RegExp(`#${b} \\(stub_write\\) expired`));
    expect(seen).toContain('wrote C');
    expect((await executed()).every((r) => r.executed)).toBe(true); // each told once
  });

  it('resume › halted → nothing executes, claim not consumed', async () => {
    const t = await start({ 'heads/praw': [turn({ name: 'stub_write', input: { title: 'Later' } }), turn(respond('report', 'done'))] });
    const { commands, scheduler } = t.app.services;
    await handleInteraction(interaction({ commandName: 'halt', userId: 'admin1' }), commands);
    await press(t, cards(t)[0]!.payload.buttons!.approvalId);
    expect(t.fake.calls).toEqual([]);
    expect(await executed()).toEqual([{ id: 1, executed: false }]);
    await handleInteraction(interaction({ commandName: 'resume', userId: 'admin1' }), commands);
    await scheduler.idle();
    expect(t.fake.calls).toEqual([{ title: 'Later' }]);
    expect(await executed()).toEqual([{ id: 1, executed: true }]);
  });

  it('contract (a): /halt landing between the claim and the run un-claims it; after /resume it runs exactly once', async () => {
    const t = await start({ 'heads/praw': [turn({ name: 'stub_write', input: { title: 'Race' } }), turn(respond('report', 'done'))] });
    const { approvals, halt, commands, scheduler } = t.app.services;
    const real = approvals.claimToolOutcomes.bind(approvals);
    let once = true;
    approvals.claimToolOutcomes = async (id) => {
      const got = await real(id);
      if (once) { once = false; await halt.halt('admin1'); } // the halt lands after the claim returned
      return got;
    };
    await press(t, cards(t)[0]!.payload.buttons!.approvalId);
    expect(t.fake.calls).toEqual([]);
    expect(await executed()).toEqual([{ id: 1, executed: false }]);
    expect(await toolAudits()).toEqual(['awaiting_approval', 'halted']);
    await handleInteraction(interaction({ commandName: 'resume', userId: 'admin1' }), commands);
    await scheduler.idle();
    expect(t.fake.calls).toEqual([{ title: 'Race' }]);
    expect(await executed()).toEqual([{ id: 1, executed: true }]);
  });

  it('resume › a tool whose runtime policy now refuses (e.g. repo removed from allowlist, host now resolving private) returns a tool error, not a write', async () => {
    let seen = '';
    const fake = fakeWrite();
    const t = await start({ 'heads/praw': [turn({ name: 'stub_write', input: { title: 'Gone' } }), (req) => ((seen = textOf(req)), turn(respond('report', 'could not')))] }, fake);
    fake.policy.denied.add('Gone'); // changed between the request and the decision
    await press(t, cards(t)[0]!.payload.buttons!.approvalId);
    expect(fake.calls).toEqual([]);
    expect(await toolAudits()).toEqual(['awaiting_approval', 'tool_error']);
    expect(seen).toContain('refused: Gone is no longer allowed');
    expect(await executed()).toEqual([{ id: 1, executed: true }]); // used up: a new approval is needed
  });

  it('fix: approve → budget stop before the model turn → the next owner run receives the result exactly once', async () => {
    const seen: string[] = [];
    const capture = (req: ChatRequest) => (seen.push(textOf(req)), turn(respond('chat', 'noted')));
    const t = await start({ 'heads/praw': [turn({ name: 'stub_write', input: { title: 'Kept' } }), capture] });
    const { cfg, scheduler } = t.app.services;
    await cfg.set('budget.companyDailyUsd', 0.000001, 'test');
    await press(t, cards(t)[0]!.payload.buttons!.approvalId);
    expect(t.fake.calls).toEqual([{ title: 'Kept' }]);
    expect(seen).toEqual([]); // the owner run stopped at the budget, before any provider call
    expect((await db.pool.query('SELECT tool_result, result_delivered_at FROM approvals')).rows).toEqual([{ tool_result: 'ran:\nwrote Kept', result_delivered_at: null }]);
    await cfg.set('budget.companyDailyUsd', 1000, 'test');
    const thread = (await db.pool.query<{ thread_id: string }>('SELECT thread_id FROM tasks')).rows[0]!.thread_id;
    const follow = (text: string) => humanMsg(`${mentionOf('praw')} ${text}`, { channelId: thread, parentChannelId: PRAW_WORK, threadId: thread, mentionedHeads: ['praw'] });
    expect(await status(t.task.id)).toBe('doing'); // held open (not closed) while its outcome is undelivered
    await scheduler.onMessage(follow('status?'));
    await scheduler.idle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('Approved tool results:');
    expect(seen[0]).toContain('wrote Kept');
    expect((await db.pool.query('SELECT result_delivered_at IS NOT NULL AS done FROM approvals')).rows).toEqual([{ done: true }]);
    // Delivered once: a later owner run of the task gets nothing again (the conversation task closed after its run here).
    expect(await t.app.services.approvals.pendingToolDeliveries(t.task.id)).toEqual([]);
    expect(t.fake.calls).toEqual([{ title: 'Kept' }]); // never re-run
  });

  it('fix: halt mid-batch → the executed call is not re-run and its result is delivered on resume', async () => {
    let seen = '';
    const fake = fakeWrite();
    const t = await start({
      'heads/praw': [turn({ name: 'stub_write', input: { title: 'A' } }, { name: 'stub_write', input: { title: 'B' } }), (req) => ((seen = textOf(req)), turn(respond('report', 'done')))],
    }, fake);
    const { halt, commands, scheduler } = t.app.services;
    fake.hooks.before = async (title) => { if (title === 'A') await halt.halt('admin1'); }; // /halt lands while A runs
    const [a, b] = cards(t).map((p) => p.payload.buttons!.approvalId);
    await press(t, a!); // the task waits on B, so it stays awaiting_approval
    await press(t, b!);
    expect(fake.calls).toEqual([{ title: 'A' }]);
    expect(seen).toBe('');
    expect(await executed()).toEqual([{ id: 1, executed: true }, { id: 2, executed: false }]);
    fake.hooks.before = undefined;
    await handleInteraction(interaction({ commandName: 'resume', userId: 'admin1' }), commands);
    await scheduler.idle();
    expect(fake.calls).toEqual([{ title: 'A' }, { title: 'B' }]);
    expect(seen).toContain('wrote A');
    expect(seen).toContain('wrote B');
    expect((await db.pool.query('SELECT count(*)::int AS n FROM approvals WHERE result_delivered_at IS NULL')).rows[0].n).toBe(0);
  });

  it('M3: at boot a call claimed with no recorded outcome is alerted and reported to the owner, never re-run', async () => {
    await migrateUp(db.pool);
    await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, loadPrompts(PROMPTS_DIR));
    await db.pool.query("UPDATE departments SET provider = 'claude', model = 'claude-sonnet-5-5', work_channel_id = $1 WHERE id = 'praw'", [PRAW_WORK]);
    const task = await new TaskRepo(db.pool).create({ title: 'Crashed', deptId: 'praw', owner: { kind: 'head', dept: 'praw' }, requester: { kind: 'head', dept: 'praw' }, origin: 'schedule', channelId: PRAW_WORK, status: 'doing' });
    const input = canonicalJson({ title: 'Mid' });
    await db.pool.query(
      `INSERT INTO approvals (task_id, reason, est_cost_usd, requested_by, kind, status, decided_at, tool_name, tool_input, input_sha256, executed_at)
       VALUES ($1, 'tool stub_write', 0, 'head:praw', 'tool', 'approved', now(), 'stub_write', $2::jsonb, $3, now())`,
      [task.id, input, inputDigest(input)],
    );
    let seen = '';
    const fake = fakeWrite();
    const provider = new ActorProvider({ 'heads/praw': [(req) => ((seen = textOf(req)), turn(respond('report', 'checked')))] });
    const b = await boot(db.pool, { provider, groups: [fake.group] });
    app = b.app;
    await b.app.services.scheduler.idle();
    const alert = b.port.posts.find((p) => p.target.channelId === BOT_LOG_CHANNEL && String(p.payload.title).startsWith('Incident ') && p.payload.body.includes('where: boot · approved tool calls'));
    expect(alert?.payload.body).toContain('approval #1');
    expect(fake.calls).toEqual([]);
    expect(seen).toMatch(/#1 \(stub_write\) was claimed but its outcome was not recorded/);
  });

  it('I1: Praw mentioned in an hq task thread calling a write tool is refused; no approval row, hq task unchanged', async () => {
    await migrateUp(db.pool);
    await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, loadPrompts(PROMPTS_DIR));
    await db.pool.query("UPDATE departments SET provider = 'claude', model = 'claude-sonnet-5-5', work_channel_id = $1 WHERE id = 'praw'", [PRAW_WORK]);
    const hq = await new TaskRepo(db.pool).create({ title: 'HQ goal', deptId: 'hq', owner: { kind: 'head', dept: 'hq' }, requester: { kind: 'human', userId: '42' }, origin: 'slash', status: 'doing', threadId: 'th-hq' });
    let seen = '';
    const fake = fakeWrite();
    const provider = new ActorProvider({ 'heads/hq': [turn(respond('chat', 'hq here')), turn(respond('chat', 'hq again'))], 'heads/praw': [turn({ name: 'stub_write', input: { title: 'Sneaky' } }), (req) => ((seen = textOf(req) + JSON.stringify(req.messages)), turn(respond('chat', 'cannot')))] });
    const b = await boot(db.pool, { provider, groups: [fake.group] });
    app = b.app;
    await b.app.services.scheduler.onMessage(humanMsg(`${mentionOf('praw')} write it`, { channelId: 'th-hq', threadId: 'th-hq', parentChannelId: HQ_WORK, mentionedHeads: ['praw'] }));
    await b.app.services.scheduler.idle();
    expect(provider.remaining()['heads/praw']).toBe(0);
    expect(seen).toContain('can only be requested by the task owner');
    expect(fake.calls).toEqual([]);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM approvals')).rows[0].n).toBe(0);
    expect(await status(hq.id)).toBe('doing');
    expect(await toolAudits()).toEqual(['approval_not_owner']);
  });
});

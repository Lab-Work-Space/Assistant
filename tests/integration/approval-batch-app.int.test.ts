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
import { ActorProvider, CONFIG_CHANNEL, TestPort, boot, migrateUp, resetDb, respond, turn } from './helpers.js';

// R4 PM-C9: the stub tool is not in the catalog (an undeclared name is fail-closed), so this file gives it a test class. Only this seam; DERIVED stays the real one.
vi.mock('../../tools/manifest/catalog.js', async (orig) => {
  const { withTestClasses } = await import('../fakes/tool-classes.js');
  const { WRITE } = await import('../../tools/manifest/types.js');
  return withTestClasses(await orig<typeof import('../../tools/manifest/catalog.js')>(), { stub_write: { ...WRITE, sensitive: false, group: 'test' } });
});

/** APPROVAL-BATCH-1 end to end: several tool approvals of one task, one card, Approve all, each call runs once. */
const PRAW_WORK = '1565999999999999001';
let db: TestDb;
let app: App | null = null;
beforeAll(async () => { db = await freshDb(); });
afterEach(async () => { await app?.stop(); app = null; await resetDb(db.pool); await db.pool.query('TRUNCATE scheduled_jobs RESTART IDENTITY'); });
afterAll(async () => { await db.close(); });

function fakeWrite() {
  const calls: { title: string }[] = [];
  const tool: ToolPlugin<{ title: string }> = {
    name: 'stub_write', description: 'stub write', kind: 'write', inputSchema: z.object({ title: z.string() }), requiresApproval: () => false,
    run: async (i) => { calls.push(i); return { content: `wrote ${i.title}` }; },
  };
  const group: GroupFactory = () => ({ id: 'stub', tools: [tool as ToolPlugin<any>] });
  return { calls, group };
}
const textOf = (req: ChatRequest) => JSON.stringify(req.messages[0]);

async function start(script: ConstructorParameters<typeof ActorProvider>[0], batching: false | { windowMs: number } = { windowMs: 60_000 }) {
  await migrateUp(db.pool);
  await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, loadPrompts(PROMPTS_DIR));
  await db.pool.query("UPDATE departments SET provider = 'claude', model = 'claude-sonnet-5-5', work_channel_id = $1 WHERE id = 'praw'", [PRAW_WORK]);
  const fake = fakeWrite();
  const port = new TestPort();
  port.snowflakes = true;
  const t = await boot(db.pool, { provider: new ActorProvider(script), groups: [fake.group], port, approvalBatching: batching });
  app = t.app;
  await new JobRepo(db.pool).add({ guildId: 'g', channelId: PRAW_WORK, userId: '42', prompt: 'post the weekly update', origin: 'schedule', kind: 'daily', hhmm: '09:00', tz: 'Asia/Bangkok', nextRunAt: new Date(Date.now() - 60_000) }, 'unlimited');
  await t.app.services.jobRunner.tick();
  await t.app.services.jobRunner.tick();
  await t.app.services.scheduler.idle();
  const task = (await db.pool.query<{ id: string; status: string }>('SELECT id, status FROM tasks')).rows[0]!;
  return { ...t, port, fake, task };
}
type Started = Awaited<ReturnType<typeof start>>;
const cards = (t: Started) => t.port.posts.filter((p) => p.target.channelId === CONFIG_CHANNEL && p.payload.type === 'approval');
const press = async (t: Started, customId: string, messageId: string) => {
  const i = interaction({ kind: 'button', customId, userId: 'admin1', messageId, messageAuthorId: 'hq' });
  const r = await handleInteraction(i, t.app.services.commands);
  await t.app.services.scheduler.idle();
  return r;
};
const status = async (id: string) => (await db.pool.query<{ status: string }>('SELECT status FROM tasks WHERE id = $1', [id])).rows[0]!.status;
const executed = async () => (await db.pool.query<{ id: number; executed: boolean; status: string }>('SELECT id, executed_at IS NOT NULL AS executed, status FROM approvals ORDER BY id')).rows;
const THREE = turn({ name: 'stub_write', input: { title: 'A' } }, { name: 'stub_write', input: { title: 'B' } }, { name: 'stub_write', input: { title: 'C' } });

describe('batched tool approvals (APPROVAL-BATCH-1)', () => {
  it('int › three stub_write calls in one turn → no card inside the window; flush → ONE card; Approve all → each call runs exactly once, digest-checked', async () => {
    let seen = '';
    const t = await start({ 'heads/praw': [THREE, (req) => ((seen = textOf(req)), turn(respond('report', 'done')))] });
    expect(t.task.status).toBe('awaiting_approval');
    expect(cards(t)).toEqual([]); // held inside the window
    await t.app.services.batching!.flushAll();
    expect(cards(t)).toHaveLength(1);
    const card = cards(t)[0]!;
    expect(card.payload.buttons).toBeUndefined();
    expect(card.payload.fields!.map((f) => f.name)).toEqual(['#1 · stub\\_write', '#2 · stub\\_write', '#3 · stub\\_write']);
    const { batchId, digest } = card.payload.batchButtons!;
    // a per-item click first: the card is refreshed (not closed), the other two keep their buttons
    await press(t, 'approval:1:approve', card.id);
    expect(t.port.closed).toEqual([]);
    expect(t.port.updated.at(-1)!.payload.batchButtons!.items.map((i) => i.pending)).toEqual([false, true, true]);
    expect(t.fake.calls).toEqual([]); // the task waits on the newest row
    const r = await press(t, `approval:b:${batchId}:${digest}:approve`, card.id);
    expect(JSON.stringify(r)).toContain('Approved 2 of 3 (1 already decided or expired).');
    expect(t.fake.calls).toEqual([{ title: 'A' }, { title: 'B' }, { title: 'C' }]);
    expect(await executed()).toEqual([{ id: 1, executed: true, status: 'approved' }, { id: 2, executed: true, status: 'approved' }, { id: 3, executed: true, status: 'approved' }]);
    expect(seen).toContain('wrote A');
    expect(seen).toContain('wrote C');
    expect(t.port.updated.at(-1)!.payload.batchButtons!.items.every((i) => !i.pending)).toBe(true);
    expect((await db.pool.query<{ state: string }>('SELECT state FROM approval_batches')).rows).toEqual([{ state: 'closed' }]);
    // the one audit row per decided item carries taskId and the approval id; one summary row for the batch click
    const audits = (await db.pool.query<{ action: string; outcome: string; task_id: string | null; tool: string | null }>("SELECT action, outcome, task_id, tool FROM audit_log WHERE action LIKE 'approval.%' ORDER BY id")).rows;
    expect(audits.map((a) => [a.action, a.outcome])).toEqual([
      ['approval.approve', 'ok #1'], ['approval.approve', 'ok #2'], ['approval.approve', 'ok #3'], ['approval.batch_approve', `batch:${batchId} digest:${digest} n=3 decided=2`],
    ]);
    expect(audits.every((a) => a.task_id === t.task.id)).toBe(true);
  });

  it('int › Deny all cancels the task; nothing runs', async () => {
    const t = await start({ 'heads/praw': [THREE] });
    await t.app.services.batching!.flushAll();
    const card = cards(t)[0]!;
    const { batchId, digest } = card.payload.batchButtons!;
    await press(t, `approval:b:${batchId}:${digest}:reject`, card.id);
    expect(t.fake.calls).toEqual([]);
    expect(await status(t.task.id)).toBe('cancelled');
    expect((await executed()).map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
  });

  it('int › a second Approve all on the same card answers "already decided" and runs nothing twice', async () => {
    const t = await start({ 'heads/praw': [THREE, turn(respond('report', 'done'))] });
    await t.app.services.batching!.flushAll();
    const card = cards(t)[0]!;
    const { batchId, digest } = card.payload.batchButtons!;
    await press(t, `approval:b:${batchId}:${digest}:approve`, card.id);
    const again = await press(t, `approval:b:${batchId}:${digest}:approve`, card.id);
    expect(JSON.stringify(again)).toContain('These approvals were already decided.');
    expect(t.fake.calls).toHaveLength(3);
  });

  it('int › the window timer posts the card on its own, and a single approval posts today\'s card after the window', async () => {
    const one = await start({ 'heads/praw': [turn({ name: 'stub_write', input: { title: 'Solo' } })] }, { windowMs: 40 });
    await new Promise((r) => setTimeout(r, 150));
    await one.app.services.scheduler.idle();
    expect(cards(one)).toHaveLength(1);
    expect(cards(one)[0]!.payload.buttons).toEqual({ approvalId: '1' });
    expect(cards(one)[0]!.payload.batchButtons).toBeUndefined();
  });

  it('int › a halted system leaves the task waiting after Approve all, like a single approve', async () => {
    const t = await start({ 'heads/praw': [THREE] });
    await t.app.services.batching!.flushAll();
    const card = cards(t)[0]!;
    const { batchId, digest } = card.payload.batchButtons!;
    await handleInteraction(interaction({ commandName: 'halt', userId: 'admin1' }), t.app.services.commands);
    await press(t, `approval:b:${batchId}:${digest}:approve`, card.id);
    expect(t.fake.calls).toEqual([]);
    expect(await status(t.task.id)).toBe('awaiting_approval');
    expect((await executed()).map((r) => r.status)).toEqual(['approved', 'approved', 'approved']);
  });
});

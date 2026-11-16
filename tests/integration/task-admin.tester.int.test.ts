import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { App } from '../../app.js';
import { seed } from '../../company/index.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo } from '../../db/repos/index.js';
import { JobRepo } from '../../db/repos/jobs.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { handleInteraction } from '../../discord/index.js';
import { cmd, interaction } from '../../discord/commands/test-helpers.js';
import { PROMPTS_DIR, loadPrompts } from '../../prompts/index.js';
import type { GroupFactory } from '../../tools/plugins/index.js';
import type { ToolPlugin } from '../../tools/types.js';
import { ActorProvider, CTO, SlowProvider, TestPort, boot, migrateUp, resetDb, respond, turn } from './helpers.js';

// R4 PM-C9: the stub tool is not in the catalog (an undeclared name is fail-closed), so this file gives it a test class. Only this seam; DERIVED stays the real one.
vi.mock('../../tools/manifest/catalog.js', async (orig) => {
  const { withTestClasses } = await import('../fakes/tool-classes.js');
  const { WRITE } = await import('../../tools/manifest/types.js');
  return withTestClasses(await orig<typeof import('../../tools/manifest/catalog.js')>(), { stub_write: { ...WRITE, sensitive: false, group: 'test' } });
});

/**
 * TASKADMIN-1 independent tester probes (stage 6): things the developer suite exercises only at unit level or not at all, driven through the real app and PostgreSQL.
 *  - an old approval card (solo and batch) clicked after an admin cancel runs nothing
 *  - a real owner run in flight when the admin presses cancel (no fake loop): ends cancelled, no further provider call, the task is not resurrected
 *  - two admins and a racing approve against one cancel: no deadlock, one winner, a consistent end state
 *  - /task list over the real DB with hostile model text: bound, no live mentions
 *  - retry for the halt and error reasons
 */
const PRAW_WORK = '1565999999999999001';
const ADMIN = '123456789012345678';
let db: TestDb;
let app: App | null = null;
beforeAll(async () => { db = await freshDb(); });
afterEach(async () => {
  await app?.stop();
  app = null;
  await resetDb(db.pool);
  await db.pool.query('TRUNCATE web_grants, approval_batches, task_grants, scheduled_jobs RESTART IDENTITY CASCADE');
});
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
type Booted = Awaited<ReturnType<typeof start>>;
async function start<P extends ActorProvider | SlowProvider>(provider: P, o: { batching?: false | { windowMs: number } } = {}) {
  await migrateUp(db.pool);
  await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, loadPrompts(PROMPTS_DIR));
  await db.pool.query("UPDATE departments SET provider = 'claude', model = 'claude-sonnet-5-5', work_channel_id = $1 WHERE id = 'praw'", [PRAW_WORK]);
  const fake = fakeWrite();
  const port = new TestPort();
  port.snowflakes = true;
  const t = await boot(db.pool, { provider, groups: [fake.group], port, approvalBatching: o.batching ?? false });
  app = t.app;
  return { app: t.app, provider, port, fake, s: t.app.services, deps: t.app.services.commands };
}
const mkTask = (t: Booted, over: Partial<Parameters<Booted['s']['tasks']['create']>[0]> = {}) =>
  t.s.tasks.create({ title: 'a task', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat', ...over });
const slash = async (t: Booted, sub: string, strings: Record<string, string> = {}, bools: Record<string, boolean> = {}, userId = ADMIN) => {
  const r = (await handleInteraction(cmd('task', sub, { strings, bools, userId }), t.deps))!;
  return { r, text: r.content ?? '' };
};
const nonceOf = (r: { components?: unknown[] }, kind: string): string =>
  (r.components as { components: { custom_id: string }[] }[])[0]!.components.find((c) => c.custom_id.startsWith(`taskadm:${kind}:`))!.custom_id;
const press = async (t: Booted, customId: string, userId = ADMIN) => {
  const r = (await handleInteraction(interaction({ kind: 'button', customId, userId }), t.deps))!;
  await t.s.scheduler.idle();
  return r;
};
const cardPress = async (t: Booted, customId: string, messageId: string) => {
  const r = await handleInteraction(interaction({ kind: 'button', customId, userId: 'admin1', messageId, messageAuthorId: 'hq' }), t.deps);
  await t.s.scheduler.idle();
  return r;
};
const status = async (t: Booted, id: string) => (await t.s.tasks.get(id))!.status;
const THREE = turn({ name: 'stub_write', input: { title: 'A' } }, { name: 'stub_write', input: { title: 'B' } });

async function praw(t: Booted): Promise<string> {
  await new JobRepo(db.pool).add({ guildId: 'g', channelId: PRAW_WORK, userId: '42', prompt: 'post the weekly update', origin: 'schedule', kind: 'daily', hhmm: '09:00', tz: 'Asia/Bangkok', nextRunAt: new Date(Date.now() - 60_000) }, 'unlimited');
  await t.s.jobRunner.tick();
  await t.s.jobRunner.tick();
  await t.s.scheduler.idle();
  return (await db.pool.query<{ id: string }>('SELECT id FROM tasks')).rows[0]!.id;
}

describe('an old approval card clicked after an admin cancel runs nothing', () => {
  it('batched card: the batch is closed, the card is closed, Approve all and a per-item click both answer "already decided", no tool runs, the task stays cancelled', async () => {
    const t = await start(new ActorProvider({ 'heads/praw': [THREE] }), { batching: { windowMs: 60_000 } });
    const id = await praw(t);
    expect(await status(t, id)).toBe('awaiting_approval');
    await t.s.batching!.flushAll();
    const card = t.port.posts.find((p) => p.payload.type === 'approval')!;
    const { batchId, digest } = card.payload.batchButtons!;
    const c = await slash(t, 'cancel', { task: id.slice(0, 8) });
    expect(c.text).toContain('Pending approvals that will expire: 2');
    expect((await press(t, nonceOf(c.r, 'cancel'))).content).toMatch(/^Cancelled 1 task/);
    expect(await status(t, id)).toBe('cancelled');
    expect((await db.pool.query('SELECT state FROM approval_batches')).rows).toEqual([{ state: 'closed' }]);
    expect(t.port.closed.length).toBeGreaterThan(0); // the posted card was closed
    const all = await cardPress(t, `approval:b:${batchId}:${digest}:approve`, card.id);
    expect(JSON.stringify(all)).toContain('already decided');
    const one = await cardPress(t, 'approval:1:approve', card.id);
    expect(JSON.stringify(one)).toMatch(/already decided|expired/i);
    expect(t.fake.calls).toEqual([]);
    expect(await status(t, id)).toBe('cancelled');
    expect((await db.pool.query('SELECT status, executed_at IS NOT NULL AS ex FROM approvals ORDER BY id')).rows).toEqual([{ status: 'expired', ex: false }, { status: 'expired', ex: false }]);
  });

  it('a solo card: approve after the cancel is refused by the decide path (expired), no tool runs', async () => {
    const t = await start(new ActorProvider({ 'heads/praw': [turn({ name: 'stub_write', input: { title: 'Solo' } })] }));
    const id = await praw(t);
    const card = t.port.posts.find((p) => p.payload.type === 'approval')!;
    const c = await slash(t, 'cancel', { task: id.slice(0, 8) });
    await press(t, nonceOf(c.r, 'cancel'));
    const r = await cardPress(t, 'approval:1:approve', card.id);
    expect(JSON.stringify(r)).toMatch(/already decided|expired/i);
    expect(t.fake.calls).toEqual([]);
    expect(await status(t, id)).toBe('cancelled');
  });

  it('an approval decided while halted (approved, not yet run) and then cancelled never runs after /resume', async () => {
    const t = await start(new ActorProvider({ 'heads/praw': [turn({ name: 'stub_write', input: { title: 'Held' } }), turn(respond('report', 'x'))] }));
    const id = await praw(t);
    const card = t.port.posts.find((p) => p.payload.type === 'approval')!;
    await t.s.halt.halt('test');
    await cardPress(t, 'approval:1:approve', card.id);
    expect((await db.pool.query('SELECT status FROM approvals')).rows).toEqual([{ status: 'approved' }]);
    expect(await status(t, id)).toBe('awaiting_approval'); // approved while halted: waits
    const c = await slash(t, 'cancel', { task: id.slice(0, 8) });
    await press(t, nonceOf(c.r, 'cancel'));
    expect(await status(t, id)).toBe('cancelled');
    await handleInteraction(cmd('resume', null, { userId: ADMIN }), t.deps);
    await t.s.scheduler.idle();
    await t.s.approvals.resumeApproved();
    await t.s.scheduler.idle();
    expect(t.fake.calls).toEqual([]);
    expect(await status(t, id)).toBe('cancelled');
  });
});

describe('a real owner run in flight when the admin cancels', () => {
  it('the model stream is aborted, the run ends as cancelled (not halted), no second provider call, the task is not resurrected', async () => {
    const provider = new SlowProvider();
    const t = await start(provider);
    const x = await mkTask(t, { status: 'todo' });
    await t.deps.taskAdmin!.bus.emit('task.ready', { taskId: x.id });
    await provider.started;
    expect(t.s.taskRuns.active(x.id)).toBe(true);
    const c = await slash(t, 'cancel', { task: x.id.slice(0, 8) });
    expect(c.text).toContain('Running now: yes');
    const done = press(t, nonceOf(c.r, 'cancel'));
    const out = await done;
    expect(out.content).toMatch(/^Cancelled 1 task/);
    await t.s.scheduler.idle();
    expect(provider.calls).toBe(1);
    expect(await status(t, x.id)).toBe('cancelled');
    expect(t.s.taskRuns.active(x.id)).toBe(false);
    const alerts = t.port.posts.filter((p) => p.payload.type === 'alert').map((p) => `${p.payload.title}`);
    expect(alerts).not.toContain('Halted');
    expect(alerts).toContain('Task cancelled'); // the fixed alert reached the task thread
    expect((await db.pool.query("SELECT outcome FROM audit_log WHERE action = 'task.cancel.abort'")).rows).toEqual([{ outcome: 'runs 1' }]);
    expect((await db.pool.query('SELECT status FROM tasks WHERE id = $1', [x.id])).rows[0]).toEqual({ status: 'cancelled' });
  });
});

describe('concurrency', () => {
  it('two admins confirm and click the same cancel at once: exactly one cancels, the other is refused, one ok audit row', async () => {
    const t = await start(new ActorProvider({}));
    const root = await mkTask(t, { status: 'doing' });
    for (let i = 0; i < 3; i++) await mkTask(t, { parentId: root.id });
    const a = await slash(t, 'cancel', { task: root.id.slice(0, 8), cascade: 'children' }, {}, ADMIN);
    const b = await slash(t, 'cancel', { task: root.id.slice(0, 8), cascade: 'children' }, {}, '222222222222222222');
    const [ra, rb] = await Promise.all([press(t, nonceOf(a.r, 'cancel'), ADMIN), press(t, nonceOf(b.r, 'cancel'), '222222222222222222')]);
    const texts = [ra.content ?? '', rb.content ?? ''];
    expect(texts.filter((x) => /^Cancelled 4 tasks/.test(x))).toHaveLength(1);
    expect(texts.filter((x) => /already done or cancelled|changed or the confirmation expired/.test(x))).toHaveLength(1);
    expect((await db.pool.query("SELECT outcome FROM audit_log WHERE action = 'task.cancel' AND outcome LIKE 'ok%'")).rows).toHaveLength(1);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM tasks WHERE status <> 'cancelled'")).rows[0]).toEqual({ n: 0 });
  });

  it('a cancel racing an approve click (30 rounds, halted so nothing wakes): no deadlock, the task always ends cancelled, an approval is expired or approved but never both executed and cancelled-run', async () => {
    const t = await start(new ActorProvider({}));
    await t.s.halt.halt('test');
    for (let n = 0; n < 30; n++) {
      const x = await mkTask(t, { status: 'doing' });
      const a = await t.s.approvals.request({ taskId: x.id, kind: 'tool', tool: { name: 'stub_write', input: { title: `n${n}` } }, reason: 'r', estCostUsd: 0, requestedBy: CTO });
      const c = await slash(t, 'cancel', { task: x.id.slice(0, 8) });
      const click = nonceOf(c.r, 'cancel');
      const [out] = await Promise.all([press(t, click), t.s.approvals.decide(a.id, 'approved', { id: ADMIN, isAdmin: true })]);
      expect(out.content).toMatch(/^Cancelled 1 task/);
      expect(await status(t, x.id)).toBe('cancelled');
    }
    expect(t.fake.calls).toEqual([]);
  });
});

describe('/task list over the real database with hostile model text', () => {
  it('30 tasks with maximum-length titles, mentions, markdown and secrets: under 2000 characters, no live mention, secrets masked, ephemeral', async () => {
    const t = await start(new ActorProvider({}));
    const evil = '@everyone <@&1234567890> <@!99> **bold** `code` [x](http://e.x) sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 ' + 'Z'.repeat(300);
    for (let i = 0; i < 30; i++) {
      const x = await mkTask(t, { status: 'doing', title: evil.slice(0, 190) });
      if (i % 2) await t.s.tasks.update(x.id, { status: 'blocked', blockedReason: 'owner', blockedNote: evil });
    }
    const { r, text } = await slash(t, 'list');
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toMatch(/^Open 30\/\d+ \(limits\.openTasks\)/);
    expect(text).toMatch(/… and \d+ more$/);
    expect(text).not.toMatch(/sk-ant/);
    expect(text).not.toMatch(/(?<!\\)@everyone/);
    expect(text).not.toMatch(/(?<![\\])<@[&!]?\d+>/);
    expect(r.ephemeral).toBe(true);
    expect(r.allowedMentions).toEqual({ parse: [] });
  });
});

describe('/task retry: halt and error reasons', () => {
  it.each(['halt', 'error'] as const)('a task blocked by %s (company not halted) goes back to todo and the owner runs it once', async (reason) => {
    const t = await start(new ActorProvider({ 'heads/software': [turn(respond('chat', 'back'))] }));
    const x = await mkTask(t, { status: 'doing' });
    await t.s.tasks.update(x.id, { status: 'blocked', blockedReason: reason });
    const r = await slash(t, 'retry', { task: x.id.slice(0, 8) });
    expect(r.text).toContain('is back in todo');
    await t.s.scheduler.idle();
    expect(t.provider.callsOf('heads/software').length).toBe(1);
    expect((await db.pool.query("SELECT outcome, tool FROM audit_log WHERE action = 'task.retry'")).rows).toEqual([{ outcome: 'ok', tool: reason }]);
  });

  it('retry then immediate second retry: the second is "only a blocked task" or stale, never a second run', async () => {
    const t = await start(new ActorProvider({ 'heads/software': [turn(respond('chat', 'one')), turn(respond('chat', 'two'))] }));
    const x = await mkTask(t, { status: 'doing' });
    await t.s.tasks.update(x.id, { status: 'blocked', blockedReason: 'error' });
    const [a, b] = await Promise.all([slash(t, 'retry', { task: x.id.slice(0, 8) }), slash(t, 'retry', { task: x.id.slice(0, 8) })]);
    await t.s.scheduler.idle();
    const texts = [a.text, b.text];
    expect(texts.filter((s) => s.includes('is back in todo'))).toHaveLength(1);
    expect(t.provider.callsOf('heads/software').length).toBe(1);
  });
});

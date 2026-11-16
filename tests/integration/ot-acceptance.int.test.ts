import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../../app.js';
import { seed } from '../../company/index.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo, TaskRepo } from '../../db/repos/index.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { handleInteraction } from '../../discord/index.js';
import { interaction } from '../../discord/commands/test-helpers.js';
import { PROMPTS_DIR, loadPrompts } from '../../prompts/index.js';
import { ActorProvider, CONFIG_CHANNEL, HQ_WORK, TestPort, boot, humanMsg, migrateUp, resetDb, respond, taskIdOf, turn } from './helpers.js';

/**
 * OT-1 end to end through the real app: on an off day a delegated child is held, the system raises an overtime card in #setting, a Bot Admin approves it
 * for that task tree, the held child and its roll-up run through consumed runs, and a halt revokes the grant. Every day is an off day (all seven weekdays),
 * so the test does not depend on the date it runs on (the database clock decides the request's day).
 */
const ADMIN = '123456789012345678';
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
let db: TestDb;
let app: App | null = null;
beforeAll(async () => { db = await freshDb(); });
afterEach(async () => { await app?.stop(); app = null; await resetDb(db.pool); });
afterAll(async () => { await db.close(); });

const done = (summary: string, report: ReturnType<typeof respond>) => (req: Parameters<typeof taskIdOf>[0]) =>
  turn({ name: 'update_task', input: { taskId: taskIdOf(req), status: 'done', summary } }, report);

async function start() {
  const provider = new ActorProvider({
    'heads/hq': [
      turn({ name: 'create_task', input: { title: 'Build the MVP', description: 'Plan the MVP.', assignee: { kind: 'head', dept: 'software' }, estCostUsd: 0.1 } }),
      turn(respond('chat', 'Delegated.')),
      done('MVP planned.', respond('report', 'Final: MVP planned.')),
    ],
    'heads/software': [(req) => turn({ name: 'update_task', input: { taskId: taskIdOf(req), status: 'done', summary: 'Plan ready.' } }, respond('report', 'Plan ready.'))],
  });
  const port = new TestPort();
  port.snowflakes = true;
  const t = await boot(db.pool, { provider, port, offDays: ALL_DAYS });
  app = t.app;
  const { scheduler } = t.app.services;
  await scheduler.onMessage(humanMsg('<@100> Launch an MVP', { channelId: HQ_WORK, mentionedHeads: ['hq'] }));
  await scheduler.idle();
  return { ...t, port, provider, scheduler };
}
type Started = Awaited<ReturnType<typeof start>>;
const otCards = (t: Started) => t.port.posts.filter((p) => p.target.channelId === CONFIG_CHANNEL && p.payload.otButtons !== undefined);
const press = async (t: Started, customId: string, messageId: string, o: { roles?: string[]; channelId?: string } = {}) => {
  const i = interaction({ kind: 'button', customId, userId: ADMIN, messageId, messageAuthorId: 'hq', ...(o.roles ? { roles: o.roles } : {}), ...(o.channelId ? { channelId: o.channelId } : {}) });
  const r = await handleInteraction(i, t.app.services.commands);
  await t.scheduler.idle();
  return r;
};
const rows = () => db.pool.query<{ id: number; status: string; runs_used: number; revoke_reason: string | null; card_message_id: string | null; digest: string }>('SELECT id, status, runs_used, revoke_reason, card_message_id, digest FROM ot_requests ORDER BY id').then((r) => r.rows);
const cid = (r: { id: number; digest: string }, a: string) => `approval:ot:${r.id}:${r.digest}:${a}`;

describe('overtime through the real app', () => {
  it('a held delegated child raises ONE card in #setting (with the notice line); approve runs the child and its roll-up, each consuming a run, and a halt revokes the grant', async () => {
    const t = await start();
    expect(t.provider.callsOf('heads/software')).toHaveLength(0);
    expect((await db.pool.query('SELECT owner, origin, status FROM tasks ORDER BY depth')).rows.map((r) => r.status)).toEqual(['doing', 'todo']);
    expect(otCards(t)).toHaveLength(1);
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'pending', card_message_id: otCards(t)[0]!.id });
    const notice = t.port.posts.find((p) => p.payload.type === 'chat' && p.payload.body.startsWith('⏸️'));
    expect(notice).toBeDefined();
    expect((notice!.payload as { body: string }).body).toContain('ส่งคำขอ OT ให้ Bot Admin แล้ว');
    expect(JSON.stringify(t.provider.callsOf('heads/hq')[1]!.messages)).toContain('It will start on the next workday');

    const card = otCards(t)[0]!;
    // a non-admin, a button in another channel and a forged digest change nothing
    await press(t, cid(row!, 'approve'), card.id, { roles: [] });
    await press(t, cid(row!, 'approve'), card.id, { channelId: '1570000000000000888' });
    await press(t, `approval:ot:${row!.id}:000000000000:approve`, card.id);
    expect((await rows())[0]!.status).toBe('pending');
    expect(t.provider.callsOf('heads/software')).toHaveLength(0);

    await press(t, cid(row!, 'approve'), card.id);
    await vi.waitFor(async () => expect((await rows())[0]).toMatchObject({ status: 'approved', runs_used: 2 })); // the child, then the roll-up on the root
    expect(t.provider.callsOf('heads/software')).toHaveLength(1);
    expect((await db.pool.query('SELECT status FROM tasks ORDER BY depth')).rows.map((r) => r.status)).toEqual(['done', 'done']);
    expect(t.port.updated.some((u) => u.messageId === card.id && u.payload.otButtons?.mode === 'granted')).toBe(true);
    expect(t.port.posts.some((p) => p.payload.type === 'chat' && p.payload.body.startsWith('✅ อนุมัติ OT ถึง'))).toBe(true);
    const audit = (await db.pool.query<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE 'ot.%' ORDER BY id")).rows.map((r) => r.action);
    expect(audit).toEqual(['ot.request', 'ot.approve']);

    // a halt revokes the grant and closes its card; resume restores nothing
    await t.app.services.halt.halt('test');
    await vi.waitFor(async () => expect((await rows())[0]!.revoke_reason).toBe('halt'));
    await t.app.services.halt.resume('test');
    expect((await rows())[0]!.revoke_reason).toBe('halt');
    expect(t.port.closed.some((c) => c.messageId === card.id && c.note.includes('halted'))).toBe(true);
    const again = await press(t, cid(row!, 'revoke'), card.id);
    expect(JSON.stringify(again)).toMatch(/Already ended|nothing/i);
  });

  it('Deny closes the card and is sticky for the rest of the day (no second card)', async () => {
    const t = await start();
    const [row] = await rows();
    const card = otCards(t)[0]!;
    await press(t, cid(row!, 'deny'), card.id);
    expect((await rows())[0]!.status).toBe('denied');
    expect(t.port.closed.some((c) => c.messageId === card.id && c.note.includes('denied'))).toBe(true);
    expect(otCards(t)).toHaveLength(1);
    await t.app.services.scheduler.onTaskReady((await db.pool.query<{ id: string }>("SELECT id FROM tasks WHERE status = 'todo'")).rows[0]!.id);
    await t.scheduler.idle();
    expect(otCards(t)).toHaveLength(1); // denied today: no second card
  });

  it('Approve whole day: the day is added to the extra workdays, the claim row says workday, and a stale second click is refused', async () => {
    const t = await start();
    const [row] = await rows();
    const card = otCards(t)[0]!;
    const before = t.app.services.cfg.get('schedule.workDays');
    const r = await press(t, cid(row!, 'day'), card.id);
    expect(JSON.stringify(r)).toMatch(/ALL held work/);
    expect((await rows())[0]!.status).toBe('workday');
    expect(t.app.services.cfg.get('schedule.workDays')).toHaveLength(before.length + 1);
    const again = await press(t, cid(row!, 'day'), card.id);
    expect(JSON.stringify(again)).toContain('Already decided');
    expect(t.app.services.cfg.get('schedule.workDays')).toHaveLength(before.length + 1);
    await vi.waitFor(async () => expect((await db.pool.query('SELECT status FROM tasks ORDER BY depth')).rows.map((x) => x.status)).toEqual(['done', 'done']), { timeout: 15_000 });
  });

  it('switching ot.enabled off stops a granted tree at once; the held work stays held', async () => {
    const t = await start();
    const [row] = await rows();
    const card = otCards(t)[0]!;
    await t.app.services.cfg.set('ot.enabled', false, 'test');
    const r = await press(t, cid(row!, 'approve'), card.id);
    expect(JSON.stringify(r)).toContain('switched off');
    expect(t.provider.callsOf('heads/software')).toHaveLength(0);
    expect((await rows())[0]!.status).toBe('pending');
  });
});

describe('overtime switch (G2OT-03)', () => {
  it('turning ot.enabled off from any path revokes every grant and closes its card; turning it back on the same day revives nothing', async () => {
    const t = await start();
    const [row] = await rows();
    const card = otCards(t)[0]!;
    await press(t, cid(row!, 'approve'), card.id);
    await vi.waitFor(async () => expect((await rows())[0]!.status).toBe('approved'));
    await t.app.services.cfg.set('ot.enabled', false, 'psql');
    await vi.waitFor(async () => expect((await rows())[0]!.revoke_reason).toBe('admin'));
    await vi.waitFor(() => expect(t.port.closed.some((c) => c.messageId === card.id && c.note.includes('switched off'))).toBe(true));
    await t.app.services.cfg.set('ot.enabled', true, 'psql');
    expect((await rows())[0]!.revoke_reason).toBe('admin');
  });
});

describe('overtime boot revokes (OT-C4)', () => {
  const seedGrant = async () => {
    await migrateUp(db.pool);
    await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, loadPrompts(PROMPTS_DIR));
    await new TaskRepo(db.pool).create({ id: 'root-ot', title: 't', deptId: 'praw', owner: { kind: 'head', dept: 'praw' }, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
    await db.pool.query(
      `INSERT INTO ot_requests (root_id, local_day, seq, requested_by, digest, status, card_channel_id, card_message_id, expires_at, decided_by, decided_at, grant_expires_at, max_runs, max_usd, usd_base)
       VALUES ('root-ot', (now() AT TIME ZONE 'Asia/Bangkok')::date, 1, '1', 'abcdef012345', 'approved', $1, '1570000000000000111', now() + interval '10 hours', $2, now(), now() + interval '4 hours', 30, 2, 0)`,
      [CONFIG_CHANNEL, ADMIN],
    );
  };
  const reason = async () => (await db.pool.query<{ revoke_reason: string | null }>('SELECT revoke_reason FROM ot_requests')).rows[0]!.revoke_reason;

  it('a grant decided before the halted row last changed (a halt and resume while the process was down) is revoked at boot, before the scheduler runs, and its card is closed once the clients are up', async () => {
    await seedGrant();
    await db.pool.query("INSERT INTO config (key, value, updated_by) VALUES ('halted', 'false'::jsonb, 'psql') ON CONFLICT (key) DO UPDATE SET updated_at = now()");
    const t = await boot(db.pool, { provider: new ActorProvider({}), start: false, offDays: ALL_DAYS });
    app = t.app;
    expect(await reason()).toBe('halt');
    await t.app.start();
    await vi.waitFor(() => expect(t.port.closed.some((c) => c.messageId === '1570000000000000111' && c.note.includes('halted'))).toBe(true));
  });

  it('boot while halted revokes every grant; boot with no halt row leaves a live grant alone', async () => {
    await seedGrant();
    const t0 = await boot(db.pool, { provider: new ActorProvider({}), start: false, offDays: ALL_DAYS });
    expect(await reason()).toBeNull();
    await t0.app.stop();
    await db.pool.query("INSERT INTO config (key, value, updated_by) VALUES ('halted', 'true'::jsonb, 'psql') ON CONFLICT (key) DO UPDATE SET value = 'true'::jsonb");
    const t1 = await boot(db.pool, { provider: new ActorProvider({}), start: false, offDays: ALL_DAYS });
    app = t1.app;
    expect(await reason()).toBe('halt');
  });
});

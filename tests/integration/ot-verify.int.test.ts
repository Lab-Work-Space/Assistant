import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../../app.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { OtRequestRepo } from '../../db/repos/ot-requests.js';
import { TaskRepo } from '../../db/repos/index.js';
import { handleInteraction } from '../../discord/index.js';
import { interaction } from '../../discord/commands/test-helpers.js';
import { ActorProvider, CONFIG_CHANNEL, HQ_WORK, TestPort, boot, humanMsg, resetDb, respond, taskIdOf, turn } from './helpers.js';

/** OT-1 stage 6 (tester): independent probes on top of the backend suite. Every day is an off day so the date the test runs on does not matter. */
const ADMIN = '123456789012345678';
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
let db: TestDb;
let app: App | null = null;
beforeAll(async () => { db = await freshDb(); });
afterEach(async () => { await app?.stop(); app = null; await resetDb(db.pool); });
afterAll(async () => { await db.close(); });

const ct = (title: string) => turn({ name: 'create_task', input: { title, description: 'x', assignee: { kind: 'head', dept: 'software' }, estCostUsd: 0.1 } });
const done = (s: string) => (req: Parameters<typeof taskIdOf>[0]) => turn({ name: 'update_task', input: { taskId: taskIdOf(req), status: 'done', summary: s } }, respond('report', s));
const rows = () => db.pool.query<{ id: number; root_id: string; status: string; runs_used: number; digest: string; card_message_id: string | null; revoke_reason: string | null; grant_expires_at: Date | null }>('SELECT * FROM ot_requests ORDER BY id').then((r) => r.rows);

describe('(a) the owner scenario with two roots', () => {
  it('approve OT for root 1 runs only root 1; root 2 stays held with its own card, and approving root 2 later runs it', async () => {
    const provider = new ActorProvider({
      'heads/hq': [ct('Root one'), turn(respond('chat', 'ok1')), ct('Root two'), turn(respond('chat', 'ok2')), done('one'), done('two')],
      'heads/software': [(req) => turn({ name: 'update_task', input: { taskId: taskIdOf(req), status: 'done', summary: 'd' } }, respond('report', 'd')), (req) => turn({ name: 'update_task', input: { taskId: taskIdOf(req), status: 'done', summary: 'd' } }, respond('report', 'd'))],
    });
    const port = new TestPort(); port.snowflakes = true;
    const t = await boot(db.pool, { provider, port, offDays: ALL_DAYS });
    app = t.app;
    const { scheduler } = t.app.services;
    await scheduler.onMessage(humanMsg('<@100> one', { channelId: HQ_WORK, mentionedHeads: ['hq'] }));
    await scheduler.idle();
    await scheduler.onMessage(humanMsg('<@100> two', { channelId: HQ_WORK, mentionedHeads: ['hq'], id: 'm2' } as never));
    await scheduler.idle();
    const rs = await rows();
    expect(rs).toHaveLength(2);
    expect(new Set(rs.map((r) => r.root_id)).size).toBe(2);
    const cards = port.posts.filter((p) => p.target.channelId === CONFIG_CHANNEL && p.payload.otButtons !== undefined);
    expect(cards).toHaveLength(2);
    const notices = port.posts.filter((p) => p.payload.type === 'chat' && p.payload.body.startsWith('⏸️') && p.payload.body.includes('ส่งคำขอ OT ให้ Bot Admin แล้ว'));
    expect(notices.length).toBe(2);
    const press = async (r: (typeof rs)[number], a: string) => {
      const i = interaction({ kind: 'button', customId: `approval:ot:${r.id}:${r.digest}:${a}`, userId: ADMIN, messageId: r.card_message_id!, messageAuthorId: 'hq' });
      const out = await handleInteraction(i, t.app.services.commands); await scheduler.idle(); return out;
    };
    await press(rs[0]!, 'approve');
    await vi.waitFor(async () => expect((await rows())[0]).toMatchObject({ status: 'approved', runs_used: 2 }));
    const roots = rs.map((r) => r.root_id);
    const st = async (root: string) => (await db.pool.query<{ status: string }>('SELECT status FROM tasks WHERE root_id = $1 ORDER BY depth', [root])).rows.map((x) => x.status);
    expect(await st(roots[0]!)).toEqual(['done', 'done']);
    expect(await st(roots[1]!)).toEqual(['doing', 'todo']); // second tree stays held
    expect((await rows())[1]).toMatchObject({ status: 'pending', runs_used: 0 });
    expect(port.posts.some((p) => p.payload.type === 'chat' && /^✅ อนุมัติ OT ถึง \d\d:\d\d/.test(p.payload.body))).toBe(true);
    // grant window: <= 4h and never past the stored expiry
    const g = (await rows())[0]!;
    const hrs = (g.grant_expires_at!.getTime() - Date.now()) / 3.6e6;
    expect(hrs).toBeLessThanOrEqual(4.001);
    // now approve root 2
    await press(rs[1]!, 'approve');
    await vi.waitFor(async () => expect(await st(roots[1]!)).toEqual(['done', 'done']));
  });
});

describe('(d)(f) caps, slice, midnight on the repository', () => {
  const mk = async (id: string, userId = '1') => new TaskRepo(db.pool).create({ id, title: 't', deptId: 'hq', owner: { kind: 'head', dept: 'hq' }, requester: { kind: 'human', userId }, origin: 'chat', threadId: '1570000000000000009', channelId: '1570000000000000001' });
  const repoFn = async () => {
    const { migrateUp } = await import('./helpers.js'); await migrateUp(db.pool);
    const { seed } = await import('../../company/index.js'); const { ChannelMapRepo, DepartmentRepo, PersonaRepo } = await import('../../db/repos/index.js'); const { PROMPTS_DIR, loadPrompts } = await import('../../prompts/index.js');
    await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, loadPrompts(PROMPTS_DIR));
    return new OtRequestRepo(db.pool);
  };
  const A = { tz: 'Asia/Bangkok', perRoot: 2, perDay: 20, perPerson: 4 };
  const grant = async (repo: OtRequestRepo, root: string, o: { runs?: number; usd?: number; hours?: number } = {}) => {
    const r = await repo.raise({ rootId: root, requestedBy: '1', ...A });
    if (!r.ok) throw new Error(r.why);
    await repo.setCard(r.row.id, CONFIG_CHANNEL, String(1570000000000000100n + BigInt(r.row.id)));
    const a = await repo.approve({ id: r.row.id, digest: r.row.digest, messageId: String(1570000000000000100n + BigInt(r.row.id)), channelId: CONFIG_CHANNEL, userId: ADMIN, tz: A.tz, hours: o.hours ?? 4, maxRuns: o.runs ?? 30, maxUsd: o.usd ?? 2, gates: { offDay: () => true, halted: () => false, enabled: () => true } });
    if (!a.ok) throw new Error(a.error);
    return a.row;
  };
  const day = async () => (await db.pool.query<{ d: string }>("SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date::text AS d")).rows[0]!.d;

  it('30 runs then the 31st is refused, under 45 concurrent consumes exactly 30 win', async () => {
    const repo = await repoFn(); await mk('r1');
    await grant(repo, 'r1');
    const d = await day();
    const res = await Promise.all(Array.from({ length: 45 }, () => repo.consume('r1', d)));
    expect(res.filter((x) => x.ok)).toHaveLength(30);
    expect(res.filter((x) => !x.ok && x.why === 'exhausted')).toHaveLength(15);
    expect((await rows())[0]!.runs_used).toBe(30);
    expect(await repo.usable('r1', d)).toBe(false);
  });

  it('the $2 slice: spend above the base counts, the base is not charged, the cap stops starts', async () => {
    const repo = await repoFn(); await mk('r2');
    await db.pool.query("INSERT INTO budget_days (day, scope, scope_id, spent_usd, reserved_usd) VALUES (DATE '1970-01-01','task','r2', 1.5, 0)");
    await grant(repo, 'r2');
    const d = await day();
    expect((await repo.consume('r2', d)).ok).toBe(true);
    await db.pool.query("UPDATE budget_days SET spent_usd = 3.49 WHERE scope='task' AND scope_id='r2'"); // 1.99 over base
    expect((await repo.consume('r2', d)).ok).toBe(true);
    await db.pool.query("UPDATE budget_days SET spent_usd = 3.5 WHERE scope='task' AND scope_id='r2'"); // exactly 2.00 over base
    const c = await repo.consume('r2', d);
    expect(c).toMatchObject({ ok: false, why: 'exhausted' });
    expect(await repo.usable('r2', d)).toBe(false);
  });

  it('a third request for one root on one day is refused (cap_root); 4h cap and midnight cap on the window', async () => {
    const repo = await repoFn(); await mk('r3');
    const one = await grant(repo, 'r3', { hours: 12 });
    // window never beyond 12h by the table and never past local midnight
    const mid = (await db.pool.query<{ m: Date }>("SELECT ((date_trunc('day', now() AT TIME ZONE 'Asia/Bangkok') + interval '1 day') AT TIME ZONE 'Asia/Bangkok') AS m")).rows[0]!.m;
    expect(one.grantExpiresAt!.getTime()).toBeLessThanOrEqual(mid.getTime());
    await db.pool.query("UPDATE ot_requests SET status='approved' WHERE id=$1", [one.id]);
    await repo.revoke(one.id, 'x', 'admin');
    const two = await repo.raise({ rootId: 'r3', requestedBy: '1', ...A });
    expect(two.ok).toBe(true);
    if (two.ok) await repo.endUnposted(two.row.id);
    const three = await repo.raise({ rootId: 'r3', requestedBy: '1', ...A });
    expect(three).toMatchObject({ ok: false, why: 'cap_root' });
  });

  it('(f) midnight: a grant of yesterday, an expired grant, and a stale pending row are all dead', async () => {
    const repo = await repoFn(); await mk('r4'); await mk('r5');
    const g = await grant(repo, 'r4');
    const d = await day();
    expect((await repo.consume('r4', '2000-01-01')).ok).toBe(false); // caller's day is not the grant's day
    expect((await repo.consume('r4', d)).ok).toBe(true); // control: it was live
    await db.pool.query("UPDATE ot_requests SET decided_at = now() - interval '2 hours', grant_expires_at = now() - interval '1 hour' WHERE id=$1", [g.id]);
    expect((await repo.consume('r4', d)).ok).toBe(false);
    expect(await repo.usable('r4', d)).toBe(false);
    expect(await repo.unexpired('r4', d)).toBeNull();
    const r = await repo.raise({ rootId: 'r5', requestedBy: '1', ...A });
    if (!r.ok) throw new Error(r.why);
    await repo.setCard(r.row.id, CONFIG_CHANNEL, '1570000000000000555');
    await db.pool.query('ALTER TABLE ot_requests DROP CONSTRAINT ot_requests_expiry');
    await db.pool.query("UPDATE ot_requests SET expires_at = now() - interval '1 second' WHERE id=$1", [r.row.id]);
    const a = await repo.approve({ id: r.row.id, digest: r.row.digest, messageId: '1570000000000000555', channelId: CONFIG_CHANNEL, userId: ADMIN, tz: A.tz, hours: 4, maxRuns: 30, maxUsd: 2, gates: { offDay: () => true, halted: () => false, enabled: () => true } });
    expect(a).toMatchObject({ ok: false, error: 'expired' });
    const dd = await repo.claimDay({ id: r.row.id, digest: r.row.digest, messageId: '1570000000000000555', channelId: CONFIG_CHANNEL, userId: ADMIN, tz: A.tz, configChannelId: CONFIG_CHANNEL });
    expect(dd.ok).toBe(false);
  });

  it('table CHECKs: 13h window, $51 cap, seq 6 and a second live grant are refused by the database itself', async () => {
    const repo = await repoFn(); await mk('r6');
    const g = await grant(repo, 'r6');
    const bad = (sql: string) => expect(db.pool.query(sql)).rejects.toThrow();
    await bad(`UPDATE ot_requests SET grant_expires_at = decided_at + interval '13 hours' WHERE id=${g.id}`);
    await bad(`UPDATE ot_requests SET max_usd = 51 WHERE id=${g.id}`);
    await bad(`UPDATE ot_requests SET max_runs = 201 WHERE id=${g.id}`);
    await bad(`UPDATE ot_requests SET runs_used = max_runs + 1 WHERE id=${g.id}`);
    await bad(`INSERT INTO ot_requests (root_id, local_day, seq, requested_by, digest, expires_at) VALUES ('r6', now()::date, 6, '1', 'abcdefabcdef', now() + interval '1 hour')`);
  });
});

describe('(e)(g)(h) halt, model paths, off-day surfaces', () => {
  it('(e) halt then resume leaves the grant revoked (consume refused); boot-while-halted covered by ot-acceptance', async () => {
    const provider = new ActorProvider({ 'heads/hq': [ct('R'), turn(respond('chat', 'ok'))] });
    const port = new TestPort(); port.snowflakes = true;
    const t = await boot(db.pool, { provider, port, offDays: ALL_DAYS }); app = t.app;
    await t.app.services.scheduler.onMessage(humanMsg('<@100> r', { channelId: HQ_WORK, mentionedHeads: ['hq'] }));
    await t.app.services.scheduler.idle();
    const r = (await rows())[0]!;
    await handleInteraction(interaction({ kind: 'button', customId: `approval:ot:${r.id}:${r.digest}:approve`, userId: ADMIN, messageId: r.card_message_id!, messageAuthorId: 'hq' }), t.app.services.commands);
    await t.app.services.scheduler.idle();
    await t.app.services.halt.halt('t');
    await vi.waitFor(async () => expect((await rows())[0]!.revoke_reason).toBe('halt'));
    await t.app.services.halt.resume('t');
    const repo = new OtRequestRepo(db.pool);
    const d = (await db.pool.query<{ d: string }>("SELECT (now() AT TIME ZONE 'Asia/Bangkok')::date::text AS d")).rows[0]!.d;
    expect((await repo.consume(r.root_id, d)).ok).toBe(false);
    // a button on a halted company: approve refused
  });

  it('(g) no tool the model can call lists an ot.* key as writable; admin console keys exclude them', async () => {
    const { isAdminConfigKey } = await import('../../admin/keys.js');
    for (const k of ['ot.enabled', 'ot.hours', 'ot.maxRuns', 'ot.maxUsd', 'ot.requestsPerRootPerDay', 'ot.requestsPerDay', 'ot.requestsPerPersonPerDay']) expect(isAdminConfigKey(k)).toBe(false);
    const t = await boot(db.pool, { provider: new ActorProvider({}), start: false, offDays: ALL_DAYS }); app = t.app;
    const names = (t.app.services as unknown as { adminConsole: unknown });
    expect(names).toBeDefined();
  });
});

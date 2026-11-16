import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventBus, type AppEvents } from '../core/events.js';
import { migrate } from '../db/migrate.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { DepartmentRepo, TaskRepo } from '../db/index.js';
import type { ActorRef } from '../company/types.js';
import { Budget } from './budget.js';
import { BotRoots } from './botroots.js';
import { FakeConfig } from './test-helpers.js';

let db: TestDb;
const now = new Date('2026-11-03T10:00:00Z');
const hq: ActorRef = { kind: 'head', dept: 'hq' };
const praw: ActorRef = { kind: 'head', dept: 'praw' };
const LOCAL = 'claude-code-local';

const mk = (init: ConstructorParameters<typeof FakeConfig>[0] = {}) => {
  const cfg = new FakeConfig({ 'limits.localUnlimited': false, 'budget.botDailyUsd': 1000, 'budget.taskUsd': 1000, ...init });
  const bus = new EventBus<AppEvents>();
  const paused: unknown[] = [];
  bus.on('governance.paused', (p) => { paused.push(p); });
  return { cfg, paused, budget: new Budget(db.pool, cfg, bus, () => now) };
};
const local = (b: Budget, o: { pool?: 'warroom'; actor?: ActorRef } = {}) =>
  b.reserve({ actor: o.actor ?? hq, estUsd: 0, model: 'local/claude-sonnet-5-5', provider: LOCAL, ...(o.pool ? { pool: o.pool } : {}) });

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'), 'up');
  await new DepartmentRepo(db.pool).upsert({ id: 'hq', name: 'HQ', categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
});
beforeEach(async () => {
  await db.pool.query('DELETE FROM budget_days');
  await db.pool.query('DELETE FROM tasks');
});
afterAll(async () => { await db.close(); });

describe('TW4 the warroom pool', () => {
  it('local: warroom runs stop at warroom.localCallsPerDay with one alert, and a human run (no pool) still goes through', async () => {
    const { budget, paused } = mk({ 'warroom.localCallsPerDay': 3 });
    for (let i = 0; i < 3; i++) expect((await local(budget, { pool: 'warroom' })).ok).toBe(true);
    expect(await local(budget, { pool: 'warroom' })).toEqual({ ok: false, scope: 'warroom' });
    expect(await local(budget, { pool: 'warroom' })).toEqual({ ok: false, scope: 'warroom' });
    expect(paused).toEqual([{ scope: 'warroom', day: '2026-11-03' }]);
    expect((await local(budget, { actor: praw })).ok).toBe(true); // a human mention to Praw
    // and the shared pool still has room: 3 + 1 of 200
    const rows = await budget.usage('2026-11-03');
    expect(rows.find((r) => r.scope === 'local')!.calls).toBe(4);
    expect(rows.find((r) => r.scope === 'warroom')!.calls).toBe(3);
  });

  it('the default pool is half of the shared local pool: warroom runs can never use more than 100 of 200', async () => {
    const { budget } = mk();
    const all = await Promise.all(Array.from({ length: 120 }, () => local(budget, { pool: 'warroom' })));
    expect(all.filter((r) => r.ok)).toHaveLength(100);
    const humans = await Promise.all(Array.from({ length: 100 }, () => local(budget)));
    expect(humans.filter((r) => r.ok)).toHaveLength(100); // humans keep their half
    expect((await local(budget)).ok).toBe(false);
  });

  it('USD: warroom runs stop at warroom.dailyUsd; a run outside the pool is only held to the company budget', async () => {
    const { budget, paused } = mk({ 'warroom.dailyUsd': 1, 'warroom.botDailyUsd': 1, 'budget.companyDailyUsd': 5 });
    const a = await budget.reserve({ actor: hq, estUsd: 0.8, pool: 'warroom' });
    expect(a.ok).toBe(true);
    if (a.ok) await budget.settle(a.reservationId, 0.8);
    expect(await budget.reserve({ actor: hq, estUsd: 0.5, pool: 'warroom' })).toEqual({ ok: false, scope: 'warroom' });
    expect(paused).toEqual([{ scope: 'warroom', day: '2026-11-03' }]);
    expect((await budget.reserve({ actor: praw, estUsd: 3 })).ok).toBe(true);
  });

  it('a head\'s warroom USD talk is held to its own warroom share and never touches its ordinary bot budget', async () => {
    const { budget, paused } = mk({ 'budget.botDailyUsd': 1, 'warroom.botDailyUsd': 0.5, 'warroom.dailyUsd': 2.5 });
    const a = await budget.reserve({ actor: hq, estUsd: 0.4, pool: 'warroom' });
    expect(a.ok).toBe(true);
    if (a.ok) await budget.settle(a.reservationId, 0.4);
    // G2TW-03: its own scope, naming the bot, so the scheduler does not pause all warroom routing
    expect(await budget.reserve({ actor: hq, estUsd: 0.2, pool: 'warroom' })).toEqual({ ok: false, scope: 'warroom_bot' });
    expect(paused).toEqual([{ scope: 'warroom_bot', actor: hq, day: '2026-11-03' }]);
    expect((await budget.reserve({ actor: hq, estUsd: 1 })).ok).toBe(true); // the CEO's human work still has its whole daily budget
    expect((await budget.reserve({ actor: praw, estUsd: 0.4, pool: 'warroom' })).ok).toBe(true); // another head has its own share
    const rows = await budget.usage('2026-11-03');
    expect(rows.find((r) => r.scope === 'bot' && r.scopeId === 'head:hq')!.spentUsd).toBe(0);
  });

  it('no deadlock: parallel warroom and human reserves with tasks all finish', async () => {
    const { budget } = mk();
    const r = await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? local(budget, { pool: 'warroom' }) : budget.reserve({ actor: hq, estUsd: 0.01, pool: 'warroom' }))));
    expect(r.every((x) => x.ok)).toBe(true);
  });
});

describe('TW6 BotRoots over the tasks table', () => {
  it('counts only parentless, delegated, non-human-requested tasks created today; survives a new instance (restart)', async () => {
    const tasks = new TaskRepo(db.pool);
    const cfg = new FakeConfig({ 'limits.localUnlimited': false, 'warroom.rootTasksPerDay': 2 });
    const mkRoots = () => new BotRoots(cfg, (since) => tasks.countBotRootsSince(since), () => Date.now());
    await tasks.create({ title: 'h', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'chat' }); // a person's: not counted
    const bot = await tasks.create({ title: 'b1', deptId: 'hq', owner: hq, requester: praw, origin: 'delegated' });
    await tasks.create({ title: 'child', deptId: 'hq', owner: hq, requester: praw, origin: 'delegated', parentId: bot.id }); // not a root
    const r1 = await mkRoots().acquire();
    expect(r1).toBeTypeOf('function');
    await tasks.create({ title: 'b2', deptId: 'hq', owner: hq, requester: praw, origin: 'delegated' });
    r1!();
    expect(await mkRoots().acquire()).toBeNull(); // a fresh instance sees both rows
  });

  it('G2TW-02: a root task made while answering a person (source_user_id set) is not counted', async () => {
    const tasks = new TaskRepo(db.pool);
    await tasks.create({ title: 'for a person', deptId: 'hq', owner: hq, requester: praw, origin: 'delegated', sourceUserId: '42' });
    await tasks.create({ title: 'bot talk', deptId: 'hq', owner: hq, requester: praw, origin: 'delegated' });
    expect(await tasks.countBotRootsSince(new Date(0))).toBe(1);
  });

  it('openOf lists id, status and department only, for the owner, unfinished tasks only', async () => {
    const tasks = new TaskRepo(db.pool);
    const a = await tasks.create({ title: 'secret title', deptId: 'hq', owner: hq, requester: praw, origin: 'delegated' });
    await tasks.create({ title: 'other owner', deptId: 'hq', owner: praw, requester: hq, origin: 'delegated' });
    const done = await tasks.create({ title: 'done one', deptId: 'hq', owner: hq, requester: praw, origin: 'delegated' });
    await tasks.update(done.id, { status: 'done' });
    const rows = await tasks.openOf(hq, 10);
    expect(rows).toEqual([{ id: a.id, status: 'todo', deptId: 'hq' }]);
    expect(JSON.stringify(rows)).not.toContain('secret');
    const stale = await tasks.staleOpen(new Date(Date.now() + 60_000), 10);
    expect(stale.map((s) => s.id).sort()).toEqual([...rows.map((r) => r.id)].concat((await tasks.openOf(praw, 10)).map((r) => r.id)).sort());
  });
});

describe('SPEND-1 the warroom layout and the department month', () => {
  it('S9: a warroom USD run locks and books the dept row too (company -> dept -> task -> warroom -> warroom_bot) and is refused by a department cap', async () => {
    const { budget, paused } = mk({ 'spend.deptMonthlyUsd': { hq: 0.5 }, 'budget.companyDailyUsd': 1000, 'warroom.dailyUsd': 1000, 'warroom.botDailyUsd': 1000 });
    const r = await budget.reserve({ actor: hq, estUsd: 0.3, model: 'claude-sonnet-5-5', pool: 'warroom' });
    expect(r.ok).toBe(true);
    const dept = (await db.pool.query("SELECT to_char(day,'YYYY-MM-DD') AS day, reserved_usd::float8 AS r FROM budget_days WHERE scope = 'dept'")).rows;
    expect(dept).toEqual([{ day: '2026-11-01', r: 0.3 }]);
    expect(await budget.reserve({ actor: hq, estUsd: 0.3, model: 'claude-sonnet-5-5', pool: 'warroom' })).toEqual({ ok: false, scope: 'dept' });
    expect(paused.at(-1)).toMatchObject({ scope: 'dept', dept: 'hq', day: '2026-11-01' });
    if (r.ok) await budget.settle(r.reservationId, 0.2);
    expect((await db.pool.query("SELECT spent_usd::float8 AS s FROM budget_days WHERE scope = 'dept'")).rows[0].s).toBe(0.2);
    expect((await db.pool.query("SELECT spent_usd::float8 AS s FROM budget_days WHERE scope = 'warroom_bot'")).rows[0].s).toBe(0.2);
  });
});

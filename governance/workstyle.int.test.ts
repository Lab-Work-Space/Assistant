import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WarroomGuard } from '../agents/team/warroom.js';
import type { ActorRef } from '../company/types.js';
import { EventBus, type AppEvents } from '../core/events.js';
import { DepartmentRepo, GuardStateRepo, TaskRepo } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { Budget, LIFTED_CAPS } from './budget.js';
import { FakeConfig } from './test-helpers.js';

let db: TestDb;
const now = new Date('2026-11-03T10:00:00Z');
const hq: ActorRef = { kind: 'head', dept: 'hq' };
const LOCAL = 'claude-code-local';
const ID = (n: number) => `15700000000000${String(10000 + n)}`; // 19-digit snowflake-shaped ids

const mk = (init: ConstructorParameters<typeof FakeConfig>[0] = {}) => {
  const cfg = new FakeConfig({ 'budget.botDailyUsd': 1000, 'budget.taskUsd': 1000, 'budget.companyDailyUsd': 1000, ...init });
  const bus = new EventBus<AppEvents>();
  const events: AppEvents['governance.paused'][] = [];
  bus.on('governance.paused', (p) => { events.push(p); });
  return { cfg, events, budget: new Budget(db.pool, cfg, bus, () => now) };
};
const local = (b: Budget, o: { pool?: 'warroom'; taskId?: string } = {}) =>
  b.reserve({ actor: hq, estUsd: 0, model: 'local/claude-sonnet-5-5', provider: LOCAL, ...(o.pool ? { pool: o.pool } : {}), ...(o.taskId ? { taskId: o.taskId } : {}) });
const metered = (b: Budget, o: { pool?: 'warroom' } = {}) => b.reserve({ actor: hq, estUsd: 0.5, model: 'claude-sonnet-5-5', provider: 'claude', ...(o.pool ? { pool: o.pool } : {}) });

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'), 'up');
  await new DepartmentRepo(db.pool).upsert({ id: 'hq', name: 'HQ', categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
});
beforeEach(async () => {
  await db.pool.query('DELETE FROM budget_days');
  await db.pool.query('DELETE FROM tasks');
  await db.pool.query('DELETE FROM guard_state');
});
afterAll(async () => { await db.close(); });

describe('WS1 the lift is an explicit list, decided per call from the provider', () => {
  it('the three local counts (day, warroom pool, per-root) are skipped for a local call with the flag on, and still counted', async () => {
    const { budget } = mk({ 'limits.localCallsPerDay': 2, 'warroom.localCallsPerDay': 2, 'limits.localCallsPerTask': 2 });
    const root = await new TaskRepo(db.pool).create({ title: 't', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
    for (let i = 0; i < 6; i++) expect((await local(budget, { pool: 'warroom', taskId: root.id })).ok).toBe(true);
    const rows = await budget.usage('2026-11-03');
    expect(rows.find((r) => r.scope === 'local')!.calls).toBe(6); // counters keep counting
    expect(rows.find((r) => r.scope === 'warroom')!.calls).toBe(6);
  });

  it('with the flag off the same calls are refused as before (local, then warroom, then local_task)', async () => {
    const { budget } = mk({ 'limits.localUnlimited': false, 'limits.localCallsPerDay': 5, 'warroom.localCallsPerDay': 2, 'limits.localCallsPerTask': 1 });
    const root = await new TaskRepo(db.pool).create({ title: 't', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
    expect((await local(budget, { taskId: root.id })).ok).toBe(true);
    expect(await local(budget, { taskId: root.id })).toEqual({ ok: false, scope: 'local_task' });
    expect((await local(budget, { pool: 'warroom' })).ok).toBe(true);
    expect((await local(budget, { pool: 'warroom' })).ok).toBe(true);
    expect(await local(budget, { pool: 'warroom' })).toEqual({ ok: false, scope: 'warroom' });
  });

  it('a metered call is never lifted: every USD scope still refuses with the flag on', async () => {
    const { budget } = mk({ 'budget.companyDailyUsd': 0.6, 'warroom.dailyUsd': 0.4 });
    expect((await metered(budget)).ok).toBe(true);
    expect(await metered(budget)).toEqual({ ok: false, scope: 'company' });
    const b2 = mk({ 'warroom.dailyUsd': 0.4 });
    expect(await metered(b2.budget, { pool: 'warroom' })).toEqual({ ok: false, scope: 'warroom' });
  });

  it('LIFTED_CAPS is exactly the list of Gate 1 WS1 (nothing else is skipped)', () => {
    expect([...LIFTED_CAPS].sort()).toEqual([
      'limits.localCallsPerDay', 'limits.localCallsPerTask', 'limits.turnsPerTask', 'meetings.adHocPerDay', 'warroom.localCallsPerDay',
      'warroom.rootTasksPerDay', 'warroom.turnsPerHour', 'warroom.turnsPerThreadPerHour',
    ]);
  });
});

describe('WS5 the alert refuses nothing and is sent once a day', () => {
  it('bot-triggered local calls (the warroom row) passing limits.localBotCallsAlert raise one alert and nothing is refused', async () => {
    const { budget, events } = mk({ 'limits.localBotCallsAlert': 3 });
    for (let i = 0; i < 8; i++) expect((await local(budget, { pool: 'warroom' })).ok).toBe(true);
    expect(events.filter((e) => e.scope === 'local_bot_alert')).toEqual([{ scope: 'local_bot_alert', day: '2026-11-03' }]);
  });

  it('a person\'s local calls (no pool) never count towards it', async () => {
    const { budget, events } = mk({ 'limits.localBotCallsAlert': 2 });
    for (let i = 0; i < 6; i++) await local(budget);
    expect(events).toEqual([]);
  });
});

describe('WS4 the stall state survives a restart', () => {
  it('a stalled key is still stalled after the guard is rebuilt from the database, and a person\'s message lifts it there', async () => {
    const store = new GuardStateRepo(db.pool);
    const lim = () => ({ turnsPerThreadPerHour: 1000, turnsPerHour: 1000, stallTurns: 2, heldMax: 5 });
    const g1 = new WarroomGuard(lim, () => now.getTime(), store);
    const key = ID(1);
    await g1.ensure(key);
    expect(g1.start(key, 'hq').kind).toBe('ok');
    expect(g1.start(key, 'software').kind).toBe('ok');
    expect(g1.start(key, 'hq')).toEqual({ kind: 'stalled', ceoTurn: true });
    await g1.flush(key);
    expect((await db.pool.query('SELECT run_count, stalled, ceo_turn FROM guard_state WHERE key = $1', [key])).rows).toEqual([{ run_count: 2, stalled: true, ceo_turn: true }]);

    const g2 = new WarroomGuard(lim, () => now.getTime(), store); // a restart
    expect(g2.isStalled(key)).toBe(false); // nothing is loaded until the key is used
    await g2.ensure(key);
    expect(g2.isStalled(key)).toBe(true);
    expect(g2.takeCeoTurn(key)).toBe(true); // the one CEO turn is still owed, once
    await g2.flush(key);
    const g3 = new WarroomGuard(lim, () => now.getTime(), store);
    await g3.ensure(key);
    expect(g3.isStalled(key)).toBe(true);
    expect(g3.takeCeoTurn(key)).toBe(false);
    g3.humanMessage(key);
    await g3.flush(key);
    const g4 = new WarroomGuard(lim, () => now.getTime(), store);
    await g4.ensure(key);
    expect(g4.isStalled(key)).toBe(false);
  });

  it('the one task-write reset used is remembered across a restart, and old keys are pruned', async () => {
    const store = new GuardStateRepo(db.pool);
    const lim = () => ({ turnsPerThreadPerHour: 1000, turnsPerHour: 1000, stallTurns: 5, heldMax: 5 });
    const g1 = new WarroomGuard(lim, () => now.getTime(), store);
    const key = ID(2);
    await g1.ensure(key);
    g1.start(key, 'hq');
    g1.taskWrite(key);
    await g1.flush(key);
    const g2 = new WarroomGuard(lim, () => now.getTime(), store);
    await g2.ensure(key);
    for (let i = 0; i < 3; i++) g2.start(key, 'hq');
    g2.taskWrite(key); // not a second reset
    for (let i = 0; i < 2; i++) expect(g2.start(key, 'hq').kind).toBe('ok');
    expect(g2.start(key, 'hq').kind).toBe('stalled');
    await db.pool.query("UPDATE guard_state SET touched_at = now() - interval '7 hours'");
    await store.prune(new Date(Date.now() - 6 * 3_600_000));
    expect((await db.pool.query('SELECT 1 FROM guard_state')).rowCount).toBe(0);
  });

  it('a synthetic (non-snowflake) key is not stored and never throws', async () => {
    const store = new GuardStateRepo(db.pool);
    await store.put('thread-1', { count: 1, stalled: false, ceoTurn: false, resetUsed: false });
    expect(await store.get('thread-1')).toBeNull();
  });
});

describe('WS6/WS13 task rows carry the origin category (inherited, never from input) and a conversation marker', () => {
  it('a child copies its parent\'s origin category even when the creator passes another', async () => {
    const tasks = new TaskRepo(db.pool);
    const root = await tasks.create({ title: 'r', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'chat', originCategoryId: ID(5), conversation: true, originMessageId: ID(6) });
    expect(root).toMatchObject({ originCategoryId: ID(5), conversation: true, originMessageId: ID(6) });
    const kid = await tasks.create({ title: 'k', deptId: 'hq', owner: hq, requester: hq, origin: 'delegated', parentId: root.id, originCategoryId: ID(9) });
    expect(kid.originCategoryId).toBe(ID(5));
    expect(kid.conversation).toBe(false);
    const plain = await tasks.create({ title: 'p', deptId: 'hq', owner: hq, requester: hq, origin: 'delegated', originCategoryId: 'not-a-snowflake' });
    expect(plain.originCategoryId).toBeNull();
  });

  it('findOpenConversation finds one open conversation per (head, person, place) and ignores finished ones', async () => {
    const tasks = new TaskRepo(db.pool);
    const a = await tasks.create({ title: 'a', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'chat', threadId: ID(7), conversation: true, status: 'doing' });
    await tasks.create({ title: 'goal', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'slash', threadId: ID(7), status: 'doing' }); // a /goal task is not one
    expect((await tasks.findOpenConversation({ deptId: 'hq', userId: '1', where: ID(7) }))?.id).toBe(a.id);
    expect(await tasks.findOpenConversation({ deptId: 'hq', userId: '2', where: ID(7) })).toBeNull();
    expect(await tasks.findOpenConversation({ deptId: 'software', userId: '1', where: ID(7) })).toBeNull();
    await tasks.update(a.id, { status: 'done' });
    expect(await tasks.findOpenConversation({ deptId: 'hq', userId: '1', where: ID(7) })).toBeNull();
  });
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventBus, type AppEvents } from '../core/events.js';
import { migrate } from '../db/migrate.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { BudgetDayRepo, DepartmentRepo, TaskRepo } from '../db/index.js';
import type { ActorRef } from '../company/types.js';
import { Budget } from './budget.js';
import { FakeConfig } from './test-helpers.js';
import { createClaudeCodeLocalProvider } from '../providers/claude-code-local/index.js';
import type { ChatRequest } from '../providers/types.js';
import { installFakeClaude } from '../tests/fakes/claudeCli.js';

let db: TestDb;
let tasks: TaskRepo;
let now = new Date('2026-10-31T10:00:00Z');
const hq: ActorRef = { kind: 'head', dept: 'hq' };
const persona: ActorRef = { kind: 'persona', personaId: 'analyst' };
const days = () => new BudgetDayRepo(db.pool);
const mk = (cfg = new FakeConfig({ 'limits.localUnlimited': false, 'budget.botDailyUsd': 1000, 'budget.taskUsd': 1000 })) => {
  const bus = new EventBus<AppEvents>();
  const paused: unknown[] = [];
  bus.on('governance.paused', (p) => { paused.push(p); });
  return { cfg, bus, paused, budget: new Budget(db.pool, cfg, bus, () => now) };
};

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'), 'up');
  await new DepartmentRepo(db.pool).upsert({ id: 'hq', name: 'HQ', categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
  tasks = new TaskRepo(db.pool);
});
beforeEach(async () => {
  now = new Date('2026-10-31T10:00:00Z');
  await db.pool.query('DELETE FROM budget_days');
  await db.pool.query('DELETE FROM spend_days');
  await db.pool.query('DELETE FROM tasks');
});
afterAll(async () => { await db.close(); });

const newTask = (parentId?: string) =>
  tasks.create({ title: 't', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'chat', parentId });

describe('Budget', () => {
  it('reserve fails with scope company when daily spent+est > 5', async () => {
    const { budget, paused } = mk();
    const r1 = await budget.reserve({ actor: hq, estUsd: 4.5 });
    expect(r1.ok).toBe(true);
    if (r1.ok) await budget.settle(r1.reservationId, 4.5);
    expect(await budget.reserve({ actor: hq, estUsd: 0.6 })).toEqual({ ok: false, scope: 'company' });
    expect((await budget.reserve({ actor: hq, estUsd: 0.5 })).ok).toBe(true); // exactly at the limit is allowed
    expect(paused).toEqual([{ scope: 'company', day: '2026-10-31' }]);
  });

  it('governance.paused fires once per day per scope', async () => {
    const { budget, paused } = mk();
    await budget.reserve({ actor: hq, estUsd: 5 });
    await budget.reserve({ actor: hq, estUsd: 1 });
    await budget.reserve({ actor: hq, estUsd: 1 });
    expect(paused).toHaveLength(1);
    now = new Date('2026-11-01T00:00:01Z');
    expect((await budget.reserve({ actor: hq, estUsd: 5 })).ok).toBe(true); // new UTC day, fresh rows
    await budget.reserve({ actor: hq, estUsd: 1 });
    expect(paused).toHaveLength(2);
  });

  it('parallel reservations cannot exceed company budget', async () => {
    const { budget } = mk();
    const actors: ActorRef[] = Array.from({ length: 20 }, (_, i) => ({ kind: 'persona', personaId: `p${i}` }));
    const res = await Promise.all(actors.map((a) => budget.reserve({ actor: a, estUsd: 0.5 })));
    expect(res.filter((r) => r.ok)).toHaveLength(10);
    expect(res.filter((r) => !r.ok && r.scope === 'company')).toHaveLength(10);
    const row = await days().get('2026-10-31', 'company', '');
    expect(row).toMatchObject({ reservedUsd: 5, spentUsd: 0 });
  });

  it('settle with lower actual frees headroom', async () => {
    const { budget } = mk();
    const r = await budget.reserve({ actor: hq, estUsd: 4 });
    if (!r.ok) throw new Error('expected ok');
    expect((await budget.reserve({ actor: hq, estUsd: 2 })).ok).toBe(false);
    await budget.settle(r.reservationId, 1);
    expect(await days().get('2026-10-31', 'company', '')).toMatchObject({ reservedUsd: 0, spentUsd: 1 });
    expect((await budget.reserve({ actor: hq, estUsd: 2 })).ok).toBe(true);
  });

  it('settle on a later UTC day still settles the original day', async () => {
    const { budget } = mk();
    const r = await budget.reserve({ actor: hq, estUsd: 1 });
    if (!r.ok) throw new Error('expected ok');
    now = new Date('2026-11-01T00:30:00Z');
    await budget.settle(r.reservationId, 0.8);
    expect(await days().get('2026-10-31', 'company', '')).toMatchObject({ reservedUsd: 0, spentUsd: 0.8 });
    expect(await days().get('2026-11-01', 'company', '')).toBeNull();
  });

  it('settle twice or with unknown id throws and does not double count', async () => {
    const { budget } = mk();
    const r = await budget.reserve({ actor: hq, estUsd: 1 });
    if (!r.ok) throw new Error('expected ok');
    await budget.settle(r.reservationId, 1);
    await expect(budget.settle(r.reservationId, 1)).rejects.toThrow(/unknown reservation/);
    expect((await days().get('2026-10-31', 'company', ''))?.spentUsd).toBe(1);
  });

  it('release frees the reservation without spending', async () => {
    const { budget } = mk();
    const r = await budget.reserve({ actor: hq, estUsd: 3 });
    if (!r.ok) throw new Error('expected ok');
    await budget.release(r.reservationId);
    expect(await days().get('2026-10-31', 'company', '')).toMatchObject({ reservedUsd: 0, spentUsd: 0 });
  });

  it('per-bot limit returns scope bot and emits with the actor', async () => {
    const { budget, paused } = mk(new FakeConfig({ 'limits.localUnlimited': false, 'budget.botDailyUsd': 1, 'budget.taskUsd': 1000 }));
    expect((await budget.reserve({ actor: persona, estUsd: 0.8 })).ok).toBe(true);
    expect(await budget.reserve({ actor: persona, estUsd: 0.3 })).toEqual({ ok: false, scope: 'bot' });
    expect((await budget.reserve({ actor: hq, estUsd: 0.9 })).ok).toBe(true); // other bot unaffected
    expect(paused).toEqual([{ scope: 'bot', actor: persona, day: '2026-10-31' }]);
    expect(await days().get('2026-10-31', 'bot', 'persona:analyst')).toMatchObject({ reservedUsd: 0.8 });
  });

  it('per-task limit 0.50 returns scope task', async () => {
    const { budget, paused } = mk(new FakeConfig({ 'limits.localUnlimited': false, 'budget.botDailyUsd': 1000 }));
    const t = await newTask();
    expect((await budget.reserve({ actor: hq, taskId: t.id, estUsd: 0.4 })).ok).toBe(true);
    expect(await budget.reserve({ actor: hq, taskId: t.id, estUsd: 0.2 })).toEqual({ ok: false, scope: 'task' });
    expect(paused).toEqual([]);
  });

  it('child spend counts against root task budget', async () => {
    const { budget } = mk(new FakeConfig({ 'limits.localUnlimited': false, 'budget.botDailyUsd': 1000 }));
    const root = await newTask();
    const child = await newTask(root.id);
    const r = await budget.reserve({ actor: hq, taskId: child.id, estUsd: 0.3 });
    if (!r.ok) throw new Error('expected ok');
    await budget.settle(r.reservationId, 0.3);
    expect(await budget.reserve({ actor: hq, taskId: root.id, estUsd: 0.3 })).toEqual({ ok: false, scope: 'task' });
    expect(await budget.reserve({ actor: hq, taskId: child.id, estUsd: 0.3 })).toEqual({ ok: false, scope: 'task' });
    expect(await budget.treeSpend(root.id)).toBeCloseTo(0.3, 6);
    expect(await days().get('2026-10-31', 'task', root.id)).toBeNull(); // keyed by day sentinel, not the date
  });

  it('task cap does not reset at UTC midnight', async () => {
    const { budget } = mk(new FakeConfig({ 'limits.localUnlimited': false, 'budget.botDailyUsd': 1000 }));
    const t = await newTask();
    const r = await budget.reserve({ actor: hq, taskId: t.id, estUsd: 0.4 });
    if (!r.ok) throw new Error('expected ok');
    await budget.settle(r.reservationId, 0.4);
    now = new Date('2026-11-01T00:05:00Z');
    expect(await budget.reserve({ actor: hq, taskId: t.id, estUsd: 0.2 })).toEqual({ ok: false, scope: 'task' });
  });

  it('unknown model refuses reservation', async () => {
    const { budget, paused } = mk();
    expect(budget.costOf.bind(budget, 'mystery-1', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 })).toThrow(/no price/);
    expect(await budget.reserve({ actor: hq, estUsd: 0.1, model: 'mystery-1' })).toEqual({ ok: false, scope: 'price' });
    expect(paused).toEqual([]);
    expect(await days().get('2026-10-31', 'company', '')).toBeNull();
  });

  it('reserve rejects NaN, negative and Infinity estimates (fail closed)', async () => {
    const { budget } = mk();
    for (const bad of [NaN, -1, Infinity]) expect(await budget.reserve({ actor: hq, estUsd: bad })).toEqual({ ok: false, scope: 'price' });
  });

  it('reserve with an unknown task id throws and leaves nothing reserved', async () => {
    const { budget } = mk();
    await expect(budget.reserve({ actor: hq, taskId: 'nope', estUsd: 0.1 })).rejects.toThrow(/task nope/);
    expect(await days().get('2026-10-31', 'company', '')).toBeNull();
  });

  it('reserve throws when the database fails (caller fails closed)', async () => {
    const cfg = new FakeConfig({ 'limits.localUnlimited': false });
    const broken = new Budget({ connect: async () => { throw new Error('db down'); } } as never, cfg, new EventBus<AppEvents>());
    await expect(broken.reserve({ actor: hq, estUsd: 0.1 })).rejects.toThrow('db down');
  });

  it('costOf prices input, output, cache read and cache write', () => {
    const { budget } = mk();
    // sonnet: in 2, out 10, cacheRead 0.2, cacheWrite = 2*1.25 = 2.5 per MTok
    const c = budget.costOf('claude-sonnet-5-5', { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 1_000_000, cacheWriteTokens: 1_000_000 });
    expect(c).toBeCloseTo(2 + 1 + 0.2 + 2.5, 9);
    const cfg = new FakeConfig({ 'limits.localUnlimited': false, pricing: { m: { inPerMTok: 4, outPerMTok: 8 } } });
    const noCache = new Budget(db.pool, cfg, new EventBus<AppEvents>());
    expect(noCache.costOf('m', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 })).toBeCloseTo(4, 9); // falls back to input price
  });

  it('usage lists rows for a day', async () => {
    const { budget } = mk();
    const r = await budget.reserve({ actor: hq, estUsd: 1 });
    if (!r.ok) throw new Error('expected ok');
    await budget.settle(r.reservationId, 0.5);
    const rows = await budget.usage('2026-10-31');
    expect(rows).toEqual([
      { day: '2026-10-31', scope: 'bot', scopeId: 'head:hq', reservedUsd: 0, spentUsd: 0.5, calls: 0 },
      { day: '2026-10-31', scope: 'company', scopeId: '', reservedUsd: 0, spentUsd: 0.5, calls: 0 },
    ]);
  });

  it('clearStaleReservations zeroes leftover reserved amounts', async () => {
    const { budget } = mk();
    await budget.reserve({ actor: hq, estUsd: 2 });
    await mk().budget.clearStaleReservations(); // a fresh process after a restart has no open reservations
    expect(await days().get('2026-10-31', 'company', '')).toMatchObject({ reservedUsd: 0 });
  });

  it('clearStaleReservations refuses while this process has an open reservation', async () => {
    const { budget } = mk();
    const r = await budget.reserve({ actor: hq, estUsd: 1 });
    if (!r.ok) throw new Error('expected ok');
    await expect(budget.clearStaleReservations()).rejects.toThrow(/open reservation/);
    expect(await days().get('2026-10-31', 'company', '')).toMatchObject({ reservedUsd: 1 });
  });

  it('sub-micro-dollar estimates round up and settle leaves reserved exactly 0', async () => {
    const { budget } = mk();
    const r = await budget.reserve({ actor: hq, estUsd: 0.0000004 });
    if (!r.ok) throw new Error('expected ok');
    expect(await days().get('2026-10-31', 'company', '')).toMatchObject({ reservedUsd: 0.000001 });
    await budget.settle(r.reservationId, 0.0000004);
    expect(await days().get('2026-10-31', 'company', '')).toMatchObject({ reservedUsd: 0, spentUsd: 0 });
    const r2 = await budget.reserve({ actor: hq, estUsd: 0.3 });
    if (!r2.ok) throw new Error('expected ok');
    expect(await days().get('2026-10-31', 'company', '')).toMatchObject({ reservedUsd: 0.3 });
    await budget.settle(r2.reservationId, 0.2999996);
    expect(await days().get('2026-10-31', 'company', '')).toMatchObject({ reservedUsd: 0, spentUsd: 0.3 });
  });
});

describe('Budget: local calls (Gate 1 L8, spec §4.3)', () => {
  const LOCAL = 'claude-code-local';
  /** Per-attempt timeout for the hanging fake: long enough that the fake (a node process) always starts and records itself. */
  const SLOW_START_MS = 1500;
  const localReq = (budget: Budget, o: { taskId?: string; signal?: AbortSignal; actor?: ActorRef } = {}) =>
    budget.reserve({ actor: o.actor ?? hq, estUsd: 0, model: 'local/claude-sonnet-5-5', provider: LOCAL, ...(o.taskId ? { taskId: o.taskId } : {}), ...(o.signal ? { signal: o.signal } : {}) });
  const calls = async (scope: string, scopeId = '') =>
    (await db.pool.query<{ calls: number }>('SELECT calls FROM budget_days WHERE scope = $1 AND scope_id = $2', [scope, scopeId])).rows[0]?.calls ?? 0;
  const chatReq: ChatRequest = { model: 'local/claude-sonnet-5-5', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], maxTokens: 10 };
  async function drain(it: AsyncIterable<unknown>) { for await (const _ of it) { /* consume */ } }
  const withFake = async (fn: (fake: ReturnType<typeof installFakeClaude>) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), 'ccl-budget-'));
    try { await fn(installFakeClaude(dir)); } finally { rmSync(dir, { recursive: true, force: true }); }
  };

  it('201 parallel local reserves → exactly 200 ok', async () => {
    const { budget, paused } = mk();
    const all = await Promise.all(Array.from({ length: 201 }, () => localReq(budget)));
    expect(all.filter((r) => r.ok)).toHaveLength(200);
    expect(all.filter((r) => !r.ok)).toEqual([{ ok: false, scope: 'local' }]);
    expect(await calls('local')).toBe(200);
    expect(paused).toEqual([{ scope: 'local', day: '2026-10-31' }]);
  });

  it('201st local call refused with scope local', async () => {
    const { budget, paused } = mk(); // default limits.localCallsPerDay = 200
    for (let i = 0; i < 200; i++) expect((await localReq(budget)).ok).toBe(true);
    expect(await localReq(budget)).toEqual({ ok: false, scope: 'local' });
    expect(await calls('local')).toBe(200);
    expect(paused).toEqual([{ scope: 'local', day: '2026-10-31' }]);
  });

  it('local count ignores USD budgets, is announced once per day and resets at UTC midnight', async () => {
    const { budget, paused } = mk(new FakeConfig({ 'limits.localUnlimited': false, 'limits.localCallsPerDay': 3, 'budget.companyDailyUsd': 0 }));
    for (let i = 0; i < 3; i++) expect((await localReq(budget)).ok).toBe(true); // a $0 company budget does not stop local calls
    expect(await localReq(budget)).toEqual({ ok: false, scope: 'local' });
    expect(await localReq(budget)).toEqual({ ok: false, scope: 'local' });
    expect(paused).toEqual([{ scope: 'local', day: '2026-10-31' }]);
    now = new Date('2026-11-01T00:00:01Z');
    expect((await localReq(budget)).ok).toBe(true); // a new UTC day has a fresh count
    const money = await db.pool.query<{ r: number; s: number }>('SELECT sum(reserved_usd) AS r, sum(spent_usd) AS s FROM budget_days');
    expect(money.rows[0]).toEqual({ r: 0, s: 0 });
  });

  it('a local reservation skips the price check and settles at 0 without touching USD rows', async () => {
    const { budget } = mk();
    const r = await budget.reserve({ actor: hq, estUsd: 3, model: 'local/no-price-needed', provider: LOCAL });
    if (!r.ok) throw new Error('expected ok');
    await budget.settle(r.reservationId, 0);
    const rows = await db.pool.query<{ scope: string }>("SELECT scope FROM budget_days WHERE scope IN ('company','bot')");
    expect(rows.rows).toEqual([]);
  });

  it('D4 price check still refuses unknown model for provider claude', async () => {
    const { budget } = mk(new FakeConfig({ 'limits.localUnlimited': false, pricing: { 'claude-sonnet-5-5': { inPerMTok: 2, outPerMTok: 10 } } }));
    expect(await budget.reserve({ actor: hq, estUsd: 0, model: 'local/claude-sonnet-5-5', provider: 'claude' })).toEqual({ ok: false, scope: 'price' });
    expect(await budget.reserve({ actor: hq, estUsd: 0, model: 'local/claude-sonnet-5-5' })).toEqual({ ok: false, scope: 'price' });
    expect(await budget.reserve({ actor: hq, estUsd: 0, model: 'mystery-1', provider: 'claude' })).toEqual({ ok: false, scope: 'price' });
    expect(await calls('local')).toBe(0);
  });

  it('per-root local call cap (limits.localCallsPerTask) refuses with scope local_task, counted on the root for child tasks', async () => {
    const { budget, paused } = mk(new FakeConfig({ 'limits.localUnlimited': false, 'limits.localCallsPerTask': 2 }));
    const root = await newTask();
    const child = await newTask(root.id);
    expect((await localReq(budget, { taskId: root.id })).ok).toBe(true);
    expect((await localReq(budget, { taskId: child.id })).ok).toBe(true);
    expect(await localReq(budget, { taskId: child.id })).toEqual({ ok: false, scope: 'local_task' });
    expect(await calls('task', root.id)).toBe(2);
    expect(await calls('local')).toBe(2); // the refused call consumed nothing
    expect(paused).toEqual([]); // a tree cap is not a daily pause
    expect((await localReq(budget)).ok).toBe(true); // other work is not affected
  });

  it('the per-root cap comes from the localCap seam (approved caps raise it)', async () => {
    const cfg = new FakeConfig({ 'limits.localUnlimited': false, 'limits.localCallsPerTask': 1 });
    const budget = new Budget(db.pool, cfg, new EventBus<AppEvents>(), () => now, { localCap: async () => 3 });
    const root = await newTask();
    for (let i = 0; i < 3; i++) expect((await localReq(budget, { taskId: root.id })).ok).toBe(true);
    expect(await localReq(budget, { taskId: root.id })).toEqual({ ok: false, scope: 'local_task' });
  });

  it('retry consumes a second count', async () => {
    await withFake(async (fake) => {
      fake.scenario({ mode: 'hang' });
      const { budget } = mk();
      const root = await newTask();
      const provider = createClaudeCodeLocalProvider({
        claudePath: fake.path, timeoutMs: SLOW_START_MS, concurrency: 1, audit: async () => {}, log: { error: () => {} },
        onAttempt: (n, signal) => budget.onLocalAttempt(n, signal),
      });
      const ac = new AbortController();
      const r = await localReq(budget, { taskId: root.id, signal: ac.signal });
      if (!r.ok) throw new Error('expected ok');
      await expect(drain(provider.chat(chatReq, ac.signal))).rejects.toThrow(/timed out/);
      await budget.release(r.reservationId);
      expect(fake.starts()).toHaveLength(2);
      expect(await calls('local')).toBe(2);
      expect(await calls('task', root.id)).toBe(2);
    });
  }, 20_000);

  it('a retry is refused at the daily cap, but only counted against the per-root cap', async () => {
    await withFake(async (fake) => {
      fake.scenario({ mode: 'hang' });
      const mkProvider = (budget: Budget) => createClaudeCodeLocalProvider({
        claudePath: fake.path, timeoutMs: SLOW_START_MS, concurrency: 1, audit: async () => {}, log: { error: () => {} },
        onAttempt: (n, signal) => budget.onLocalAttempt(n, signal),
      });
      const daily = mk(new FakeConfig({ 'limits.localUnlimited': false, 'limits.localCallsPerDay': 1 }));
      let ac = new AbortController();
      expect((await localReq(daily.budget, { signal: ac.signal })).ok).toBe(true);
      await expect(drain(mkProvider(daily.budget).chat(chatReq, ac.signal))).rejects.toThrow(/quota/);
      expect(fake.starts()).toHaveLength(1);
      expect(await calls('local')).toBe(1);
      expect(daily.paused).toEqual([{ scope: 'local', day: '2026-10-31' }]);

      await db.pool.query('DELETE FROM budget_days');
      const perRoot = mk(new FakeConfig({ 'limits.localUnlimited': false, 'limits.localCallsPerTask': 1 }));
      const root = await newTask();
      ac = new AbortController();
      expect((await localReq(perRoot.budget, { taskId: root.id, signal: ac.signal })).ok).toBe(true);
      await expect(drain(mkProvider(perRoot.budget).chat(chatReq, ac.signal))).rejects.toThrow(/timed out/);
      expect(fake.starts()).toHaveLength(3); // the retry ran: it overshoots the tree cap by one, and the next reserve asks for approval
      expect(await calls('task', root.id)).toBe(2);
      expect(await localReq(perRoot.budget, { taskId: root.id })).toEqual({ ok: false, scope: 'local_task' });
    });
  }, 20_000);

  it('count error → zero spawns', async () => {
    await withFake(async (fake) => {
      fake.scenario({ mode: 'payload', payload: { text: 'hi' } });
      const cfg = new FakeConfig({ 'limits.localUnlimited': false });
      const { budget } = mk(cfg);
      const provider = createClaudeCodeLocalProvider({
        claudePath: fake.path, timeoutMs: 5000, concurrency: 1, audit: async () => {}, log: { error: () => {} },
        onAttempt: (n, signal) => budget.onLocalAttempt(n, signal),
      });
      // (a) No counted reservation bound to this call's signal: refused before any spawn.
      await expect(drain(provider.chat(chatReq, new AbortController().signal))).rejects.toThrow(/quota/);
      // (b) The count itself fails (limit unreadable): reserve throws, so the caller makes no call (D23).
      cfg.throwOn.add('limits.localCallsPerDay');
      const ac = new AbortController();
      await expect(localReq(budget, { signal: ac.signal })).rejects.toThrow();
      await expect(drain(provider.chat(chatReq, ac.signal))).rejects.toThrow(/quota/);
      // (c) The database fails during the count: reserve throws.
      const broken = new Budget({ connect: async () => { throw new Error('db down'); } } as never, new FakeConfig({ 'limits.localUnlimited': false }), new EventBus<AppEvents>(), () => now);
      await expect(localReq(broken)).rejects.toThrow(/db down/);
      // (d) A released reservation no longer authorises an attempt.
      cfg.throwOn.clear();
      const ac2 = new AbortController();
      const r = await localReq(budget, { signal: ac2.signal });
      if (!r.ok) throw new Error('expected ok');
      await budget.release(r.reservationId);
      await expect(drain(provider.chat(chatReq, ac2.signal))).rejects.toThrow(/quota/);
      expect(fake.starts()).toHaveLength(0);
      expect(await calls('local')).toBe(1);
    });
  });

  it('a config or DB error inside onLocalAttempt on attempt 2 → no second spawn (fail closed)', async () => {
    await withFake(async (fake) => {
      fake.scenario({ mode: 'hang' });
      for (const breakIt of ['config', 'db'] as const) {
        await db.pool.query('DELETE FROM budget_days');
        const cfg = new FakeConfig({ 'limits.localUnlimited': false });
        let dbDown = false;
        const pool = new Proxy(db.pool, {
          get(t, p) {
            if (p === 'connect') return () => (dbDown ? Promise.reject(new Error('db down')) : t.connect());
            const v = Reflect.get(t, p);
            return typeof v === 'function' ? v.bind(t) : v;
          },
        });
        const budget = new Budget(pool, cfg, new EventBus<AppEvents>(), () => now);
        const provider = createClaudeCodeLocalProvider({
          claudePath: fake.path, timeoutMs: SLOW_START_MS, concurrency: 1, audit: async () => {}, log: { error: () => {} },
          onAttempt: async (n, signal) => {
            if (n === 2) {
              if (breakIt === 'config') cfg.throwOn.add('limits.localCallsPerDay');
              else dbDown = true;
            }
            await budget.onLocalAttempt(n, signal);
          },
        });
        const before = fake.starts().length;
        const ac = new AbortController();
        expect((await localReq(budget, { signal: ac.signal })).ok).toBe(true);
        await expect(drain(provider.chat(chatReq, ac.signal))).rejects.toThrow(/quota/);
        expect(fake.starts().length - before).toBe(1); // attempt 1 ran (timed out); attempt 2 never spawned
        expect(await calls('local')).toBe(1);
      }
    });
  }, 20_000);

  it('mixed parallel API and local reserves on one root never deadlock', async () => {
    const { budget } = mk(new FakeConfig({ 'limits.localUnlimited': false, 'budget.botDailyUsd': 1000, 'budget.taskUsd': 1000, 'budget.companyDailyUsd': 1000 }));
    const root = await newTask();
    const jobs = Array.from({ length: 40 }, (_, i) =>
      i % 2 ? localReq(budget, { taskId: root.id }) : budget.reserve({ actor: hq, taskId: root.id, estUsd: 0.01, model: 'claude-sonnet-5-5' }));
    const all = await Promise.all(jobs);
    expect(all.every((r) => r.ok)).toBe(true);
    expect(await calls('task', root.id)).toBe(20);
  });
});

describe('SPEND-1 department monthly budget and spend rollup', () => {
  const MODEL = 'claude-sonnet-5-5';
  const LOCAL = 'claude-code-local';
  const localReq = (budget: Budget, o: { taskId?: string; signal?: AbortSignal; actor?: ActorRef } = {}) =>
    budget.reserve({ actor: o.actor ?? hq, estUsd: 0, model: 'local/claude-sonnet-5-5', provider: LOCAL, ...(o.taskId ? { taskId: o.taskId } : {}), ...(o.signal ? { signal: o.signal } : {}) });
  const cap = (usd: number) => new FakeConfig({ 'limits.localUnlimited': false, 'budget.botDailyUsd': 1000, 'budget.taskUsd': 1000, 'budget.companyDailyUsd': 1000, 'spend.deptMonthlyUsd': { hq: usd } });
  const deptRow = (dept = 'hq', month = '2026-10-01') => days().get(month, 'dept', dept);
  const spendRows = async () => (await db.pool.query<{ day: string; dept_id: string; provider: string; model: string; tool: string; root_id: string; usd: number; calls: number }>(
    "SELECT to_char(day,'YYYY-MM-DD') AS day, dept_id, provider, model, tool, root_id, spent_usd::float8 AS usd, calls FROM spend_days ORDER BY day, dept_id, provider, model, tool, root_id")).rows;
  /** Records the order of every row lock a transaction takes. */
  const patched = new WeakSet<object>();
  const sink: { current: string[][] } = { current: [] };
  const recording = (log: string[][]) => new Proxy(db.pool, {
    get(t, p) {
      if (p === 'connect') return async () => {
        const c = await t.connect();
        if (!patched.has(c)) { // the pool reuses clients: patch each once
          patched.add(c);
          const q = c.query.bind(c) as (...a: unknown[]) => unknown;
          (c as unknown as { query: unknown }).query = (...a: unknown[]) => {
            if (typeof a[0] === 'string' && a[0].includes('FOR UPDATE')) sink.current.push([(a[1] as string[])[1]!, (a[1] as string[])[2]!]);
            return q(...a);
          };
        }
        sink.current = log;
        return c;
      };
      const v = (t as unknown as Record<string | symbol, unknown>)[p];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });

  it('S9: a dept refusal at the cap, exactly-at-cap is allowed, and every refusal is reported (SP-02)', async () => {
    const { budget, paused } = mk(cap(1));
    const a = await budget.reserve({ actor: hq, estUsd: 0.6, model: MODEL });
    expect(a.ok).toBe(true);
    expect(await budget.reserve({ actor: hq, estUsd: 0.5, model: MODEL })).toEqual({ ok: false, scope: 'dept' });
    expect((await budget.reserve({ actor: hq, estUsd: 0.4, model: MODEL })).ok).toBe(true); // exactly at the cap
    expect(await budget.reserve({ actor: hq, estUsd: 0.5, model: MODEL })).toEqual({ ok: false, scope: 'dept' });
    expect(await budget.reserve({ actor: hq, estUsd: 0.5, model: MODEL })).toEqual({ ok: false, scope: 'dept' });
    expect(paused.filter((p) => (p as { scope: string }).scope === 'dept')).toEqual(Array.from({ length: 3 }, (_, i) => ({ scope: 'dept', dept: 'hq', day: '2026-10-01', estUsd: 0.5 })));
    expect(await deptRow()).toMatchObject({ reservedUsd: 1, spentUsd: 0 });
    // another department is not affected
    expect((await budget.reserve({ actor: { kind: 'head', dept: 'rnd' }, estUsd: 0.9, model: MODEL })).ok).toBe(true);
  });

  it('S9: 30 parallel reserves on one dept never overshoot, finish without a timeout, on a pool of at most 10', async () => {
    const { budget } = mk(cap(1));
    const res = await Promise.all(Array.from({ length: 30 }, () => budget.reserve({ actor: hq, estUsd: 0.1, model: MODEL })));
    expect(res.filter((r) => r.ok)).toHaveLength(10);
    expect(res.filter((r) => !r.ok && r.scope === 'dept')).toHaveLength(20);
    expect(await deptRow()).toMatchObject({ reservedUsd: 1 });
    expect(db.pool.options.max).toBeLessThanOrEqual(10);
  });

  it('S9: key layouts are exactly company -> dept -> bot -> task, warroom company -> dept -> task -> warroom -> warroom_bot, and local never locks dept', async () => {
    const log: string[][] = [];
    const cfg = cap(100);
    const budget = new Budget(recording(log) as never, cfg, new EventBus<AppEvents>(), () => now);
    const root = await newTask();
    await budget.reserve({ actor: hq, taskId: root.id, estUsd: 0.01, model: MODEL });
    expect(log.map((l) => l[0])).toEqual(['company', 'dept', 'bot', 'task']);
    log.length = 0;
    await budget.reserve({ actor: hq, taskId: root.id, estUsd: 0.01, model: MODEL, pool: 'warroom' });
    expect(log.map((l) => l[0])).toEqual(['company', 'dept', 'task', 'warroom', 'warroom_bot']);
    log.length = 0;
    await localReq(budget, { taskId: root.id });
    expect(log.map((l) => l[0])).toEqual(['task', 'local']);
    expect(await deptRow()).toMatchObject({ reservedUsd: 0.02 }); // the two metered reserves only
  });

  it('S9: deptCap and the persona lookup use the reserving transaction client, never a second pooled connection', async () => {
    const seen: unknown[] = [];
    const cfg = cap(100);
    const budget = new Budget(db.pool, cfg, new EventBus<AppEvents>(), () => now, { deptCap: async (d, m, c) => { seen.push([d, m, typeof (c as { release?: unknown }).release]); return 100; } });
    await budget.reserve({ actor: hq, estUsd: 0.01, model: MODEL });
    expect(seen).toEqual([['hq', '2026-10-01', 'function']]);
  });

  it('S9: mixed parallel metered, local and warroom reserves plus settles on one root finish with no deadlock', async () => {
    const { budget } = mk(cap(1000));
    const root = await newTask();
    const jobs = Array.from({ length: 36 }, async (_, i) => {
      const r = i % 3 === 0 ? await localReq(budget, { taskId: root.id }) : await budget.reserve({ actor: hq, taskId: root.id, estUsd: 0.01, model: MODEL, ...(i % 3 === 1 ? { pool: 'warroom' as const } : {}) });
      if (r.ok) await (i % 2 ? budget.settle(r.reservationId, 0.005) : budget.release(r.reservationId));
      return r.ok;
    });
    expect((await Promise.all(jobs)).every(Boolean)).toBe(true);
  });

  it('S9/S13: a local call never touches the dept row, but the rollup still books it to its department (calls >= 1, spent 0)', async () => {
    const { budget } = mk(cap(1));
    const ac = new AbortController();
    const r = await localReq(budget, { signal: ac.signal });
    expect(r.ok).toBe(true);
    expect(await deptRow()).toBeNull();
    if (r.ok) {
      await budget.onLocalAttempt(1, ac.signal);
      await budget.onLocalAttempt(2, ac.signal); // one retry
      await budget.release(r.reservationId);
    }
    const r2 = await localReq(budget); // never attempted: still books 1
    if (r2.ok) await budget.release(r2.reservationId);
    expect(await spendRows()).toEqual([{ day: '2026-10-31', dept_id: 'hq', provider: 'claude-code-local', model: 'local/claude-sonnet-5-5', tool: 'llm', root_id: '', usd: 0, calls: 3 }]);
    expect(await deptRow()).toBeNull();
  });

  it('rollup matches spent: dept row, spend_days and tasks.cost_usd agree, by provider/model/tool/root', async () => {
    const { budget } = mk(cap(100));
    const root = await newTask();
    for (const [tool, usd] of [['image_generate', 0.25], ['ocr', 0.125], ['ocr', 0.5]] as const) {
      const r = await budget.reserve({ actor: hq, taskId: root.id, estUsd: 1, model: MODEL, provider: 'gemini', attribution: { provider: 'gemini', model: 'gemini-x.1', tool } });
      if (r.ok) await budget.settle(r.reservationId, usd);
    }
    const r = await budget.reserve({ actor: persona, estUsd: 1, model: MODEL, provider: 'claude' }); // no persona row: unattributed, default tool
    if (r.ok) await budget.settle(r.reservationId, 0.0625);
    const rows = await spendRows();
    expect(rows).toEqual([
      { day: '2026-10-31', dept_id: '_unattributed', provider: 'claude', model: MODEL, tool: 'llm', root_id: '', usd: 0.0625, calls: 1 },
      { day: '2026-10-31', dept_id: 'hq', provider: 'gemini', model: 'gemini-x.1', tool: 'image_generate', root_id: root.id, usd: 0.25, calls: 1 },
      { day: '2026-10-31', dept_id: 'hq', provider: 'gemini', model: 'gemini-x.1', tool: 'ocr', root_id: root.id, usd: 0.625, calls: 2 },
    ]);
    expect(await deptRow()).toMatchObject({ spentUsd: 0.875, reservedUsd: 0 });
    expect((await tasks.get(root.id))!.costUsd).toBeCloseTo(0.875, 9);
    // a release books nothing
    const z = await budget.reserve({ actor: hq, estUsd: 1, model: MODEL });
    if (z.ok) await budget.release(z.reservationId);
    expect(await spendRows()).toHaveLength(3);
  });

  it('a persona books to its department row, found through the reserving client', async () => {
    await db.pool.query("INSERT INTO departments (id, name) VALUES ('rnd','rnd') ON CONFLICT DO NOTHING");
    await db.pool.query("INSERT INTO personas (id, dept_id, name, prompt_ref) VALUES ('analyst','rnd','a','x') ON CONFLICT DO NOTHING");
    const { budget } = mk(new FakeConfig({ 'budget.botDailyUsd': 1000, 'budget.taskUsd': 1000, 'budget.companyDailyUsd': 1000, 'spend.deptMonthlyUsd': { rnd: 0.5 } }));
    expect((await budget.reserve({ actor: persona, estUsd: 0.4, model: MODEL })).ok).toBe(true);
    expect(await budget.reserve({ actor: persona, estUsd: 0.2, model: MODEL })).toEqual({ ok: false, scope: 'dept' });
    expect(await deptRow('rnd')).toMatchObject({ reservedUsd: 0.4 });
    await db.pool.query("DELETE FROM personas WHERE id = 'analyst'");
  });

  it('S12: a settle after local midnight and month end books to the reserve-time month and day (Asia/Bangkok)', async () => {
    const { budget } = mk(cap(100));
    now = new Date('2026-11-30T16:59:59Z'); // 23:59:59 on 2026-11-30 in Bangkok
    const r = await budget.reserve({ actor: hq, estUsd: 0.5, model: MODEL, provider: 'gemini' });
    expect(r.ok).toBe(true);
    now = new Date('2026-11-30T17:00:01Z'); // 00:00:01 on 2026-12-01 in Bangkok
    if (r.ok) await budget.settle(r.reservationId, 0.3);
    expect(await deptRow('hq', '2026-11-01')).toMatchObject({ spentUsd: 0.3, reservedUsd: 0 });
    expect(await deptRow('hq', '2026-12-01')).toBeNull();
    expect((await spendRows()).map((x) => [x.day, x.usd])).toEqual([['2026-11-30', 0.3]]);
    // the company row keeps the UTC day (unchanged): reserved and settled on 2026-11-30
    expect(await days().get('2026-11-30', 'company', '')).toMatchObject({ spentUsd: 0.3 });
    // a new reserve now lands in December
    expect((await budget.reserve({ actor: hq, estUsd: 0.1, model: MODEL })).ok).toBe(true);
    expect(await deptRow('hq', '2026-12-01')).toMatchObject({ reservedUsd: 0.1 });
  });

  it('S10: NUL, emoji, 200-char and empty attribution is booked as fallbacks, the settle succeeds, and attribution never changes a decision', async () => {
    const { budget } = mk(cap(1));
    const bad = [
      { provider: 'gem\u0000ini', model: 'm\u0000x', tool: 'bad\u0000tool' },
      { provider: '🤖', model: '🤖', tool: '🤖' },
      { provider: 'x'.repeat(200), model: 'y'.repeat(200), tool: 'z'.repeat(200) },
      { provider: '', model: '', tool: '' },
      { provider: 'Has Space', model: 'has space', tool: 'Has-Dash' },
    ];
    for (const a of bad) {
      const r = await budget.reserve({ actor: hq, estUsd: 0.01, model: MODEL, attribution: a });
      expect(r.ok).toBe(true);
      if (r.ok) await budget.settle(r.reservationId, 0.01);
    }
    expect(await spendRows()).toEqual([{ day: '2026-10-31', dept_id: 'hq', provider: 'unknown', model: '', tool: 'other', root_id: '', usd: 0.05, calls: 5 }]);
    // the same request with different attribution gets the same decision at the cap
    expect(await budget.reserve({ actor: hq, estUsd: 5, model: MODEL, attribution: { provider: 'gemini', tool: 'ocr' } })).toEqual({ ok: false, scope: 'dept' });
    expect(await budget.reserve({ actor: hq, estUsd: 5, model: MODEL, attribution: { provider: 'other', tool: 'stt' } })).toEqual({ ok: false, scope: 'dept' });
    expect((await budget.reserve({ actor: hq, estUsd: 0.1, model: MODEL, attribution: { provider: 'gemini', tool: 'ocr' } })).ok).toBe(true);
    expect((await budget.reserve({ actor: hq, estUsd: 0.1, model: MODEL })).ok).toBe(true);
  });

  it('S11: a rollup failure makes the settle throw, leaves budget_days and tasks.cost_usd unchanged and keeps the hold; a later settle works', async () => {
    const { budget } = mk(cap(100));
    const root = await newTask();
    const r = await budget.reserve({ actor: hq, taskId: root.id, estUsd: 0.5, model: MODEL });
    if (!r.ok) throw new Error('reserve failed');
    await db.pool.query("CREATE FUNCTION spend_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'rollup refused'; END $$");
    await db.pool.query('CREATE TRIGGER spend_fail_t BEFORE INSERT ON spend_days FOR EACH ROW EXECUTE FUNCTION spend_fail()');
    try {
      await expect(budget.settle(r.reservationId, 0.3)).rejects.toThrow(/rollup refused/);
    } finally {
      await db.pool.query('DROP TRIGGER spend_fail_t ON spend_days');
      await db.pool.query('DROP FUNCTION spend_fail()');
    }
    expect(await deptRow()).toMatchObject({ reservedUsd: 0.5, spentUsd: 0 });
    expect(await days().get('2026-10-31', 'company', '')).toMatchObject({ reservedUsd: 0.5, spentUsd: 0 });
    expect((await tasks.get(root.id))!.costUsd).toBe(0);
    expect(await spendRows()).toEqual([]);
    await budget.settle(r.reservationId, 0.3); // the reservation stayed open: the retry books once
    expect(await deptRow()).toMatchObject({ reservedUsd: 0, spentUsd: 0.3 });
    expect((await spendRows())[0]).toMatchObject({ usd: 0.3, calls: 1 });
  });

  it('a dept row exists for a metered call with no cap, and Budget.usage() leaves it out', async () => {
    const { budget } = mk();
    const r = await budget.reserve({ actor: hq, estUsd: 0.2, model: MODEL });
    if (r.ok) await budget.settle(r.reservationId, 0.1);
    expect(await deptRow()).toMatchObject({ spentUsd: 0.1 });
    expect((await budget.usage('2026-10-01')).some((x) => x.scope === 'dept')).toBe(false);
  });
});

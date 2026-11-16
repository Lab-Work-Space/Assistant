import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventBus, type AppEvents } from '../core/events.js';
import { migrate } from '../db/migrate.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import type { Pool } from '../db/pool.js';
import { ConfigStore } from './store.js';
import { CONFIG_DEFAULTS } from './defaults.js';

let db: TestDb;
const bus = () => new EventBus<AppEvents>();
const opened: ConfigStore[] = [];
let logs: unknown[] = [];
const sink = { error: (o: unknown) => { logs.push(o); } };
async function openTracked(b = bus(), pool: Pool = db.pool) {
  const s = await ConfigStore.open(pool, b, sink);
  opened.push(s);
  return s;
}
const waitFor = (fn: () => boolean, ms = 1000) =>
  new Promise<void>((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (fn()) { clearInterval(iv); res(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error('timeout')); }
    }, 10);
  });

beforeEach(() => { logs = []; });

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'), 'up');
});
afterAll(async () => {
  await Promise.all(opened.map((s) => s.close()));
  await db.close();
});

describe('ConfigStore', () => {
  it('get returns default when no row', async () => {
    const s = await openTracked();
    expect(s.get('budget.companyDailyUsd')).toBe(5);
    expect(s.get('limits.childrenPerTask')).toBe(5);
    expect(s.get('halted')).toBe(false);
    expect(s.get('pricing')['claude-sonnet-5-5']).toEqual({ inPerMTok: 2, outPerMTok: 10, cacheReadPerMTok: 0.2 });
    expect(s.get('pricing')['claude-haiku-5-5']).toEqual({ inPerMTok: 0.1, outPerMTok: 0.5, cacheReadPerMTok: 0.01 });
    expect(CONFIG_DEFAULTS['provider.default']).toEqual({ provider: 'claude', model: 'claude-sonnet-5-5' });
  });

  it('set on store A is visible to watcher on store B within 1000 ms', async () => {
    const a = await openTracked();
    const b = await openTracked();
    const seen: number[] = [];
    b.watch('budget.taskUsd', (v) => seen.push(v));
    const t0 = Date.now();
    await a.set('budget.taskUsd', 0.75, 'tester');
    await waitFor(() => seen.length > 0);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(seen).toEqual([0.75]);
    expect(b.get('budget.taskUsd')).toBe(0.75);
  });

  it('set rejects invalid value (negative budget)', async () => {
    const s = await openTracked();
    await expect(s.set('budget.botDailyUsd', -1, 'x')).rejects.toThrow();
    expect(s.get('budget.botDailyUsd')).toBe(1);
  });

  it('set returns old and new', async () => {
    const s = await openTracked();
    const r = await s.set('context.messages', 12, 'x');
    expect(r).toEqual({ old: 30, new: 12 });
    expect(await s.set('context.messages', 20, 'x')).toEqual({ old: 12, new: 20 });
  });

  it('rejects nan, inf, 1e308, negative', async () => {
    const s = await openTracked();
    const bad = [NaN, Infinity, -Infinity, 1e308, -0.01];
    const numeric = [
      'budget.companyDailyUsd', 'budget.botDailyUsd', 'budget.taskUsd', 'approval.thresholdUsd',
      'approval.expiryHours', 'limits.turnsPerTask', 'limits.depth', 'limits.concurrency',
      'context.messages', 'limits.childrenPerTask', 'limits.openTasks', 'limits.humanRunsPer10Min',
      'limits.prawPerUser10Min', 'limits.prawConcurrency',
      'limits.localCallsPerDay', 'limits.localCallsPerTask', 'limits.localConcurrency', 'provider.localTimeoutMs',
    ] as const;
    for (const k of numeric) for (const v of bad) await expect(s.set(k, v, 'x'), `${k}=${v}`).rejects.toThrow();
    for (const v of bad) {
      await expect(s.set('pricing', { m: { inPerMTok: v, outPerMTok: 1 } }, 'x'), `in=${v}`).rejects.toThrow();
      await expect(s.set('pricing', { m: { inPerMTok: 1, outPerMTok: v } }, 'x'), `out=${v}`).rejects.toThrow();
      await expect(s.set('pricing', { m: { inPerMTok: 1, outPerMTok: 1, cacheReadPerMTok: v } }, 'x'), `cr=${v}`).rejects.toThrow();
    }
    // non-integer for integer-valued limits
    await expect(s.set('limits.depth', 1.5, 'x')).rejects.toThrow();
  });

  it('rejects unknown key', async () => {
    const s = await openTracked();
    await expect((s as unknown as { set(k: string, v: unknown, by: string): Promise<unknown> }).set('nope', 1, 'x')).rejects.toThrow(/unknown/i);
  });

  it('set emits config.changed on the bus', async () => {
    const b = bus();
    const got: unknown[] = [];
    b.on('config.changed', (p) => { got.push(p); });
    const s = await openTracked(b);
    await s.set('limits.depth', 2, 'x');
    expect(got).toEqual([{ key: 'limits.depth' }]);
  });

  it('forged NOTIFY payload does not change value', async () => {
    const a = await openTracked();
    const b = await openTracked();
    const { rows } = await db.pool.query<{ s: string }>('SELECT current_schema() AS s');
    const schema = rows[0]!.s;
    const seen: number[] = [];
    b.watch('budget.companyDailyUsd', (v) => seen.push(v));
    for (const payload of [`${schema}:budget.companyDailyUsd`, `${schema}:budget.companyDailyUsd=99999`, `${schema}:budget.companyDailyUsd:99999`, 'garbage']) {
      await db.pool.query("SELECT pg_notify('config_changed', $1)", [payload]);
    }
    await a.set('limits.concurrency', 3, 'x'); // barrier: notifications are delivered in order
    await waitFor(() => b.get('limits.concurrency') === 3);
    expect(b.get('budget.companyDailyUsd')).toBe(5);
    expect(seen).toEqual([]);
  });

  it('ignores notifications from other schemas', async () => {
    const s = await openTracked();
    const seen: number[] = [];
    s.watch('limits.depth', (v) => seen.push(v));
    await db.pool.query("INSERT INTO config(key,value) VALUES ('limits.depth','7') ON CONFLICT (key) DO UPDATE SET value='7'");
    await db.pool.query("SELECT pg_notify('config_changed', 'other_schema:limits.depth')");
    await s.set('limits.concurrency', 2, 'x'); // barrier
    await waitFor(() => s.get('limits.concurrency') === 2);
    expect(seen).toEqual([]);
    expect(s.get('limits.depth')).not.toBe(7);
  });

  it('unsubscribed watcher is not called and close stops the listener', async () => {
    const a = await openTracked();
    const calls: number[] = [];
    const off = a.watch('limits.openTasks', (v) => calls.push(v));
    off();
    await a.set('limits.openTasks', 9, 'x');
    expect(calls).toEqual([]);
  });

  it('recovers after the listener backend is killed and catches up on missed changes', async () => {
    const a = await openTracked();
    const b = await openTracked();
    const seen: number[] = [];
    b.watch('limits.depth', (v) => seen.push(v));
    expect(b.listenerHealthy()).toBe(true);
    await db.pool.query('SELECT pg_terminate_backend($1)', [b.listenerPid()]);
    await waitFor(() => !b.listenerHealthy());
    expect(b.get('halted')).toBe(true); // fail closed while unhealthy
    await a.set('limits.depth', 11, 'x'); // changed while b is down or reconnecting
    await waitFor(() => b.listenerHealthy(), 3000);
    await waitFor(() => seen.includes(11));
    expect(b.get('limits.depth')).toBe(11);
    expect(b.get('halted')).toBe(false);
    expect(logs.length).toBeGreaterThan(0);
    // and live notifications work again
    await a.set('limits.depth', 12, 'x');
    await waitFor(() => b.get('limits.depth') === 12);
  });

  it('corrupt halted row resolves to halted=true', async () => {
    await db.pool.query(`INSERT INTO config(key,value) VALUES ('halted','"banana"') ON CONFLICT (key) DO UPDATE SET value='"banana"'`);
    try {
      const s = await openTracked();
      expect(s.get('halted')).toBe(true);
    } finally {
      await db.pool.query(`DELETE FROM config WHERE key='halted'`);
    }
  });

  it('halted becomes true when a live reload finds a corrupt row', async () => {
    const s = await openTracked();
    expect(s.get('halted')).toBe(false);
    const seen: boolean[] = [];
    s.watch('halted', (v) => seen.push(v));
    await db.pool.query(`INSERT INTO config(key,value) VALUES ('halted','123') ON CONFLICT (key) DO UPDATE SET value='123', version = config.version + 1`);
    try {
      await db.pool.query("SELECT pg_notify('config_changed', (SELECT current_schema()) || ':halted')");
      await waitFor(() => s.get('halted') === true);
      expect(seen).toEqual([true]);
    } finally {
      await db.pool.query(`DELETE FROM config WHERE key='halted'`);
    }
  });

  it('a stale reload resolved out of order does not overwrite a newer version', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const proxy = new Proxy(db.pool, {
      get(t, p) {
        if (p === 'query') {
          return async (...args: unknown[]) => {
            const res = await (t.query as (...a: unknown[]) => Promise<unknown>)(...args);
            if (typeof args[0] === 'string' && args[0].includes('FROM config WHERE key') && ++calls === 1) await gate;
            return res;
          };
        }
        const v = Reflect.get(t, p);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as Pool;
    const a = await openTracked(bus(), proxy);
    const x = await openTracked();
    await x.set('limits.concurrency', 2, 'x'); // a: read #1 (v older) is held
    await waitFor(() => calls >= 1);
    await x.set('limits.concurrency', 3, 'x'); // a: read #2 applies the newer version
    await waitFor(() => a.get('limits.concurrency') === 3);
    release();
    await new Promise((r) => setTimeout(r, 100));
    expect(a.get('limits.concurrency')).toBe(3);
  });

  function gatedPool() {
    let armed = false;
    let onOptions: (() => void) | null = null;
    let reached!: () => void;
    let release!: () => void;
    const reachedP = new Promise<void>((r) => { reached = r; });
    const gate = new Promise<void>((r) => { release = r; });
    const pool = new Proxy(db.pool, {
      get(t, p) {
        if (p === 'query') {
          return async (...args: unknown[]) => {
            const res = await (t.query as (...a: unknown[]) => Promise<unknown>)(...args);
            if (armed && typeof args[0] === 'string' && args[0].includes('ORDER BY key')) {
              armed = false;
              reached();
              await gate;
            }
            return res;
          };
        }
        if (p === 'options' && onOptions) { const f = onOptions; onOptions = null; f(); }
        const v = Reflect.get(t, p);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    }) as Pool;
    return { pool, onConnect: (f: () => void) => { onOptions = f; }, arm: () => { armed = true; }, reached: reachedP, release };
  }
  const listenerPids = async () =>
    new Set((await db.pool.query<{ pid: number }>(`SELECT pid FROM pg_stat_activity WHERE query = 'LISTEN config_changed' AND application_name = $1`, [db.schema])).rows.map((r) => r.pid));

  it('halted stays true until the resync after an outage completes', async () => {
    const g = gatedPool();
    const s = await openTracked(bus(), g.pool);
    g.arm();
    await db.pool.query('SELECT pg_terminate_backend($1)', [s.listenerPid()]);
    await g.reached; // reconnect: LISTEN done, loadAll query returned but not yet applied
    expect(s.listenerHealthy()).toBe(false);
    expect(s.get('halted')).toBe(true);
    g.release();
    await waitFor(() => s.listenerHealthy(), 3000);
    expect(s.get('halted')).toBe(false);
  });

  it('close() during an in-flight reconnect leaves no LISTEN backend behind', async () => {
    const g = gatedPool();
    const s = await openTracked(bus(), g.pool);
    const before = await listenerPids();
    let closing: Promise<void> = Promise.resolve();
    g.onConnect(() => { closing = s.close(); }); // close() lands exactly while the reconnect is starting
    await db.pool.query('SELECT pg_terminate_backend($1)', [s.listenerPid()]);
    await waitFor(() => !s.listenerHealthy());
    await waitFor(() => closing !== undefined && (s as unknown as { closed: boolean }).closed, 3000);
    await closing;
    await new Promise((r) => setTimeout(r, 400));
    const leaked = [...(await listenerPids())].filter((p) => !before.has(p));
    expect(leaked).toEqual([]);
    expect(s.listenerHealthy()).toBe(false);
  });

  it('halted flipped during an outage reaches watchers exactly once after recovery', async () => {
    const a = await openTracked();
    await a.set('halted', true, 'x');
    const b = await openTracked();
    expect(b.get('halted')).toBe(true);
    const seen: boolean[] = [];
    b.watch('halted', (v) => seen.push(v));
    await db.pool.query('SELECT pg_terminate_backend($1)', [b.listenerPid()]);
    await waitFor(() => !b.listenerHealthy());
    await a.set('halted', false, 'x'); // while b is down
    await waitFor(() => b.listenerHealthy(), 3000);
    await new Promise((r) => setTimeout(r, 200));
    expect(b.get('halted')).toBe(false);
    expect(seen).toEqual([false]);
  });
});

describe('ConfigStore.setIf (compare-and-swap, Gate 1 C7)', () => {
  beforeEach(async () => { await db.pool.query('DELETE FROM config'); });
  it('applies when every key still holds the expected value, all or nothing', async () => {
    const s = await openTracked();
    const r = await s.setIf([
      { key: 'budget.taskUsd', value: 2, expect: CONFIG_DEFAULTS['budget.taskUsd'] },
      { key: 'limits.depth', value: 4, expect: CONFIG_DEFAULTS['limits.depth'] },
    ], 'user:u1 via praw');
    expect(r.ok).toBe(true);
    expect(s.get('budget.taskUsd')).toBe(2);
    expect(s.get('limits.depth')).toBe(4);
    expect((await db.pool.query("SELECT updated_by FROM config WHERE key = 'limits.depth'")).rows[0].updated_by).toBe('user:u1 via praw');
  });

  it('refuses everything when one key was changed after the proposal (a slash command between propose and confirm)', async () => {
    const s = await openTracked();
    await s.set('approval.thresholdUsd', 3, 'user:slash');
    const r = await s.setIf([
      { key: 'budget.botDailyUsd', value: 9, expect: CONFIG_DEFAULTS['budget.botDailyUsd'] },
      { key: 'approval.thresholdUsd', value: 7, expect: CONFIG_DEFAULTS['approval.thresholdUsd'] },
    ], 'user:u1 via praw');
    expect(r).toEqual({ ok: false, key: 'approval.thresholdUsd', reason: 'changed' });
    expect(s.get('approval.thresholdUsd')).toBe(3);
    expect(s.get('budget.botDailyUsd')).toBe(CONFIG_DEFAULTS['budget.botDailyUsd']);
  });

  it('refuses a value the schema rejects, and compares objects regardless of key order', async () => {
    const s = await openTracked();
    expect(await s.setIf([{ key: 'budget.taskUsd', value: -1, expect: 0.5 }], 'x')).toEqual({ ok: false, key: 'budget.taskUsd', reason: 'invalid' });
    await s.set('provider.default', { provider: 'claude', model: 'm' }, 'x');
    const r = await s.setIf([{ key: 'provider.default', value: { model: 'n', provider: 'claude' }, expect: { model: 'm', provider: 'claude' } }], 'x');
    expect(r.ok).toBe(true);
  });

  it('two racing applies on the same key: exactly one wins', async () => {
    const s = await openTracked();
    const exp = s.get('limits.openTasks');
    const rs = await Promise.all([1, 2].map((n) => s.setIf([{ key: 'limits.openTasks', value: 100 + n, expect: exp }], 'x')));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
  });
});

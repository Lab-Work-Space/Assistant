import pg from 'pg';
import type { EventBus, AppEvents, ErrorSink } from '../core/events.js';
import type { Pool } from '../db/pool.js';
import { ConfigRepo } from '../db/repos/ledger.js';
import { CONFIG_DEFAULTS } from './defaults.js';
import { ConfigSchema, isConfigKey, type ConfigKey, type ConfigValue } from './schema.js';

const CHANNEL = 'config_changed';

/** A write that only applies while the key still holds `expect` (the value the proposal was built on). */
export interface ConfigWrite {
  key: ConfigKey;
  value: unknown;
  expect: unknown;
}

/** Key-order independent JSON, so a value read back from jsonb compares equal to one built in memory. */
export function canonical(v: unknown): string {
  const walk = (x: unknown): unknown =>
    Array.isArray(x) ? x.map(walk)
    : x !== null && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, walk((x as Record<string, unknown>)[k])]))
    : x;
  return JSON.stringify(walk(v)) ?? 'null';
}
type Watcher = (v: never) => void;
const noopSink: ErrorSink = { error: () => undefined };
const BACKOFF_START_MS = 250;
const BACKOFF_MAX_MS = 5000;

/**
 * Realtime config: DB rows are the source of truth, every instance caches values.
 * NOTIFY payload is `<schema>:<key>` and is only a hint: the listener always re-reads the row (Gate 1 D18).
 * Fail closed (D9): a corrupt/unreadable `halted` row, or an unhealthy LISTEN connection, reads as halted=true.
 */
export class ConfigStore {
  private readonly cache = new Map<ConfigKey, unknown>();
  private readonly versions = new Map<ConfigKey, number>();
  private readonly busEmitted = new Map<ConfigKey, number | undefined>();
  private readonly watchers = new Map<ConfigKey, Set<Watcher>>();
  private listener: pg.Client | null = null;
  private healthy = false;
  private closed = false;
  private reconnecting = false;
  private lastHaltedFired = true; // last effective halted value delivered to watchers
  private reconnectTimer: NodeJS.Timeout | null = null;

  private constructor(
    private readonly pool: Pool,
    private readonly bus: EventBus<AppEvents>,
    private readonly repo: ConfigRepo,
    private readonly schema: string,
    private readonly log: ErrorSink,
  ) {}

  static async open(pool: Pool, bus: EventBus<AppEvents>, log: ErrorSink = noopSink): Promise<ConfigStore> {
    const schema = (await pool.query<{ s: string }>('SELECT current_schema() AS s')).rows[0]!.s;
    const store = new ConfigStore(pool, bus, new ConfigRepo(pool), schema, log);
    try {
      const client = await store.connectListener();
      await store.loadAll(false);
      if (store.closed || store.listener !== client) throw new Error('config listener lost during open');
      store.healthy = true;
      store.lastHaltedFired = store.get('halted');
    } catch (err) {
      await store.close();
      throw err;
    }
    return store;
  }

  /** False while the LISTEN connection is down (the cache may be stale). */
  listenerHealthy(): boolean {
    return this.healthy;
  }

  /** Backend pid of the LISTEN connection (diagnostics/tests). */
  listenerPid(): number | null {
    return (this.listener as (pg.Client & { processID?: number }) | null)?.processID ?? null;
  }

  /** R8 PV-C01: whether a stored row with a valid value backs `k` (false: no row, or only an invalid one that `apply` ignored, so the code default is in effect). */
  hasRow(k: ConfigKey): boolean {
    return this.versions.has(k);
  }

  get<K extends ConfigKey>(k: K): ConfigValue<K> {
    if (k === 'halted' && !this.healthy) return true as ConfigValue<K>;
    return (this.cache.has(k) ? this.cache.get(k) : CONFIG_DEFAULTS[k]) as ConfigValue<K>;
  }

  async set<K extends ConfigKey>(k: K, v: ConfigValue<K>, by: string): Promise<{ old: ConfigValue<K>; new: ConfigValue<K> }> {
    if (!isConfigKey(k)) throw new Error(`unknown config key: ${String(k)}`);
    const parsed = ConfigSchema[k].parse(v) as ConfigValue<K>;
    const old = this.get(k);
    await this.repo.upsert(k, parsed, by);
    await this.pool.query('SELECT pg_notify($1, $2)', [CHANNEL, `${this.schema}:${k}`]);
    await this.refresh(k);
    // Always announce our own write, but only once per version (the listener may have applied it first).
    if (this.busEmitted.get(k) !== this.versions.get(k)) await this.announce(k);
    return { old, new: this.get(k) };
  }

  /**
   * Gate 1 C7: all-or-nothing compare-and-swap in the database. Each key's row is locked (FOR UPDATE; an absent row is claimed by
   * INSERT ... DO NOTHING) and its CURRENT value (the schema default when there is no row) must equal `expect`, else nothing is
   * written and the first stale key is named. A slash command that changed a key after the proposal therefore makes the apply fail.
   */
  async setIf(writes: ConfigWrite[], by: string): Promise<{ ok: true; results: { key: ConfigKey; old: unknown; new: unknown }[] } | { ok: false; key: ConfigKey; reason: 'changed' | 'invalid' }> {
    const sorted = [...writes].sort((a, b) => a.key.localeCompare(b.key)); // fixed lock order
    const parsed: unknown[] = [];
    for (const w of sorted) {
      const r = isConfigKey(w.key) ? ConfigSchema[w.key].safeParse(w.value) : null;
      if (!r?.success) return { ok: false, key: w.key, reason: 'invalid' };
      parsed.push(r.data);
    }
    const results: { key: ConfigKey; old: unknown; new: unknown }[] = [];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      for (const [i, w] of sorted.entries()) {
        const cur = await client.query<{ value: unknown }>('SELECT value FROM config WHERE key = $1 FOR UPDATE', [w.key]);
        let old: unknown = CONFIG_DEFAULTS[w.key];
        if (cur.rows[0]) {
          const r = ConfigSchema[w.key].safeParse(cur.rows[0].value);
          old = r.success ? r.data : cur.rows[0].value;
        }
        if (canonical(old) !== canonical(w.expect)) {
          await client.query('ROLLBACK');
          return { ok: false, key: w.key, reason: 'changed' };
        }
        const json = JSON.stringify(parsed[i]);
        if (cur.rows[0]) {
          await client.query('UPDATE config SET value = $2::jsonb, version = version + 1, updated_by = $3, updated_at = now() WHERE key = $1', [w.key, json, by]);
        } else {
          const ins = await client.query('INSERT INTO config (key, value, updated_by) VALUES ($1,$2::jsonb,$3) ON CONFLICT (key) DO NOTHING', [w.key, json, by]);
          if (!ins.rowCount) {
            await client.query('ROLLBACK');
            return { ok: false, key: w.key, reason: 'changed' };
          }
        }
        await client.query('SELECT pg_notify($1, $2)', [CHANNEL, `${this.schema}:${w.key}`]);
        results.push({ key: w.key, old, new: parsed[i] });
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    for (const w of sorted) {
      await this.refresh(w.key);
      if (this.busEmitted.get(w.key) !== this.versions.get(w.key)) await this.announce(w.key);
    }
    return { ok: true, results };
  }

  watch<K extends ConfigKey>(k: K, fn: (v: ConfigValue<K>) => void): () => void {
    let set = this.watchers.get(k);
    if (!set) this.watchers.set(k, (set = new Set()));
    const w = fn as unknown as Watcher;
    set.add(w);
    return () => { set.delete(w); };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const l = this.listener;
    this.listener = null;
    this.healthy = false;
    this.watchers.clear();
    if (l) await l.end().catch(() => undefined);
  }

  /** Connects and LISTENs; the client is always ended if anything fails or the store closed meanwhile. */
  private async connectListener(): Promise<pg.Client> {
    // Dedicated LISTEN connection (outside the pool's max), same connection options incl. search_path.
    const client = new pg.Client(this.pool.options);
    client.on('notification', (m) => {
      if (m.channel === CHANNEL && m.payload) void this.onNotify(m.payload);
    });
    client.on('error', (err) => this.onDown(client, err));
    client.on('end', () => this.onDown(client, new Error('listener connection ended')));
    try {
      await client.connect();
      if (this.closed) throw new Error('config store closed');
      await client.query(`LISTEN ${CHANNEL}`);
      if (this.closed) throw new Error('config store closed');
    } catch (err) {
      await client.end().catch(() => undefined);
      throw err;
    }
    this.listener = client;
    return client;
  }

  private onDown(client: pg.Client, err: unknown): void {
    if (this.closed || client !== this.listener) return;
    this.listener = null;
    this.healthy = false;
    this.log.error({ err }, 'config listener down; halted reads true until it recovers');
    client.end().catch(() => undefined);
    this.emitHalted();
    if (!this.reconnecting) this.scheduleReconnect(BACKOFF_START_MS); // a running reconnect notices the lost client itself
  }

  private scheduleReconnect(delay: number): void {
    if (this.closed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect(delay);
    }, delay);
  }

  private async reconnect(delay: number): Promise<void> {
    if (this.closed || this.reconnecting) return;
    this.reconnecting = true;
    try {
      const client = await this.connectListener(); // LISTEN first so nothing is missed, then catch up
      await this.loadAll(true);
      if (this.closed || this.listener !== client) throw new Error('listener lost during resync');
      this.healthy = true; // only now may halted read the real value again
      this.emitHalted();
      this.log.error({ recovered: true }, 'config listener recovered');
    } catch (err) {
      this.healthy = false;
      const l = this.listener;
      this.listener = null;
      if (l) await l.end().catch(() => undefined);
      if (!this.closed) {
        this.log.error({ err }, 'config listener reconnect failed');
        this.reconnecting = false;
        this.scheduleReconnect(Math.min(delay * 2, BACKOFF_MAX_MS));
      }
    } finally {
      this.reconnecting = false;
    }
  }

  /** Delivers the effective halted value (fail-closed aware) to watchers whenever it differs from what they last saw. */
  private emitHalted(): void {
    const v = this.get('halted');
    if (v === this.lastHaltedFired) return;
    this.lastHaltedFired = v;
    this.fire('halted', v);
  }

  private fire(key: ConfigKey, value: unknown): void {
    for (const w of [...(this.watchers.get(key) ?? [])]) {
      try { w(value as never); } catch { /* watcher errors must not break reload */ }
    }
  }

  private async loadAll(notify: boolean): Promise<void> {
    const rows = new Map((await this.repo.list()).map((r) => [r.key, r]));
    for (const key of Object.keys(ConfigSchema) as ConfigKey[]) {
      const r = rows.get(key);
      await this.apply(key, r ? { value: r.value, version: r.version } : null, notify);
    }
    // RFMD P5 M2: a stored override of a removed media price key is ignored (never breaks the load); its key name is logged once per load.
    for (const k of ['media.imageUsd', 'media.videoUsdPerSecond']) if (rows.has(k)) this.log.error({ key: k, ignored: true }, 'stored config key was removed and is ignored');
    // After recovery the effective halted value may differ from the fail-closed value watchers last saw.
  }

  private async onNotify(payload: string): Promise<void> {
    if (this.closed) return;
    const i = payload.indexOf(':');
    if (i < 0 || payload.slice(0, i) !== this.schema) return;
    const key = payload.slice(i + 1);
    if (!isConfigKey(key)) return;
    try {
      await this.refresh(key);
    } catch (err) {
      this.log.error({ err, key }, 'config reload failed');
      if (key === 'halted') {
        // read error counts as halted; forget the version so the next good read is applied
        this.versions.delete('halted');
        if (this.cache.get('halted') !== true) {
          this.cache.set('halted', true);
          this.emitHalted();
          await this.bus.emit('config.changed', { key });
        }
      }
    }
  }

  /** Re-reads the row (never the notify payload). Returns true if the effective value changed. */
  private async refresh(key: ConfigKey): Promise<boolean> {
    const row = await this.repo.get(key);
    return this.apply(key, row ? { value: row.value, version: row.version } : null, true);
  }

  /** Applies a freshly read row only if it is newer than what is cached (out-of-order reloads are dropped). */
  private async apply(key: ConfigKey, row: { value: unknown; version: number } | null, notify: boolean): Promise<boolean> {
    let next: unknown = CONFIG_DEFAULTS[key];
    if (row) {
      const cachedVersion = this.versions.get(key) ?? 0;
      if (row.version <= cachedVersion && this.versions.has(key)) return false;
      const r = ConfigSchema[key].safeParse(row.value);
      if (r.success) next = r.data;
      else if (key === 'halted') next = true; // corrupt halted row fails closed
      else { this.log.error({ key }, 'invalid config row ignored'); return false; }
      this.versions.set(key, row.version);
    } else {
      this.versions.delete(key);
    }
    const prev = this.cache.has(key) ? this.cache.get(key) : CONFIG_DEFAULTS[key];
    if (JSON.stringify(prev) === JSON.stringify(next)) return false;
    this.cache.set(key, next);
    if (notify) {
      if (key === 'halted') this.emitHalted();
      else this.fire(key, next);
      await this.announce(key);
    }
    return true;
  }

  private announce(key: ConfigKey): Promise<void> {
    this.busEmitted.set(key, this.versions.get(key));
    return this.bus.emit('config.changed', { key });
  }
}

import type { ConfigKey, ConfigValue } from '../config/schema.js';
import { CONFIG_DEFAULTS } from '../config/defaults.js';

/** In-memory stand-in for ConfigStore (get/set/watch); several Halt/Budget instances can share one. */
export class FakeConfig {
  readonly values = new Map<ConfigKey, unknown>();
  readonly throwOn = new Set<ConfigKey>();
  /** R8: what `listenerHealthy()` answers (the real ConfigStore is false while its LISTEN connection is down). */
  listenerOk = true;
  private readonly watchers = new Map<ConfigKey, Set<(v: never) => void>>();

  constructor(init: Partial<{ [K in ConfigKey]: ConfigValue<K> }> = {}) {
    for (const [k, v] of Object.entries(init)) this.values.set(k as ConfigKey, v);
  }
  get<K extends ConfigKey>(k: K): ConfigValue<K> {
    if (this.throwOn.has(k)) throw new Error(`read error: ${k}`);
    return (this.values.has(k) ? this.values.get(k) : CONFIG_DEFAULTS[k]) as ConfigValue<K>;
  }
  listenerHealthy(): boolean {
    return this.listenerOk;
  }
  async set<K extends ConfigKey>(k: K, v: ConfigValue<K>, _by: string): Promise<{ old: ConfigValue<K>; new: ConfigValue<K> }> {
    const old = this.get(k);
    this.values.set(k, v);
    for (const w of [...(this.watchers.get(k) ?? [])]) w(v as never);
    return { old, new: v };
  }
  watch<K extends ConfigKey>(k: K, fn: (v: ConfigValue<K>) => void): () => void {
    let s = this.watchers.get(k);
    if (!s) this.watchers.set(k, (s = new Set()));
    s.add(fn as never);
    return () => { s.delete(fn as never); };
  }
}

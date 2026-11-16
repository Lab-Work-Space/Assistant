import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS } from '../config/defaults.js';
import { ConfigSchema, type ConfigKey } from '../config/schema.js';
import { ADMIN_CONFIG_KEYS, HANDLER_KEYS, isAdminConfigKey } from './keys.js';

const WS_KEYS = ['ws.enabled', 'ws.maxRunsPerTree', 'ws.maxRunsPerDay'] as const satisfies readonly ConfigKey[];
const ok = (k: ConfigKey, v: unknown) => ConfigSchema[k].safeParse(v).success;

describe('WS-1 (SA-1 5.5, WS-C24): the ws keys are the owner\'s', () => {
  it('every ws key is a handler key, never writable through config_propose', () => {
    for (const k of WS_KEYS) {
      expect(HANDLER_KEYS, k).toContain(k);
      expect(isAdminConfigKey(k), k).toBe(false);
      expect(ADMIN_CONFIG_KEYS, k).not.toContain(k);
    }
  });
  it('defaults: off until Gate 2, 40 per tree, 200 per day', () => {
    expect(WS_KEYS.map((k) => CONFIG_DEFAULTS[k])).toEqual([false, 40, 200]);
    for (const k of WS_KEYS) expect(ok(k, CONFIG_DEFAULTS[k]), k).toBe(true);
  });
  it('ranges', () => {
    expect(ok('ws.maxRunsPerTree', 1) && ok('ws.maxRunsPerTree', 200)).toBe(true);
    expect(ok('ws.maxRunsPerTree', 0) || ok('ws.maxRunsPerTree', 201) || ok('ws.maxRunsPerTree', 1.5)).toBe(false);
    expect(ok('ws.maxRunsPerDay', 1) && ok('ws.maxRunsPerDay', 1000)).toBe(true);
    expect(ok('ws.maxRunsPerDay', 0) || ok('ws.maxRunsPerDay', 1001) || ok('ws.maxRunsPerDay', 'x')).toBe(false);
    expect(ok('ws.enabled', 'true') || ok('ws.enabled', 1)).toBe(false);
  });
  it('the software default tool list still fits the schema (max 100)', () => {
    expect(ok('tools.byDept', CONFIG_DEFAULTS['tools.byDept'])).toBe(true);
  });
});

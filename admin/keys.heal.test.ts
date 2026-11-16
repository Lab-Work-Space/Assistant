import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS } from '../config/defaults.js';
import { ConfigSchema, type ConfigKey } from '../config/schema.js';
import { ADMIN_CONFIG_KEYS, HANDLER_KEYS, isAdminConfigKey } from './keys.js';

const HEAL_KEYS = ['heal.enabled', 'heal.maxRetries', 'heal.maxWakesPerTask', 'heal.maxWakesPerDeciderDay', 'warroom.stallQuietMinutes', 'warroom.quietLiftsPerDay', 'warroom.personLiftsPerDay'] as const satisfies readonly ConfigKey[];
const ok = (k: ConfigKey, v: unknown) => ConfigSchema[k].safeParse(v).success;

describe('HEAL-1 (HL-C2, HL-C17): the heal keys are the owner\'s', () => {
  it('every heal key is a handler key, never writable through config_propose', () => {
    for (const k of HEAL_KEYS) {
      expect(HANDLER_KEYS, k).toContain(k);
      expect(isAdminConfigKey(k), k).toBe(false);
      expect(ADMIN_CONFIG_KEYS, k).not.toContain(k);
    }
  });
  it('defaults', () => {
    expect(HEAL_KEYS.map((k) => CONFIG_DEFAULTS[k])).toEqual([true, 2, 2, 10, 60, 3, 4]);
    for (const k of HEAL_KEYS) expect(ok(k, CONFIG_DEFAULTS[k]), k).toBe(true);
  });
  it('ranges reject out-of-range, fractional and non-numeric values', () => {
    expect(ok('heal.maxRetries', 0) && ok('heal.maxRetries', 5)).toBe(true);
    expect(ok('heal.maxRetries', 6) || ok('heal.maxRetries', -1) || ok('heal.maxRetries', 1.5)).toBe(false);
    expect(ok('heal.maxWakesPerTask', 0) && ok('heal.maxWakesPerTask', 5)).toBe(true);
    expect(ok('heal.maxWakesPerTask', 6)).toBe(false);
    expect(ok('heal.maxWakesPerDeciderDay', 1) && ok('heal.maxWakesPerDeciderDay', 50)).toBe(true);
    expect(ok('heal.maxWakesPerDeciderDay', 0) || ok('heal.maxWakesPerDeciderDay', 51)).toBe(false);
    expect(ok('warroom.stallQuietMinutes', 15) && ok('warroom.stallQuietMinutes', 360)).toBe(true);
    expect(ok('warroom.stallQuietMinutes', 14) || ok('warroom.stallQuietMinutes', 361) || ok('warroom.stallQuietMinutes', 1440)).toBe(false);
    for (const k of ['warroom.quietLiftsPerDay', 'warroom.personLiftsPerDay'] as const) {
      expect(ok(k, 0) && ok(k, 24), k).toBe(true);
      expect(ok(k, 25) || ok(k, -1) || ok(k, 'x'), k).toBe(false);
    }
    expect(ok('heal.enabled', 'yes')).toBe(false);
  });
});

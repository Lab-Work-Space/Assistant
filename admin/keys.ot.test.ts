import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS } from '../config/defaults.js';
import { ConfigSchema } from '../config/schema.js';
import { ADMIN_CONFIG_KEYS, HANDLER_KEYS, isAdminConfigKey, isAdminReadKey } from './keys.js';

const OT_KEYS = ['ot.enabled', 'ot.hours', 'ot.maxRuns', 'ot.maxUsd', 'ot.requestsPerRootPerDay', 'ot.requestsPerDay', 'ot.requestsPerPersonPerDay'] as const;

describe('OT-1 OT-C1: the ot.* keys are the owner\'s', () => {
  it('every ot.* key is a handler key: config_propose (a model tool in the admin console) can never write one', () => {
    for (const k of OT_KEYS) {
      expect(Object.keys(ConfigSchema), k).toContain(k);
      expect(HANDLER_KEYS, k).toContain(k);
      expect(isAdminConfigKey(k), k).toBe(false);
      expect(ADMIN_CONFIG_KEYS, k).not.toContain(k);
      expect(isAdminReadKey(k), k).toBe(true); // an admin may still read them
    }
  });

  it('no ot.* key exists in the schema that is not covered above (a new key must be added to HANDLER_KEYS deliberately)', () => {
    const all = Object.keys(ConfigSchema).filter((k) => k.startsWith('ot.'));
    expect(all.sort()).toEqual([...OT_KEYS].sort());
  });
});

/** The zod bounds must stay inside the ot_requests CHECKs (migration 030), so a config value can never be one the table refuses. */
describe('OT-1: schema bounds sit inside the database CHECKs', () => {
  const ok = (k: (typeof OT_KEYS)[number], v: unknown) => ConfigSchema[k].safeParse(v).success;
  it('ot.hours: at most 12 (grant_window is 12 hours)', () => {
    expect(ok('ot.hours', 12)).toBe(true);
    expect(ok('ot.hours', 12.5)).toBe(false);
    expect(ok('ot.hours', 0.5)).toBe(true);
    expect(ok('ot.hours', 0.4)).toBe(false);
  });
  it('ot.maxRuns: 1 to 200 (max_runs CHECK)', () => {
    expect(ok('ot.maxRuns', 200)).toBe(true);
    expect(ok('ot.maxRuns', 201)).toBe(false);
    expect(ok('ot.maxRuns', 1)).toBe(true);
    expect(ok('ot.maxRuns', 0)).toBe(false);
    expect(ok('ot.maxRuns', 1.5)).toBe(false);
  });
  it('ot.maxUsd: above 0 and at most 50 (max_usd CHECK)', () => {
    expect(ok('ot.maxUsd', 50)).toBe(true);
    expect(ok('ot.maxUsd', 50.01)).toBe(false);
    expect(ok('ot.maxUsd', 0.01)).toBe(true);
    expect(ok('ot.maxUsd', 0)).toBe(false);
    for (const bad of [Number.NaN, Infinity, -1]) expect(ok('ot.maxUsd', bad), String(bad)).toBe(false);
  });
  it('ot.requestsPerRootPerDay: 1 to 5 (seq CHECK)', () => {
    expect(ok('ot.requestsPerRootPerDay', 5)).toBe(true);
    expect(ok('ot.requestsPerRootPerDay', 6)).toBe(false);
    expect(ok('ot.requestsPerRootPerDay', 0)).toBe(false);
  });
  it('the daily caps are bounded integers and every default is valid', () => {
    expect(ok('ot.requestsPerDay', 100)).toBe(true);
    expect(ok('ot.requestsPerDay', 101)).toBe(false);
    expect(ok('ot.requestsPerPersonPerDay', 100)).toBe(true);
    expect(ok('ot.requestsPerPersonPerDay', 0)).toBe(false);
    for (const k of OT_KEYS) expect(ok(k, CONFIG_DEFAULTS[k]), k).toBe(true);
  });
});

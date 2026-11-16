import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS } from '../config/defaults.js';
import { ConfigSchema, type ConfigKey } from '../config/schema.js';
import { ADMIN_CONFIG_KEYS, HANDLER_KEYS, isAdminConfigKey } from './keys.js';

const KEYS = ['grow.retro.enabled', 'grow.retro.weekday', 'grow.retro.hour', 'skills.ai.enabled', 'skills.ai.maxPerDeptWeek', 'skills.ai.maxPerWeek'] as const satisfies readonly ConfigKey[];
const ok = (k: ConfigKey, v: unknown) => ConfigSchema[k].safeParse(v).success;

describe('GROW-1 (GW-C27): the retro and skill AI keys are the owner\'s', () => {
  it('every key is a handler key, never writable through config_propose', () => {
    for (const k of KEYS) {
      expect(HANDLER_KEYS, k).toContain(k);
      expect(isAdminConfigKey(k), k).toBe(false);
      expect(ADMIN_CONFIG_KEYS, k).not.toContain(k);
    }
  });
  it('defaults: retro on Friday 16:00, skill AI off, 1 per dept per week, 5 per week', () => {
    expect(KEYS.map((k) => CONFIG_DEFAULTS[k])).toEqual([true, 5, 16, false, 1, 5]);
    for (const k of KEYS) expect(ok(k, CONFIG_DEFAULTS[k]), k).toBe(true);
  });
  it('ranges', () => {
    expect(ok('grow.retro.weekday', 1) && ok('grow.retro.weekday', 7)).toBe(true);
    expect(ok('grow.retro.weekday', 0) || ok('grow.retro.weekday', 8) || ok('grow.retro.weekday', 1.5)).toBe(false);
    expect(ok('grow.retro.hour', 0) && ok('grow.retro.hour', 23)).toBe(true);
    expect(ok('grow.retro.hour', -1) || ok('grow.retro.hour', 24)).toBe(false);
    expect(ok('skills.ai.maxPerDeptWeek', 0) && ok('skills.ai.maxPerDeptWeek', 10)).toBe(true);
    expect(ok('skills.ai.maxPerDeptWeek', 11)).toBe(false);
    expect(ok('skills.ai.maxPerWeek', 0) && ok('skills.ai.maxPerWeek', 50)).toBe(true);
    expect(ok('skills.ai.maxPerWeek', 51)).toBe(false);
    expect(ok('grow.retro.enabled', 'yes') || ok('skills.ai.enabled', 1)).toBe(false);
  });
});

describe('LEARN-1 (LL-C9): incident log, incident threshold and seed switch are the owner\'s', () => {
  const L = ['grow.incidents.enabled', 'grow.retro.incidentThreshold', 'skills.seed.enabled'] as const satisfies readonly ConfigKey[];
  it('handler keys, absent from ADMIN_CONFIG_KEYS, with the spec defaults and ranges', () => {
    for (const k of L) {
      expect(HANDLER_KEYS, k).toContain(k);
      expect(isAdminConfigKey(k), k).toBe(false);
      expect(ADMIN_CONFIG_KEYS, k).not.toContain(k);
      expect(ok(k, CONFIG_DEFAULTS[k]), k).toBe(true);
    }
    expect(L.map((k) => CONFIG_DEFAULTS[k])).toEqual([true, 5, true]);
    expect(ok('grow.retro.incidentThreshold', 0) && ok('grow.retro.incidentThreshold', 50)).toBe(true);
    expect(ok('grow.retro.incidentThreshold', -1) || ok('grow.retro.incidentThreshold', 51) || ok('grow.retro.incidentThreshold', 2.5)).toBe(false);
    expect(ok('grow.incidents.enabled', 'yes') || ok('skills.seed.enabled', 1)).toBe(false);
  });
});

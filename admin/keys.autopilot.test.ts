import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS } from '../config/defaults.js';
import { ConfigSchema, type ConfigKey } from '../config/schema.js';
import { ADMIN_CONFIG_KEYS, HANDLER_KEYS, isAdminConfigKey } from './keys.js';

const KEYS = ['autopilot.enabled', 'autopilot.maxApprovalsPerProject'] as const satisfies readonly ConfigKey[];
const ok = (k: ConfigKey, v: unknown) => ConfigSchema[k].safeParse(v).success;

describe('AUTO-1 (AP-C10): the autopilot keys are the owner\'s', () => {
  it('both are handler keys, never writable through config_propose', () => {
    for (const k of KEYS) {
      expect(HANDLER_KEYS, k).toContain(k);
      expect(isAdminConfigKey(k), k).toBe(false);
      expect(ADMIN_CONFIG_KEYS, k).not.toContain(k);
    }
  });
  it('defaults: on, 500 approvals per project', () => {
    expect(KEYS.map((k) => CONFIG_DEFAULTS[k])).toEqual([true, 500]);
    for (const k of KEYS) expect(ok(k, CONFIG_DEFAULTS[k]), k).toBe(true);
  });
  it('ranges', () => {
    expect(ok('autopilot.maxApprovalsPerProject', 1) && ok('autopilot.maxApprovalsPerProject', 5000)).toBe(true);
    expect(ok('autopilot.maxApprovalsPerProject', 0) || ok('autopilot.maxApprovalsPerProject', 5001) || ok('autopilot.maxApprovalsPerProject', 1.5)).toBe(false);
    expect(ok('autopilot.enabled', 'true') || ok('autopilot.enabled', 1)).toBe(false);
  });
});

const CO_KEYS = ['autopilot.scope', 'autopilot.company.maxApprovalsPerDay', 'autopilot.company.maxApprovalsPerTree', 'autopilot.company.maxApprovalsPerPersonDay'] as const satisfies readonly ConfigKey[];

describe('AUTO-2 (AC-C4, AC-C16): the company keys are the owner\'s', () => {
  it('all are handler keys, never writable through config_propose', () => {
    for (const k of CO_KEYS) {
      expect(HANDLER_KEYS, k).toContain(k);
      expect(isAdminConfigKey(k), k).toBe(false);
      expect(ADMIN_CONFIG_KEYS, k).not.toContain(k);
    }
  });
  it('defaults: project scope, 600 a day, 80 a tree, 200 a person day', () => {
    expect(CO_KEYS.map((k) => CONFIG_DEFAULTS[k])).toEqual(['project', 600, 80, 200]);
    for (const k of CO_KEYS) expect(ok(k, CONFIG_DEFAULTS[k]), k).toBe(true);
  });
  it('ranges and the scope enum', () => {
    expect(ok('autopilot.scope', 'company') && ok('autopilot.scope', 'project')).toBe(true);
    expect(ok('autopilot.scope', 'all') || ok('autopilot.scope', true) || ok('autopilot.scope', '')).toBe(false);
    const rng: [ConfigKey, number][] = [['autopilot.company.maxApprovalsPerDay', 10000], ['autopilot.company.maxApprovalsPerTree', 1000], ['autopilot.company.maxApprovalsPerPersonDay', 10000]];
    for (const [k, max] of rng) {
      expect(ok(k, 1) && ok(k, max), k).toBe(true);
      expect(ok(k, 0) || ok(k, max + 1) || ok(k, 1.5), k).toBe(false);
    }
  });
});

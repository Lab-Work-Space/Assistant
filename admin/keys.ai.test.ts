import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS } from '../config/defaults.js';
import { ConfigSchema, type ConfigKey } from '../config/schema.js';
import { ADMIN_CONFIG_KEYS, HANDLER_KEYS, isAdminConfigKey } from './keys.js';

const AI_KEYS = ['approval.ai.enabled', 'approval.ai.maxPerTree', 'approval.ai.maxPerDay'] as const satisfies readonly ConfigKey[];
const ok = (k: ConfigKey, v: unknown) => ConfigSchema[k].safeParse(v).success;

describe('AI-APPROVE-1 (AA-C17): the AI approver keys are the owner\'s', () => {
  it('every key is a handler key, never writable through config_propose', () => {
    for (const k of AI_KEYS) {
      expect(HANDLER_KEYS, k).toContain(k);
      expect(isAdminConfigKey(k), k).toBe(false);
      expect(ADMIN_CONFIG_KEYS, k).not.toContain(k);
    }
  });
  it('defaults: off, 40 per tree, 300 per day', () => {
    expect(AI_KEYS.map((k) => CONFIG_DEFAULTS[k])).toEqual([false, 40, 300]);
    for (const k of AI_KEYS) expect(ok(k, CONFIG_DEFAULTS[k]), k).toBe(true);
  });
  it('ranges', () => {
    expect(ok('approval.ai.maxPerTree', 1) && ok('approval.ai.maxPerTree', 500)).toBe(true);
    expect(ok('approval.ai.maxPerTree', 0) || ok('approval.ai.maxPerTree', 501) || ok('approval.ai.maxPerTree', 1.5)).toBe(false);
    expect(ok('approval.ai.maxPerDay', 1) && ok('approval.ai.maxPerDay', 5000)).toBe(true);
    expect(ok('approval.ai.maxPerDay', 0) || ok('approval.ai.maxPerDay', 5001)).toBe(false);
    expect(ok('approval.ai.enabled', 'yes')).toBe(false);
  });
});

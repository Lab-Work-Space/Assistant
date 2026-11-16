import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS } from '../config/defaults.js';
import { ConfigSchema } from '../config/schema.js';
import { ADMIN_CONFIG_KEYS, HANDLER_KEYS } from './keys.js';
import { EXECUTOR_TABLE_GRANTS } from '../db/executor-role.js';

describe('ASKBACK-1 AB10/AB11 config and grants', () => {
  const keys = ['ask.enabled', 'ask.timeoutHours', 'ask.perRoot', 'ask.perDay'] as const;

  it('the ask.* keys are owner-only: HANDLER_KEYS, never ADMIN_CONFIG_KEYS (config_propose cannot write them)', () => {
    for (const k of keys) {
      expect(HANDLER_KEYS).toContain(k);
      expect(ADMIN_CONFIG_KEYS).not.toContain(k);
    }
  });

  it('defaults and zod bounds: finite integers within the stated ranges', () => {
    expect(keys.map((k) => CONFIG_DEFAULTS[k])).toEqual([true, 4, 6, 40]);
    expect(ConfigSchema['ask.timeoutHours'].safeParse(1).success && ConfigSchema['ask.timeoutHours'].safeParse(72).success).toBe(true);
    for (const bad of [0, 73, 1.5, Number.NaN, Infinity]) expect(ConfigSchema['ask.timeoutHours'].safeParse(bad).success).toBe(false);
    for (const bad of [1, 21, 2.5, Number.NaN]) expect(ConfigSchema['ask.perRoot'].safeParse(bad).success).toBe(false);
    expect(ConfigSchema['ask.perRoot'].safeParse(2).success).toBe(true);
    for (const bad of [0, 501, 0.5, Number.NaN]) expect(ConfigSchema['ask.perDay'].safeParse(bad).success).toBe(false);
    expect(ConfigSchema['ask.enabled'].safeParse('yes').success).toBe(false);
  });

  it('task_questions is not in the executor role grants', () => {
    expect(EXECUTOR_TABLE_GRANTS.map((g) => g.table)).not.toContain('task_questions');
  });
});

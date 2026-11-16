import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS } from '../config/defaults.js';
import { ConfigSchema } from '../config/schema.js';
import { planOpenSourcesEnabled } from '../discord/commands/plans.js';
import { ADMIN_CONFIG_KEYS, HANDLER_KEYS, isAdminConfigKey } from './keys.js';

const K = 'web.search.openSources' as const;

describe('SEARCH-1 (SR-C9): web.search.openSources', () => {
  it('is a handler key, never writable through config_propose', () => {
    expect(HANDLER_KEYS).toContain(K);
    expect(isAdminConfigKey(K)).toBe(false);
    expect(ADMIN_CONFIG_KEYS).not.toContain(K);
  });
  it('default true (owner decision), boolean only', () => {
    expect(CONFIG_DEFAULTS[K]).toBe(true);
    expect(ConfigSchema[K].safeParse(true).success && ConfigSchema[K].safeParse(false).success).toBe(true);
    expect(ConfigSchema[K].safeParse('true').success || ConfigSchema[K].safeParse(1).success).toBe(false);
  });
  it('the plan flags enabling as a risk and disabling as not', () => {
    const cfg = (v: boolean) => ({ get: () => v }) as never;
    const on = planOpenSourcesEnabled('on', { cfg: cfg(false) });
    expect('risk' in on && on.risk).toBe(true);
    const off = planOpenSourcesEnabled('off', { cfg: cfg(true) });
    expect('risk' in off && off.risk).toBe(false);
  });
});

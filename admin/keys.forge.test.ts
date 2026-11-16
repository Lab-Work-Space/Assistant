import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS } from '../config/defaults.js';
import { ConfigSchema } from '../config/schema.js';
import { ADMIN_CONFIG_KEYS, HANDLER_KEYS, configRisk, isAdminConfigKey } from './keys.js';

/** R7 PLUGIN-FORGE BE2 (spec 5.10, PF-C13, FG-AC17): `forge.enabled` is the owner's; no model-reachable path writes it. */
describe('forge.enabled', () => {
  it('is a handler key and never writable through config_propose (no AdminOp touches the forge)', () => {
    expect(HANDLER_KEYS).toContain('forge.enabled');
    expect(isAdminConfigKey('forge.enabled')).toBe(false);
    expect(ADMIN_CONFIG_KEYS).not.toContain('forge.enabled');
  });
  it('defaults to false and is a strict boolean', () => {
    expect(CONFIG_DEFAULTS['forge.enabled']).toBe(false);
    const ok = (v: unknown): boolean => ConfigSchema['forge.enabled'].safeParse(v).success;
    expect(ok(false) && ok(true)).toBe(true);
    expect(ok('true') || ok(1) || ok(null)).toBe(false);
  });
  it('configRisk is true only for false to true', () => {
    expect(configRisk('forge.enabled', false, true)).toBe(true);
    expect(configRisk('forge.enabled', true, false)).toBe(false);
    expect(configRisk('forge.enabled', false, false)).toBe(false);
  });
});

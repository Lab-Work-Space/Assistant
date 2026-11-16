import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS } from '../config/defaults.js';
import { ConfigSchema } from '../config/schema.js';
import { ADMIN_CONFIG_KEYS, ADMIN_READ_KEYS, HANDLER_KEYS, configRisk, isAdminConfigKey, requiresCard } from './keys.js';

/** R8 PROV-FALLBACK G6 / PV-C08: the switch is the owner's; no model-reachable path writes it. */
describe('provider.fallback.enabled', () => {
  it('is a handler key, readable, and never writable through config_propose', () => {
    expect(HANDLER_KEYS).toContain('provider.fallback.enabled');
    expect(ADMIN_READ_KEYS).toContain('provider.fallback.enabled');
    expect(isAdminConfigKey('provider.fallback.enabled')).toBe(false);
    expect(ADMIN_CONFIG_KEYS).not.toContain('provider.fallback.enabled');
  });
  it('no AdminOp names it (the op file does not mention the key or its plan)', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ops.ts'), 'utf8');
    expect(src).not.toMatch(/provider\.fallback|planFallbackEnabled/);
  });
  it('defaults to false and is a strict boolean', () => {
    expect(CONFIG_DEFAULTS['provider.fallback.enabled']).toBe(false);
    const ok = (v: unknown): boolean => ConfigSchema['provider.fallback.enabled'].safeParse(v).success;
    expect(ok(false) && ok(true)).toBe(true);
    expect(ok('true') || ok(1) || ok(null)).toBe(false);
  });
  it('configRisk is true only for false to true; it never needs the model-card path', () => {
    expect(configRisk('provider.fallback.enabled', false, true)).toBe(true);
    expect(configRisk('provider.fallback.enabled', true, false)).toBe(false);
    expect(configRisk('provider.fallback.enabled', false, false)).toBe(false);
    expect(requiresCard('provider.fallback.enabled', false, true)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS } from '../config/defaults.js';
import { ConfigSchema, type ConfigKey } from '../config/schema.js';
import { ADMIN_CONFIG_KEYS, HANDLER_KEYS, configRisk, isAdminConfigKey } from './keys.js';

/** R6 MCP-1 BE2 (spec 5.9, MCP-AC20, MC-C14): the mcp keys are the owner's; no model-reachable path writes them. */
const KEYS = ['mcp.enabled', 'mcp.maxCallsPerTree', 'mcp.maxCallsPerDay'] as const satisfies readonly ConfigKey[];
const ok = (k: ConfigKey, v: unknown) => ConfigSchema[k].safeParse(v).success;

describe('mcp config keys', () => {
  it('every key is a handler key and never writable through config_propose', () => {
    for (const k of KEYS) {
      expect(HANDLER_KEYS, k).toContain(k);
      expect(isAdminConfigKey(k), k).toBe(false);
      expect(ADMIN_CONFIG_KEYS, k).not.toContain(k);
    }
  });
  it('defaults: off, 40 per tree, 200 per day; each default passes its own schema', () => {
    expect(KEYS.map((k) => CONFIG_DEFAULTS[k])).toEqual([false, 40, 200]);
    for (const k of KEYS) expect(ok(k, CONFIG_DEFAULTS[k]), k).toBe(true);
  });
  it('ranges: tree 1-500, day 1-5000, integers only; the switch is a strict boolean', () => {
    expect(ok('mcp.maxCallsPerTree', 1) && ok('mcp.maxCallsPerTree', 500)).toBe(true);
    expect(ok('mcp.maxCallsPerTree', 0) || ok('mcp.maxCallsPerTree', 501) || ok('mcp.maxCallsPerTree', 1.5) || ok('mcp.maxCallsPerTree', '40')).toBe(false);
    expect(ok('mcp.maxCallsPerDay', 1) && ok('mcp.maxCallsPerDay', 5000)).toBe(true);
    expect(ok('mcp.maxCallsPerDay', 0) || ok('mcp.maxCallsPerDay', 5001) || ok('mcp.maxCallsPerDay', -1)).toBe(false);
    expect(ok('mcp.enabled', 'true') || ok('mcp.enabled', 1) || ok('mcp.enabled', null)).toBe(false);
  });
  it('configRisk is true only for false to true on the switch', () => {
    expect(configRisk('mcp.enabled', false, true)).toBe(true);
    expect(configRisk('mcp.enabled', true, false)).toBe(false);
    expect(configRisk('mcp.enabled', false, false)).toBe(false);
    expect(configRisk('mcp.maxCallsPerDay', 200, 300)).toBe(false);
  });
});

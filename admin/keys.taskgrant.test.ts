import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS } from '../config/defaults.js';
import { ConfigSchema } from '../config/schema.js';
import { ADMIN_CONFIG_KEYS, HANDLER_KEYS, isAdminConfigKey, isAdminReadKey } from './keys.js';

const KEYS = ['taskGrant.enabled', 'taskGrant.hours', 'taskGrant.conversationHours', 'taskGrant.maxCalls', 'taskGrant.allowTainted'] as const;

describe('TREEGRANT-1: the taskGrant.* keys are the owner\'s', () => {
  it('every taskGrant.* key is a handler key: no model-reachable path (config_propose) writes one, an admin may still read them', () => {
    for (const k of KEYS) {
      expect(Object.keys(ConfigSchema), k).toContain(k);
      expect(HANDLER_KEYS, k).toContain(k);
      expect(isAdminConfigKey(k), k).toBe(false);
      expect(ADMIN_CONFIG_KEYS, k).not.toContain(k);
      expect(isAdminReadKey(k), k).toBe(true);
    }
  });
  it('no other taskGrant.* key exists in the schema (a new key must be added to HANDLER_KEYS deliberately)', () => {
    expect(Object.keys(ConfigSchema).filter((k) => k.startsWith('taskGrant.')).sort()).toEqual([...KEYS].sort());
  });
  it('bounds: hours and conversationHours 1 to 72 (the 72 h CHECK), maxCalls 1 to 500 (the max_calls CHECK), integers; every default is valid and is the spec default', () => {
    const ok = (k: (typeof KEYS)[number], v: unknown) => ConfigSchema[k].safeParse(v).success;
    for (const k of ['taskGrant.hours', 'taskGrant.conversationHours'] as const) {
      expect([ok(k, 1), ok(k, 72), ok(k, 0), ok(k, 73), ok(k, 1.5)], k).toEqual([true, true, false, false, false]);
    }
    expect([ok('taskGrant.maxCalls', 1), ok('taskGrant.maxCalls', 500), ok('taskGrant.maxCalls', 0), ok('taskGrant.maxCalls', 501), ok('taskGrant.maxCalls', Number.NaN)]).toEqual([true, true, false, false, false]);
    expect(ok('taskGrant.enabled', 'yes')).toBe(false);
    for (const k of KEYS) expect(ok(k, CONFIG_DEFAULTS[k]), k).toBe(true);
    expect([CONFIG_DEFAULTS['taskGrant.enabled'], CONFIG_DEFAULTS['taskGrant.hours'], CONFIG_DEFAULTS['taskGrant.conversationHours'], CONFIG_DEFAULTS['taskGrant.maxCalls'], CONFIG_DEFAULTS['taskGrant.allowTainted']]).toEqual([true, 12, 4, 40, true]);
  });
});

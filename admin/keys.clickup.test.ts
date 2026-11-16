import { describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS } from '../config/defaults.js';
import { ConfigSchema } from '../config/schema.js';
import { ADMIN_CONFIG_KEYS, HANDLER_KEYS, isAdminConfigKey, isAdminReadKey } from './keys.js';
import { AdminOp } from './ops.js';

const KEYS = ['clickup.writesPerDay', 'clickup.pollListIds'] as const;

describe('CLICKUP-ALL-1 C11: the workspace keys are the owner\'s', () => {
  it('both keys exist, are handler keys, are never config_propose keys, and may still be read', () => {
    for (const k of KEYS) {
      expect(Object.keys(ConfigSchema), k).toContain(k);
      expect(HANDLER_KEYS, k).toContain(k);
      expect(ADMIN_CONFIG_KEYS, k).not.toContain(k);
      expect(isAdminConfigKey(k), k).toBe(false);
      expect(isAdminReadKey(k), k).toBe(true);
    }
  });

  it('no admin operation can write either key: the op list has only clickup_channel for ClickUp, and watch/limit ops do not parse', () => {
    const ops = AdminOp.options.map((o) => (o.shape as { op: { value: string } }).op.value).filter((x) => /clickup|watch|write|poll/.test(x));
    expect(ops).toEqual(['clickup_channel']);
    for (const op of ['clickup_watch', 'clickup_writes_per_day', 'clickup_poll_lists', 'config_set']) {
      expect(AdminOp.safeParse({ op, list_id: '7001', action: 'add', value: 500 }).success, op).toBe(false);
    }
    expect(AdminOp.safeParse({ op: 'clickup_channel', channel: null, writesPerDay: 500 }).success).toBe(false); // strict: no smuggled key
  });

  it('bounds and defaults: writesPerDay 0..500 integer (default 50); pollListIds at most 10 ids (default empty)', () => {
    const w = ConfigSchema['clickup.writesPerDay'];
    expect(w.safeParse(0).success).toBe(true);
    expect(w.safeParse(500).success).toBe(true);
    for (const bad of [-1, 501, 1.5, Number.NaN, '5']) expect(w.safeParse(bad).success, String(bad)).toBe(false);
    expect(CONFIG_DEFAULTS['clickup.writesPerDay']).toBe(50);
    const p = ConfigSchema['clickup.pollListIds'];
    expect(p.safeParse(Array.from({ length: 10 }, (_, i) => `l${i}`)).success).toBe(true);
    expect(p.safeParse(Array.from({ length: 11 }, (_, i) => `l${i}`)).success).toBe(false);
    expect(p.safeParse(['../x']).success).toBe(false);
    expect(CONFIG_DEFAULTS['clickup.pollListIds']).toEqual([]);
  });
});

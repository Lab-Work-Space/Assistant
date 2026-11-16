import { describe, expect, it } from 'vitest';
import { ADMIN_CONSOLE_NOTE, ADMIN_TOOL_NAMES } from './names.js';
import { AdminOp } from './ops.js';

describe('AdminOp skill ops (SK14)', () => {
  const ok = (o: unknown) => AdminOp.safeParse(o).success;

  it('accepts exactly the four skill ops', () => {
    expect(ok({ op: 'skill_attach', skill: 'handover', target: 'dept:software' })).toBe(true);
    expect(ok({ op: 'skill_attach', skill: 'handover', target: 'persona:system-analyst', priority: 5 })).toBe(true);
    expect(ok({ op: 'skill_detach', skill: 'handover', target: 'dept:software' })).toBe(true);
    expect(ok({ op: 'skill_toggle', skill: 'handover', enabled: false })).toBe(true);
    expect(ok({ op: 'skill_rollback', skill: 'handover', version: 2 })).toBe(true);
    const skillOps = AdminOp.options.map((o) => o.shape.op.value).filter((v) => v.startsWith('skill_')).sort();
    expect(skillOps).toEqual(['skill_attach', 'skill_detach', 'skill_rollback', 'skill_toggle']);
  });

  it('refuses skill_create and skill_edit (skill text is written by a Bot Admin only), extra fields and a bad slug', () => {
    expect(ok({ op: 'skill_create', skill: 'handover', instructions: 'some instructions here' })).toBe(false);
    expect(ok({ op: 'skill_edit', skill: 'handover', instructions: 'some instructions here' })).toBe(false);
    expect(ok({ op: 'skill_attach', skill: 'handover', target: 'dept:software', tools: ['x'] })).toBe(false);
    expect(ok({ op: 'skill_toggle', skill: 'Bad Slug', enabled: true })).toBe(false);
    expect(ok({ op: 'skill_rollback', skill: 'handover', version: 0 })).toBe(false);
  });

  it('the admin tool list and the console note are unchanged (no skill tool, no skill text)', () => {
    expect([...ADMIN_TOOL_NAMES].sort()).toEqual(['admin_op_propose', 'code_propose', 'code_rollback', 'config_get', 'config_propose', 'deploy_propose', 'deploy_read', 'discord_read', 'perm_propose', 'server_propose', 'site_publish_static']);
    expect(ADMIN_CONSOLE_NOTE).not.toMatch(/skill/i);
  });
});

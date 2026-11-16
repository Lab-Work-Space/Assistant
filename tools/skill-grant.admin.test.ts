import { describe, expect, it, vi } from 'vitest';
import { SENSITIVE_TOOL } from '../discord/approval/approval-rooms.js';
import { MOD_TOOL_NAMES } from '../admin/names.js';
import { skillToolAllowed, type GrantEnv } from './skill-grant.js';

// G2SK-02: today every ADMIN name but discord_read also matches SENSITIVE_TOOL, so the ADMIN list clause cannot be isolated with real names.
// Here the list gains a name that is neither sensitive nor in the MOD list: only the ADMIN clause can refuse it. R4: the stub names are real, declared, non-sensitive catalog names (an undeclared name is now sensitive, fail-closed).
vi.mock('../admin/names.js', async (orig) => {
  const m = await orig<typeof import('../admin/names.js')>();
  return { ...m, ADMIN_TOOL_NAMES: [...m.ADMIN_TOOL_NAMES, 'forum_post'] as const };
});

const env = (n: string): GrantEnv => ({ registered: () => [n], builtins: () => [], kindOf: () => 'write' });

describe('skillToolAllowed: the ADMIN list clause on its own (G2SK-02)', () => {
  it('a name only in ADMIN_TOOL_NAMES (not sensitive, not MOD, no other exclusion) is refused; the same stub without the listing passes', () => {
    expect(SENSITIVE_TOOL.test('forum_post')).toBe(false);
    expect((MOD_TOOL_NAMES as readonly string[]).includes('forum_post')).toBe(false);
    expect(skillToolAllowed('forum_post', env('forum_post'))).toBe(false);
    expect(skillToolAllowed('clickup_update_task', env('clickup_update_task'))).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { ADMIN_TOOL_NAMES, MOD_TOOL_NAMES } from '../admin/names.js';
import { SENSITIVE_TOOL } from '../discord/approval/approval-rooms.js';
import { BOT_TALK_TOOLS, NO_APPROVAL_TOOLS, type ToolKind } from './policy-approval.js';
import { skillToolAllowed, type GrantEnv } from './skill-grant.js';

/** A stub registry: every name in `kinds` is registered, `builtins` are core builtins, `undefined` kind = a kindless plugin. */
const env = (kinds: Record<string, ToolKind | undefined>, builtins: string[] = []): GrantEnv => ({
  registered: () => Object.keys(kinds),
  builtins: () => builtins,
  kindOf: (n) => kinds[n],
});

describe('skillToolAllowed: grant rule G (SK8). Each case fails exactly ONE clause on a stub registry', () => {
  it('positive: a registered, kinded, non-builtin, non-sensitive plugin tool', () => {
    expect(skillToolAllowed('clickup_create_task', env({ clickup_create_task: 'write' }))).toBe(true);
    expect(skillToolAllowed('web_search', env({ web_search: 'read' }))).toBe(true);
  });

  it('registered() omits the name although kindOf answers with a kind: refused by the registered clause alone', () => {
    const e: GrantEnv = { registered: () => ['other_tool'], builtins: () => [], kindOf: () => 'write' };
    expect(skillToolAllowed('clickup_create_task', { ...e, registered: () => ['clickup_create_task'] })).toBe(true);
    expect(skillToolAllowed('clickup_create_task', e)).toBe(false);
  });

  it('unregistered name', () => {
    expect(skillToolAllowed('ghost_tool', env({ other_tool: 'read' }))).toBe(false);
  });

  it('kindless plugin (registered, not builtin, not sensitive, not listed)', () => {
    expect(skillToolAllowed('new_plugin', env({ new_plugin: undefined }))).toBe(false);
  });

  it('core builtin only: create_task is registered with a kind and fails only the builtin clause', () => {
    const e = env({ create_task: 'write' }, ['create_task']);
    expect(SENSITIVE_TOOL.test('create_task')).toBe(false);
    expect(skillToolAllowed('create_task', e)).toBe(false);
    expect(skillToolAllowed('create_task', env({ create_task: 'write' }))).toBe(true); // proves the builtin clause is the one that refused
  });

  it.each(['github_create_branch', 'save_lesson', 'knowledge_propose', 'prompt_propose', 'skill_x', 'skill_propose'])('SENSITIVE_TOOL name %s (as a non-builtin stub) is refused', (n) => {
    expect(SENSITIVE_TOOL.test(n)).toBe(true);
    expect(skillToolAllowed(n, env({ [n]: 'write' }))).toBe(false);
  });

  it('the list clause: discord_read is in ADMIN and MOD, matches no SENSITIVE pattern, and is refused only by the list check', () => {
    expect(SENSITIVE_TOOL.test('discord_read')).toBe(false);
    expect((ADMIN_TOOL_NAMES as readonly string[]).includes('discord_read')).toBe(true);
    expect((MOD_TOOL_NAMES as readonly string[]).includes('discord_read')).toBe(true);
    expect(skillToolAllowed('discord_read', env({ discord_read: 'read' }))).toBe(false);
  });

  it('every ADMIN_TOOL_NAMES and MOD_TOOL_NAMES entry is refused even when registered with a kind', () => {
    for (const n of [...ADMIN_TOOL_NAMES, ...MOD_TOOL_NAMES]) expect(skillToolAllowed(n, env({ [n]: 'read' }))).toBe(false);
  });

  it('bot talk: warroom_say as a non-builtin stub is refused only by the bot-talk clause', () => {
    expect(SENSITIVE_TOOL.test('warroom_say')).toBe(false);
    for (const n of BOT_TALK_TOOLS) expect(skillToolAllowed(n, env({ [n]: 'write' }))).toBe(false);
  });

  it('no approval: diagram_create (registered, kind write, non-builtin) is refused only by the no-approval clause', () => {
    expect(SENSITIVE_TOOL.test('diagram_create')).toBe(false);
    for (const n of NO_APPROVAL_TOOLS) expect(skillToolAllowed(n, env({ [n]: 'write' }))).toBe(false);
  });
});

import { ADMIN_TOOL_NAMES, MOD_TOOL_NAMES } from '../admin/names.js';
import { isNonSensitiveTool } from '../discord/approval/approval-rooms.js';
import { isBotTalk, isNoApproval, type ToolKind } from './policy-approval.js';

/** What the grant rule needs to know about the tool registry; read on every call so later registrations are seen. */
export interface GrantEnv {
  registered(): readonly string[];
  /** Core builtins (they come from prompt meta only). */
  builtins(): readonly string[];
  /** The tool's declared kind, undefined when it has none. */
  kindOf(name: string): ToolKind | undefined;
}

/** A tool name that may be echoed in a refusal (SK15). */
export const SAFE_TOOL_NAME = /^[a-z0-9_]{1,64}$/;

/**
 * Grant rule G (SK8): the ONE predicate deciding whether a skill may add a tool to an actor. It runs at write time (skill create, tools,
 * attach, rollback) and again in `effective()` at run time, so a version stored before a rule change is filtered and never trusted.
 * A name passes only if ALL of these hold. Every list is imported, never copied.
 */
export function skillToolAllowed(name: string, env: GrantEnv): boolean {
  return (
    env.registered().includes(name) && // registered
    env.kindOf(name) !== undefined && // has a defined kind: approvalFor can see it (a kindless plugin could write with no approval)
    !env.builtins().includes(name) && // not a core builtin (those come from prompt meta, mirrors tools.byDept in policy.ts)
    isNonSensitiveTool(name) && // B7: not GitHub/code/deploy/knowledge/prompt/skill_/admin... (SENSITIVE_TOOL)
    !(ADMIN_TOOL_NAMES as readonly string[]).includes(name) &&
    !(MOD_TOOL_NAMES as readonly string[]).includes(name) &&
    !isBotTalk(name) &&
    !isNoApproval(name)
  );
}

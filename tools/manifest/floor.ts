// R4: the frozen floor. A leaf module (NO imports). The pattern is moved verbatim from discord/approval/approval-rooms.ts (which re-exports SENSITIVE_TOOL under the same name).

/**
 * Gate 1 WS7: tools whose approval card never leaves #⚙️-setting, whatever task it belongs to: GitHub writes, code/devjob, deploy and site
 * publishing, knowledge and prompt edits, the admin console families (config, admin op, perm, server) and moderation. Matched on the tool name.
 * FROZEN: never extended. A new tool declares `sensitive` in its manifest; V4 refuses `sensitive:false` for a name this matches.
 */
const PATTERN = /^(github_|devjob|code_|deploy|site_|knowledge_|prompt_|config_|admin_|perm_|server_|mod_|moderat|ban|kick|welcome|save_lesson|delete_lesson|skill_)/i; // SK8: skill_ (skill_propose and any later skill tool never leave #⚙️-setting). G2WS-03: lessons are company-wide knowledge

/**
 * Exported as a frozen object with `test` only (the one method every reader uses), not as the RegExp itself: `Object.freeze(regex)` does NOT protect a
 * RegExp (`regex.compile('x')` rewrites the pattern in V8 and only then throws on `lastIndex`). The real pattern stays in this module's closure.
 */
export const SENSITIVE_TOOL: Readonly<Pick<RegExp, 'test'>> = Object.freeze({ test: (name: string): boolean => PATTERN.test(name) });

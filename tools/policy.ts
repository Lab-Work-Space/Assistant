import type { ConfigStore } from '../config/store.js';
import type { PromptDoc } from '../prompts/index.js';
import { DERIVED } from './manifest/catalog.js';
import { MCP_NAME } from './manifest/external.js';
import { skillToolAllowed } from './skill-grant.js';
import type { ToolKind } from './policy-approval.js';

/** The one department whose prompt may say `tools: ["*"]` (expanded here, never by the registry). */
export const WILDCARD_DEPT = 'praw';

/**
 * WS-1 (SA-1 C8, Gate 1 WS-C19): tools that exist for one department only. `effective()` drops them for every other department from every
 * source (the praw wildcard, a stored `tools.byDept`, skills, prompt meta); each tool also checks the actor in code.
 */
export const DEPT_ONLY: Readonly<Record<string, string>> = DERIVED.deptOnly; // R4: a frozen view of the manifest (deptOnly)

export interface ToolPolicy {
  /**
   * Tool names an actor of `dept` may call. Core builtins come from the actor's prompt meta; plugin tools come only
   * from `tools.byDept[dept]` (prompt meta cannot grant a plugin); `"*"` (praw only) expands to every registered name.
   * Unregistered names are dropped, the result is deduped. `skillTools` (SKILLS-1: the tools of the actor's dept and persona skills) are
   * added only when grant rule G holds for each name (tools/skill-grant.ts), checked here at run time as well as at write time.
   */
  effective(dept: string, promptTools: string[], skillTools?: readonly string[]): string[];
}

/**
 * `registered` / `builtins` are read on every call so tools registered after the policy is built are seen.
 * Defaults to read-only tools by explicit name (P16b): write tools are never granted by default.
 */
export function createToolPolicy(
  cfg: Pick<ConfigStore, 'get'>,
  registered: () => string[],
  builtins: () => string[] = () => [],
  /** Declared kind of a registered tool; without it no skill can add a tool (fail closed). */
  kindOf: (name: string) => ToolKind | undefined = () => undefined,
  /**
   * R6 MCP-1 (spec 5.8): the names of the active MCP servers' tools granted to a department (held by McpHost). The ONLY way an `mcp_` name reaches an actor; every other
   * source below drops them. Added only while `mcpOn()` is exactly true (a throw or anything else is off).
   */
  mcpFor?: (dept: string) => readonly string[],
  mcpOn?: () => unknown,
): ToolPolicy {
  const env = { registered, builtins, kindOf };
  const isMcp = (n: string): boolean => n.startsWith('mcp_');
  const on = (): boolean => {
    try { return mcpOn?.() === true; } catch { return false; }
  };
  return {
    effective(dept, promptTools, skillTools = []) {
      const all = new Set(registered().filter((n) => !isMcp(n)));
      const core = new Set(builtins().filter((n) => !isMcp(n)));
      promptTools = promptTools.filter((n) => !isMcp(n));
      skillTools = skillTools.filter((n) => !isMcp(n));
      const out = new Set<string>();
      if (dept === WILDCARD_DEPT && promptTools.includes('*')) for (const n of all) out.add(n);
      for (const n of promptTools) if (core.has(n) && all.has(n)) out.add(n);
      const granted = (Object.hasOwn(cfg.get('tools.byDept'), dept) ? cfg.get('tools.byDept')[dept]! : []).filter((n) => !isMcp(n));
      for (const n of granted) if (!core.has(n) && all.has(n)) out.add(n);
      for (const n of skillTools) if (skillToolAllowed(n, env)) out.add(n);
      if (mcpFor && on()) {
        try {
          for (const n of mcpFor(dept)) if (MCP_NAME.test(n)) out.add(n);
        } catch { /* a host fault grants nothing */ }
      }
      return [...out].filter((n) => !Object.hasOwn(DEPT_ONLY, n) || DEPT_ONLY[n] === dept);
    },
  };
}

/** Explicit tool names found in prompt frontmatter that no registered tool answers to (startup check; never a grant). */
export function unknownPromptTools(prompts: Map<string, PromptDoc>, registered: string[]): string[] {
  const known = new Set(registered);
  const bad = new Set<string>();
  for (const doc of prompts.values()) for (const n of doc.meta.tools) if (n !== '*' && !known.has(n)) bad.add(n);
  return [...bad].sort();
}

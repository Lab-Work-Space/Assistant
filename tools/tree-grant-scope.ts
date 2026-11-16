import { ADMIN_TOOL_NAMES, MOD_TOOL_NAMES } from '../admin/names.js';
import { isNonSensitiveTool } from '../discord/approval/approval-rooms.js';
import { canonicalJson, inputDigest } from '../governance/canonical.js';
import { forwardWider } from './builtin/forwardTo.js';
import { DOC_KINDS, isDraftKind, type DocKind } from './plugins/docs/kinds.js';
import { BOT_TALK_TOOLS, NO_APPROVAL_TOOLS, type ToolKind } from './policy-approval.js';
import { TREE_GRANT_TOOLS } from './tree-grant-tools.js';
import type { ToolContext } from './types.js';

export { TREE_GRANT_TOOLS };

/**
 * KEY RULE (S2): the grant waives only the CENTRAL approvalFor result. A tool whose own requiresApproval is anything but the boolean `false`
 * (a reason, true, a throw) keeps its card. `kind` is the registered kind of the tool, `own` its own answer (computed on the run path only).
 */
export const treeGrantCovers = (name: string, kind: ToolKind | undefined, own: unknown): boolean =>
  TREE_GRANT_TOOLS.includes(name) && kind === 'write' && own === false && isNonSensitiveTool(name);

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * TG-C4 (a): predicates over the STORED input only, pure and deterministic. Applied at render, decision and consume alike.
 *  - doc_create: never a DRAFT kind (money, tax or offer documents always ask); an unknown kind is not covered.
 *  - write_file: never an overwrite (an overwrite destroys a file nobody saw).
 */
export function storedInputOk(name: string, input: unknown): boolean {
  if (!isObject(input)) return false;
  if (name === 'doc_create') {
    const k = input['kind'];
    return typeof k === 'string' && (DOC_KINDS as readonly string[]).includes(k) && !isDraftKind(k as DocKind);
  }
  if (name === 'write_file') return input['overwrite'] !== true;
  return true;
}

/**
 * TG-C3 (F-1, S7): ONE pure predicate over a stored approval row. The solo card, the batch card and its refresh, decideTaskGrant and decideBatch({task})
 * (for every member) all call it, so the button and the click can never disagree. It never calls a tool's requiresApproval (no synthesized context).
 */
export function treeGrantEligible(
  row: { kind?: string | undefined; toolName?: string | null | undefined; toolInput?: unknown; inputSha256?: string | null | undefined },
  kindOf: (name: string) => ToolKind | undefined,
): boolean {
  if (row.kind !== 'tool' || !row.toolName || !row.inputSha256) return false;
  if (!TREE_GRANT_TOOLS.includes(row.toolName) || kindOf(row.toolName) !== 'write') return false;
  try {
    if (inputDigest(canonicalJson(row.toolInput)) !== row.inputSha256) return false;
  } catch { return false; }
  return storedInputOk(row.toolName, row.toolInput);
}

/**
 * TG-C4 (b): run-time predicates, evaluated at consume only (they need run state). Any doubt, or a throw, is `false` (a card).
 *  - write_file: never in a tainted run (Praw's workspace is the site_publish_static source), whatever taskGrant.allowTainted says.
 *  - forward_to: only when the target audience is not wider (the same RF11 / G2RF-02 question the tool itself asks).
 */
export async function treeGrantRunOk(name: string, input: unknown, ctx: ToolContext): Promise<boolean> {
  try {
    if (!storedInputOk(name, input)) return false;
    if (name === 'write_file') return !ctx.tainted() && ctx.task?.tainted !== true;
    if (name === 'forward_to') {
      const dept = isObject(input) ? input['dept'] : undefined;
      return typeof dept === 'string' && (await forwardWider(dept as never, ctx)) === false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * TG-C1 (S9, F-14): startup assertion. Every entry that IS registered must be a `write` tool, non-sensitive, and not in the bot-talk, no-approval,
 * admin or moderator lists. An unregistered entry (its group is disabled: no media, no renderer, no workspace root) is skipped, not fatal.
 * A wrong kind refuses boot.
 */
export function assertTreeGrantScope(registry: { names(): string[]; kindOf(name: string): ToolKind | undefined }, list: readonly string[] = TREE_GRANT_TOOLS): void {
  const have = new Set(registry.names());
  for (const name of list) {
    if (!have.has(name)) continue;
    const bad =
      registry.kindOf(name) !== 'write' ? 'is not a write tool'
        : !isNonSensitiveTool(name) ? 'is a sensitive tool'
          : BOT_TALK_TOOLS.includes(name) || NO_APPROVAL_TOOLS.includes(name) ? 'never asks for approval already'
            : (ADMIN_TOOL_NAMES as readonly string[]).includes(name) || (MOD_TOOL_NAMES as readonly string[]).includes(name) ? 'is an admin tool'
              : null;
    if (bad) throw new Error(`task grant scope: ${name} ${bad}`);
  }
}

import { redactText } from '../core/logger.js';
import { DERIVED } from './manifest/catalog.js';
import type { ToolContext } from './types.js';

/** How much a tool call can change the world: read nothing, write something recoverable, destroy something. */
export type ToolKind = 'read' | 'write' | 'destructive';

const REASON_MAX = 500;

/**
 * F2 / LF2: the `bot_talk` rule. Talk between our own bots in the bot-only #ai-warroom never asks for approval. R4: a frozen view of the checked-in
 * manifest (approval 'bot_talk'; V6 limits it to a non-sensitive write with no tree grant). No tool kind, config value or model text can claim it, and joining needs a manifest entry AND the same diff in
 * tools/manifest/privileged.json, both protected from bot self-modification (devjob NON_SELF_MODIFIABLE). The registry passes its own registered name here (never a tool-supplied one).
 */
export const BOT_TALK_TOOLS: readonly string[] = DERIVED.botTalk; // R4: a frozen view of the manifest (approval 'bot_talk')
export const isBotTalk = (tool: string): boolean => BOT_TALK_TOOLS.includes(tool);

/**
 * RFMD P4 / RF27: `diagram_create` draws a picture from checked text and posts it only in the run's own thread or channel. It skips approval ONLY by declaring
 * approval 'no_approval' in its manifest (a frozen view, separate from BOT_TALK_TOOLS; V6 limits it to a non-sensitive write with no tree grant). No tool kind, config value or model text can add to it:
 * joining needs a manifest entry AND the same diff in tools/manifest/privileged.json (both protected from bot self-modification), and the registry passes its own registered name.
 */
export const NO_APPROVAL_TOOLS: readonly string[] = DERIVED.noApproval; // R4: a frozen view of the manifest (approval 'no_approval')
// WS-1 (Gate 1 WS-C18): the ws_* names skip approval for one reason: ws_run already covers write and delete (a `node` script can rewrite or wipe /work), so a card on the file
// tools would add nothing. The controls are the container, the host no-follow file I/O, the quotas, the run caps and the global run cap. ws_export is the only outward action
// and its target is fixed in code to the run's own thread. Skills can never be granted them (skill-grant) and tree grants never ask for them (tree-grant-scope).
export const isNoApproval = (tool: string): boolean => NO_APPROVAL_TOOLS.includes(tool);

/**
 * R3 / Gate 1 P2: read never asks; write asks unless a human is talking straight to praw (`ctx.direct`) and nothing
 * untrusted has been read in this run (`ctx.tainted()`); destructive always asks. `direct` is false for delegated, voice,
 * schedule, watch, reminder, poll and import runs, so those always ask. The reason is shown to the approver, so it is
 * built from the validated call and redacted.
 */
export function approvalFor(
  kind: ToolKind,
  ctx: Pick<ToolContext, 'direct' | 'tainted'>,
  s: { tool: string; target: string; change: string },
): false | { reason: string } {
  if (kind === 'read') return false;
  if (kind === 'write' && isBotTalk(s.tool)) return false; // bot_talk (LF2)
  if (kind === 'write' && isNoApproval(s.tool)) return false; // RF27: diagram_create
  if (kind === 'write' && ctx.direct && !ctx.tainted()) return false;
  return { reason: redactText(`tool ${s.tool} on ${s.target}: ${s.change}`).slice(0, REASON_MAX) };
}

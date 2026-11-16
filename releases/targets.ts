import type { OutboundPayload } from '../agents/loop/payload.js';
import type { ActorRef } from '../company/types.js';
import type { ReleaseTarget } from '../db/repos/releases.js';
import { escapeCardText } from '../discord/embeds/approval.js';
import type { ForgeEnqueue } from '../forge/types.js';

/** The row a target acts on: only what the post needs, plus the pinned bytes. */
export interface ClaimedRelease {
  id: number; deptId: string; slug: string; title: string; summary: string; sha256: string; bytes: number; files: number;
  sourceChannelId: string; sourceThreadId: string | null; zip: Buffer;
  /** R7: only for `install_plugin` (null for handoff); `decidedBy` is the deciding admin's snowflake (the claim set it). */
  forgeId: number | null; pluginSlug: string | null; pluginManifestSha256: string | null; decidedBy: string | null;
}
export interface TargetDeps {
  postFile(actor: ActorRef, target: { channelId: string; threadId?: string }, p: OutboundPayload, f: { name: string; data: Buffer; contentType: string; nonce?: string }): Promise<string>;
  /** R7: a plain post (the install_plugin notice in the task thread); `opts.nonce` is sent with `enforceNonce`. */
  post(actor: ActorRef, target: { channelId: string; threadId?: string }, p: OutboundPayload, opts?: { nonce?: string }): Promise<string>;
  /** R7: validates the pinned bytes again and inserts the inert build row. Held by the release target deps only (PF-C13). */
  forge: ForgeEnqueue;
  secrets: readonly string[];
}
/** `certain`: Discord certainly refused the post (RL-C3), so nothing was released and the row may go back to pending. Anything else is unknown and never re-posted. */
/** `fail: 'plugin_invalid'` (R7): the stored plugin no longer passes the rules; the service closes the row `failed` and never reverts it. */
export type TargetResult = { ok: true; messageId: string } | { ok: false; certain: boolean; errName: string; fail?: 'plugin_invalid' };

export const SANDBOX_LINE = 'Do not run or install it on your own machine; open it in a sandbox.';

/**
 * RL-C3: Discord certainly refused when the target could not be resolved as denied, or answered with an HTTP 4xx on the one send (Missing Access, Missing
 * Permissions, Unknown Channel). A 5xx, a timeout (408 included), a network error or any other throw is unknown: the message may exist. `resolve()` in the
 * port throws plain Errors for a missing channel or thread; those read as unknown here (safe: never re-posted) until the port types them.
 */
export function certainRefusal(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { name?: unknown; status?: unknown };
  if (e.name === 'DeniedChannelError') return true;
  return typeof e.status === 'number' && Number.isInteger(e.status) && e.status >= 400 && e.status < 500 && e.status !== 408;
}

/**
 * G2-RL-08: the Discord nonce of the handoff post. @discordjs/rest resends a POST after a timeout or a 5xx; with `enforceNonce` Discord drops the duplicate
 * of the same nonce. Stable per release (its id and the pinned sha256), at most 25 characters, and it carries no token.
 */
export function handoffNonce(r: Pick<ClaimedRelease, 'id' | 'sha256'>): string {
  return `rel-${r.id}-${r.sha256.slice(0, 8)}`.slice(0, 25);
}

/** The post in the task thread (RL-C10: title and summary escaped; the summary labelled as bot text; RL-C8c: the sandbox sentence). One plain message at the worst case (tested). */
export function handoffBody(r: Pick<ClaimedRelease, 'id' | 'slug' | 'title' | 'summary' | 'files' | 'bytes' | 'sha256'>, secrets: readonly string[]): string {
  return `Release #${r.id} approved by a Bot Admin - ${escapeCardText(r.title, 100, secrets)}: ${r.slug}, ${r.files} file(s), ${r.bytes} bytes, sha256 ${r.sha256}.\n` +
    `Summary (written by the bot): ${escapeCardText(r.summary, 600, secrets)}\n${SANDBOX_LINE}`;
}

/** R7 PLUGIN-FORGE (spec 5.6): the card's fixed builder sentence. `base` is the checked-in base image id, or null when it is not usable. */
export const FORGE_BUILDER_LINE = (base: string | null): string =>
  `Build (fixed, by code): the shipped files are copied into the checked-in base image ${base === null ? '(not set up yet; builds wait)' : base.replace(/^sha256:/, '').slice(0, 12)} (Node 24, no npm) with docker create, cp and commit. Nothing from the plugin runs during the build and there is no network. The plugin cannot choose the base image, the user (65534), the entry point (node /srv/plugin/server.mjs), the class or a secret.`;
/** The thread notice of an approved plugin release (spec 5.6): it says the plugin is NOT installed. */
export const FORGE_HANDOFF_BODY = (r: { id: number; pluginSlug: string; sha256: string }): string =>
  `Release #${r.id} approved by a Bot Admin: code will build plugin ${r.pluginSlug} from these exact bytes (sha256 ${r.sha256.slice(0, 16)}) and stage it. It is NOT installed until a Bot Admin runs /mcp approve; do not say it is installed.`;

type Target = (r: ClaimedRelease, d: TargetDeps) => Promise<TargetResult>;

const handoff: Target = async (r, d) => {
  const target = { channelId: r.sourceChannelId, ...(r.sourceThreadId ? { threadId: r.sourceThreadId } : {}) };
  try {
    // posted from the pinned Buffer; a text-like content type would be rewritten by the port's redaction (RL-C9)
    const messageId = await d.postFile({ kind: 'head', dept: r.deptId as Extract<ActorRef, { kind: 'head' }>['dept'] }, target, { type: 'chat', noHandles: true, body: handoffBody(r, d.secrets) }, { name: `${r.slug}.zip`, data: r.zip, contentType: 'application/zip', nonce: handoffNonce(r) });
    return { ok: true, messageId };
  } catch (err) {
    return { ok: false, certain: certainRefusal(err), errName: err instanceof Error ? err.name : 'unknown' };
  }
};

/**
 * R7 PLUGIN-FORGE (spec 3.4): `install_plugin` does not install anything. It validates the pinned bytes again and inserts the inert build row (`forge`), then posts the notice in the task
 * thread as the software head (the message id that `releases_released` needs). A build row that was inserted is harmless when the post then fails: the builder takes only builds whose release is
 * `released`, and the reconcile cancels the rest. An invalid stored plugin is `fail:'plugin_invalid'` (never reverted); an enqueue exception is a certain failure (nothing happened).
 */
const installPlugin: Target = async (r, d) => {
  if (r.forgeId === null || r.pluginSlug === null || r.pluginManifestSha256 === null || r.decidedBy === null) return { ok: false, certain: true, errName: 'plugin_row' };
  try {
    const q = await d.forge({ releaseId: r.id, forgeId: r.forgeId, pluginSlug: r.pluginSlug, sha256: r.sha256, bytes: r.bytes, manifestSha256: r.pluginManifestSha256, decidedBy: r.decidedBy, zip: r.zip });
    if (!q.ok) return q.code === 'plugin_invalid' ? { ok: false, certain: true, errName: 'plugin_invalid', fail: 'plugin_invalid' } : { ok: false, certain: true, errName: 'forge_enqueue' };
  } catch (err) {
    return { ok: false, certain: true, errName: err instanceof Error ? err.name : 'unknown' };
  }
  const target = { channelId: r.sourceChannelId, ...(r.sourceThreadId ? { threadId: r.sourceThreadId } : {}) };
  try {
    const messageId = await d.post({ kind: 'head', dept: r.deptId as Extract<ActorRef, { kind: 'head' }>['dept'] }, target, { type: 'chat', noHandles: true, body: FORGE_HANDOFF_BODY({ id: r.id, pluginSlug: r.pluginSlug, sha256: r.sha256 }) }, { nonce: handoffNonce(r) });
    return { ok: true, messageId };
  } catch (err) {
    return { ok: false, certain: certainRefusal(err), errName: err instanceof Error ? err.name : 'unknown' };
  }
};

/** The extension point (spec 3.9). R7 added `install_plugin` (migration 048 widened `releases_target_check`; its Gate is docs/security/2026-11-13-gate1-forge.md). R6 (MCP-1) does NOT add `install_mcp` (spec D10): MCP servers are installed by the Bot Admin `/mcp` commands, not by a release. */
export const RELEASE_TARGETS: Readonly<Record<ReleaseTarget, Target>> = Object.freeze({ handoff, install_plugin: installPlugin });

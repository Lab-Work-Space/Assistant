import type { ForgeCancelResult } from '../../forge/types.js';
import { escapeCardText } from '../embeds/approval.js';
import { configReply, ephemeral, type Handler, type InteractionLike } from './types.js';

/**
 * R7 PLUGIN-FORGE `/forge list|show|cancel` (spec 5.8, FG-AC23). Bot Admin in #setting only: `decide()` in commands/index.ts already checked the guild, the channel and this interaction's live
 * admin role (the same guard as `/release` and `/mcp`). The handler gets `deps.forge`, three closures (`forgeCommandDeps`), never the service: there is no build, retry, stage, install or GC
 * here. Every reply is ephemeral. Idea names are tokens and project titles are model text, so everything goes through `escapeCardText`. Nothing echoes input.
 */
const NO_FORGE = ephemeral('The plugin forge is not available.');
const idOf = (i: InteractionLike): number | null => {
  const n = i.options.integer('id');
  return typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 ? n : null;
};

const CANCEL_TEXT: Record<'not_found' | 'not_open' | 'busy' | 'exception', string> = {
  not_found: 'No forge with that number.',
  not_open: 'That forge is already installed or cancelled.',
  busy: 'A build of that forge is building right now; try again when it has finished.',
  exception: 'That could not be done now; nothing was changed.',
};

export const forgeList: Handler = async (_i, deps) => {
  if (!deps.forge) return NO_FORGE;
  const rows = await deps.forge.list(25);
  if (!rows.length) return configReply('Plugin forges', 'No forges yet.', { ephemeral: true });
  const secrets = deps.secrets ?? [];
  return configReply('Plugin forges', `${rows.length} most recent. Details: /forge show.`, {
    ephemeral: true,
    fields: rows.slice(0, 25).map((r) => ({
      name: `#${Math.trunc(r.id)} ${escapeCardText(r.ideaName, 40, secrets)} (${escapeCardText(r.status, 16, secrets)})`.slice(0, 256),
      value: `idea #${Math.trunc(r.ideaId)}, ${escapeCardText(r.deptId, 32, secrets)}, project #${Math.trunc(r.projectId)}; server ${r.serverSlug ? escapeCardText(r.serverSlug, 16, secrets) : '-'}; last build ${r.lastBuild ? `#${Math.trunc(r.lastBuild.id)} ${escapeCardText(r.lastBuild.status, 16, secrets)}${r.lastBuild.code ? ` (${escapeCardText(r.lastBuild.code, 40, secrets)})` : ''}` : '-'}`.slice(0, 1024),
    })),
  });
};

export const forgeShow: Handler = async (i, deps) => {
  if (!deps.forge) return NO_FORGE;
  const id = idOf(i);
  if (id === null) return ephemeral('Give a forge number.');
  const d = await deps.forge.show(id);
  if (!d) return ephemeral('No forge with that number.');
  const s = deps.secrets ?? [];
  const e = (t: string, n: number): string => escapeCardText(t, n, s);
  const lines = [
    `**Forge #${Math.trunc(d.id)}** (${e(d.status, 16)}${d.closeReason ? `, ${e(d.closeReason, 32)}` : ''}). Tool idea #${Math.trunc(d.ideaId)} ${e(d.ideaName, 40)} from ${e(d.deptId, 32)}.`,
    `Project #${Math.trunc(d.projectId)} ${e(d.projectTitle, 60)} (${e(d.projectStatus, 16)}).`,
    `Releases: ${d.releases.length ? d.releases.map((r) => `#${Math.trunc(r.id)} ${e(r.status, 16)}`).join(', ') : 'none'}.`,
    ...d.builds.map((b) => `Build #${Math.trunc(b.id)} (release #${Math.trunc(b.releaseId)}): ${e(b.status, 16)}${b.code ? ` (${e(b.code, 40)})` : ''}, attempts ${Math.trunc(b.attempts)}${b.image12 ? `, image ${e(b.image12, 12)}` : ''}.`),
    d.server ? `Server ${e(d.server.slug, 16)} (${e(d.server.status, 16)}). See /mcp show slug:${e(d.server.slug, 16)}.` : 'No server staged.',
  ];
  return configReply(`Forge #${Math.trunc(d.id)}`, lines.join('\n'), { ephemeral: true });
};

const cancelText = (id: number, r: ForgeCancelResult): string => {
  if (!r.ok) return CANCEL_TEXT[r.code];
  return `Forge #${id} is cancelled. Queued builds were cancelled.${r.serverSlug ? ` Its server ${escapeCardText(r.serverSlug, 16, [])} (${escapeCardText(r.serverStatus ?? '', 16, [])}) was not touched; use /mcp disable slug:${escapeCardText(r.serverSlug, 16, [])} if it should go.` : ''}`;
};

export const forgeCancel: Handler = async (i, deps) => {
  if (!deps.forge) return NO_FORGE;
  const id = idOf(i);
  if (id === null) return ephemeral('Give a forge number.');
  return ephemeral(cancelText(id, await deps.forge.cancel({ id, userId: i.userId })));
};

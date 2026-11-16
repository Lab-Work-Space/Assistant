import type { ReleaseView } from '../../db/repos/releases.js';
import { RELEASE_CARD_ID, escapeCardText } from '../embeds/approval.js';
import { configReply, ephemeral, type Handler, type InteractionLike } from './types.js';

const NO_RELEASES = ephemeral('Releases are not available.');
const link = (guildId: string, r: ReleaseView): string | null =>
  r.releasedMessageId ? `https://discord.com/channels/${guildId}/${r.sourceThreadId ?? r.sourceChannelId}/${r.releasedMessageId}` : null;
const when = (d: Date | null): string => (d ? `<t:${Math.floor(d.getTime() / 1000)}:f>` : '-');

/**
 * `relcard:<token>:approve|reject` (R5 RELEASE-1, Gate 1 RL-C11). decide() already checked the guild, #⚙️-setting and this click's live Bot Admin role, and route()
 * sends only this exact id shape here. ReleaseService.decide() then checks the stored card (channel and message id), the row's status and expiry, the halt flag and
 * the kill switch, and does the one conditional claim. The custom id carries a random token and nothing else.
 */
export const releaseCardButton: Handler = async (i, deps) => {
  const m = RELEASE_CARD_ID.exec(i.customId);
  if (!m || !deps.releases) return m ? NO_RELEASES : ephemeral('Unknown action.');
  const action = m[2] as 'approve' | 'reject';
  const r = await deps.releases.decide({ token: m[1]!, action, userId: i.userId, channelId: i.channelId, messageId: i.messageId ?? null });
  if (!r.ok) return ephemeral(r.text);
  if (action === 'reject') return ephemeral('Rejected. Nothing was released.');
  if (r.row.target === 'install_plugin') return ephemeral(`Approved #${r.row.id}: the build is queued. Nothing is installed until a Bot Admin runs /mcp approve on the staged server.`);
  return ephemeral(`Released #${r.row.id}: posted in the task thread.`);
};

/** `/release list`: the newest requests (number, slug, status, escaped title; never the summary or the bytes). */
export const releaseList: Handler = async (_i, deps) => {
  if (!deps.releases) return NO_RELEASES;
  const rows = await deps.releases.list(25);
  if (!rows.length) return configReply('Releases', 'No releases yet.', { ephemeral: true });
  const secrets = deps.secrets ?? [];
  return configReply('Releases', `${rows.length} most recent. Details: /release show.`, {
    ephemeral: true,
    fields: rows.slice(0, 25).map((r) => ({
      name: `#${Math.trunc(r.id)} ${r.slug} (${r.status})`.slice(0, 256),
      value: `${escapeCardText(r.title, 100, secrets) || '-'} - ${r.files} file(s), ${r.bytes} bytes, ${r.deptId}`.slice(0, 1024),
    })),
  });
};

const idOf = (i: InteractionLike): number | null => {
  const n = i.options.integer('id');
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : null;
};

/** `/release show id`: one request. The bot text (title, summary) is escaped and labelled; a released row links its message so a forged "approved" line can be checked (RL-C10). */
export const releaseShow: Handler = async (i, deps) => {
  if (!deps.releases) return NO_RELEASES;
  const id = idOf(i);
  if (id === null) return ephemeral('Give a release number.');
  const r = await deps.releases.show(id);
  if (!r) return ephemeral('No release with that number.');
  const secrets = deps.secrets ?? [];
  const url = link(deps.guildId, r);
  const runs = r.evidence.runs.length
    ? r.evidence.runs.map((x) => `- ws_run ${x.verb}: ${/^exit=(-?\d+)$/.test(x.result) ? `exit ${x.result.slice(5)}` : x.result} (${when(new Date(x.at))})`).join('\n')
    : 'No test run recorded for this workspace.';
  const lines = [
    `**${escapeCardText(r.title, 100, secrets)}**`,
    `Status: ${r.status}${r.outcome ? ` (${r.outcome})` : ''}. Department ${r.deptId}. Requested ${when(r.createdAt)}, expires ${when(r.expiresAt)}.`,
    ...(r.target === 'install_plugin' ? [`Target: install_plugin. Plugin ${escapeCardText(r.pluginSlug ?? '', 16, secrets)} (forge #${Math.trunc(r.forgeId ?? 0)}), manifest ${(r.pluginManifestSha256 ?? '').slice(0, 16)}.`] : []),
    `Artefact: workspace ${r.slug}, ${r.files} file(s), ${r.bytes} bytes, sha256 ${r.sha256}.`,
    r.tainted ? 'The requesting run read outside content (tainted).' : 'Whether earlier runs that wrote these files read outside content is not tracked.',
    `Summary (written by the bot): ${escapeCardText(r.summary, 600, secrets)}`,
    `Evidence (recorded by code):\n${runs}`,
    r.decidedBy ? `Decided by <@${r.decidedBy}> ${when(r.decidedAt)}.` : 'Not decided yet.',
    ...(r.reason ? [`Reason from a Bot Admin: ${escapeCardText(r.reason, 200, secrets)}`] : []),
    ...(url ? [`Released message: ${url}`] : []),
  ];
  return configReply(`Release #${Math.trunc(r.id)}`, lines.join('\n'), { ephemeral: true });
};

/** `/release reject id reason`: a Bot Admin in #setting (decide()). The service screens the reason; the stored, screened text goes to the head (RL-C10 scoped exception). */
export const releaseReject: Handler = async (i, deps) => {
  if (!deps.releases) return NO_RELEASES;
  const id = idOf(i);
  if (id === null) return ephemeral('Give a release number.');
  const r = await deps.releases.reject({ id, userId: i.userId, reason: i.options.string('reason') ?? '' });
  return ephemeral(r.ok ? 'Rejected. Nothing was released.' : r.text);
};

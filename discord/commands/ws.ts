import { escapeCardText } from '../embeds/approval.js';
import { SLUG_RE } from '../../workspaces/files.js';
import { configReply, ephemeral, type CommandDeps, type Handler } from './types.js';

const NO_WS = ephemeral('Workspaces are not available in this process.');
const need = (deps: CommandDeps) => deps.ws ?? null;

const size = (n: number): string => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(1)} MiB`);

/** `/ws list`: every workspace with its status and size (up to 25 rows). Titles are bot-written: card-escaped and cut. */
export const wsList: Handler = async (_i, deps) => {
  const w = need(deps);
  if (!w) return NO_WS;
  const rows = await w.list();
  if (!rows.length) return configReply('Workspaces', 'No workspaces yet.', { ephemeral: true });
  return configReply('Workspaces', `${rows.length} workspace${rows.length === 1 ? '' : 's'}. Archive one with /ws archive.`, {
    ephemeral: true,
    fields: rows.slice(0, 25).map((r) => ({
      name: `${r.slug} (${r.status})`.slice(0, 256),
      value: `${escapeCardText(r.title, 100, deps.secrets ?? []) || '-'} - ${size(r.bytes)}, node_modules ${size(r.nmBytes)}`,
    })),
  });
};

/** `/ws archive slug`: the workspace becomes read-only. Bot Admin in #setting only (decide()); audited with the slug. */
export const wsArchive: Handler = async (i, deps) => {
  const w = need(deps);
  if (!w) return NO_WS;
  const slug = (i.options.string('slug') ?? '').trim();
  if (slug.length < 3 || !SLUG_RE.test(slug)) return ephemeral('Give a workspace name of 3 to 40 characters (a-z, 0-9, -, starting with a letter).');
  const ok = await w.archive(slug, i.userId);
  await deps.audit({ actor: `user:${i.userId}`, action: 'ws.archive', tool: 'ws', outcome: slug });
  return ok ? configReply('Workspace archived', `${slug} is now read-only.`, { ephemeral: true }) : ephemeral('No active workspace with that name.');
};

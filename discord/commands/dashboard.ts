import { ephemeral, type Handler } from './types.js';

/**
 * `/dashboard` (Gate 1 S41). The guard already checked guild, #setting and the Bot Admin role of this interaction. The reply is ephemeral
 * with link previews suppressed, and the link is wrapped in angle brackets as well so Discord does not unfurl it.
 */
export const dashboardCmd: Handler = async (i, deps) => {
  if (!deps.dashboard) return ephemeral('The dashboard is only available when the assistant runs in local mode.');
  const r = await deps.dashboard.link(i.userId);
  if (!r.ok) return ephemeral(r.error);
  return { ...ephemeral(`Dashboard sign-in (works once, valid 5 minutes, opens on your own computer only):\n<${r.url}>`), suppressEmbeds: true };
};

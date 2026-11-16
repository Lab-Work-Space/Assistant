import { escapeCardText } from '../embeds/approval.js';
import { configReply, ephemeral, type CommandDeps, type Handler, type Reply } from './types.js';

/** Every reply of /tool is ephemeral (the deferral in commands/index.ts is ephemeral too). */
const priv = (title: string, body: string, fields?: { name: string; value: string }[]): Reply => configReply(title, body, { ephemeral: true, ...(fields ? { fields } : {}) });
const NO_GROW = ephemeral('Tool requests and ideas are not available in this process.');
const need = (deps: CommandDeps) => deps.grow ?? null;
const day = (d: Date): string => d.toISOString().slice(0, 10);

/** `/tool ideas`: up to 25 open ideas. The text is bot-written and untrusted: card-escaped and cut; a tainted run's idea is marked UNVERIFIED. */
export const toolIdeas: Handler = async (_i, deps) => {
  const g = need(deps);
  if (!g) return NO_GROW;
  const rows = await g.ideas.list(25);
  if (!rows.length) return priv('Tool ideas', 'No tool ideas are open.');
  return priv('Tool ideas', `${rows.length} open. Close one with /tool idea_close.`, rows.map((r) => ({
    name: `#${r.id} ${r.deptId} ${r.name} (${day(r.createdAt)})${r.tainted ? ' UNVERIFIED' : ''}`.slice(0, 256),
    value: escapeCardText(r.problem, 200, deps.secrets ?? []) || '-',
  })));
};

export const toolIdeaClose: Handler = async (i, deps) => {
  const g = need(deps);
  if (!g) return NO_GROW;
  const id = i.options.integer('id');
  if (id === null || id < 1) return ephemeral('Unknown idea.');
  const r = await g.ideas.close(id, i.userId, i.options.string('reason'));
  return r.ok ? ephemeral(`Idea #${id} closed.`) : ephemeral(r.text);
};

/** `/tool requests`: pending requests (ids, department, tool; never the reason). */
export const toolRequests: Handler = async (_i, deps) => {
  const g = need(deps);
  if (!g) return NO_GROW;
  const rows = await g.requests.listPending(25);
  if (!rows.length) return priv('Tool requests', 'No tool requests are waiting.');
  return priv('Tool requests', `${rows.length} waiting.`, rows.map((r) => ({
    name: `#${r.id} ${r.deptId} ${r.tool}`.slice(0, 256),
    value: `${r.messageId ? 'card posted' : 'no card'}, expires <t:${Math.floor(r.expiresAt.getTime() / 1000)}:R>`,
  })));
};

import { PROJECT_BUDGET_ID, PROJECT_CARD_ID, escapeCardText } from '../embeds/approval.js';
import { configReply, ephemeral, type CommandDeps, type Handler, type Reply } from './types.js';

/** AUTO-1: every reply of /project and of its buttons is ephemeral (the deferral in commands/index.ts is ephemeral too). decide() already checked the guild, #⚙️-setting and this click's live Bot Admin role. */
const NO_PROJECTS = ephemeral('Projects are not available in this process.');
const need = (deps: CommandDeps) => deps.projects ?? null;
const priv = (title: string, body: string, fields?: { name: string; value: string }[]): Reply => configReply(title, body, { ephemeral: true, ...(fields ? { fields } : {}) });
const n2 = (n: unknown): string => Number(n).toFixed(2);

/** `projcard:<token>:approve|reject`: only this exact id shape reaches here (route()); the service checks the stored card, the status and the expiry. */
export const projectCardButton: Handler = async (i, deps) => {
  const m = PROJECT_CARD_ID.exec(i.customId);
  const p = need(deps);
  if (!m || !p) return ephemeral('Unknown action.');
  const action = m[2] as 'approve' | 'reject';
  const r = await p.decideCard({ token: m[1]!, action, userId: i.userId, channelId: i.channelId, messageId: i.messageId ?? null });
  if (!r.ok) return ephemeral(r.text);
  if (r.result === 'rejected') return ephemeral('Rejected. Nothing started.');
  return ephemeral(`Approved: project #${r.project.id} started. Root task ${r.root.id.slice(0, 8)}. Adopted ${r.adopted}, skipped ${r.skipped.length}.`);
};

/** `projbud:<token>:raise|close`. */
export const projectBudgetButton: Handler = async (i, deps) => {
  const m = PROJECT_BUDGET_ID.exec(i.customId);
  const p = need(deps);
  if (!m || !p) return ephemeral('Unknown action.');
  const action = m[2] as 'raise' | 'close';
  const r = await p.decideBudget({ token: m[1]!, action, userId: i.userId, channelId: i.channelId, messageId: i.messageId ?? null });
  if (!r.ok) return ephemeral(r.text);
  return ephemeral(r.result === 'raised' ? `Raised. ${r.unblocked} blocked task${r.unblocked === 1 ? '' : 's'} restarted.` : `Project #${r.project.id} closed.`);
};

/** `/project start`: the same rules as the CEO's proposal; the card goes to #setting for a (second) Bot Admin or this one to approve. */
export const projectStart: Handler = async (i, deps) => {
  const p = need(deps);
  if (!p) return NO_PROJECTS;
  const r = await p.start({
    userId: i.userId, title: i.options.string('title') ?? '', goal: i.options.string('goal') ?? '', deadline: i.options.string('deadline') ?? '',
    usd: i.options.number('usd') ?? Number.NaN, calls: i.options.integer('calls') ?? Number.NaN, adopt: i.options.string('adopt'), idea: i.options.integer('idea'),
  });
  return ephemeral(r.ok ? r.text : r.error);
};

/** `/project list`: up to 25 rows, newest first. Titles are model- or admin-written text: card-escaped and cut. */
export const projectList: Handler = async (_i, deps) => {
  const p = need(deps);
  if (!p) return NO_PROJECTS;
  // AUTO-2 (SA-1 5.7): the scope line first; a read error shows "project"
  let company = false;
  try { company = deps.cfg.get('autopilot.scope') === 'company'; } catch { company = false; }
  const scope = company ? 'Autopilot scope: company (task trees outside a project run without cards, except dangerous work)' : 'Autopilot scope: project';
  const rows = await p.list(25);
  if (!rows.length) return priv('Projects', `${scope}\nNo projects yet.`);
  const now = (deps.now ?? (() => new Date()))().getTime();
  return priv('Projects', `${scope}\n${rows.length} shown, newest first.`, rows.map((r) => ({
    name: `#${r.id} ${r.status}${r.paused ? ' paused' : ''}${r.status === 'proposed' && r.expiresAt.getTime() <= now ? ' (expired)' : ''}${r.status === 'proposed' && !r.messageId ? ' (no card)' : ''}${r.status === 'active' && r.pastDeadline ? ' (past deadline)' : ''}${r.exhaustedAt && r.status === 'active' ? ' (budget used up)' : ''}`.slice(0, 256),
    value: `${escapeCardText(r.title, 60, deps.secrets ?? [])} | deadline ${r.deadline} | calls ${Math.trunc(Number(r.calls))}/${r.maxLocalCalls} | usd ${n2(r.usd)}/${n2(r.maxUsd)} | approvals ${r.approvalsUsed}/${r.maxApprovals}${r.rootTaskId ? ` | root ${r.rootTaskId.slice(0, 8)}` : ''}`.slice(0, 1024),
  })));
};

const idOf = (v: number | null): number | null => (v !== null && Number.isSafeInteger(v) && v >= 1 ? v : null);
const idCmd = (run: (p: NonNullable<CommandDeps['projects']>, id: number, by: string) => Promise<{ text: string }>): Handler => async (i, deps) => {
  const p = need(deps);
  if (!p) return NO_PROJECTS;
  const id = idOf(i.options.integer('id'));
  if (id === null) return ephemeral('No project with that number.');
  return ephemeral((await run(p, id, i.userId)).text);
};

export const projectPause = idCmd((p, id, by) => p.pause(id, by));
export const projectResume = idCmd((p, id, by) => p.resume(id, by));
export const projectClose = idCmd((p, id, by) => p.close(id, by));
export const projectRaise = idCmd((p, id, by) => p.raise(id, by));
export const projectExtend: Handler = async (i, deps) => {
  const p = need(deps);
  if (!p) return NO_PROJECTS;
  const id = idOf(i.options.integer('id'));
  if (id === null) return ephemeral('No project with that number.');
  return ephemeral((await p.extend(id, i.options.string('date') ?? '', i.userId)).text);
};

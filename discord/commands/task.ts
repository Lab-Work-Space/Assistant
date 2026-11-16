import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { redactText } from '../../core/logger.js';
import type { AdminTaskRow, Task, TaskStatus } from '../../db/repos/tasks.js';
import { TASK_OPEN_STATUSES } from '../../db/repos/tasks.js';
import { cancelDigest, TASK_CANCEL_MAX } from '../../governance/approval/approvals.js';
import { retryBlocked } from '../../agents/tasks/retry.js';
import { escapeCardText } from '../embeds/approval.js';
import type { NonceEntry } from './task-nonce.js';
import { ephemeral, type CommandDeps, type Handler, type InteractionLike, type Reply, type TaskAdminDeps } from './types.js';

/**
 * TASKADMIN-1: `/task list|cancel|retry|done` and the `taskadm:` confirm buttons. Reached only through decide() (guild, #⚙️-setting, the live Bot Admin role),
 * by a COMMAND_TABLE row or by route() for a button. No tool, AdminOp, config key or Praw command leads here (TA-C1). Every reply is ephemeral with no
 * mentions; the only database text in a reply is id8, dept and status (code-controlled words) plus a masked, one-line, cut title and note (TA-C4).
 */

/** TA-C2: the exact button id. */
export const TASKADM_ID = /^taskadm:(cancel|dismiss|done):([0-9a-f]{16})$/;
const ID_REF = /^[0-9a-f-]{6,36}$/;
const NOT_AVAILABLE = 'Task administration is not available.';
const REPLY_MAX = 2000;
const LIST_MAX = 25;
const SHOWN_CHILDREN = 10;
const NO_ROLLUP: readonly TaskStatus[] = ['done', 'cancelled', 'awaiting_approval'];
const ENDED: readonly TaskStatus[] = ['done', 'cancelled'];

type Code = 'E_BAD_ID' | 'E_NOT_FOUND' | 'E_AMBIGUOUS' | 'E_ENDED' | 'E_OPEN_CHILDREN' | 'E_TOO_MANY' | 'E_TOO_DEEP' | 'E_STALE' | 'E_HALTED' | 'E_NOT_BLOCKED' | 'E_TREE_ENDED' | 'E_TURNS' | 'E_NOT_REVIEW' | 'E_PENDING' | 'E_RUNNING';

const id8 = (id: string): string => id.slice(0, 8);
const word = (s: string): string => s.replace(/[^A-Za-z0-9_:-]/g, '').slice(0, 24);
const fold = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** One line, masked before the cut, markdown and mentions escaped (escapeCardText); `max` characters then an ellipsis. */
const esc = (s: string, max: number, secrets: readonly string[]): string => escapeCardText(fold(s), max + 1, secrets);
const ownerLabel = (o: Task['owner']): string => (o.kind === 'head' ? `head of ${word(o.dept)}` : word(o.personaId));
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

const audit = (deps: CommandDeps, i: InteractionLike, action: string, taskId: string | null, outcome: string, tool?: string): Promise<void> =>
  deps.audit({ actor: `user:${i.userId}`, action, taskId, ...(tool ? { tool } : {}), outcome }).catch(() => undefined);

// ---- id resolution (TA-C3) ------------------------------------------------------------------------------------------------------------------------------

export type Resolved =
  | { ok: true; id: string; deptId: string; status: TaskStatus }
  | { ok: false; code: 'E_BAD_ID' | 'E_NOT_FOUND' }
  | { ok: false; code: 'E_AMBIGUOUS'; lines: string[] };

/** The regex runs before any SQL (so `%`, `_` and `\` never reach the LIKE); `LIMIT 6`, at most 5 listed. */
export async function resolveTaskRef(ref: string, tasks: Pick<TaskAdminDeps['tasks'], 'findByIdPrefix'>): Promise<Resolved> {
  const p = ref.trim().toLowerCase();
  if (!ID_REF.test(p)) return { ok: false, code: 'E_BAD_ID' };
  const rows = await tasks.findByIdPrefix(p, 6);
  if (rows.length === 0) return { ok: false, code: 'E_NOT_FOUND' };
  if (rows.length > 1) return { ok: false, code: 'E_AMBIGUOUS', lines: rows.slice(0, 5).map((r) => `${id8(r.id)} ${word(r.deptId)} ${word(r.status)}`) };
  const r = rows[0]!;
  return { ok: true, id: r.id, deptId: r.deptId, status: r.status };
}

const refusalText = (r: Exclude<Resolved, { ok: true }>): string =>
  r.code === 'E_AMBIGUOUS' ? `Several tasks match: ${r.lines.join('; ')}. Give more characters.`
  : r.code === 'E_BAD_ID' ? 'Give at least 6 characters of the task id (0-9, a-f).'
  : 'No task matches that id.';

/** Resolves the `task` option; a refusal is audited (ids and codes only) and answered with the fixed text. */
async function resolve(i: InteractionLike, deps: CommandDeps, ta: TaskAdminDeps, action: string): Promise<Extract<Resolved, { ok: true }> | Reply> {
  const r = await resolveTaskRef(i.options.string('task') ?? '', ta.tasks);
  if (r.ok) return r;
  await audit(deps, i, action, null, `refused:${r.code}`);
  return ephemeral(refusalText(r));
}
const isReply = (x: unknown): x is Reply => typeof x === 'object' && x !== null && 'allowedMentions' in x;

const refuse = async (deps: CommandDeps, i: InteractionLike, action: string, taskId: string, code: Code, text: string): Promise<Reply> => {
  await audit(deps, i, action, taskId, `refused:${code}`);
  return ephemeral(text);
};

// ---- /task list -------------------------------------------------------------------------------------------------------------------------------------------

const FILTERS: Record<string, readonly TaskStatus[]> = {
  open: TASK_OPEN_STATUSES, blocked: ['blocked'], review: ['review'], doing: ['doing'], todo: ['todo'], awaiting_approval: ['awaiting_approval'],
};

function idle(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

/** `/task list [status]`: the open tasks, stalest first (a read: not audited, like /holiday list). */
export const taskList: Handler = async (i, deps) => {
  const ta = deps.taskAdmin;
  if (!ta) return ephemeral(NOT_AVAILABLE);
  const filter = i.options.string('status') ?? 'open';
  const statuses = FILTERS[filter];
  if (!statuses) return ephemeral('Unknown status filter.');
  const secrets = deps.secrets ?? [];
  const now = (deps.now?.() ?? new Date()).getTime();
  const counts = await ta.tasks.countByStatus();
  const open = Object.values(counts).reduce((a, b) => a + b, 0);
  const total = filter === 'open' ? open : counts[filter as keyof typeof counts] ?? 0;
  const rows = await ta.tasks.listOpenAdmin(statuses, LIST_MAX + 1);
  const cap = deps.cfg.get('limits.childrenPerTask');
  const header = `Open ${open}/${deps.cfg.get('limits.openTasks')} (limits.openTasks) · todo ${counts.todo} · doing ${counts.doing} · review ${counts.review} · blocked ${counts.blocked} · awaiting ${counts.awaiting_approval}`;
  const line = (r: AdminTaskRow): string => {
    const state = r.status === 'blocked' ? `blocked:${word(r.blockedReason ?? 'owner')}` : word(r.status);
    const note = r.status === 'blocked' && (r.blockedReason ?? 'owner') === 'owner' && r.blockedNote ? ` — ${esc(r.blockedNote, 80, secrets)}` : '';
    return `${id8(r.id)} · ${word(r.deptId)} · ${state} · idle ${idle(now - new Date(r.updatedAt).getTime())} · open children ${r.openChildren}/${cap} · ${r.depth === 0 ? 'root' : `d${r.depth}`} · ${esc(r.title, 40, secrets)}${note}`;
  };
  const lines = rows.slice(0, LIST_MAX).map(line);
  const build = (n: number): string => {
    const more = total - n;
    return [header, ...lines.slice(0, n), ...(more > 0 ? [`… and ${more} more`] : [])].join('\n');
  };
  let n = lines.length;
  while (n > 0 && build(n).length > REPLY_MAX) n--; // the bound is on the final, escaped text
  return ephemeral(build(n).slice(0, REPLY_MAX));
};

// ---- buttons ----------------------------------------------------------------------------------------------------------------------------------------------

function confirmButtons(kind: 'cancel' | 'done', nonce: string, label: string): Reply['components'] {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`taskadm:${kind}:${nonce}`).setLabel(label).setStyle(kind === 'cancel' ? ButtonStyle.Danger : ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`taskadm:dismiss:${nonce}`).setLabel('Dismiss').setStyle(ButtonStyle.Secondary),
  ).toJSON()];
}

const STALE = 'The task changed or the confirmation expired. Run the command again.';

// ---- /task cancel -----------------------------------------------------------------------------------------------------------------------------------------

/** `/task cancel task:<id> [cascade:children] [reason]`, step A: checks, then a confirm reply with a single-use button. Nothing is changed here. */
export const taskCancel: Handler = async (i, deps) => {
  const ta = deps.taskAdmin;
  if (!ta) return ephemeral(NOT_AVAILABLE);
  const secrets = deps.secrets ?? [];
  const cascadeOpt = i.options.string('cascade');
  if (cascadeOpt !== null && cascadeOpt !== 'children') return ephemeral('Unknown cascade option.');
  const cascade = cascadeOpt === 'children';
  const reasonRaw = i.options.string('reason');
  const reason = reasonRaw ? fold(redactText(reasonRaw, secrets)).slice(0, 200) || null : null; // TA-C12: masked before the cut
  const ref = await resolve(i, deps, ta, 'task.cancel');
  if (isReply(ref)) return ref;
  const target = await ta.tasks.get(ref.id);
  if (!target || ENDED.includes(target.status)) return refuse(deps, i, 'task.cancel', ref.id, 'E_ENDED', 'That task is already done or cancelled.');
  const sub = await ta.tasks.openSubtree(ref.id);
  if (sub.tooDeep) return refuse(deps, i, 'task.cancel', ref.id, 'E_TOO_DEEP', 'Refused: the task tree is deeper than 20 levels, so it cannot be cancelled in one step.');
  if (!sub.rows.length) return refuse(deps, i, 'task.cancel', ref.id, 'E_ENDED', 'That task is already done or cancelled.');
  const kids = sub.rows.filter((r) => r.id !== ref.id);
  if (!cascade && kids.length > 0) return refuse(deps, i, 'task.cancel', ref.id, 'E_OPEN_CHILDREN', `That task has ${plural(kids.length, 'open subtask')}. Add cascade:children to cancel them too.`);
  if (sub.rows.length > TASK_CANCEL_MAX) return refuse(deps, i, 'task.cancel', ref.id, 'E_TOO_MANY', `Refused: more than ${TASK_CANCEL_MAX} tasks would be cancelled.`);
  const digest = cancelDigest(sub.rows, cascade);
  const ids = sub.rows.map((r) => r.id);
  const pending = await ta.tasks.pendingApprovalCount(ids);
  const running = ids.filter((id) => ta.taskRuns.active(id)).length;
  const nonce = ta.nonces.issue({ kind: 'cancel', userId: i.userId, targetId: ref.id, digest, cascade, reason });
  const lines = [
    `**Cancel ${plural(ids.length, 'task')}?** This cannot be undone.`,
    `Target \`${id8(target.id)}\` · ${word(target.deptId)} · ${word(target.status)} · ${ownerLabel(target.owner)} · ${esc(target.title, 60, secrets)}`,
    ...(kids.length ? [`Subtasks (${kids.length}): ${kids.slice(0, SHOWN_CHILDREN).map((r) => `${id8(r.id)} ${word(r.deptId)} ${word(r.status)}`).join('; ')}${kids.length > SHOWN_CHILDREN ? ` … and ${kids.length - SHOWN_CHILDREN} more` : ''}`] : []),
    `Pending approvals that will expire: ${pending}`,
    ...(target.id === target.rootId ? ['This is the root: the task tree and its web grants end.'] : []),
    `Running now: ${running ? `yes (${plural(running, 'task')}), the model call stops` : 'no'}`,
    ...(reason ? [`Reason: ${esc(reason, 200, secrets)}`] : []),
    'Valid for 5 minutes.',
  ];
  return { content: lines.join('\n').slice(0, REPLY_MAX), ephemeral: true, allowedMentions: { parse: [] }, components: confirmButtons('cancel', nonce, `Cancel ${plural(ids.length, 'task')}`) };
};

/** Step B: the click. The nonce is checked first (same user, unexpired, single use); then Approvals.adminCancel decides under its locks. */
async function cancelClick(i: InteractionLike, deps: CommandDeps, ta: TaskAdminDeps, n: NonceEntry): Promise<Reply> {
  const tail = n.reason ? ` reason=${n.reason}` : '';
  let aborted = 0;
  let res: Awaited<ReturnType<TaskAdminDeps['approvals']['adminCancel']>>;
  try {
    res = await ta.approvals.adminCancel({ target: n.targetId, cascade: n.cascade, digest: n.digest, userId: i.userId, ...(n.reason ? { reason: n.reason } : {}) }, (ids) => { aborted = ta.taskRuns.abort(ids); });
  } catch (err) {
    await audit(deps, i, 'task.cancel', n.targetId, 'error', `cascade:${n.cascade ? 'children' : 'no'}`);
    throw err;
  }
  if (!res.ok) {
    if (res.error === 'stale') {
      await audit(deps, i, 'task.cancel', n.targetId, 'stale');
      return ephemeral(STALE);
    }
    const code: Code = res.error === 'not_found' ? 'E_NOT_FOUND' : res.error === 'ended' ? 'E_ENDED' : res.error === 'too_many' ? 'E_TOO_MANY' : res.error === 'too_deep' ? 'E_TOO_DEEP' : 'E_OPEN_CHILDREN';
    await audit(deps, i, 'task.cancel', n.targetId, `refused:${code}`);
    return ephemeral(code === 'E_NOT_FOUND' ? 'No task matches that id.' : code === 'E_ENDED' ? 'That task is already done or cancelled.' : code === 'E_TOO_MANY' ? `Refused: more than ${TASK_CANCEL_MAX} tasks would be cancelled.` : code === 'E_TOO_DEEP' ? 'Refused: the task tree is deeper than 20 levels, so it cannot be cancelled in one step.' : STALE);
  }
  // TA-C9, after COMMIT: the loops were told first (the hook above) and adminCancel emitted task.changed; then the web grants, then the cards, then the audit rows, then the reply.
  // All of it is best effort and never undoes the cancel.
  const tid = n.targetId;
  const grantIds: number[] = [];
  if (res.rootEnded) {
    try {
      grantIds.push(...(await ta.webGrants.revokeRoot(res.rootId, i.userId)));
    } catch (err) {
      deps.log.error({ errName: err instanceof Error ? err.name : 'error' }, 'task cancel: web grant revoke failed');
    }
  }
  for (const b of res.batches) {
    if (b.state === 'closed' && b.channelId && b.messageId) {
      await deps.cards?.close(b.channelId, b.messageId, 'Closed: the task was cancelled by a Bot Admin.').catch((err: unknown) => deps.log.error({ errName: err instanceof Error ? err.name : 'error' }, 'task cancel: batch card close failed'));
    }
  }
  await audit(deps, i, 'task.cancel', tid, `ok${tail}`, `cascade:${res.ids.length}`);
  const short = id8(tid);
  for (const id of res.ids) if (id !== tid) await audit(deps, i, 'task.cancel.cascade', id, `ok #${short}`);
  for (const x of res.expired) await audit(deps, i, 'approval.expire', x.taskId, `task_cancelled #${x.id}`, x.toolName ?? x.kind);
  for (const gid of grantIds) await audit(deps, i, 'web_grant.revoke', res.rootId, `admin #${gid}`);
  await audit(deps, i, 'task.cancel.abort', tid, `runs ${aborted}`);
  return ephemeral(`Cancelled ${plural(res.ids.length, 'task')}: ${res.ids.slice(0, SHOWN_CHILDREN).map(id8).join(', ')}${res.ids.length > SHOWN_CHILDREN ? ' …' : ''}`);
}

// ---- /task retry ------------------------------------------------------------------------------------------------------------------------------------------

/** `/task retry task:<id> [reset_turns:true]`: one reversible move blocked -> todo, no confirm step. */
export const taskRetry: Handler = async (i, deps) => {
  const ta = deps.taskAdmin;
  if (!ta) return ephemeral(NOT_AVAILABLE);
  const ref = await resolve(i, deps, ta, 'task.retry');
  if (isReply(ref)) return ref;
  const reset = i.options.boolean('reset_turns') === true;
  const r = await retryBlocked({ tasks: ta.tasks, bus: ta.bus, isHalted: ta.isHalted, turnsCap: () => deps.cfg.get('limits.turnsPerTask') }, ref.id, { resetTurns: reset });
  if (!r.ok && r.code === 'E_NOT_FOUND') return refuse(deps, i, 'task.retry', ref.id, 'E_NOT_FOUND', 'No task matches that id.');
  const reason = r.reason ?? 'owner';
  const no = async (code: Code, text: string): Promise<Reply> => (await audit(deps, i, 'task.retry', ref.id, `refused:${code}`, reason), ephemeral(text)); // one row, tool = the previous reason
  if (!r.ok) {
    if (r.code === 'E_HALTED') return no('E_HALTED', 'The company is halted. Use /resume first.');
    if (r.code === 'E_NOT_BLOCKED') return no('E_NOT_BLOCKED', `Only a blocked task can be retried (it is ${word(r.status ?? '')}).`);
    if (r.code === 'E_TREE_ENDED') return no('E_TREE_ENDED', 'Its parent or root task has ended.');
    if (r.code === 'E_TURNS') {
      const t = await ta.tasks.get(ref.id);
      const cap = deps.cfg.get('limits.turnsPerTask');
      return no('E_TURNS', `This task used all its turns (${t?.turnsUsed ?? cap}/${cap}). Add reset_turns:true.`);
    }
    return no('E_STALE', STALE);
  }
  const task = r.task;
  await audit(deps, i, 'task.retry', task.id, reset ? 'ok reset_turns' : 'ok', reason);
  const capNote = reason === 'budget' || reason === 'approval' ? 'Queued; it will block again unless the cap was raised or a new cap approval is granted.' : 'Queued; it runs when a slot is free (on an off day it starts on the next workday or after overtime is approved).';
  return ephemeral(`${id8(task.id)} is back in todo${reset ? ' with its turns reset' : ''}. ${capNote}`);
};

// ---- /task done -------------------------------------------------------------------------------------------------------------------------------------------

/** `/task done task:<id>`, step A: the refusals in the spec order, then a confirm reply. The move itself is Scheduler.adminAccept. */
export const taskDone: Handler = async (i, deps) => {
  const ta = deps.taskAdmin;
  if (!ta) return ephemeral(NOT_AVAILABLE);
  const ref = await resolve(i, deps, ta, 'task.done');
  if (isReply(ref)) return ref;
  const secrets = deps.secrets ?? [];
  const task = await ta.tasks.get(ref.id);
  if (!task) return refuse(deps, i, 'task.done', ref.id, 'E_NOT_FOUND', 'No task matches that id.');
  if (ta.isHalted()) return refuse(deps, i, 'task.done', task.id, 'E_HALTED', 'The company is halted. Use /resume first.');
  if (task.status !== 'review') return refuse(deps, i, 'task.done', task.id, 'E_NOT_REVIEW', `Only a task in review can be accepted (it is ${word(task.status)}).`);
  const open = await ta.tasks.countOpenChildren(task.id);
  if (open > 0) return refuse(deps, i, 'task.done', task.id, 'E_OPEN_CHILDREN', `That task has ${plural(open, 'open subtask')}. Finish or cancel them first.`);
  if ((await ta.tasks.pendingApprovalCount([task.id])) > 0) return refuse(deps, i, 'task.done', task.id, 'E_PENDING', 'That task has pending approvals. Decide them first.');
  if (ta.taskRuns.active(task.id) || ta.scheduler.isTaskBusy(task.id)) return refuse(deps, i, 'task.done', task.id, 'E_RUNNING', 'That task is running right now. Try again when it has stopped.');
  const digest = await ta.tasks.acceptDigest(task.id);
  if (!digest) return refuse(deps, i, 'task.done', task.id, 'E_STALE', STALE);
  const parent = task.parentId ? await ta.tasks.get(task.parentId) : null;
  // what reportEnded will really do: a roll-up needs a delegating (non-human) requester, a parent that is not ended or awaiting approval, and a parent thread
  const rollup = !!parent && !!parent.threadId && task.requester.kind !== 'human' && !NO_ROLLUP.includes(parent.status);
  const nonce = ta.nonces.issue({ kind: 'done', userId: i.userId, targetId: task.id, digest, cascade: false, reason: null });
  const lines = [
    '**Accept this task as done?** It moves from review to done.',
    `Target \`${id8(task.id)}\` · ${word(task.deptId)} · ${word(task.status)} · ${ownerLabel(task.owner)} · ${esc(task.title, 60, secrets)}`,
    parent ? `Parent \`${id8(parent.id)}\` · ${word(parent.status)}` : 'No parent task.',
    rollup ? 'A roll-up run of the parent will start (it costs model spend, through the usual budget checks; on an off day it is held until the next workday or approved overtime).' : 'No roll-up run starts.',
    ...(task.id === task.rootId ? ['This is the root: its web grants end.'] : []),
    'Valid for 5 minutes.',
  ];
  return { content: lines.join('\n').slice(0, REPLY_MAX), ephemeral: true, allowedMentions: { parse: [] }, components: confirmButtons('done', nonce, 'Accept as done') };
};

async function doneClick(i: InteractionLike, deps: CommandDeps, ta: TaskAdminDeps, n: NonceEntry): Promise<Reply> {
  let r: Awaited<ReturnType<TaskAdminDeps['scheduler']['adminAccept']>>;
  try {
    r = await ta.scheduler.adminAccept(n.targetId, i.userId, n.digest);
  } catch (err) {
    await audit(deps, i, 'task.done', n.targetId, 'error');
    throw err;
  }
  if (!r.ok) {
    if (r.error === 'stale') {
      await audit(deps, i, 'task.done', n.targetId, 'stale');
      return ephemeral(STALE);
    }
    const map = {
      halted: ['E_HALTED', 'The company is halted. Use /resume first.'], not_found: ['E_NOT_FOUND', 'No task matches that id.'],
      not_review: ['E_NOT_REVIEW', 'Only a task in review can be accepted.'], open_children: ['E_OPEN_CHILDREN', 'That task has open subtasks. Finish or cancel them first.'],
      pending: ['E_PENDING', 'That task has pending approvals. Decide them first.'], running: ['E_RUNNING', 'That task is running right now. Try again when it has stopped.'],
    } as const;
    const [code, text] = map[r.error];
    return refuse(deps, i, 'task.done', n.targetId, code, text);
  }
  await audit(deps, i, 'task.done', n.targetId, 'ok');
  if (r.task.id === r.task.rootId) {
    try {
      for (const gid of await ta.webGrants.revokeRoot(r.task.id, i.userId)) await audit(deps, i, 'web_grant.revoke', r.task.id, `admin #${gid}`);
    } catch (err) {
      deps.log.error({ errName: err instanceof Error ? err.name : 'error' }, 'task done: web grant revoke failed');
    }
  }
  return ephemeral(`Accepted: ${id8(r.task.id)} is done.`);
}

/** The `taskadm:` buttons. decide() already checked the guild, #⚙️-setting and this click's live admin role; only the exact id shape gets here (TA-C2). */
export const taskadmButton: Handler = async (i, deps) => {
  const ta = deps.taskAdmin;
  const m = TASKADM_ID.exec(i.customId);
  if (!m) return ephemeral('Unknown action.');
  if (!ta) return ephemeral(NOT_AVAILABLE);
  const kind = m[1] as 'cancel' | 'dismiss' | 'done';
  const nonce = m[2]!;
  if (kind === 'dismiss') {
    ta.nonces.take(nonce, i.userId, 'any');
    return ephemeral('Dismissed. Nothing was changed.');
  }
  const n = ta.nonces.take(nonce, i.userId, kind);
  if (!n) return ephemeral(STALE);
  return kind === 'cancel' ? cancelClick(i, deps, ta, n) : doneClick(i, deps, ta, n);
};

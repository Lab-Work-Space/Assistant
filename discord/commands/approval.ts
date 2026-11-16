import type { OutboundPayload } from '../../agents/loop/payload.js';
import type { Approval, ApprovalBatch, BatchMember } from '../../db/repos/index.js';
import type { ApprovalRooms } from '../approval/approval-rooms.js';
import { batchApprovalPayload, batchFits, compactItemFits, grantClosingText, parseBatchCustomId, parseOtCustomId, REVOKE_ID, taskGrantClosingText, TASK_REVOKE_ID, taskUsageLine, toolApprovalPayload, type BatchAction, type TreeGrantOffer } from '../embeds/approval.js';
import { buildMessage } from '../embeds/index.js';
import type { DiscordPort } from '../port.js';
import { otButton } from './approval.ot.js';
import { configReply, CONFIG_CHANNEL_ID, ephemeral, type Handler } from './types.js';

export const APPROVAL_ID = /^approval:(\d{1,15}):(approve|reject|ask|grant|task)$/;

const ERRORS = {
  not_admin: 'Only Bot Admins can decide approvals.',
  not_pending: 'This approval was already decided.',
  expired: 'This approval has expired.',
} as const;

type Ctx = Parameters<Handler>[0];
type Deps = Parameters<Handler>[1];

/** Buttons route to Approvals.decide (one item) or Approvals.decideBatch (a batch card's Approve all / Deny all); the admin check happens before in the guard and again there. */
export const approvalButton: Handler = async (i, deps) => {
  // OT-1 (OT-C16): its own anchored shape, matched first; this handler is reached only from here, after the guard in index.ts.
  const ot = parseOtCustomId(i.customId);
  if (ot) return otButton(i, deps, ot);
  if (i.customId.startsWith('approval:ot:')) return ephemeral('Unknown action.'); // a malformed OT id never falls through to the other shapes
  // TREEGRANT-1 (TG-C15): its own anchored revoke shape, matched before the generic one; any other `approval:t:` shape never falls through
  const tr = TASK_REVOKE_ID.exec(i.customId);
  if (tr) return taskRevokeButton(i, deps, Number(tr[1]));
  if (i.customId.startsWith('approval:t:')) return ephemeral('Unknown action.');
  const rv = REVOKE_ID.exec(i.customId);
  if (rv) return revokeButton(i, deps, Number(rv[1]));
  const batch = parseBatchCustomId(i.customId);
  if (batch) return batchButton(i, deps, batch);
  const m = APPROVAL_ID.exec(i.customId);
  if (!m) return ephemeral('Unknown action.');
  const id = Number(m[1]);
  const action = m[2] as 'approve' | 'reject' | 'ask' | 'grant' | 'task';
  if (action === 'grant') return grantButton(i, deps, id);
  if (action === 'task') return taskButton(i, deps, id);
  const decision = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'ask';
  const r = await deps.approvals.decide(id, decision, { id: i.userId, isAdmin: true });
  if (!r.ok) {
    // A card of an approval that is no longer pending cannot be pressed again: close it in place (the decision path refuses regardless).
    // On a batch card the item's own button goes and the card is re-rendered from the DB instead (B1: never close the whole card).
    if (r.error !== 'not_admin') {
      const note = `Approval #${id}: ${r.error === 'expired' ? 'expired' : 'already decided'}.`;
      const b = await batchOf(deps, id);
      if (b.kind === 'batch') await refreshBatchCard(i, deps, b.batch);
      else if (b.kind === 'none') await closeInPlace(i, deps, note);
    }
    return ephemeral(ERRORS[r.error]);
  }
  await deps.audit({ actor: `user:${i.userId}`, action: `approval.${action}`, taskId: r.approval.taskId ?? null, tool: r.approval.toolName ?? null, outcome: `ok #${id}` });
  if (decision === 'ask') {
    return configReply('Approval still pending', `Approval #${id} stays pending; ask the requester for details, then decide.`, { ephemeral: true });
  }
  // The decision is stored; the card itself is edited to show it instead of a new public reply.
  const b = await batchOf(deps, id);
  const shown = b.kind === 'batch' ? await refreshBatchCard(i, deps, b.batch)
    : b.kind === 'none' ? await closeInPlace(i, deps, `Approval #${id} ${decision} by <@${i.userId}>.`) : false;
  if (shown) return configReply(`Approval #${id} ${decision}`, 'The card above shows the decision.', { ephemeral: true });
  return configReply(`Approval #${id} ${decision}`, `Decided by <@${i.userId}>.`, { ephemeral: true });
};

/**
 * B1: whether the approval sits on a live batch card (state posted or closed). A dissolved batch (batch of one, failed post) and a
 * row that was never batched take today's path. When the lookup itself fails the card is left alone ('unknown'): closing it would
 * remove the buttons of every other item.
 */
async function batchOf(deps: Deps, approvalId: number): Promise<{ kind: 'none' } | { kind: 'unknown' } | { kind: 'batch'; batch: ApprovalBatch }> {
  if (!deps.batches) return { kind: 'none' };
  try {
    const b = await deps.batches.ofApproval(approvalId);
    // G2AB-01: a 'sealed' batch has a card only when its post went out but markPosted failed; never close that card (every other item would lose its buttons).
    if (b && b.state === 'sealed') return { kind: 'unknown' };
    return b && (b.state === 'posted' || b.state === 'closed') && b.digest ? { kind: 'batch', batch: b } : { kind: 'none' };
  } catch (err) {
    deps.log.error({ err }, 'looking up the approval batch failed');
    return { kind: 'unknown' };
  }
}

/**
 * Re-renders the batch card the button sits on from the DB (decided items lose their buttons, the rest keep theirs). The message edited is
 * the clicked one (`i.channelId`/`i.messageId`), never an id taken from the custom id. No pending item left: the card is closed and the batch
 * moves to 'closed'. False when the card could not be updated (the caller then answers with a plain reply).
 */
async function refreshBatchCard(i: Ctx, deps: Deps, batch: ApprovalBatch): Promise<boolean> {
  // G2AB-04: only the card this batch was posted as is re-rendered (a forged custom id must not paint another batch onto this message).
  if (!deps.batches || !deps.cards?.update || !i.messageId || !i.channelId || !batch.digest || batch.messageId !== i.messageId) return false;
  try {
    const members = await deps.batches.members(batch.id, deps.cfg.get('approval.expiryHours'));
    if (members.length === 0) return false;
    // WEBGRANT-1: the grant button while the feature is on; the revoke button of a grant made on THIS message (looked up by its stored card id)
    let live: Awaited<ReturnType<NonNullable<Deps['webGrants']>['unrevokedOfMessage']>> | null = null;
    try { live = (await deps.webGrants?.unrevokedOfMessage(i.messageId)) ?? null; } catch (err) { deps.log.error({ err }, 'looking up the web grant of a card failed'); }
    const grant = deps.cfg.get('web.taskGrant.enabled') === true;
    // W-C9/W-C10: the card itself keeps the scope, caps and leak statement of the grant made on it (the message content), not only the clicking admin's private reply
    const note = live ? grantClosingText({ rootId: live.rootId, expiresAt: live.expiresAt, maxFetches: live.maxFetches, maxHosts: live.maxHosts, maxUrlChars: live.maxUrlChars }, 'Web reading was allowed from this card.', deps.secrets ?? []) : undefined;
    // TREEGRANT-1 (TG-C10): the task grant of THIS message (stored card id) shows its note and ONE revoke button; the companion web grant has no card id, so it never gets a revoke of its own
    let tlive: Awaited<ReturnType<NonNullable<Deps['taskGrants']>['unrevokedOfMessage']>> | null = null;
    try { tlive = (await deps.taskGrants?.unrevokedOfMessage(i.messageId)) ?? null; } catch (err) { deps.log.error({ err }, 'looking up the task grant of a card failed'); }
    const tnote = tlive ? await taskNote(deps, tlive, 'Whole task approved from this card.') : undefined;
    const offer = !tlive && !live ? await batchOffer(deps, members) : null;
    const done = await deps.cards.update(i.channelId, i.messageId, batchApprovalPayload(members, { id: batch.id, digest: batch.digest }, deps.secrets ?? [], {
      grant,
      ...(offer ? { taskGrant: offer } : {}),
      ...(tlive ? { revokeTaskGrantId: Number(tlive.id), ...(tnote !== undefined ? { grantNote: tnote } : {}) } : live ? { revokeGrantId: Number(live.id), ...(note !== undefined ? { grantNote: note } : {}) } : {}),
    }));
    if (members.every((m) => m.status !== 'pending')) await deps.batches.close(batch.id);
    return done;
  } catch (err) {
    deps.log.error({ err }, 'refreshing an approval batch card failed');
    return false;
  }
}

/** The offer for a batch card: every member must carry one (TG-C13), else none. A lookup fault is no offer. */
async function batchOffer(deps: Deps, members: readonly Approval[]): Promise<TreeGrantOffer | null> {
  if (!deps.taskGrantOffer) return null;
  try {
    const offers = await Promise.all(members.map((m) => deps.taskGrantOffer!(m)));
    return offers.every((o) => o !== null) ? offers[0]! : null;
  } catch (err) {
    deps.log.error({ err }, 'building the task grant offer failed');
    return null;
  }
}

/** The card text of a task grant: its closing text (scope, caps, expiry, what still asks, the companion web statement) and the code-built usage line (TG-C17). */
async function taskNote(deps: Deps, g: { rootId: string; expiresAt: Date; maxCalls: number; used: number; usedByTool: unknown; webGrantId: number | null }, decided: string): Promise<string> {
  let web: { maxFetches: number; maxHosts: number; maxUrlChars: number } | null = null;
  try {
    const w = g.webGrantId !== null ? await deps.webGrants?.get(g.webGrantId) : null;
    if (w) web = { maxFetches: w.maxFetches, maxHosts: w.maxHosts, maxUrlChars: w.maxUrlChars };
  } catch { /* the web caps line is left out, the rest stands */ }
  return `${taskGrantClosingText({ rootId: g.rootId, expiresAt: g.expiresAt, maxCalls: g.maxCalls, web }, decided, deps.secrets ?? [])}\n${taskUsageLine(g.used, g.maxCalls, g.usedByTool)}`;
}

const STALE = 'This card changed; review it again.';
/** TREEGRANT-1: fixed replies. A refused click leaves the card decidable (TG-C12). */
const TASK_REPLIES = {
  halted_after_commit: 'Approved, but the company was halted just now, so the whole-task approval was not made. The call runs after /resume; the next call asks again.',
  not_grantable: "The whole task can't be approved from this card (it does not qualify, or this task already has a live approval); decide it with Approve or Reject.",
  root_ended: 'The task has ended.',
  halted: 'The company is halted; the whole task cannot be approved now. Approve or Reject still decide this card.',
} as const;
/** WEBGRANT-1: fixed replies. A refused grant leaves the card as it is: it can still be decided with Approve or Reject. */
const GRANT_REPLIES = {
  /** G2W-07: the click committed, then a halt revoked the grant: the approval stands (its call runs after /resume), web reading does not. */
  halted_after_commit: 'Approved, but the company was halted just now, so web reading was not allowed. The call runs after /resume; the next page it reads asks again.',
  not_grantable: "Web reading can't be allowed for this card; decide it with Approve or Reject.",
  root_ended: 'The task has ended.',
  halted: 'The company is halted; web reading cannot be allowed now. Approve or Reject still decide this card.',
} as const;

/** Approve all / Deny all / Ask of a batch card (B5, B6, B11, B12). */
async function batchButton(i: Ctx, deps: Deps, c: { batchId: number; digest: string; action: BatchAction }): Promise<ReturnType<Handler>> {
  const summary = (outcome: string, taskId?: string | null) =>
    deps.audit({ actor: `user:${i.userId}`, action: `approval.batch_${c.action}`, taskId: taskId ?? null, outcome: `batch:${c.batchId} digest:${c.digest} ${outcome}` });
  const known = async (): Promise<ApprovalBatch | null> => {
    try {
      const b = await deps.batches?.get(c.batchId);
      return b && (b.state === 'posted' || b.state === 'closed') ? b : null;
    } catch (err) {
      deps.log.error({ err }, 'looking up the approval batch failed');
      return null;
    }
  };
  if (c.action === 'ask') {
    const b = await known();
    if (!b || b.digest !== c.digest || !deps.batches) {
      await summary('stale');
      return ephemeral(STALE);
    }
    const pending = await deps.batches.pendingIds(b.id);
    await summary(`n=${pending.length} decided=0`, b.taskId);
    return ephemeral(`Batch stays pending (${pending.length ? pending.map((n) => `#${n}`).join(', ') : 'nothing pending'}); ask the requester for details, then decide.`);
  }
  if (!deps.approvals.decideBatch) return ephemeral('Unknown action.');
  const wantGrant = c.action === 'grant'; // approve all AND allow web reading; never falls into the reject branch below
  const wantTask = c.action === 'task'; // approve all AND the whole task (TREEGRANT-1); never falls into the reject branch below
  if (wantGrant && !deps.webGrants) return ephemeral('Unknown action.');
  if (wantTask && !deps.taskGrants) return ephemeral('Unknown action.');
  const decision = c.action === 'reject' ? 'rejected' : 'approved';
  const ids = { ...(i.messageId ? { messageId: i.messageId } : {}), ...(i.channelId ? { channelId: i.channelId } : {}) };
  const r = await deps.approvals.decideBatch(c.batchId, c.digest, decision, { id: i.userId, isAdmin: true }, wantGrant ? { grant: true, ...(i.messageId ? { messageId: i.messageId } : {}) } : wantTask ? { task: true, ...ids } : {});
  if (!r.ok) {
    if (r.error === 'not_admin') return ephemeral('Only Bot Admins can do this.');
    await summary(r.error);
    if (r.error === 'not_found') return ephemeral('Unknown action.');
    if (r.error === 'halted_after_commit') {
      for (const a of r.decided) await deps.audit({ actor: `user:${i.userId}`, action: 'approval.approve', taskId: a.taskId, tool: a.toolName ?? null, outcome: `ok #${a.id} halted_after_commit` });
      const b = await known();
      if (b) await refreshBatchCard(i, deps, b);
      return ephemeral(wantTask ? TASK_REPLIES.halted_after_commit : GRANT_REPLIES.halted_after_commit);
    }
    // A refused grant decided nothing and the card is still decidable: it is left as it is (the buttons stay).
    if (r.error === 'not_grantable' || r.error === 'root_ended' || r.error === 'halted') return ephemeral((wantTask ? TASK_REPLIES : GRANT_REPLIES)[r.error]);
    const b = await known();
    if (b) await refreshBatchCard(i, deps, b);
    return ephemeral(STALE);
  }
  const verb = c.action === 'reject' ? 'approval.reject' : 'approval.approve';
  for (const a of r.decided) await deps.audit({ actor: `user:${i.userId}`, action: verb, taskId: a.taskId, tool: a.toolName ?? null, outcome: `ok #${a.id}` });
  await summary(`n=${r.decided.length + r.skipped.length} decided=${r.decided.length}`, r.taskId);
  let b = await known();
  if (r.grant && r.decided[0]) {
    await deps.audit({ actor: `user:${i.userId}`, action: 'approval.grant', taskId: r.taskId, tool: 'fetch_page', outcome: `ok #${r.decided[0].id} grant #${r.grant.id}` });
    b = await known();
  }
  if (r.taskGrant && r.decided[0]) {
    await deps.audit({ actor: `user:${i.userId}`, action: 'approval.task_grant', taskId: r.taskId, tool: r.decided[0].toolName ?? null, outcome: `ok #${r.decided[0].id} grant #${r.taskGrant.id}${r.taskGrant.web ? ` web_grant #${r.taskGrant.web.id}` : ''}` });
    b = await known();
  }
  if (b) await refreshBatchCard(i, deps, b);
  if (r.taskGrant) {
    const text = taskGrantClosingText({ rootId: r.taskGrant.rootId, expiresAt: r.taskGrant.expiresAt, maxCalls: r.taskGrant.maxCalls, web: r.taskGrant.web }, `Approved ${r.decided.length} of ${r.decided.length + r.skipped.length}.`, deps.secrets ?? []);
    return ephemeral(text);
  }
  if (r.grant) {
    const text = grantClosingText(r.grant, `Approved ${r.decided.length} of ${r.decided.length + r.skipped.length}.`, deps.secrets ?? []);
    return ephemeral(text);
  }
  if (r.decided.length === 0) return ephemeral('These approvals were already decided.');
  const total = r.decided.length + r.skipped.length;
  const rest = r.skipped.length ? ` (${r.skipped.length} already decided or expired)` : '';
  return ephemeral(`${decision === 'approved' ? 'Approved' : 'Denied'} ${r.decided.length} of ${total}${rest}.`);
}

/**
 * WEBGRANT-1 (D5/D6): "Allow web reading for this task tree" on a solo card: approves this call and creates the grant in one transaction
 * (Approvals.decideGrant). A refusal (not_grantable, root_ended, halted) changes nothing and leaves the card alone. On a batch member the batch
 * card is re-rendered, never closed (W-C11a).
 */
async function grantButton(i: Ctx, deps: Deps, id: number): Promise<ReturnType<Handler>> {
  if (!deps.approvals.decideGrant || !deps.webGrants) return ephemeral('Unknown action.');
  const r = await deps.approvals.decideGrant(id, { id: i.userId, isAdmin: true }, i.messageId ? { messageId: i.messageId } : {});
  if (!r.ok) {
    if (r.error === 'not_admin') return ephemeral(ERRORS.not_admin);
    if (r.error === 'halted_after_commit') {
      await deps.audit({ actor: `user:${i.userId}`, action: 'approval.approve', taskId: r.approval.taskId ?? null, tool: r.approval.toolName ?? null, outcome: `ok #${id} halted_after_commit` });
      const b = await batchOf(deps, id);
      if (b.kind === 'batch') await refreshBatchCard(i, deps, b.batch);
      else if (b.kind === 'none') await closeInPlace(i, deps, `Approval #${id} approved by <@${i.userId}>; web reading was not allowed because the company was halted. The call runs after /resume.`);
      return ephemeral(GRANT_REPLIES.halted_after_commit);
    }
    if (r.error === 'not_grantable' || r.error === 'root_ended' || r.error === 'halted') return ephemeral(GRANT_REPLIES[r.error]);
    const note = `Approval #${id}: ${r.error === 'expired' ? 'expired' : 'already decided'}.`;
    const b = await batchOf(deps, id);
    if (b.kind === 'batch') await refreshBatchCard(i, deps, b.batch);
    else if (b.kind === 'none') await closeInPlace(i, deps, note);
    return ephemeral(ERRORS[r.error]);
  }
  await deps.audit({ actor: `user:${i.userId}`, action: 'approval.grant', taskId: r.approval.taskId ?? null, tool: r.approval.toolName ?? null, outcome: `ok #${id} grant #${r.grant.id}` });
  const text = grantClosingText(r.grant, `Approval #${id} approved by <@${i.userId}>.`, deps.secrets ?? []);
  const b = await batchOf(deps, id);
  if (b.kind === 'batch') {
    await refreshBatchCard(i, deps, b.batch);
  } else if (b.kind === 'none') {
    await closeInPlace(i, deps, text, r.grant.id);
  }
  return configReply(`Web reading allowed (approval #${id} approved)`, text, { ephemeral: true });
}

/**
 * D10/W-C11b: `approval:g:<grantId>:revoke`. Admin only. It acts only on the message that is that grant's card (its stored card id), so a forged
 * id cannot paint "revoked" onto another card; otherwise it answers privately and edits nothing.
 */
async function revokeButton(i: Ctx, deps: Deps, grantId: number): Promise<ReturnType<Handler>> {
  if (!deps.webGrants) return ephemeral('Unknown action.');
  const g = await deps.webGrants.get(grantId);
  if (!g || !i.messageId || g.cardMessageId !== i.messageId) return ephemeral("That button does not belong to this card; nothing was changed. /halt stops every web grant.");
  if (!(await deps.webGrants.revoke(grantId, i.userId, 'admin'))) return ephemeral('Already revoked.');
  await deps.audit({ actor: `user:${i.userId}`, action: 'web_grant.revoke', taskId: null, tool: 'fetch_page', outcome: `admin #${grantId}` });
  const b = await batchOf(deps, g.approvalId);
  if (b.kind === 'batch') await refreshBatchCard(i, deps, b.batch);
  else if (b.kind === 'none') await closeInPlace(i, deps, `Web reading revoked by <@${i.userId}> for task tree ${g.rootId.replace(/[^\w.-]/g, '').slice(0, 64)}.`);
  return configReply('Web reading revoked', 'fetch_page after untrusted content asks per URL again. A fetch already started can still finish.', { ephemeral: true });
}

/**
 * TREEGRANT-1 (spec 3.3): "Approve the whole task" on a solo card: approves this call and creates the grant (and the companion web grant when it is on) in one
 * transaction (Approvals.decideTaskGrant). A refusal changes nothing and leaves the card alone. On a batch member the batch card is re-rendered, never closed.
 */
async function taskButton(i: Ctx, deps: Deps, id: number): Promise<ReturnType<Handler>> {
  if (!deps.approvals.decideTaskGrant || !deps.taskGrants) return ephemeral('Unknown action.');
  const r = await deps.approvals.decideTaskGrant(id, { id: i.userId, isAdmin: true }, { ...(i.messageId ? { messageId: i.messageId } : {}), ...(i.channelId ? { channelId: i.channelId } : {}) });
  if (!r.ok) {
    if (r.error === 'not_admin') return ephemeral(ERRORS.not_admin);
    if (r.error === 'halted_after_commit') {
      await deps.audit({ actor: `user:${i.userId}`, action: 'approval.approve', taskId: r.approval.taskId ?? null, tool: r.approval.toolName ?? null, outcome: `ok #${id} halted_after_commit` });
      const b = await batchOf(deps, id);
      if (b.kind === 'batch') await refreshBatchCard(i, deps, b.batch);
      else if (b.kind === 'none') await closeInPlace(i, deps, `Approval #${id} approved by <@${i.userId}>; the whole task was not approved because the company was halted. The call runs after /resume.`);
      return ephemeral(TASK_REPLIES.halted_after_commit);
    }
    if (r.error === 'not_grantable' || r.error === 'root_ended' || r.error === 'halted') return ephemeral(TASK_REPLIES[r.error]);
    const note = `Approval #${id}: ${r.error === 'expired' ? 'expired' : 'already decided'}.`;
    const b = await batchOf(deps, id);
    if (b.kind === 'batch') await refreshBatchCard(i, deps, b.batch);
    else if (b.kind === 'none') await closeInPlace(i, deps, note);
    return ephemeral(ERRORS[r.error]);
  }
  await deps.audit({ actor: `user:${i.userId}`, action: 'approval.task_grant', taskId: r.approval.taskId ?? null, tool: r.approval.toolName ?? null, outcome: `ok #${id} grant #${r.grant.id}${r.grant.web ? ` web_grant #${r.grant.web.id}` : ''}` });
  const text = `${taskGrantClosingText({ rootId: r.grant.rootId, expiresAt: r.grant.expiresAt, maxCalls: r.grant.maxCalls, web: r.grant.web }, `Approval #${id} approved by <@${i.userId}>.`, deps.secrets ?? [])}\n${taskUsageLine(0, r.grant.maxCalls, {})}`;
  const b = await batchOf(deps, id);
  if (b.kind === 'batch') await refreshBatchCard(i, deps, b.batch);
  else if (b.kind === 'none') await closeInPlace(i, deps, text, { task: r.grant.id });
  return configReply(`Whole task approved (approval #${id} approved)`, text, { ephemeral: true });
}

/**
 * TG-C15: `approval:t:<grantId>:revoke`. Admin only. It acts only on the message that is that grant's card (its stored card id), so a forged id cannot paint
 * "revoked" onto another card; otherwise it answers privately and edits nothing. The companion web grant is revoked with it (by the repo).
 */
async function taskRevokeButton(i: Ctx, deps: Deps, grantId: number): Promise<ReturnType<Handler>> {
  if (!deps.taskGrants) return ephemeral('Unknown action.');
  const g = await deps.taskGrants.get(grantId);
  if (!g || !i.messageId || g.cardMessageId !== i.messageId) return ephemeral('That button does not belong to this card; nothing was changed. /halt stops every grant.');
  if (!(await deps.taskGrants.revoke(grantId, i.userId, 'admin'))) return ephemeral('Already revoked.');
  deps.taskCard?.closed(grantId); // TG-C17: a pending usage edit must not repaint the card
  await deps.audit({ actor: `user:${i.userId}`, action: 'task_grant.revoke', taskId: null, tool: null, outcome: `admin #${grantId}` });
  const b = await batchOf(deps, g.approvalId);
  if (b.kind === 'batch') await refreshBatchCard(i, deps, b.batch);
  else if (b.kind === 'none') await closeInPlace(i, deps, `Whole-task approval revoked by <@${i.userId}> for task tree ${g.rootId.replace(/[^\w.-]/g, '').slice(0, 64)}. ${taskUsageLine(g.used, g.maxCalls, g.usedByTool)}`);
  return configReply('Whole-task approval revoked', 'Calls in this task tree ask again (and web reading too, if it was allowed with it). A call already started can still finish.', { ephemeral: true });
}

/** Edits the card the button sits on (buttons removed, `note` as its text); false when that is not possible, so the caller replies instead. */
async function closeInPlace(i: Ctx, deps: Deps, note: string, revoke?: number | { task: number }): Promise<boolean> {
  if (!deps.cards || !i.messageId || !i.channelId) return false;
  try {
    await deps.cards.close(i.channelId, i.messageId, note, revoke);
    return true;
  } catch (err) {
    deps.log.error({ err }, 'closing an approval card failed');
    return false;
  }
}

/**
 * Posts an approval card with buttons. Component interactions go to the app that posted the message,
 * so it must be the hq head, which serves the commands. `channelId` is where the card goes (an approvals room, Gate 1 WS7, chosen by code);
 * it defaults to #⚙️-setting, and a failed post to a room is retried once in #⚙️-setting so a decision is never lost.
 */
export async function postApprovalCard(port: Pick<DiscordPort, 'post'>, a: Approval, secrets: readonly string[] = [], channelId: string = CONFIG_CHANNEL_ID, grantEnabled = false, taskOffer: TreeGrantOffer | null = null): Promise<string> {
  const payload = approvalPayload(a, secrets, grantEnabled, taskOffer);
  try {
    return await port.post({ kind: 'head', dept: 'hq' }, { channelId }, payload);
  } catch (err) {
    if (channelId === CONFIG_CHANNEL_ID) throw err;
    return port.post({ kind: 'head', dept: 'hq' }, { channelId: CONFIG_CHANNEL_ID }, payload);
  }
}

function approvalPayload(a: Approval, secrets: readonly string[], grantEnabled = false, taskOffer: TreeGrantOffer | null = null): OutboundPayload {
  if (a.toolName) return toolApprovalPayload(a, secrets, { grantEnabled, taskGrant: taskOffer });
  const est = a.estCostUsd === null ? 'n/a' : `$${Number(a.estCostUsd).toFixed(2)}`;
  return {
    type: 'approval',
    origin: 'governance',
    title: `Approval #${a.id} needed`,
    body: a.reason,
    fields: [
      { name: 'Task', value: a.taskId },
      { name: 'Estimated cost', value: est },
      { name: 'Requested by', value: a.requestedBy },
    ],
    buttons: { approvalId: String(a.id) },
  };
}

/**
 * Posts the batch card (ONE message, ONE embed, asserted) via the hq head, with today's one fallback to #⚙️-setting. Returns where it
 * actually went. Throws when the card cannot be built whole or both posts fail (the batch then dissolves into solo cards, B9).
 */
export async function postBatchCard(
  port: Pick<DiscordPort, 'post'>, members: readonly BatchMember[], batch: Pick<ApprovalBatch, 'id' | 'digest'>, secrets: readonly string[] = [],
  channelId: string = CONFIG_CHANNEL_ID, grantEnabled = false, taskOffer: TreeGrantOffer | null = null,
): Promise<{ channelId: string; messageId: string }> {
  if (!batch.digest) throw new Error('a batch is posted only after it is sealed');
  const payload = batchApprovalPayload(members, { id: batch.id, digest: batch.digest }, secrets, { grant: grantEnabled, taskGrant: taskOffer });
  const msgs = buildMessage(payload, { deptColor: 0 });
  if (msgs.length !== 1 || msgs[0]!.embeds.length !== 1) throw new Error('the batch card did not render as one message with one embed');
  const hq = { kind: 'head', dept: 'hq' } as const;
  try {
    return { channelId, messageId: await port.post(hq, { channelId }, payload) };
  } catch (err) {
    if (channelId === CONFIG_CHANNEL_ID) throw err;
    return { channelId: CONFIG_CHANNEL_ID, messageId: await port.post(hq, { channelId: CONFIG_CHANNEL_ID }, payload) };
  }
}

/** The card side of ApprovalBatching: eligibility (B2, B7), the card budget, and the two posts. */
export function approvalBatchHooks(d: { port: Pick<DiscordPort, 'post'>; rooms: Pick<ApprovalRooms, 'routable' | 'channelFor'>; secrets: readonly string[]; /** WEBGRANT-1: read live when a card is posted. */ grantEnabled?: () => boolean; /** TREEGRANT-1: the offer for a stored approval (null: no button). Read when a card is posted. */ taskGrantOffer?: (a: Approval) => Promise<TreeGrantOffer | null> }) {
  /** A fault or a missing member offer is no offer: the card then has its normal buttons only. */
  const offerOf = async (list: readonly Approval[]): Promise<TreeGrantOffer | null> => {
    if (!d.taskGrantOffer) return null;
    try {
      const o = await Promise.all(list.map((m) => d.taskGrantOffer!(m)));
      return o.every((x) => x !== null) ? o[0]! : null;
    } catch { return null; }
  };
  return {
    eligible: (a: Approval) => d.rooms.routable(a) && compactItemFits(a, d.secrets),
    fits: (members: Approval[], next: Approval) => batchFits(members, next, d.secrets),
    postBatch: async (members: BatchMember[], batch: ApprovalBatch) => postBatchCard(d.port, members, batch, d.secrets, await d.rooms.channelFor(members[0]!), d.grantEnabled?.() ?? false, await offerOf(members)),
    postSolo: async (a: Approval) => void (await postApprovalCard(d.port, a, d.secrets, await d.rooms.channelFor(a), d.grantEnabled?.() ?? false, await offerOf([a]))),
  };
}

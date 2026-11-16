import type { ActorRef } from '../../company/types.js';
import { redactText } from '../../core/logger.js';
import type { ErrorSink } from '../../core/events.js';
import type { Task } from '../../db/repos/tasks.js';
import type { Approvals, ToolClaim, ToolDelivery } from '../../governance/approval/approvals.js';
import type { ToolRegistry } from '../../tools/registry.js';
import type { ToolContext, ToolResult } from '../../tools/types.js';
import { digestMismatchAlert } from '../scheduler/notices.js';
import type { OutboundPayload } from './payload.js';

/** Stored outcome cap (UTF-16 units); the wrapper and the rest of the context come on top. */
export const RESULT_MAX = 4000;

/**
 * R4: the scheduler's seam to approved tool calls. claim() settles the task's decided tool approvals once; run() executes
 * one stored call through ToolRegistry.runApproved (allowlist, zod and tool refusals re-checked); store() keeps its outcome
 * on the row; unclaim() gives back a claim /halt refused before it ran; pending()/delivered() hand the outcomes to the
 * owner's model turn until one has actually started.
 */
export interface ApprovedTools {
  claim(taskId: string): Promise<ToolClaim[]>;
  run(actor: ActorRef, task: Task, c: { name: string; input: unknown }): Promise<ToolResult>;
  store(c: ToolClaim, text: string): Promise<void>;
  unclaim(c: ToolClaim): Promise<void>;
  pending(taskId: string): Promise<ToolDelivery[]>;
  delivered(ids: number[]): Promise<void>;
}

type ApprovalsPort = Pick<Approvals, 'claimToolOutcomes' | 'unclaimTool' | 'storeToolResult' | 'pendingToolDeliveries' | 'markToolsDelivered'>;

export function approvedTools(d: { approvals: ApprovalsPort; tools: Pick<ToolRegistry, 'runApproved'>; context: (actor: ActorRef, task: Task) => ToolContext | Promise<ToolContext> }): ApprovedTools {
  const { approvals } = d;
  return {
    claim: (taskId) => approvals.claimToolOutcomes(taskId),
    run: async (actor, task, c) => d.tools.runApproved(c.name, c.input, await d.context(actor, task)),
    store: async (c, text) => void (await approvals.storeToolResult(c, text)),
    unclaim: async (c) => void (await approvals.unclaimTool(c)),
    pending: (taskId) => approvals.pendingToolDeliveries(taskId),
    delivered: (ids) => approvals.markToolsDelivered(ids),
  };
}

/** Cuts at `max` UTF-16 units without splitting a surrogate pair. */
export function safeSlice(s: string, max: number): string {
  if (s.length <= max) return s;
  const end = /[\uD800-\uDBFF]/.test(s[max - 1] ?? '') ? max - 1 : max;
  return s.slice(0, end);
}

/** The text stored for an executed call: outcome word, then the redacted, capped tool output. */
export function resultText(r: ToolResult): string {
  const clean = redactText(r.content);
  const body = clean.length > RESULT_MAX ? `${safeSlice(clean, RESULT_MAX)}\n[truncated]` : clean;
  return `${r.isError ? 'failed' : 'ran'}:\n${body}`;
}

export type ApprovedRun = {
  approvedResults: string[];
  approvalNotices: string[];
  halted: boolean;
  /** Marks the outcomes delivered; the loop calls it once its first provider call is actually made. */
  onModelStart?: () => Promise<void>;
};

/** Tool names come from the registry (validated at request time); still only [\w-] reaches the model or a card. */
const cleanName = (n: string) => n.replace(/[^\w-]/g, '').slice(0, 64);
const label = (d: { approvalId: number; name: string }) => `#${d.approvalId} (${cleanName(d.name)})`;

const NOTICE: Record<Exclude<ToolDelivery['state'], 'result'>, string> = {
  rejected: 'was rejected; the call did not run.',
  expired: 'expired without a decision; the call did not run.',
  digest_mismatch: 'could not run: its stored input failed the integrity check. A new approval is needed.',
  interrupted: 'was claimed but its outcome was not recorded (the process stopped); it was not run again.',
};

/**
 * Before the owner's model turn (R4): claims the task's settled tool approvals and runs each approved stored call in
 * approval order, as the task owner, storing its outcome on the row. The model never regenerates the call. Then every
 * outcome the owner's model has not seen yet (this batch and earlier ones whose run stopped before a model call) is
 * returned for the trigger; it stays pending until onModelStart. Never throws. A halt refusal (nothing ran) gives back
 * the claims that did not run and reports `halted`, so the caller skips the run; outcomes stored so far stay pending.
 */
export async function runApprovedCalls(
  port: ApprovedTools, task: Task, o: { alert: (p: OutboundPayload) => Promise<unknown>; log: ErrorSink },
): Promise<ApprovedRun> {
  const out: ApprovedRun = { approvedResults: [], approvalNotices: [], halted: false };
  const err = (what: string, e: unknown, extra: object = {}) => o.log.error({ err: e, taskId: task.id, ...extra }, what);
  const claims = await port.claim(task.id).catch((e: unknown) => (err('approved tool claim failed', e), [] as ToolClaim[]));
  for (let i = 0; i < claims.length; i++) {
    const c = claims[i]!;
    if (c.kind === 'refused') {
      if (c.why === 'digest_mismatch') await o.alert(digestMismatchAlert(task.id, c.approvalId, cleanName(c.name))).catch(() => undefined);
      continue;
    }
    let text: string;
    try {
      const r = await port.run(task.owner, task, { name: c.name, input: c.input });
      if (r.notRun === 'halted') {
        out.halted = true;
        for (const back of claims.slice(i).filter((x) => x.kind === 'run')) await port.unclaim(back).catch((e: unknown) => err('approved tool unclaim failed', e, { approvalId: back.approvalId }));
        return out;
      }
      text = resultText(r);
    } catch (e) {
      err('approved tool call failed', e, { approvalId: c.approvalId });
      text = 'could not run (internal error); its outcome is unknown and it was not run again.';
    }
    await port.store(c, text).catch((e: unknown) => err('approved tool result store failed', e, { approvalId: c.approvalId }));
  }
  const pending = await port.pending(task.id).catch((e: unknown) => (err('approved tool results read failed', e), [] as ToolDelivery[]));
  for (const d of pending) {
    if (d.state === 'result') out.approvedResults.push(`Approval ${label(d)} ${d.text ?? ''}`);
    else out.approvalNotices.push(`Approval ${label(d)} ${NOTICE[d.state]}`);
  }
  if (pending.length) out.onModelStart = () => port.delivered(pending.map((d) => d.approvalId));
  return out;
}

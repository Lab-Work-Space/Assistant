import { z } from 'zod';
import { HEAL_REFUSALS } from '../../agents/tasks/heal-actions.js';
import { toolError, type ToolPlugin } from '../types.js';

export const resolveBlockedInput = z.object({
  taskId: z.string().trim().toLowerCase().regex(/^[0-9a-f-]{36}$/),
  action: z.enum(['retry', 'cancel']),
  instruction: z.string().trim().min(1).max(1000).optional(),
  reason: z.string().trim().min(1).max(300).optional(),
}).strict().superRefine((v, c) => {
  if (v.action === 'retry' && !v.instruction) c.addIssue({ code: 'custom', path: ['instruction'], message: 'retry needs an instruction' });
  if (v.action === 'cancel' && !v.reason) c.addIssue({ code: 'custom', path: ['reason'], message: 'cancel needs a reason' });
});
type Input = z.infer<typeof resolveBlockedInput>;

/**
 * HEAL-1 (SA-1 C1, Gate 1 HL-C9): a head decides about a blocked task it is the decider of (the parent's owner, or the CEO from a decide task), from the wake run
 * or the parent's own run. NO `kind` and `requiresApproval: false`: a declared kind would make the registry file an approval card (policy-approval.ts), and the
 * tool only moves a task inside the company. Who may call it, which task, the caps and every refusal are decided by the port from database rows
 * (agents/tasks/heal-actions.ts); the model passes the validated input only. Never an input field for the caller, the run task or the taint.
 */
export const resolveBlocked: ToolPlugin<Input> = {
  name: 'resolve_blocked',
  description:
    'Decide about a blocked task you are woken for or gave out: action "retry" with a clearer instruction (1 to 1000 characters) that is added to the task and puts it back in todo, ' +
    'or action "cancel" with a short reason (cancelling cannot be undone). Works only from the task that gave the blocked task out, or from the decision task you were woken on. ' +
    'To ask the person instead, use ask_requester.',
  inputSchema: resolveBlockedInput,
  requiresApproval: () => false,
  async run(input, ctx) {
    if (!ctx.heal) return toolError('resolve_blocked is not available');
    const r = await ctx.heal.resolve({
      actor: ctx.actor, callerTaskId: ctx.task?.id ?? null, tainted: ctx.tainted() || ctx.task?.tainted === true,
      taskId: input.taskId, action: input.action, ...(input.instruction ? { instruction: input.instruction } : {}), ...(input.reason ? { reason: input.reason } : {}),
    });
    if (!r.ok) return toolError(HEAL_REFUSALS[r.code]);
    return { content: r.action === 'retry' ? 'the task is back in todo with your instruction; its owner runs it again' : 'the task was cancelled' };
  },
};

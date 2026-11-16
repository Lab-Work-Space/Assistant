import { z } from 'zod';
import { redactText } from '../../core/logger.js';
import type { TaskStatus } from '../../db/repos/tasks.js';
import { runOrTaskTainted, sameActor, toolError, type ToolContext, type ToolPlugin, type ToolResult } from '../types.js';

export const NOTE_MAX_CHARS = 500;
export const NOTES_MAX = 5;
const BLOCKED_REASON_MIN = 5;
const BLOCKED_NEEDS_REASON = 'blocked needs a short reason in summary';
/**
 * TA-C15: the blocked reason as it travels: pattern-masked and folded to one line, NOT cut here. This layer has no literal secret list, so a cut here could
 * split a literal secret and leave a prefix the later mask no longer recognises (G2-02). The store (TaskRepo.maskNote) and each consumer (card, room line)
 * mask with the literal list first and cut to 300 after.
 */
const blockedText = (s: string): string => redactText(s).replace(/\s+/g, ' ').trim();

export const updateTaskInput = z.object({
  taskId: z.string().min(1).max(64),
  status: z.enum(['doing', 'review', 'done', 'blocked']),
  summary: z.string().trim().min(1).max(4000).optional(),
  notes: z.array(z.string().trim().min(1).max(NOTE_MAX_CHARS)).max(NOTES_MAX).optional(),
  /** TEAMTALK-1: for a task owned by a team member: up to 3 ideas and 3 decisions, shown in that member's room (any status). */
  ideas: z.array(z.string().trim().min(1).max(200)).max(3).optional(),
  decisions: z.array(z.string().trim().min(1).max(200)).max(3).optional(),
}).superRefine((v, ctx) => {
  // TASKADMIN-1 (TA-C15): a model that blocks its own task says why; the reason is stored and shown on the cards and in /task list.
  if (v.status === 'blocked' && (v.summary?.length ?? 0) < BLOCKED_REASON_MIN) ctx.addIssue({ code: 'custom', path: ['summary'], message: BLOCKED_NEEDS_REASON });
});
type Input = z.infer<typeof updateTaskInput>;

/**
 * AUTO-1 (AP-C17): the error for an unknown id. Fixed text plus the caller's own open tasks as id8, status and dept (the `ownTasksHeader` rule: no title, no description, never the
 * model's input). With no rows, no `openOf` or a fault: exactly `no task has that id`.
 */
async function noTaskText(ctx: ToolContext): Promise<string> {
  const base = 'no task has that id';
  if (!ctx.tasks.openOf) return base;
  try {
    const rows = (await ctx.tasks.openOf(ctx.actor, 10)).slice(0, 10);
    if (!rows.length) return base;
    const safe = (s: string) => s.replace(/[^\w-]/g, '').slice(0, 24);
    return `${base}. Your open tasks (id status dept): ${rows.map((r) => `${safe(r.id).slice(0, 8)} ${safe(r.status)} ${safe(r.deptId)}`).join('; ')}`;
  } catch {
    return base;
  }
}

/** Finished, cancelled or waiting on a human: the owner cannot move these (an approval is never bypassed). */
const LOCKED: readonly TaskStatus[] = ['done', 'cancelled', 'awaiting_approval'];

/**
 * Status change by the task owner only (Gate 1 D14). `done` needs a summary; up to 5 notes go to the owner
 * department's dept_notes as long-term memory.
 */
export const updateTask: ToolPlugin<Input> = {
  name: 'update_task',
  description:
    'Change the status of a task you own: doing, review (ready to check), done (needs a summary) or blocked (needs a short reason in summary, at least 5 characters; it is shown to the people who manage the task). ' +
    'With done, add up to 5 short notes: facts or decisions your department should remember. ' +
    'If you are a team member, you may also add up to 3 ideas and up to 3 decisions for your own room (short lines; they are shown to your team).',
  inputSchema: updateTaskInput,
  requiresApproval: () => false,
  async run(input, ctx): Promise<ToolResult> {
    // AUTO-1 (SA-1 3.9, AP-C17): the exact id first; else one open task of the caller whose id starts with an 8 to 35 character hex prefix (the log: the header showed id8 only)
    let task = await ctx.tasks.get(input.taskId);
    if (!task && /^[0-9a-f-]{8,35}$/.test(input.taskId) && ctx.tasks.ownByPrefix) task = await ctx.tasks.ownByPrefix(ctx.actor, input.taskId).catch(() => null);
    if (!task) return toolError(await noTaskText(ctx)); // HEAL-1 (HL-C15): the failed-tool footer shows this text, so it never echoes model input
    if (!sameActor(task.owner, ctx.actor)) return toolError('you are not the owner of that task');
    if (LOCKED.includes(task.status)) return toolError(`task is ${task.status} and cannot be changed`);
    if (input.status === 'done' && !input.summary) return toolError('done needs a summary');
    // the registry already validated the schema; this keeps a direct caller honest too (TA-C15)
    const reason = input.status === 'blocked' ? blockedText(input.summary ?? '') : null;
    if (input.status === 'blocked' && (reason?.length ?? 0) < BLOCKED_REASON_MIN) return toolError(BLOCKED_NEEDS_REASON);
    // LEARN-1 (LL-C1): the summary or blocked note below is model text. When this run (or the task it works on) read outside content, the target carries that taint in the SAME update,
    // so its room line, its parent's roll-up and a heal decide task read it as tainted. Taint is read from the run, never from tool input.
    const updated = await ctx.tasks.update(task.id, { status: input.status, ...(reason !== null ? { blockedReason: 'owner' as const, blockedNote: reason } : {}), ...(runOrTaskTainted(ctx) && !task.tainted ? { tainted: true } : {}) }, task.status);
    if (!updated) return toolError('task changed meanwhile; read it again');
    for (const note of input.notes ?? []) await ctx.notes.add(task.deptId, task.id, note);
    // T12: ideas and decisions go to the room of the persona that owns the task; for any other owner they are dropped with a fixed message.
    const wantsRoom = !!input.ideas?.length || !!input.decisions?.length;
    const room = wantsRoom && task.owner.kind === 'persona';
    await ctx.bus.emit('task.changed', {
      task: updated,
      from: task.status,
      to: input.status,
      ...(reason !== null ? { summary: reason } : input.summary ? { summary: input.summary } : {}), // a blocked reason travels pattern-masked and uncut; each consumer masks with the literal list, then cuts (TA-C15, G2-02)
      // the taint is read from the run here (never from tool input): a room entry is as tainted as the run that wrote it
      ...(room ? { ...(input.ideas?.length ? { ideas: input.ideas } : {}), ...(input.decisions?.length ? { decisions: input.decisions } : {}), runTainted: ctx.tainted() } : {}),
    });
    return { content: `task ${task.id} is now ${input.status}${wantsRoom && !room ? ' (ideas and decisions are recorded only for tasks owned by a team member, so they were not saved)' : ''}` };
  },
};

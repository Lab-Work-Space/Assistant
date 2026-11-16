import { z } from 'zod';
import { defangHandles, neutralise } from '../../company/handles.js';
import { redactText } from '../../core/logger.js';
import { sameActor, toolError, type ToolPlugin } from '../types.js';

/** ASKBACK-1: the longest question that is stored and posted, counted after redaction and defanging. */
export const ASK_MAX_CHARS = 500;

export const askRequesterInput = z.object({ question: z.string().trim().min(1).max(2000) }); // 500 is enforced after redact and defang
type Input = z.infer<typeof askRequesterInput>;

/** Fixed, code-written refusals: the model never reads anything else about why, and none of them echoes its own text. */
export const ASK_REFUSALS = {
  unavailable: 'ask_requester is not available',
  noTask: 'ask_requester needs a task you own that is in progress',
  noRequester: 'this task has no requester you can ask',
  wake: 'you cannot ask a question while answering one',
  meeting: 'ask_requester cannot be used inside a meeting',
  open: 'you already have an open question on this task; wait for the answer',
  cap: 'this task already used its 2 questions; decide yourself or mark the task blocked',
  limit: 'the question limit is reached; decide yourself or mark the task blocked',
  perRun: 'ask_requester can be called once per run',
  length: `question too long (at most ${ASK_MAX_CHARS} characters)`,
  post: 'the question could not be posted; decide yourself or mark the task blocked',
  /** AUTO-1 (SA-1 3.7): inside an approved project the owner is never asked. */
  autopilot: 'You are running an approved project: do not ask the owner. Pick the option you recommend, record it in the task notes, and proceed.',
  /** AUTO-2 (SA-1 3.5): a company tree never asks a person either. */
  autopilotCompany: 'You work under the owner\'s standing approval: do not ask a person. Pick the option you recommend, record it in the task notes, and proceed.',
  /** AB4: every call after a successful ask in the same tool batch. */
  ended: 'the run ended with a question; nothing else was done',
} as const;

/**
 * ASKBACK-1: the owner of a task asks its requester ONE clarifying question and ends its run. The requester (a head, or a person on a root task) is
 * found in the task's database rows by the scheduler's port, never named here; the question goes out as a code-framed line, the answer wakes the owner
 * again. Not approval-gated (like update_task): the line is code-framed, redacted, defanged, capped and stays in the task's own threads.
 */
export const askRequester: ToolPlugin<Input> = {
  name: 'ask_requester',
  description:
    'Ask the requester of the task you own ONE clear question when a wrong guess would waste work (at most 500 characters, at most 2 per task). ' +
    'Your run ends here; you are woken with the answer, or after a timeout with nothing, and then decide. Do not use it for status updates.',
  inputSchema: askRequesterInput,
  requiresApproval: () => false,
  async run(input, ctx) {
    if (!ctx.ask) return toolError(ASK_REFUSALS.unavailable);
    if (ctx.noAsk || ctx.askWake) return toolError(ASK_REFUSALS.wake);
    if (ctx.inMeeting) return toolError(ASK_REFUSALS.meeting);
    const task = ctx.task;
    if (!task || !sameActor(task.owner, ctx.actor) || task.status !== 'doing') return toolError(ASK_REFUSALS.noTask);
    // AUTO-1: a person is never asked inside an active project (a head requester still can be: personas are bots too, C5). A port fault reads as "no project" (today's rules).
    if (task.requester.kind === 'human' && ctx.autopilot && (await ctx.autopilot.projectOf(task.id).catch(() => null))) return toolError(ASK_REFUSALS.autopilot);
    // AUTO-2: the same inside a company tree (a port fault reads as "not company": today's behaviour)
    if (task.requester.kind === 'human' && ctx.autopilot?.inCompany && (await ctx.autopilot.inCompany(task.id).catch(() => false))) return toolError(ASK_REFUSALS.autopilotCompany);
    if (ctx.run.askCalls >= 1) return toolError(ASK_REFUSALS.perRun);
    // redact first, then break raw mentions and handles, and only then measure (the stored and posted text is this very string)
    const text = defangHandles(neutralise(redactText(input.question)));
    if (text.length > ASK_MAX_CHARS) return toolError(ASK_REFUSALS.length);
    ctx.run.askCalls++;
    const r = await ctx.ask.ask({ actor: ctx.actor, taskId: task.id, question: text, tainted: ctx.tainted() });
    if (!r.ok) return toolError(ASK_REFUSALS[r.reason]);
    ctx.run.asked = true;
    return { content: `question ${r.seq}/2 sent; your run ends now. You will be woken with the answer, or after ${r.hours} h without one, and then decide.` };
  },
};

import { z } from 'zod';
import { convertedLength, handlesIn, neutralise } from '../../company/handles.js';
import { redactText } from '../../core/logger.js';
import { toolError, type ToolPlugin } from '../types.js';

/** LF5: at most this many characters after handles became mentions, and this many calls per run. */
export const SAY_MAX_CHARS = 1500;
export const SAY_CALLS_PER_RUN = 2;

export const warroomSayInput = z.object({ text: z.string().trim().min(1).max(6000) });
type Input = z.infer<typeof warroomSayInput>;

/** LF5: fixed, code-written refusals (the model never sees anything else about why). */
export const SAY_REFUSALS = {
  actor: 'warroom_say is for department heads and Praw only',
  postOnly: 'warroom_say cannot be used in a post-only run',
  meeting: 'warroom_say cannot be used inside a meeting',
  noRollup: 'warroom_say cannot be used while summarising replies from #ai-warroom',
  unavailable: 'warroom_say is not available',
  calls: `warroom_say can be called at most ${SAY_CALLS_PER_RUN} times in one run`,
  length: `warroom_say text is too long (at most ${SAY_MAX_CHARS} characters, handles count as mentions)`,
} as const;

/**
 * F2: a head or Praw starts a talk in #ai-warroom (the fixed bot-only room) so another head that cannot see the current channel can answer there.
 * The destination is not an argument: the scheduler's port posts to the room's constant id (LF1). The text is redacted first (LF6), then handles are
 * neutralised and converted by the port's outbound pass (TW8) like any bot post. Approval rule `bot_talk` (policy-approval.ts, by name): it reaches
 * only our own bots. When the caller has a conversation task, the first reply of each mentioned head is summarised back to the person once.
 */
export const warroomSay: ToolPlugin<Input> = {
  name: 'warroom_say',
  description:
    'Post a short message in #ai-warroom as yourself, to ask another department head something when that head cannot see this channel. ' +
    'Write the handle of each head you need (@CTO, @CFO, ...). At most 1500 characters, at most 2 calls per run. The answers are summarised to the person for you; do not wait for them.',
  inputSchema: warroomSayInput,
  kind: 'write',
  summary: (i) => ({ target: '#ai-warroom', change: i.text.slice(0, 200) }),
  requiresApproval: () => false,
  async run(input, ctx) {
    if (ctx.actor.kind !== 'head') return toolError(SAY_REFUSALS.actor);
    if (ctx.noWarroomSay) return toolError(SAY_REFUSALS.noRollup);
    if (ctx.inMeeting) return toolError(SAY_REFUSALS.meeting);
    if (!ctx.warroom) return toolError(SAY_REFUSALS.unavailable);
    // LF6: redact, then neutralise raw mention markup (TW8) before the length check, which counts handles as the mentions they become.
    const text = neutralise(redactText(input.text));
    if (convertedLength(text) > SAY_MAX_CHARS) return toolError(SAY_REFUSALS.length);
    if (ctx.run.sayCalls >= SAY_CALLS_PER_RUN) return toolError(SAY_REFUSALS.calls);
    ctx.run.sayCalls++;
    // A mention chat has no task yet: the conversation task is opened now (by code) so the summary has somewhere to wait; a failure just means no summary.
    let task = ctx.task;
    if (!task && ctx.ensureConversationTask && handlesIn(text).length) {
      try {
        task = await ctx.ensureConversationTask();
      } catch {
        task = null;
      }
    }
    const r = await ctx.warroom.say({ actor: ctx.actor, text, task, tainted: ctx.tainted(), personStarted: ctx.personStarted === true, personAdmin: ctx.personAdmin === true, personUser: ctx.source.userId, ...(ctx.localLifted ? { lifted: true } : {}) });
    if (!r.ok) return toolError(r.reason);
    return {
      content: r.rollup
        ? 'posted in #ai-warroom. The first reply of each head you mentioned will be summarised to the person once; do not wait for it. Tell the person you asked.'
        : 'posted in #ai-warroom. There is no conversation to report back to, so no summary will follow.',
    };
  },
};

import { z } from 'zod';
import { DEPT_IDS, type DeptId } from '../../core/index.js';
import { DUTY_IDS } from '../../company/duties.js';
import { chainDepts, cleanCardText, discordLink, forwardDescription, forwardTitle, FORWARDS_PER_ROOT, FORWARDS_PER_RUN, REASON_MAX, SUMMARY_MAX } from '../../company/forward.js';
import { toolError, type ToolContext, type ToolPlugin } from '../types.js';
import { delegate } from './createTask.js';

/**
 * P1 #3 / Gate 1 RF9-RF11: a head hands work that belongs to another duty to that department. It is create_task, not a copy of it: `delegate` runs
 * the same owner check, assignee check, canDelegate, duty check, view check, depth / children / open-task limits, root-task gate, approval for the
 * child, conversation task and taint. On top: a required duty and a never-zero estimate, the viewing-rights check for every head, a run cap of 2,
 * a per-root cap of 4 (taken with one conditional UPDATE), no forward back into the chain, fixed title, and a card that withholds the summary when
 * the target room can be seen by people who cannot see the source.
 */
export const forwardToInput = z.object({
  dept: z.enum(DEPT_IDS),
  summary: z.string().trim().min(1).max(SUMMARY_MAX),
  reason: z.string().trim().min(1).max(REASON_MAX),
  /** RF9: required, from the closed enum, checked in code against the target department's duties. */
  duty: z.enum(DUTY_IDS),
  /** RF9: required and positive: a 0 estimate would skip the approval threshold. */
  estCostUsd: z.number({ error: 'estCostUsd is required and must be a number' }).positive('estCostUsd must be > 0').max(1_000_000),
}).strict();
type Input = z.infer<typeof forwardToInput>;

/**
 * RF11 / G2RF-02: whether the target room can be seen by people who cannot see the source (true on any doubt). Full card text only when this is false.
 * Factored out of run() so the task-tree grant (TREEGRANT-1, TG-C4 b) asks the very same question at consume time: a forward whose audience is wider keeps its card.
 */
export async function forwardWider(dept: DeptId, ctx: ToolContext): Promise<boolean> {
  const target = ctx.org.dept(dept)?.workChannelId ?? null;
  // RF11: who can read the card. Full text only when @everyone can read the source (so no one in the target room is wider), or the same channel,
  // or the run is a person talking straight to Praw with nothing untrusted read. Any doubt = withhold.
  const src = ctx.source.channelId || null;
  // G2RF-02: a run in a thread reads who can see THE THREAD (a private thread is always narrower than its parent), before any same-channel or direct shortcut.
  let wider = true;
  const thread = ctx.source.threadId;
  if (thread) wider = !(await (ctx.channelIsPublic?.(thread) ?? Promise.resolve(false)).catch(() => false));
  else if (ctx.direct && !ctx.tainted()) wider = false;
  else if (src && target && src === target) wider = false;
  else if (src && ctx.channelIsPublic) wider = !(await ctx.channelIsPublic(src).catch(() => false));
  return wider;
}

export const forwardTo: ToolPlugin<Input> = {
  name: 'forward_to',
  description:
    'Hand work that belongs to another department\'s duty to that department\'s head. Give the department, a short self-contained summary of what is needed, ' +
    'the reason it belongs there, the duty (from the fixed duty list in your instructions) and your cost estimate in USD. At most 2 per run.',
  inputSchema: forwardToInput,
  kind: 'write', // RF9: approvalFor applies (a tainted run always asks); never in BOT_TALK_TOOLS
  summary: (i) => ({ target: `head of ${i.dept}`, change: `forward (duty ${i.duty}): ${cleanCardText(i.summary, 200)} | reason: ${cleanCardText(i.reason, 100)}` }),
  requiresApproval: () => false,
  // G2RF-01: the run cap counts PROPOSALS, not created children. The registry files an approval card before run() ever executes (heads are never
  // direct), so the count is taken here, once per accepted call, on both the first call and the approved replay.
  async precheck(_input, ctx) {
    if (ctx.run.forwards >= FORWARDS_PER_RUN) return { refuse: `at most ${FORWARDS_PER_RUN} forwards per run` };
    ctx.run.forwards++;
    return null;
  },
  async run(input, ctx) {
    if (ctx.actor.kind !== 'head') return toolError('only a department head can forward work');
    const dept = input.dept as DeptId;
    const src = ctx.source.channelId || null;
    const wider = await forwardWider(dept, ctx);
    const link = discordLink(ctx.guildId, ctx.source.threadId ?? src, ctx.source.messageId);
    const description = forwardDescription({
      link, from: ctx.actor.dept,
      reason: cleanCardText(input.reason, REASON_MAX),
      summary: cleanCardText(input.summary, SUMMARY_MAX),
    });
    return delegate(
      { title: forwardTitle(input.duty), description: '', assignee: { kind: 'head', dept }, duty: input.duty, estCostUsd: input.estCostUsd },
      ctx,
      {
        viewCheckAllHeads: true,
        child: { title: forwardTitle(input.duty), description, forwardCard: wider ? 'link' : 'full' },
        check: async (parent) => {
          if ((await chainDepts({ actor: ctx.actor, task: ctx.task }, (id) => ctx.tasks.get(id))).has(dept)) return 'that department is already part of this chain of work; do not forward back into it';
          if (parent && !ctx.tasks.takeForward) return 'forwarding is not available here';
          return null;
        },
        take: async (parent) => (parent ? !!ctx.tasks.takeForward && (await ctx.tasks.takeForward(parent.rootId, FORWARDS_PER_ROOT)) : true),
      },
    );
  },
};

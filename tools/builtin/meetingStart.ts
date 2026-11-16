import { z } from 'zod';
import { DEPT_IDS } from '../../core/index.js';
import { toolError, type ToolPlugin } from '../types.js';

export const meetingStartInput = z.object({
  topic: z.string().trim().min(1).max(100),
  agenda: z.array(z.string().trim().min(1).max(200)).min(1).max(5),
  invitees: z.array(z.enum(DEPT_IDS)).min(1).max(9),
});
type Input = z.infer<typeof meetingStartInput>;

/**
 * Teamwork C / Gate 1 TW13: the CEO opens a meeting thread in #💬-ai-warroom: an agenda of at most 5 points and at most 9 invitees. The
 * caps (per day, not inside a meeting, not while another is open) are checked in `precheck`, so they hold again when an approved call
 * is replayed. RULING: a call from a run that read outside text (`ctx.tainted()`) asks for approval on top of the caps; such a run
 * with no task cannot ask (the registry refuses "needs approval ... inside a task"), so a CEO with no task and a tainted run cannot start one.
 */
export const meetingStart: ToolPlugin<Input> = {
  name: 'meeting_start',
  description:
    'Call a meeting of heads in #ai-warroom (CEO only). Give a topic, an agenda of at most 5 points and the invited heads (at most 9). ' +
    'Each invitee speaks once per round for 2 rounds, then you close with decisions. At most 2 ad-hoc meetings per day; not inside a meeting.',
  inputSchema: meetingStartInput,
  summary: (i) => ({ target: 'warroom meeting', change: `${i.invitees.length} invitees, ${i.agenda.length} agenda points` }),
  async precheck(_input, ctx) {
    if (ctx.actor.kind !== 'head' || ctx.actor.dept !== 'hq') return { refuse: 'only the CEO starts meetings' };
    if (ctx.inMeeting) return { refuse: 'a meeting cannot be started from inside a meeting' };
    if (!ctx.meetings) return { refuse: 'meetings are not available' };
    const why = ctx.meetings.refusal({ threadId: ctx.source.threadId }, ctx.localLifted === true);
    return why ? { refuse: why } : null;
  },
  requiresApproval: (_i, ctx) => (ctx.tainted() ? { reason: 'meeting_start from a run that read outside text' } : false),
  async run(input, ctx) {
    if (!ctx.meetings) return toolError('meetings are not available');
    const r = await ctx.meetings.start({ topic: input.topic, agenda: input.agenda, invitees: input.invitees, actor: ctx.actor, from: { threadId: ctx.source.threadId }, lifted: ctx.localLifted === true });
    return r.ok ? { content: 'meeting opened in #ai-warroom; the invitees speak in order and you close it' } : toolError(r.reason);
  },
};

import { z } from 'zod';
import { isDenied } from '../../../company/denylist.js';
import { DeniedChannelError, PinError } from '../../../discord/port.js';
import { toolError, type ToolContext, type ToolPlugin } from '../../types.js';
import type { GroupFactory } from '../index.js';

const SNOWFLAKE = /^\d{17,20}$/;
const Input = z.object({
  messageId: z.string().regex(SNOWFLAKE).optional().describe('Id of a message in this conversation; omit to pin the message that asked'),
  where: z.string().regex(SNOWFLAKE).optional().describe('Channel or thread of the message. Filled in by the assistant when the call is checked; leave it out'),
});
type In = z.infer<typeof Input>;

const MOVED = 'the conversation this pin was checked in is not the one running it now, so nothing was pinned; ask again';
const NO_MESSAGE = 'there is no message to pin here; pass messageId of a message in this conversation';

/**
 * Where and what to pin, from the run's conversation (ctx.source) and the pinned input. With a trigger message the target is
 * that conversation (the thread when there is one, else the channel) and a pinned `where` must equal it. Without one (an approved
 * replay or an owner run) a pinned `where` must still be this task's thread or its parent channel; neither may be denied.
 */
function resolve(i: In, ctx: ToolContext): { where: string; id: string } | { refuse: string } {
  const { channelId, threadId, messageId } = ctx.source;
  if (!channelId) return { refuse: 'there is no conversation channel to pin in' };
  if (isDenied(channelId, null) || (threadId !== null && isDenied(threadId, channelId))) return { refuse: 'this channel is off-limits' };
  const live = threadId ?? channelId;
  const id = i.messageId ?? messageId;
  if (!id || !SNOWFLAKE.test(id)) return { refuse: NO_MESSAGE };
  if (i.where === undefined) return { where: live, id };
  const ok = messageId ? i.where === live : i.where === channelId || i.where === threadId;
  return ok ? { where: i.where, id } : { refuse: MOVED };
}

/**
 * P17: pin_message pins only in the conversation the run came from. The model's input has no channel; the precheck pins the
 * message id and its channel into the approved input (P3), so an approved replay (which has no trigger message) pins exactly
 * what the approver saw, and only while that channel is still this task's conversation. Kind write (R3).
 */
export const pinGroup: GroupFactory = (deps) => {
  const pin: ToolPlugin<In> = {
    name: 'pin_message',
    description: 'Pin a message in the current channel or thread (by default the message that asked you).',
    kind: 'write',
    inputSchema: Input,
    requiresApproval: () => false, // the central write policy (R3) decides
    async precheck(input, ctx) {
      const r = resolve(input, ctx);
      if ('refuse' in r) return r;
      return { summary: { target: `channel ${r.where}`, change: `pin message ${r.id}` }, pin: { messageId: r.id, where: r.where } };
    },
    async run(input, ctx) {
      const r = resolve(input, ctx);
      if ('refuse' in r) return toolError(r.refuse);
      try {
        await deps.port.pin(ctx.actor, r.where, r.id);
        return { content: `Pinned message ${r.id}.` };
      } catch (e) {
        if (e instanceof PinError) return toolError(e.message);
        if (e instanceof DeniedChannelError) return toolError('this channel is off-limits');
        return toolError('pinning failed');
      }
    },
  };
  return { id: 'pin', tools: [pin] as ToolPlugin<any>[] };
};

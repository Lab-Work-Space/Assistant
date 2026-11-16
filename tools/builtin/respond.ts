import { z } from 'zod';
import { MODEL_PAYLOAD_TYPES, toPayload } from '../../agents/loop/payload.js';
import type { ToolPlugin } from '../types.js';

/** Field count and lengths are truncated by toPayload, not rejected, so a long report still gets posted. */
export const respondInput = z.object({
  type: z.enum(MODEL_PAYLOAD_TYPES),
  title: z.string().optional(),
  body: z.string().min(1),
  fields: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
});
type Input = z.infer<typeof respondInput>;

/** Ends the turn with the final answer. No footer, buttons or config embeds: those are system-only. */
export const respond: ToolPlugin<Input> = {
  name: 'respond',
  description: 'Send your final answer for this turn. type: chat for a reply, report for finished work, alert for a problem.',
  inputSchema: respondInput,
  requiresApproval: () => false,
  async run(input) {
    return { content: 'sent', terminal: toPayload(input) };
  },
};

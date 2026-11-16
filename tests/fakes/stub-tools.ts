import { z } from 'zod';
import type { ToolPlugin } from '../../tools/types.js';

/** A stand-in for a destructive-class tool (the manifest classifies github_create_branch as DESTRUCTIVE): the autopilot tests only need a call that always makes a card; it never runs. */
export const destructiveStub = (): ToolPlugin<Record<string, unknown>> => ({
  name: 'github_create_branch', description: 'test stub of a destructive-class tool', inputSchema: z.object({}).passthrough(),
  kind: 'write', requiresApproval: () => false, run: async () => ({ content: 'ok' }),
});

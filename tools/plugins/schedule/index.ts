import { z } from 'zod';
import { CapError } from '../../../db/repos/praw.js';
import type { ScheduledJob } from '../../../db/repos/jobs.js';
import { runOrTaskTainted, TAINTED_SETUP_REFUSAL, toolError, type ToolContext, type ToolPlugin } from '../../types.js';
import type { GroupFactory } from '../index.js';
import type { PluginDeps } from '../deps.js';
import { MIN_INTERVAL_MINUTES, planJob } from './time.js';

/** Jobs are only managed from a human-started conversation (P14); schedule/watch/delegated chains cannot create more of themselves. */
const CREATORS = new Set(['chat', 'slash', 'voice']);
export const PROMPT_MAX = 2000;

export const capMessage = (e: CapError): string => `schedule limit reached (${e.scope === 'user' ? 'per user' : 'company'}: ${e.limit}); remove one first`;

export const describeJob = (j: Pick<ScheduledJob, 'id' | 'prompt' | 'kind' | 'hhmm' | 'intervalMinutes' | 'nextRunAt'>): string =>
  `#${j.id} ${j.kind === 'daily' ? `daily ${j.hhmm}` : j.kind === 'interval' ? `every ${j.intervalMinutes}m` : 'once'}, next ${j.nextRunAt.toISOString()}: ${j.prompt.slice(0, 120)}`;

const AddInput = z.object({
  prompt: z.string().trim().min(1).max(PROMPT_MAX).describe('What Praw should do each time the job runs'),
  kind: z.enum(['daily', 'interval', 'once']),
  hhmm: z.string().max(5).optional().describe('daily: 24-hour time like 09:00, in the schedule time zone (Asia/Bangkok by default)'),
  intervalMinutes: z.number().int().min(MIN_INTERVAL_MINUTES).max(525_600).optional().describe(`interval: minutes between runs, at least ${MIN_INTERVAL_MINUTES}`),
  at: z.string().max(40).optional().describe('once: ISO 8601 date-time (no offset = the schedule time zone)'),
});
const RemoveInput = z.object({ id: z.number().int().min(1) });

function requester(ctx: ToolContext): { userId: string; channelId: string } | string {
  if (!CREATORS.has(ctx.origin)) return 'schedules can only be managed from a conversation with a person, not from schedules, watches or delegated work';
  if (!ctx.source.userId) return 'no requesting user for this run';
  return { userId: ctx.source.userId, channelId: ctx.source.channelId }; // the parent channel for a thread: the run creates its own thread there
}

export const scheduleGroup: GroupFactory = (deps: PluginDeps) => {
  const repo = deps.jobs;
  if (!repo) return { id: 'schedule', disabled: 'scheduled jobs store not available' };
  const add: ToolPlugin<z.infer<typeof AddInput>> = {
    name: 'schedule_add',
    description: 'Schedule a prompt for Praw to run later: daily at a time, every N minutes (15 or more), or once. The result is posted in this channel.',
    kind: 'write',
    inputSchema: AddInput,
    requiresApproval: () => false,
    // LEARN-1 LL-C2: refused before any card is filed (the central approval comes after the precheck)
    async precheck(_input, ctx) {
      return runOrTaskTainted(ctx) ? { refuse: TAINTED_SETUP_REFUSAL } : null;
    },
    async run(input, ctx) {
      const who = requester(ctx);
      if (typeof who === 'string') return toolError(who);
      const plan = planJob(input, deps.clock(), deps.cfg.get('schedule.timezone'));
      if ('error' in plan) return toolError(plan.error);
      try {
        const j = await repo.add({ guildId: deps.env.guildId, channelId: who.channelId, userId: who.userId, prompt: input.prompt, origin: 'schedule', ...plan },
          { perUser: deps.cfg.get('limits.schedulesPerUser'), total: deps.cfg.get('limits.schedulesTotal') });
        return j ? { content: `Schedule #${j.id} saved; first run ${plan.nextRunAt.toISOString()}.` } : toolError('schedule was not saved');
      } catch (err) {
        if (err instanceof CapError) return toolError(capMessage(err));
        throw err;
      }
    },
  };
  const list: ToolPlugin<Record<string, never>> = {
    name: 'schedule_list',
    description: "List the requesting person's scheduled jobs.",
    kind: 'read',
    inputSchema: z.object({}),
    requiresApproval: () => false,
    async run(_i, ctx) {
      const who = requester(ctx);
      if (typeof who === 'string') return toolError(who);
      const rows = await repo.list(who.userId);
      return { content: rows.length ? rows.map(describeJob).join('\n') : 'No scheduled jobs.' };
    },
  };
  const remove: ToolPlugin<z.infer<typeof RemoveInput>> = {
    name: 'schedule_remove',
    description: "Remove one of the requesting person's scheduled jobs by id.",
    kind: 'write',
    inputSchema: RemoveInput,
    requiresApproval: () => false,
    async run(input, ctx) {
      const who = requester(ctx);
      if (typeof who === 'string') return toolError(who);
      return (await repo.remove(input.id, who.userId)) ? { content: `Schedule #${input.id} removed.` } : toolError(`no schedule #${input.id} of yours`);
    },
  };
  return { id: 'schedule', tools: [add, list, remove] as ToolPlugin<any>[] };
};

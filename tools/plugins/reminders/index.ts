import { z } from 'zod';
import { CapError } from '../../../db/repos/praw.js';
import { wallToUtc } from '../../../db/repos/jobs.js';
import type { Reminder } from '../../../db/repos/reminders.js';
import { runOrTaskTainted, TAINTED_SETUP_REFUSAL, toolError, type ToolContext, type ToolPlugin } from '../../types.js';
import type { GroupFactory } from '../index.js';
import type { PluginDeps } from '../deps.js';

const MIN_MS = 60_000;
const YEAR_MS = 365 * 24 * 60 * MIN_MS;
export const TEXT_MAX = 500;
/** Tools that create a reminder only run for a human-started conversation (P14); schedule/watch/delegated chains cannot. */
const CREATORS = new Set(['chat', 'slash', 'voice']);

export type ReminderSpec = {
  text: string;
  when: string | { inMinutes: number };
  everyMinutes?: number | undefined;
  advanceMinutes?: number | undefined;
  notifyVia?: 'dm' | 'channel' | undefined;
};

export type ReminderPlan = { remindAt: Date; everyMinutes: number | null; advanceMinutes: number | null; notifyVia: 'dm' | 'channel' } | { error: string };

const MAX_MINUTES = 525_600;
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?$/;

/** Strict ISO 8601 date-time only. With Z or an offset it is absolute; without one it is the wall clock in `tz`. NaN for anything else. */
export function parseIsoWhen(s: string, tz: string): number {
  const m = ISO.exec(s.trim());
  if (!m) return NaN;
  const [, y, mo, d, h, mi, sec] = m;
  const wall = Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +(sec ?? 0));
  const back = new Date(wall);
  if (back.getUTCMonth() !== +mo! - 1 || back.getUTCDate() !== +d! || +h! > 23 || +mi! > 59 || +(sec ?? 0) > 59) return NaN; // 02-31, 25:00
  if (m[7]) return Date.parse(s.trim());
  return wallToUtc(wall, tz).getTime();
}

/** Shared by the tool and `/remind add`: the time must be in the future and within a year; every 1..525600; advance >= 0 and before the reminder. */
export function planReminder(i: ReminderSpec, now: number, tz = 'Asia/Bangkok'): ReminderPlan {
  const ms = typeof i.when === 'string' ? parseIsoWhen(i.when, tz) : now + i.when.inMinutes * MIN_MS;
  if (!Number.isFinite(ms)) return { error: 'when must be an ISO 8601 date-time (like 2026-11-02T09:00) or {inMinutes}' };
  if (ms <= now) return { error: 'that time is in the past' };
  if (ms > now + YEAR_MS) return { error: 'reminders can be at most 1 year ahead' };
  if (i.everyMinutes !== undefined && (!Number.isInteger(i.everyMinutes) || i.everyMinutes < 1 || i.everyMinutes > MAX_MINUTES)) return { error: `everyMinutes must be 1 to ${MAX_MINUTES}` };
  if (i.advanceMinutes !== undefined && (!Number.isInteger(i.advanceMinutes) || i.advanceMinutes < 0)) return { error: 'advanceMinutes must be 0 or more' };
  // An advance notice that would already be due now adds nothing: drop it.
  const advance = i.advanceMinutes !== undefined && i.advanceMinutes * MIN_MS < ms - now ? i.advanceMinutes : null;
  return { remindAt: new Date(ms), everyMinutes: i.everyMinutes ?? null, advanceMinutes: advance, notifyVia: i.notifyVia ?? 'channel' };
}

export const capMessage = (e: CapError): string => `reminder limit reached (${e.scope === 'user' ? 'per user' : 'company'}: ${e.limit}); cancel one first`;

export const describeReminder = (r: Pick<Reminder, 'id' | 'text' | 'remindAt' | 'everyMinutes' | 'notifyVia'>): string =>
  `#${r.id} ${r.remindAt.toISOString()}${r.everyMinutes ? ` every ${r.everyMinutes}m` : ''}${r.notifyVia === 'dm' ? ' (dm)' : ''}: ${r.text.slice(0, 120)}`;

const AddInput = z.object({
  text: z.string().trim().min(1).max(TEXT_MAX).describe('What to remind about'),
  when: z.union([z.string().min(1).max(40), z.object({ inMinutes: z.number().int().min(1).max(525_600) })]).describe('ISO 8601 date-time (no offset = the schedule time zone, Asia/Bangkok by default) or {inMinutes} from now'),
  everyMinutes: z.number().int().min(1).max(MAX_MINUTES).optional().describe('Repeat every N minutes'),
  advanceMinutes: z.number().int().min(0).optional().describe('Also remind N minutes before'),
  notifyVia: z.enum(['dm', 'channel']).optional(),
});
const CancelInput = z.object({ id: z.number().int().min(1) });

/** The requester comes from the trigger only (P14); a missing user or a non-human origin refuses. */
function requester(ctx: ToolContext): { userId: string; channelId: string } | string {
  if (!CREATORS.has(ctx.origin)) return 'reminders can only be managed from a conversation with a person, not from schedules, watches or delegated work';
  if (!ctx.source.userId) return 'no requesting user for this run';
  return { userId: ctx.source.userId, channelId: ctx.source.threadId ?? ctx.source.channelId };
}

export const remindersGroup: GroupFactory = (deps: PluginDeps) => {
  const repo = deps.reminders;
  if (!repo) return { id: 'reminders', disabled: 'reminders store not available' };
  const add: ToolPlugin<z.infer<typeof AddInput>> = {
    name: 'add_reminder',
    description: 'Set a reminder for the person talking to you (posted in this channel, or by DM). Up to 1 year ahead.',
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
      const plan = planReminder(input, deps.clock(), deps.cfg.get('schedule.timezone'));
      if ('error' in plan) return toolError(plan.error);
      try {
        const r = await repo.add({ guildId: deps.env.guildId, channelId: who.channelId, userId: who.userId, text: input.text, ...plan },
          { perUser: deps.cfg.get('limits.remindersPerUser'), total: deps.cfg.get('limits.remindersTotal') });
        return r ? { content: `Reminder #${r.id} set for ${plan.remindAt.toISOString()}.` } : toolError('reminder was not saved');
      } catch (err) {
        if (err instanceof CapError) return toolError(capMessage(err));
        throw err;
      }
    },
  };
  const list: ToolPlugin<Record<string, never>> = {
    name: 'list_reminders',
    description: "List the requesting person's pending reminders.",
    kind: 'read',
    inputSchema: z.object({}),
    requiresApproval: () => false,
    async run(_i, ctx) {
      const who = requester(ctx);
      if (typeof who === 'string') return toolError(who);
      const rows = await repo.list(who.userId);
      return { content: rows.length ? rows.map(describeReminder).join('\n') : 'No pending reminders.' };
    },
  };
  const cancel: ToolPlugin<z.infer<typeof CancelInput>> = {
    name: 'cancel_reminder',
    description: "Cancel one of the requesting person's reminders by id.",
    kind: 'write',
    inputSchema: CancelInput,
    requiresApproval: () => false,
    async run(input, ctx) {
      const who = requester(ctx);
      if (typeof who === 'string') return toolError(who);
      return (await repo.cancel(input.id, who.userId)) ? { content: `Reminder #${input.id} cancelled.` } : toolError(`no reminder #${input.id} of yours`);
    },
  };
  return { id: 'reminders', tools: [add, list, cancel] as ToolPlugin<any>[] };
};

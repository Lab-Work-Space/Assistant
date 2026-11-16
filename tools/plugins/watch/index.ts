import { z } from 'zod';
import { redactText } from '../../../core/logger.js';
import { CapError } from '../../../db/repos/praw.js';
import type { Watch } from '../../../db/repos/watches.js';
import { checkUrl, type Resolver } from '../../../net/guard.js';
import { systemResolver } from '../../../net/system.js';
import { urlKey } from '../../urls.js';
import { toolError, type ToolContext, type ToolPlugin } from '../../types.js';
import type { GroupFactory } from '../index.js';
import type { PluginDeps } from '../deps.js';

export const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 525_600;
const TARGET_MAX = 2000;
const TOPIC_MAX = 200;
const REASON_MAX = 300;
/** Watches are only managed from a human-started conversation (P14); schedule/watch/delegated chains cannot create more of themselves. */
const CREATORS = new Set(['chat', 'slash', 'voice']);

export type WatchSpec = { kind: 'url' | 'topic'; target: string; intervalMinutes: number };
export type WatchPlan = WatchSpec | { error: string };
/** What the SSRF pre-check needs (the same resolver and port allow-list the poller's safeFetch uses). */
export type WatchNet = { resolver: Resolver; extraPorts: () => number[] };

/**
 * Shared by the tool and `/watch add`. A url must be http(s) and pass the full net/guard target check now (scheme, credentials,
 * port, host name, every resolved address); nothing is fetched here. The stored target has no fragment. The error text never echoes the input.
 */
export async function planWatch(i: { kind: string; target: string; intervalMinutes: number }, net: WatchNet): Promise<WatchPlan> {
  if (!Number.isInteger(i.intervalMinutes) || i.intervalMinutes < MIN_INTERVAL_MINUTES || i.intervalMinutes > MAX_INTERVAL_MINUTES)
    return { error: `the interval must be ${MIN_INTERVAL_MINUTES} to ${MAX_INTERVAL_MINUTES} minutes` };
  const target = i.target.trim();
  if (i.kind === 'topic') {
    return target && target.length <= TOPIC_MAX ? { kind: 'topic', target, intervalMinutes: i.intervalMinutes } : { error: `a topic is 1 to ${TOPIC_MAX} characters` };
  }
  if (i.kind !== 'url') return { error: 'kind must be url or topic' };
  const key = target.length <= TARGET_MAX ? urlKey(target) : null;
  if (key === null) return { error: 'a url watch needs an http(s) url' };
  try {
    await checkUrl(key, { resolver: net.resolver, extraPorts: net.extraPorts() });
  } catch {
    return { error: 'that address cannot be watched (private, local, credentialed or unresolvable)' };
  }
  return { kind: 'url', target: key, intervalMinutes: i.intervalMinutes };
}

export const capMessage = (e: CapError): string => `watch limit reached (${e.scope === 'user' ? 'per user' : 'company'}: ${e.limit}); remove one first`;

export const describeWatch = (w: Pick<Watch, 'id' | 'kind' | 'target' | 'intervalMinutes'>): string =>
  `#${w.id} ${w.kind} every ${w.intervalMinutes}m: ${w.target.slice(0, 150)}`;

const AddInput = z.object({
  kind: z.enum(['url', 'topic']).describe('url: tell me when the page text changes; topic: tell me about new web search results'),
  target: z.string().trim().min(1).max(TARGET_MAX).describe('The http(s) url, or the topic words to search for'),
  intervalMinutes: z.number().int().min(MIN_INTERVAL_MINUTES).max(MAX_INTERVAL_MINUTES).describe(`Minutes between checks, at least ${MIN_INTERVAL_MINUTES}`),
});
const RemoveInput = z.object({ id: z.number().int().min(1) });

function requester(ctx: ToolContext): { userId: string; channelId: string } | string {
  if (!CREATORS.has(ctx.origin)) return 'watches can only be managed from a conversation with a person, not from schedules, watches or delegated work';
  if (!ctx.source.userId) return 'no requesting user for this run';
  return { userId: ctx.source.userId, channelId: ctx.source.channelId }; // the parent channel for a thread
}

export const watchGroup: GroupFactory = (deps: PluginDeps) => {
  const repo = deps.watches;
  if (!repo) return { id: 'watch', disabled: 'watches store not available' };
  const net: WatchNet = { resolver: deps.net?.resolver ?? systemResolver, extraPorts: () => deps.cfg.get('net.extraPorts') };
  const add: ToolPlugin<z.infer<typeof AddInput>> = {
    name: 'watch_add',
    description: 'Watch a web page for changes, or a topic for new search results, and post a summary in this channel (checked at most every 15 minutes).',
    kind: 'write',
    inputSchema: AddInput,
    // R17/P5: after untrusted content, a url the run has not seen (and any topic, whose words are sent to a search engine) needs approval.
    requiresApproval(input, ctx) {
      if (!ctx.tainted()) return false;
      const key = input.kind === 'url' ? urlKey(input.target) : null;
      if (key !== null && ctx.run.knownUrls.has(key)) return false;
      return { reason: redactText(`watch_add after untrusted content, ${input.kind} not seen in this run: ${input.target}`).slice(0, REASON_MAX) };
    },
    async run(input, ctx) {
      const who = requester(ctx);
      if (typeof who === 'string') return toolError(who);
      const plan = await planWatch(input, net);
      if ('error' in plan) return toolError(plan.error);
      try {
        const w = await repo.add({ guildId: deps.env.guildId, channelId: who.channelId, userId: who.userId, ...plan },
          { perUser: deps.cfg.get('limits.watchesPerUser'), total: deps.cfg.get('limits.watchesTotal') });
        return w ? { content: `Watch #${w.id} saved; the first check is the baseline and posts nothing.` } : toolError('watch was not saved');
      } catch (err) {
        if (err instanceof CapError) return toolError(capMessage(err));
        throw err;
      }
    },
  };
  const list: ToolPlugin<Record<string, never>> = {
    name: 'watch_list',
    description: "List the requesting person's watches.",
    kind: 'read',
    inputSchema: z.object({}),
    requiresApproval: () => false,
    async run(_i, ctx) {
      const who = requester(ctx);
      if (typeof who === 'string') return toolError(who);
      const rows = await repo.list(who.userId);
      return { content: rows.length ? rows.map(describeWatch).join('\n') : 'No watches.' };
    },
  };
  const remove: ToolPlugin<z.infer<typeof RemoveInput>> = {
    name: 'watch_remove',
    description: "Stop one of the requesting person's watches by id.",
    kind: 'write',
    inputSchema: RemoveInput,
    requiresApproval: () => false,
    async run(input, ctx) {
      const who = requester(ctx);
      if (typeof who === 'string') return toolError(who);
      return (await repo.remove(input.id, who.userId)) ? { content: `Watch #${input.id} removed.` } : toolError(`no watch #${input.id} of yours`);
    },
  };
  return { id: 'watch', tools: [add, list, remove] as ToolPlugin<any>[] };
};

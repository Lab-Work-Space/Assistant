import { z } from 'zod';
import type { MusicPlayer, MusicReply } from '../../../voice/music/index.js';
import { toolError, type ToolContext, type ToolPlugin, type ToolResult } from '../../types.js';
import type { GroupFactory } from '../index.js';
import type { PluginDeps } from '../deps.js';

/** Only a person can ask for music (their voice channel decides where Praw plays); schedules, watches and delegated work cannot. */
const HUMAN = new Set(['chat', 'slash', 'voice']);
const PlayInput = z.object({ query: z.string().trim().min(1).max(300).describe('A song name to search on YouTube, or a YouTube link') });
const VolumeInput = z.object({ percent: z.number().int().min(0).max(150).describe('Music volume in percent, 0 to 150') });
const NoInput = z.object({});

const out = (r: MusicReply): ToolResult => (r.ok ? { content: r.text } : toolError(r.text));

const refusal = (ctx: ToolContext): string | null =>
  !HUMAN.has(ctx.origin) ? 'music can only be controlled from a conversation with a person' : !ctx.source.userId ? 'no requesting user for this run' : null;

/** Checked before the approval decision too (precheck), so a delegated or scheduled run never gets a card it could not use. */
const precheck = async (_i: unknown, ctx: ToolContext) => {
  const r = refusal(ctx);
  return r ? { refuse: r } : null;
};

function requester(ctx: ToolContext): string | ToolResult {
  const r = refusal(ctx);
  return r ? toolError(r) : ctx.source.userId!;
}

/**
 * Task 36 (M5, AC12): music in Praw's voice channel. The write tools (`kind: 'write'`) go through the central approvalFor: a person
 * talking straight to Praw with nothing untrusted read plays at once; voice, delegated or tainted runs ask first. Off when the media
 * check disabled music (P22) or there is no player.
 */
export const musicGroup: GroupFactory = (deps: PluginDeps) => {
  const off = deps.mediaDisabled?.find((d) => d.id === 'music');
  if (off) return { id: 'music', disabled: off.why };
  const m: Pick<MusicPlayer, 'play' | 'precheckPlay' | 'skip' | 'stop' | 'list' | 'setVolume'> | undefined = deps.music;
  if (!m) return { id: 'music', disabled: 'music player not available' };
  const play: ToolPlugin<z.infer<typeof PlayInput>> = {
    name: 'music_play',
    description: "Play a song in the voice channel the requesting person is in (Praw joins it). A song name is searched on YouTube; links must be YouTube links. Queues it if something is already playing.",
    kind: 'write',
    inputSchema: PlayInput,
    summary: (i) => ({ target: 'music', change: `play ${JSON.stringify(i.query.slice(0, 120))}` }),
    // every refusal that needs no side effect (origin, requester, query/allowlist, voice channel) comes before any approval card
    async precheck(i, ctx) {
      const r = refusal(ctx) ?? (await m.precheckPlay(ctx.source.userId!, i.query));
      return r ? { refuse: r } : null;
    },
    requiresApproval: () => false,
    async run(i, ctx) {
      const who = requester(ctx);
      return typeof who === 'string' ? out(await m.play(who, i.query)) : who;
    },
  };
  const queue: ToolPlugin<Record<string, never>> = {
    name: 'music_queue',
    description: 'Show what is playing, the music queue and the volume.',
    kind: 'read',
    // the labels are other members' search text (also restored from music_state): untrusted for the model
    untrustedOutput: true,
    untrustedSource: 'music',
    inputSchema: NoInput,
    requiresApproval: () => false,
    async run() {
      return out(m.list());
    },
  };
  const control = (name: string, description: string, change: string, fn: () => Promise<MusicReply>): ToolPlugin<Record<string, never>> => ({
    name, description, kind: 'write', inputSchema: NoInput, summary: () => ({ target: 'music', change }), precheck, requiresApproval: () => false,
    async run(_i, ctx) {
      const who = requester(ctx);
      return typeof who === 'string' ? out(await fn()) : who;
    },
  });
  const volume: ToolPlugin<z.infer<typeof VolumeInput>> = {
    name: 'music_volume',
    description: 'Set the music volume (0 to 150 percent).',
    kind: 'write',
    inputSchema: VolumeInput,
    summary: (i) => ({ target: 'music', change: `volume ${i.percent}%` }),
    precheck,
    requiresApproval: () => false,
    async run(i, ctx) {
      const who = requester(ctx);
      return typeof who === 'string' ? out(await m.setVolume(i.percent)) : who;
    },
  };
  return {
    id: 'music',
    tools: [play, queue, control('music_skip', 'Skip the song that is playing.', 'skip', () => m.skip()), control('music_stop', 'Stop the music and clear the queue.', 'stop and clear the queue', () => m.stop()), volume] as ToolPlugin<any>[],
  };
};

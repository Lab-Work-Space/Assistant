import type { Client } from 'discord.js';
import type { DiscordGatewayAdapterCreator } from '@discordjs/voice';
import { isDenied } from '../company/denylist.js';
import { voiceChannelPermissionError } from '../discord/perm/permissions.js';
import { binaryGroupsDisabled } from './binaries.js';
import { VoiceManager } from './manager.js';
import { DiscordVoiceSession } from './session.js';
import { probeVoiceLibrary } from './library.js';
import type { VoiceManagerDeps } from './manager.js';
import { MusicPlayer, MusicQueue, TRACK_CAP_BYTES, TRACK_CAP_SECONDS, type MusicStore } from './music/index.js';
import type { MediaBackend } from '../media/backend.js';
import { EdgeTts, GeminiStt, VoiceChat, VoiceMinuteCap, type Stt, type Tts } from './chat/index.js';
import type { MeteredModel } from '../agents/call/metered.js';
import type { Scheduler } from '../agents/scheduler/scheduler.js';
import type { ConfigStore } from '../config/store.js';
import type { AuditFn } from '../governance/index.js';

export { binaryGroupsDisabled, bootBinaries, checkBinaries, hashPath, PINNED_BINARIES, pinnedFor, type BinaryCheck, type CheckBinariesOptions, type Exec } from './binaries.js';
export { VoiceJoinError, VoiceManager, type VoiceManagerDeps } from './manager.js';
export { loadVoiceLibrary, probeVoiceLibrary, type VoiceLib } from './library.js';
export { buildResource } from './audio.js';
export { MusicPlayer, type MusicReply } from './music/index.js';
export { VoiceChat, type Stt, type Tts } from './chat/index.js';
export { DaveRequiredError, daveLive, daveNegotiated, DiscordVoiceSession, effectiveVolume, type AudioSource, type VoiceSession } from './session.js';

type Log = { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };

/** Spec 4.4: the boot health check is retried this many times, this far apart, before music and voice are turned off. */
export const MEDIA_BOOT_ATTEMPTS = 10;
export const MEDIA_BOOT_DELAY_MS = 1500;
export const MEDIA_UNREACHABLE = 'media sidecar unreachable';

/**
 * The backend's health check plus the voice library probe: a backend whose binaries fail (R13) or a library that fails to load
 * (DAVE/opus native) turns off music and voice. A health() that rejects (the sidecar is not up yet) is retried `attempts` times,
 * `delayMs` apart (R8: `sleep` is injected); after the last one music and voice are disabled with why "media sidecar unreachable".
 * A definite answer (even a failed check) is not retried. Never throws: the boot continues, and the disabled groups reach the one
 * startup tool-groups alert.
 */
export async function bootMedia(
  backend: MediaBackend,
  probe: () => Promise<string | null> = probeVoiceLibrary,
  o: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ disabled: { id: string; why: string }[] }> {
  const attempts = Math.max(1, o.attempts ?? MEDIA_BOOT_ATTEMPTS);
  const delayMs = o.delayMs ?? MEDIA_BOOT_DELAY_MS;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let h: Awaited<ReturnType<MediaBackend['health']>> | null = null;
  for (let i = 0; i < attempts && !h; i++) {
    if (i > 0) await sleep(delayMs);
    h = await Promise.resolve().then(() => backend.health()).catch(() => null); // a sync throw counts as a failed attempt too
  }
  const bins = h
    ? binaryGroupsDisabled(h.check).map((d) => ({ ...d, ...(h.why ? { why: h.why } : {}) }))
    : [{ id: 'music', why: MEDIA_UNREACHABLE }, { id: 'voice', why: MEDIA_UNREACHABLE }];
  const lib = await probe();
  const out = new Map(bins.map((d) => [d.id, d.why]));
  if (lib) for (const id of ['music', 'voice']) out.set(id, out.has(id) ? `${out.get(id)}; ${lib}` : lib);
  return { disabled: [...out].map(([id, why]) => ({ id, why })) };
}

/** Praw's VoiceManager over her own discord.js client (the only one with GuildVoiceStates, P17). */
export function prawVoiceManager(d: { client: () => Client | undefined; guildId: string; log: Log; silenceMs?: () => number; isHalted?: () => boolean; unavailable?: () => string | null }
  & Partial<Pick<VoiceManagerDeps, 'createSession' | 'checkChannel'>>): VoiceManager {
  return new VoiceManager({
    log: d.log,
    ...(d.isHalted ? { isHalted: d.isHalted } : {}),
    ...(d.unavailable ? { unavailable: d.unavailable } : {}),
    createSession: d.createSession ?? (() => new DiscordVoiceSession({
      log: d.log,
      ...(d.silenceMs ? { silenceMs: d.silenceMs() } : {}),
      adapterCreator: (guildId) => (d.client()?.guilds.cache.get(guildId)?.voiceAdapterCreator as DiscordGatewayAdapterCreator | undefined) ?? null,
    })),
    checkChannel: d.checkChannel ?? (async (channelId) => {
      const client = d.client();
      if (!client) return 'Praw is not connected to Discord';
      const ch = await client.channels.fetch(channelId).catch(() => null);
      if (!ch || !('guildId' in ch) || ch.guildId !== d.guildId || !ch.isVoiceBased()) return `<#${channelId}> is not a voice channel in this server`;
      if (isDenied(ch.id, ch.parentId ?? null)) return 'That channel is off-limits for Praw';
      const me = ch.guild.members.me;
      if (!me) return 'Praw cannot verify her permissions in this server';
      return voiceChannelPermissionError(ch, me);
    }),
  });
}

/** The voice channel a member is in now, from Praw's own client (GuildVoiceStates, P17); null when not in one or unknown. */
export const prawVoiceChannelOf = (client: () => Client | undefined, guildId: string) => async (userId: string): Promise<string | null> =>
  client()?.guilds.cache.get(guildId)?.voiceStates.cache.get(userId)?.channelId ?? null;

/** Praw's music player over the pinned binaries (P22): yt-dlp's JS runtime is this process's own node (P7 Step 0). */
export function prawMusicPlayer(d: {
  voice: VoiceManager; guildId: string; log: Log; store: MusicStore; allowlist: () => readonly string[]; voiceChannelOf: (userId: string) => Promise<string | null>;
  media: MediaBackend;
}): MusicPlayer {
  const queue = new MusicQueue(d.store, d.log);
  return new MusicPlayer({ guildId: d.guildId, voice: d.voice, queue, log: d.log, allowlist: d.allowlist, voiceChannelOf: d.voiceChannelOf, start: (q) => d.media.startTrack(q, { allowlist: d.allowlist(), capBytes: TRACK_CAP_BYTES, capSeconds: TRACK_CAP_SECONDS }) });
}

/**
 * Praw's voice chat (Task 37): STT on the metered Gemini (voice.stt), Edge TTS decoded by the pinned ffmpeg, the per-user daily
 * minutes cap, and the members' names, bot flags and voice channels from Praw's own client (GuildVoiceStates, P17).
 */
export function prawVoiceChat(d: {
  voice: VoiceManager; guildId: string; client: () => Client | undefined; voiceChannelOf: (userId: string) => Promise<string | null>;
  metered: MeteredModel; cfg: Pick<ConfigStore, 'get'>; ask: Scheduler['ask']; log: Log; audit: AuditFn; clock: () => number;
  post: (channelId: string, text: string) => Promise<void>; secrets: readonly string[]; musicPlaying?: () => boolean; media: MediaBackend; stt?: Stt; tts?: Tts;
}): VoiceChat {
  const member = (id: string) => {
    try {
      const g = d.client()?.guilds.cache.get(d.guildId);
      return g?.members?.cache.get(id) ?? g?.voiceStates?.cache.get(id)?.member ?? null;
    } catch {
      return null; // a cache problem never breaks the receive path
    }
  };
  return new VoiceChat({
    guildId: d.guildId, voice: d.voice, voiceChannelOf: d.voiceChannelOf, cfg: d.cfg, log: d.log, audit: d.audit, ask: d.ask, post: d.post, secrets: d.secrets, clock: d.clock, ...(d.musicPlaying ? { musicPlaying: d.musicPlaying } : {}),
    stt: d.stt ?? new GeminiStt({ metered: d.metered }),
    tts: d.tts ?? new EdgeTts({ decode: (b) => d.media.decode(b) }),
    minutes: new VoiceMinuteCap(d.cfg, d.clock),
    // an unknown member is treated as a person: the opt-in set (invoker + button presses, never bots) still gates them
    isBot: (id) => member(id)?.user.bot ?? false,
    nameOf: (id) => member(id)?.displayName ?? id,
  });
}


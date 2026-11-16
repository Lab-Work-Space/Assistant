import type { AgentOutcome } from '../../agents/loop/loop.js';
import type { IncomingMessage } from '../../company/types.js';
import { isDenied } from '../../company/denylist.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeVoiceSession } from '../../tests/fakes/voice.js';
import { VoiceManager } from '../manager.js';
import { VoiceMinuteCap } from './caps.js';
import { VoiceChat } from './index.js';

/** 48 kHz mono s16le: a 440 Hz tone (speech stand-in) and digital silence, in whole milliseconds. */
export const RATE = 48_000;
export function tone(ms: number, amp = 8000): Buffer {
  const n = (RATE * ms) / 1000;
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 440 * i) / RATE)), i * 2);
  return b;
}
export const silence = (ms: number): Buffer => Buffer.alloc(((RATE * ms) / 1000) * 2);
/** Splits a buffer into 20 ms chunks, like the opus decoder's output. */
export const chunks = (...parts: Buffer[]): Uint8Array[] => {
  const all = Buffer.concat(parts);
  const out: Uint8Array[] = [];
  for (let i = 0; i < all.length; i += 1920) out.push(all.subarray(i, i + 1920));
  return out;
};
export async function* iter(cs: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const c of cs) yield c;
}

export const outcome = (body: string, over: Partial<AgentOutcome> = {}): AgentOutcome => ({ payload: { type: 'chat', body }, costUsd: 0.001, turns: 1, ...over });

/** Records ask() calls; answers with `reply` (or null = refused). */
export function fakeAsk(reply: string | null = 'สวัสดีค่ะ') {
  const calls: { msg: IncomingMessage; o: Parameters<AskFn>[1] }[] = [];
  const ask: AskFn = async (msg, o) => {
    calls.push({ msg, o });
    return reply === null ? null : outcome(reply);
  };
  return { ask, calls };
}
export type AskFn = (msg: IncomingMessage, o?: { deliver?: boolean; origin?: 'slash' | 'voice' | 'chat'; preCharged?: boolean }) => Promise<AgentOutcome | null>;

export const flush = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};


export const GUILD_ID = 'g1';
export const VC = '1565999999999999555';
export const VC2 = '1565999999999999556';
export const TEXT = '1565999999999999001';
export const DENIED_VC = '1565715069969502310';

/** VoiceChat over a real VoiceManager and fake sessions; `where` is each member's voice channel; `now` drives the timers. */
export function chatRig(o: { session?: () => FakeVoiceSession; cfg?: FakeConfig; tts?: { synthesize(t: string, v: string): Promise<Buffer> }; reply?: string | null } = {}) {
  const sessions: FakeVoiceSession[] = [];
  const cfg = o.cfg ?? new FakeConfig();
  const log = { info() {}, warn() {}, error() {} };
  const voice = new VoiceManager({
    log, haltTimeoutMs: 500,
    createSession: () => { const s = o.session?.() ?? new FakeVoiceSession(); sessions.push(s); return s; },
    checkChannel: async (id) => (isDenied(id, null) ? 'That channel is off-limits for Praw' : null),
  });
  const where = new Map<string, string | null>([['u1', VC]]);
  const clock = { now: Date.parse('2026-11-01T10:00:00Z') };
  const a = fakeAsk(o.reply === undefined ? 'สวัสดีค่ะ' : o.reply);
  const transcribed: string[] = [];
  const posts: { channelId: string; text: string }[] = [];
  const audits: Record<string, unknown>[] = [];
  const chat = new VoiceChat({
    guildId: GUILD_ID, voice, voiceChannelOf: async (u) => where.get(u) ?? null, cfg, log,
    stt: { transcribe: async () => (transcribed.push('x'), 'สวัสดีพราว') },
    tts: o.tts ?? { synthesize: async (t) => Buffer.from(`pcm:${t}`) },
    secrets: [], ask: a.ask, audit: async (e) => void audits.push(e as never), post: async (channelId, text) => void posts.push({ channelId, text }),
    isBot: (u) => u.startsWith('bot'), nameOf: (u) => u, minutes: new VoiceMinuteCap(cfg, () => clock.now), clock: () => clock.now, tickMs: 5, musicPlaying: () => (music.checks++, music.playing),
  });
  /** `checks` counts musicPlaying() calls: each is one idle tick, which decides (and audits a leave) synchronously right after. */
  const music = { playing: false, checks: 0 };
  const join = (userId = 'u1') => chat.join({ userId, channelId: TEXT, parentChannelId: null });
  return { chat, voice, sessions, where, clock, cfg, music, join, transcribed, posts, audits, ...a, session: () => sessions[sessions.length - 1] };
}
export const until = async (f: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

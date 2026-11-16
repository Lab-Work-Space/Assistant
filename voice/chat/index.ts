import { randomUUID } from 'node:crypto';
import type { Scheduler } from '../../agents/scheduler/scheduler.js';
import { isDenied } from '../../company/denylist.js';
import type { ConfigStore } from '../../config/store.js';
import type { AuditFn } from '../../governance/index.js';
import { VoiceJoinError, type VoiceManager } from '../manager.js';
import type { VoiceMinuteCap } from './caps.js';
import { VoicePipeline } from './pipeline.js';
import type { Stt } from './stt.js';
import type { Tts } from './tts.js';

export { VoiceMinuteCap } from './caps.js';
export { VoicePipeline, type VoicePipelineDeps } from './pipeline.js';
export { GeminiStt, toWav16k, usableTranscript, type Stt } from './stt.js';
export { decodeToPcm, EdgeTts, edgeSynth, speakableText, ssmlEscape, TTS_VOICE_RE, type Tts } from './tts.js';
export { utterances } from './vad.js';

type Log = { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };

/** The join notice (P20), posted publicly in the invoking text channel with the opt-in button. */
export const JOIN_NOTICE = [
  'พราวเข้าห้องเสียงแล้ว เสียงของคนที่พูดจะถูกส่งไป Google เพื่อถอดเสียง',
  'พราวฟังเฉพาะคนที่สั่ง /voice join และคนที่กดปุ่มด้านล่าง ส่วนคำตอบของพราวจะถูกส่งไป Microsoft (Edge TTS) เพื่อแปลงเป็นเสียง',
  'Voice chat: the speaker\'s audio goes to Google for transcription and Praw\'s reply text to Microsoft for speech. Only the invoker and people who press the button are heard.',
].join('\n');
export const OPT_IN_PREFIX = 'voice:optin:';

export interface VoiceChatDeps {
  guildId: string;
  voice: Pick<VoiceManager, 'join' | 'leave' | 'current' | 'onLeave'>;
  /** The member's current voice channel (Praw's own client, GuildVoiceStates), or null. */
  voiceChannelOf(userId: string): Promise<string | null>;
  stt: Stt;
  tts: Tts;
  ask: Scheduler['ask'];
  cfg: Pick<ConfigStore, 'get'>;
  log: Log;
  audit: AuditFn;
  /** P24: the literal secrets masked from every spoken reply and its text fallback. */
  secrets: readonly string[];
  /** Posts text as Praw in a text channel (the TTS failure fallback). */
  post(channelId: string, text: string): Promise<void>;
  isBot(userId: string): boolean;
  nameOf(userId: string): string;
  minutes: VoiceMinuteCap;
  clock(): number;
  /** True while the music player has a track going: the idle auto-leave timer is paused then (maxSessionMin still applies). */
  musicPlaying?(): boolean;
  /** Auto-leave check interval (default 5 s). */
  tickMs?: number;
}

type Active = { nonce: string; channelId: string; invoker: string; startedAt: number; lastActive: number; optedIn: Set<string>; pipeline: VoicePipeline; timer: NodeJS.Timeout };
export type JoinResult = { ok: true; nonce: string; channelId: string } | { ok: false; text: string };

/**
 * `/voice join` / `/voice leave` and the opt-in button (P20). Praw joins only the invoker's own voice channel, never a denied one,
 * one channel at a time (the VoiceManager). Every way out of the channel (/voice leave, /halt, a kick, a DAVE drop, the auto-leave
 * checks: invoker gone, `voice.idleMin`, `voice.maxSessionMin`) goes through VoiceManager.leave, whose onLeave stops the pipeline.
 */
export class VoiceChat {
  private cur: Active | null = null;

  constructor(private readonly d: VoiceChatDeps) {
    d.voice.onLeave(() => this.stop());
  }

  active(): boolean {
    return this.cur !== null;
  }

  async join(i: { userId: string; channelId: string; parentChannelId: string | null }): Promise<JoinResult> {
    const vc = await this.d.voiceChannelOf(i.userId);
    if (!vc) return { ok: false, text: 'Join a voice channel first, then use /voice join.' };
    if (isDenied(vc, null)) return { ok: false, text: 'That voice channel is off-limits for Praw.' };
    if (this.cur) return { ok: false, text: this.cur.channelId === vc ? 'Praw is already listening in your voice channel.' : `Praw is already in a voice channel (<#${this.cur.channelId}>); use /voice leave first.` };
    let session;
    try {
      session = await this.d.voice.join(vc, this.d.guildId);
    } catch (err) {
      if (err instanceof VoiceJoinError) return { ok: false, text: err.message };
      throw err;
    }
    if (this.cur) return { ok: false, text: 'Praw is already listening in a voice channel.' };
    const now = this.d.clock();
    const optedIn = new Set([i.userId]);
    const pipeline = new VoicePipeline({
      session, stt: this.d.stt, tts: this.d.tts, secrets: this.d.secrets, ask: this.d.ask, cfg: this.d.cfg, log: this.d.log, audit: this.d.audit, minutes: this.d.minutes,
      channel: { channelId: i.channelId, parentChannelId: i.parentChannelId }, nameOf: (u) => this.d.nameOf(u), isBot: (u) => this.d.isBot(u),
      allowed: (u) => optedIn.has(u), announce: (text) => this.d.post(i.channelId, text),
      onActivity: () => {
        if (this.cur) this.cur.lastActive = this.d.clock();
      },
    });
    const timer = setInterval(() => void this.tick().catch(() => undefined), this.d.tickMs ?? 5000);
    timer.unref?.();
    this.cur = { nonce: randomUUID(), channelId: vc, invoker: i.userId, startedAt: now, lastActive: now, optedIn, pipeline, timer };
    pipeline.start();
    return { ok: true, nonce: this.cur.nonce, channelId: vc };
  }

  /** From anywhere, by anyone: Praw leaves voice (music too, like /halt does). */
  async leave(): Promise<{ ok: boolean; text: string }> {
    if (!this.d.voice.current()) return { ok: false, text: 'Praw is not in a voice channel.' };
    await this.d.voice.leave();
    return { ok: true, text: 'Praw left the voice channel.' };
  }

  /** The join notice's button: the session nonce scopes it, so an old notice's button opts nobody into a later session. */
  async optIn(nonce: string, userId: string): Promise<string> {
    const c = this.cur;
    if (!c || c.nonce !== nonce) return 'This voice session has ended; ask for /voice join again.';
    if (this.d.isBot(userId)) return 'Bots are never transcribed.';
    // The presser must be in the session's voice channel right now: someone elsewhere is not in the conversation Praw listens to.
    if ((await this.d.voiceChannelOf(userId)) !== c.channelId) return 'Join the voice channel Praw is in first, then press the button.';
    if (this.cur !== c) return 'This voice session has ended; ask for /voice join again.';
    c.optedIn.add(userId);
    return 'You opted in: Praw now listens to you in this voice session (your audio goes to Google for transcription). พราวจะฟังเสียงของคุณแล้วค่ะ';
  }

  private async tick(): Promise<void> {
    const c = this.cur;
    if (!c) return;
    const now = this.d.clock();
    let why: string | null = null;
    // Idle pauses while music plays; the idle clock restarts from the moment the music stops.
    if (this.d.musicPlaying?.()) c.lastActive = now;
    if (now - c.startedAt >= this.d.cfg.get('voice.maxSessionMin') * 60_000) why = 'max-length';
    else if (now - c.lastActive >= this.d.cfg.get('voice.idleMin') * 60_000) why = 'idle';
    else if ((await this.d.voiceChannelOf(c.invoker)) !== c.channelId) why = 'invoker-left';
    if (!why || this.cur !== c) return;
    this.d.log.info({ reason: why }, 'voice chat auto-leave');
    await this.d.audit({ actor: 'head:praw', action: 'voice.leave', outcome: why }).catch(() => undefined);
    await this.d.voice.leave();
  }

  private stop(): void {
    const c = this.cur;
    this.cur = null;
    if (!c) return;
    clearInterval(c.timer);
    c.pipeline.stop();
  }
}

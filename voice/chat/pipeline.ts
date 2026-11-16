import { randomUUID } from 'node:crypto';
import { MeteredError } from '../../agents/call/metered.js';
import type { Scheduler } from '../../agents/scheduler/scheduler.js';
import type { IncomingMessage } from '../../company/types.js';
import { redactText } from '../../core/logger.js';
import type { ConfigStore } from '../../config/store.js';
import type { AuditFn } from '../../governance/index.js';
import type { VoiceSession } from '../session.js';
import type { VoiceMinuteCap } from './caps.js';
import type { Stt } from './stt.js';
import type { Tts } from './tts.js';
import { utterances } from './vad.js';

type Log = { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };

export interface VoicePipelineDeps {
  session: VoiceSession;
  stt: Stt;
  tts: Tts;
  /** Task 10: ask(msg, {deliver:false, origin:'voice'}) → the outcome; it takes the per-user Praw slot itself (no preCharged). */
  ask: Scheduler['ask'];
  cfg: Pick<ConfigStore, 'get'>;
  /** Posts text in the invoking text channel (the fallback when TTS fails). */
  announce(text: string): Promise<void>;
  log: Log;
  audit: AuditFn;
  /** The invoking text channel: the utterance messages are routed and answered as if posted there. */
  channel: { channelId: string; parentChannelId: string | null };
  nameOf(userId: string): string;
  /** P20: the invoker and the users who opted in by button. Anyone else's stream is never iterated (never decoded). */
  allowed(userId: string): boolean;
  isBot(userId: string): boolean;
  minutes: VoiceMinuteCap;
  /** P24: the literal secrets; every spoken or announced text is masked with them (and the generic patterns) first. */
  secrets: readonly string[];
  /** Called on every accepted utterance and every reply (the idle timer). */
  onActivity?(): void;
  /** Slack past the clip's own length before a reply that never finished playing is given up (default 5 s). */
  overlayGraceMs?: number;
}

/** Received PCM from the session: s16le 48 kHz mono. */
const RATE = 48_000;
const BYTES_PER_SEC = RATE * 2;
/** What the session plays: s16le 48 kHz stereo. */
const OUT_BYTES_PER_MS = (48_000 * 2 * 2) / 1000;
/** Replies waiting to be spoken; more utterances meanwhile are dropped (one reply at a time, never a backlog). */
const MAX_PENDING = 2;

const SAY = {
  minutes: (n: number) => `ขอโทษนะคะ วันนี้ใช้เวลาคุยด้วยเสียงครบ ${n} นาทีแล้ว พราวจะไม่ฟังเสียงของคุณต่อจนถึงพรุ่งนี้ค่ะ`,
  budget: 'ขอโทษนะคะ งบประมาณของวันนี้หมดแล้ว พราวถอดเสียงต่อไม่ได้ค่ะ',
  busy: 'ขอโทษนะคะ ตอนนี้พราวรับคำขอไม่ได้ ลองใหม่อีกสักครู่นะคะ',
  failed: 'ขอโทษนะคะ พราวตอบไม่ได้ในตอนนี้ค่ะ',
} as const;

/**
 * Voice chat over one session (Task 37, AC13): per-user VAD (voice.silenceMs) → STT (metered Gemini) → Praw's run through
 * Scheduler.ask with origin `voice` (never direct: writes need approval, P2) → TTS → mixed over the music while it is ducked (AC12b).
 * The transcript is the message content; the agent context wraps it once as untrusted (kind human, source voice). Audio,
 * transcripts and TTS output live in memory only and are dropped after use (P20); audit rows carry outcomes, never text.
 */
export class VoicePipeline {
  private off: (() => void) | null = null;
  private stopped = true;
  private chain: Promise<void> = Promise.resolve();
  private pending = 0;
  /** Users told they are over the daily minutes; ignored (undecoded) for the rest of the session. */
  private readonly capped = new Set<string>();

  constructor(private readonly d: VoicePipelineDeps) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.off = this.d.session.onSpeech((userId, pcm) => this.onSpeech(userId, pcm));
  }

  stop(): void {
    this.stopped = true;
    this.off?.();
    this.off = null;
  }

  private onSpeech(userId: string, pcm: AsyncIterable<Uint8Array>): void {
    // Decide before touching the iterable: returning without iterating discards the stream undecoded (P20).
    if (this.stopped || !this.d.allowed(userId) || this.d.isBot(userId) || this.capped.has(userId)) return;
    if (this.d.minutes.exhausted(userId)) return this.overCap(userId);
    void this.consume(userId, pcm).catch((err: unknown) => this.d.log.warn({ err: errName(err) }, 'voice utterance failed'));
  }

  private async consume(userId: string, pcm: AsyncIterable<Uint8Array>): Promise<void> {
    for await (const utt of utterances(pcm, { sampleRate: RATE, silenceMs: this.d.cfg.get('voice.silenceMs') })) {
      if (this.stopped) return;
      if (this.pending >= MAX_PENDING) {
        await this.audit(userId, 'dropped-busy'); // never sent to STT, so not counted against the daily minutes
        continue;
      }
      if (!this.d.minutes.take(userId, utt.length / BYTES_PER_SEC)) return this.overCap(userId);
      this.d.onActivity?.();
      this.enqueue(() => this.handle(userId, utt));
    }
  }

  private overCap(userId: string): void {
    if (this.capped.has(userId)) return;
    this.capped.add(userId);
    void this.audit(userId, 'refused-minutes');
    this.enqueue(() => this.speak(SAY.minutes(this.d.cfg.get('limits.voiceMinPerUserDay'))));
  }

  private enqueue(job: () => Promise<void>): void {
    this.pending++;
    this.chain = this.chain
      .then(async () => {
        if (!this.stopped) await job();
      })
      .catch((err: unknown) => this.d.log.warn({ err: errName(err) }, 'voice reply failed'))
      .finally(() => {
        this.pending--;
      });
  }

  private async handle(userId: string, utt: Buffer): Promise<void> {
    let transcript: string;
    try {
      transcript = await this.d.stt.transcribe(utt, { sampleRate: RATE, lang: 'th' });
    } catch (err) {
      if (this.stopped) return;
      const budget = err instanceof MeteredError && err.reason === 'budget';
      await this.audit(userId, budget ? 'refused-budget' : 'stt-failed');
      if (budget) await this.speak(SAY.budget);
      else this.d.log.warn({ err: errName(err) }, 'voice STT failed');
      return;
    }
    if (this.stopped) return;
    if (!transcript) return void (await this.audit(userId, 'empty'));
    const out = await this.d.ask(this.message(userId, transcript), { deliver: false, origin: 'voice' });
    transcript = ''; // dropped: nothing keeps the text once the run has it
    if (this.stopped) return;
    if (!out || out.stopped === 'halted') {
      await this.audit(userId, 'refused');
      if (!out) await this.speak(SAY.busy);
      return;
    }
    await this.audit(userId, out.stopped ?? 'ok');
    await this.speak(out.payload.body || SAY.failed);
  }

  /** A human message from this speaker in the invoking text channel; origin is set by Scheduler.ask (P1), never by content. */
  private message(userId: string, transcript: string): IncomingMessage {
    const { channelId, parentChannelId } = this.d.channel;
    return {
      id: `voice:${randomUUID()}`, channelId, parentChannelId, threadId: null,
      author: { id: userId, name: this.d.nameOf(userId), kind: 'human' },
      content: transcript, mentionedHeads: ['praw'], isAdmin: false, attachments: [], origin: 'voice',
    };
  }

  /** TTS → mixed over the music while it is ducked; on a TTS failure the text is posted in the channel instead. */
  private async speak(raw: string): Promise<void> {
    if (this.stopped) return;
    const text = redactText(raw, this.d.secrets); // P24: masked before TTS (Microsoft) and before the text fallback
    let pcm: Buffer;
    try {
      pcm = await this.d.tts.synthesize(text, this.d.cfg.get('voice.ttsVoice'));
    } catch (err) {
      this.d.log.warn({ err: errName(err) }, 'voice TTS failed; posting the reply as text');
      if (!this.stopped) await this.d.announce(text).catch(() => undefined);
      return;
    }
    if (this.stopped) return;
    this.d.onActivity?.();
    this.d.session.duck(true);
    // The mixer pulls a clip through only while the music flows: a stalled track must not keep the music ducked and the queue stuck.
    let timer: NodeJS.Timeout | undefined;
    const drop = new AbortController(); // on timeout the clip leaves the mixer queue instead of playing late over the music
    const bound = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), pcm.length / OUT_BYTES_PER_MS + (this.d.overlayGraceMs ?? 5000))));
    try {
      if ((await Promise.race([this.d.session.overlay(pcm, drop.signal), bound])) === 'timeout') {
        drop.abort();
        this.d.log.warn({}, 'voice reply did not finish playing; given up');
      }
    } catch (err) {
      this.d.log.warn({ err: errName(err) }, 'voice reply could not be played');
    } finally {
      clearTimeout(timer);
      this.d.session.duck(false);
      this.d.onActivity?.();
    }
  }

  private audit(userId: string, outcome: string): Promise<void> {
    return this.d.audit({ actor: `user:${userId}`, action: 'voice.utterance', outcome }).catch(() => undefined);
  }
}

const errName = (err: unknown) => (err instanceof Error ? err.name : 'error');

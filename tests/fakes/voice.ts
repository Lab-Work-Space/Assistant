import type { AudioSource, VoiceSession } from '../../voice/session.js';

/**
 * Fake voice session (no gateway, no UDP, no opus): records every call. `speak(userId, chunks)` delivers an utterance to the
 * `onSpeech` listeners as a lazy iterable; `decoded` lists the users whose audio a listener actually read (P20: a stream nobody
 * iterates is never decoded). `close(reason)` simulates the library dropping the connection (kick, DAVE downgrade).
 */
export class FakeVoiceSession implements VoiceSession {
  channelId: string | null = null;
  readonly calls: string[] = [];
  readonly played: { src: AudioSource; volume: number }[] = [];
  readonly decoded: string[] = [];
  volume = 1;
  ducked = false;
  /** Resolves a `leave()` that `hangLeave` held back (tests of the halt timeout). */
  releaseLeave: () => void = () => {};
  /** Resolves a `join()` that `hangJoin` held back (a join still connecting). */
  releaseJoin: () => void = () => {};
  private readonly speech = new Set<(userId: string, pcm: AsyncIterable<Uint8Array>) => void>();
  private readonly closed = new Set<(reason: string) => void>();

  /** holdPlay: bytes read from each played stream, in order (what would have been encoded and sent). */
  readonly audio: Buffer[] = [];
  /** Set to make the next play() reject (e.g. a DaveRequiredError while E2EE is not live). */
  playError: Error | null = null;
  private finishPlay: (() => void) | null = null;

  /**
   * `holdPlay`: play() reads the stream and resolves only when it ends, another play replaces it, or the session leaves
   * (like the real session); without it play() resolves at once.
   */
  constructor(private readonly o: { failJoin?: Error; hangLeave?: boolean; hangJoin?: boolean; holdPlay?: boolean } = {}) {}

  async join(channelId: string, guildId: string): Promise<void> {
    this.calls.push(`join:${guildId}/${channelId}`);
    if (this.o.failJoin) throw this.o.failJoin;
    if (this.channelId) throw new Error('already connected');
    if (this.o.hangJoin) await new Promise<void>((r) => (this.releaseJoin = r));
    this.channelId = channelId;
  }

  async leave(): Promise<void> {
    this.calls.push('leave');
    this.finishPlay?.();
    if (this.o.hangLeave) await new Promise<void>((r) => (this.releaseLeave = r));
    this.channelId = null;
  }

  async play(src: AudioSource, o: { volume: number }): Promise<void> {
    this.calls.push('play');
    this.played.push({ src, volume: o.volume });
    this.volume = o.volume;
    if (this.playError) {
      const e = this.playError;
      this.playError = null;
      throw e;
    }
    if (!this.o.holdPlay) return;
    this.finishPlay?.(); // a replaced source resolves its own play()
    await new Promise<void>((resolve) => {
      const done = () => {
        if (this.finishPlay === done) this.finishPlay = null;
        resolve();
      };
      this.finishPlay = done;
      src.stream.on('data', (b: Buffer) => this.audio.push(Buffer.from(b)));
      src.stream.once('end', done);
      src.stream.once('close', done);
      src.stream.once('error', done);
    });
  }

  /** Spoken replies (overlay) with the duck state at that moment. */
  readonly overlays: { pcm: Buffer; ducked: boolean }[] = [];
  /** Set to make the next overlay() reject. */
  overlayError: Error | null = null;
  /** overlay() never resolves (a stalled music stream never pulls the clip through the mixer). */
  overlayHang = false;

  /** The abort signal passed with each overlay (aborted when the caller gave up on the clip). */
  readonly overlaySignals: (AbortSignal | undefined)[] = [];

  async overlay(pcm: Buffer, signal?: AbortSignal): Promise<void> {
    this.calls.push('overlay');
    this.overlaySignals.push(signal);
    this.overlays.push({ pcm, ducked: this.ducked });
    if (this.overlayError) {
      const e = this.overlayError;
      this.overlayError = null;
      throw e;
    }
    if (this.overlayHang) await new Promise<never>(() => {});
  }

  /** Whether a held play() is still running. */
  get playing(): boolean {
    return this.finishPlay !== null;
  }

  setVolume(v: number): void {
    this.calls.push(`volume:${v}`);
    this.volume = v;
  }

  duck(on: boolean): void {
    this.calls.push(`duck:${on}`);
    this.ducked = on;
  }

  onSpeech(cb: (userId: string, pcm: AsyncIterable<Uint8Array>) => void): () => void {
    this.speech.add(cb);
    return () => this.speech.delete(cb);
  }

  onClose(cb: (reason: string) => void): () => void {
    this.closed.add(cb);
    return () => this.closed.delete(cb);
  }

  speak(userId: string, chunks: Uint8Array[]): void {
    const decoded = this.decoded;
    const pcm: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        decoded.push(userId);
        yield* chunks;
      },
    };
    for (const cb of this.speech) cb(userId, pcm);
  }

  close(reason: string): void {
    this.channelId = null;
    for (const cb of this.closed) cb(reason);
  }
}

type Listener = (...a: unknown[]) => void;
class Emitter {
  private readonly ls = new Map<string, Set<Listener>>();
  on(e: string, f: Listener): this { let s = this.ls.get(e); if (!s) this.ls.set(e, (s = new Set())); s.add(f); return this; }
  off(e: string, f: Listener): this { this.ls.get(e)?.delete(f); return this; }
  emit(e: string, ...a: unknown[]): boolean { for (const f of [...(this.ls.get(e) ?? [])]) f(...a); return true; }
}

export type FakeDave = { protocolVersion: number; voicePrivacyCode: string | null; session?: { ready: boolean } };

/** A @discordjs/voice VoiceConnection stand-in: tests drive `state` with `setState`. */
export class FakeConnection extends Emitter {
  state: { status: string; networking?: { state: { dave?: FakeDave } } } = { status: 'signalling' };
  readonly receiver = { speaking: new Emitter(), subscriptions: new Map<string, unknown>(), subscribe: () => { throw new Error('not used'); } };
  subscribed: unknown = null;
  /** Packets that reached the library's encrypt/prepare step (what would go on the wire). */
  readonly prepared: Buffer[] = [];
  constructor(readonly options: Record<string, unknown>) { super(); }
  prepareAudioPacket(b: Buffer): Buffer | undefined { if (this.state.status !== 'ready') return undefined; this.prepared.push(b); return b; }
  playOpusPacket(b: Buffer): void { this.prepareAudioPacket(b); }
  setState(status: string, dave?: FakeDave): void {
    const old = this.state;
    this.state = { status, ...(status === 'ready' ? { networking: { state: dave ? { dave } : {} } } : {}) };
    this.emit('stateChange', old, this.state);
  }
  subscribe(p: unknown): void { this.subscribed = p; }
  destroy(): void { if (this.state.status !== 'destroyed') this.setState('destroyed'); }
}

/** Models the AudioPlayer status rules that matter here: pause() only works from playing (dist AudioPlayer.pause). */
export class FakePlayer extends Emitter {
  readonly calls: string[] = [];
  status = 'idle';
  /** Set to make play() throw synchronously (e.g. a destroyed resource). */
  throwOnPlay: Error | null = null;
  /** Every resource handed to play(), in order. */
  readonly resources: unknown[] = [];
  play(r: unknown): void { this.calls.push('play'); if (this.throwOnPlay) throw this.throwOnPlay; this.resources.push(r); this.status = 'playing'; }
  pause(): boolean { this.calls.push('pause'); if (this.status !== 'playing') return false; this.status = 'paused'; return true; }
  unpause(): boolean { this.calls.push('unpause'); if (this.status !== 'paused') return false; this.status = 'playing'; return true; }
  stop(): boolean { this.calls.push('stop'); this.status = 'idle'; return true; }
}

const LIVE: FakeDave = { protocolVersion: 1, voicePrivacyCode: '12345 67890', session: { ready: true } };
export const liveDave = (): FakeDave => ({ ...LIVE, session: { ready: true } });

/** A fake @discordjs/voice module for DiscordVoiceSession (no gateway, no UDP); `connections`/`players` record what it built. */
export function fakeVoiceLib() {
  const connections: FakeConnection[] = [];
  const players: FakePlayer[] = [];
  const lib = {
    VoiceConnectionStatus: { Signalling: 'signalling', Connecting: 'connecting', Ready: 'ready', Disconnected: 'disconnected', Destroyed: 'destroyed' },
    AudioPlayerStatus: { Idle: 'idle', Playing: 'playing', Paused: 'paused', AutoPaused: 'autopaused', Buffering: 'buffering' },
    EndBehaviorType: { Manual: 0, AfterSilence: 1, AfterInactivity: 2 },
    NoSubscriberBehavior: { Pause: 'pause', Play: 'play', Stop: 'stop' },
    joinVoiceChannel: (o: Record<string, unknown>) => { const c = new FakeConnection(o); connections.push(c); return c; },
    entersState: (c: FakeConnection, status: string, signal: AbortSignal) => new Promise((resolve, reject) => {
      if (c.state.status === status) return resolve(c);
      const on = (_o: unknown, n: { status: string }) => { if (n.status === status) { c.off('stateChange', on as Listener); resolve(c); } };
      c.on('stateChange', on as Listener);
      signal.addEventListener('abort', () => { c.off('stateChange', on as Listener); reject(new Error('aborted')); }, { once: true });
    }),
    createAudioPlayer: () => { const p = new FakePlayer(); players.push(p); return p; },
    AudioResource: class { constructor(readonly edges: unknown[], readonly streams: unknown[]) {} },
  };
  return { lib, connections, players };
}

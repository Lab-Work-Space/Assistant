import type { AppEvents, EventBus } from '../core/index.js';
import type { VoiceSession } from './session.js';

/** A user-facing refusal (already in a channel, missing Connect/Speak, denied channel, DAVE). */
export class VoiceJoinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceJoinError';
  }
}

type Log = { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };

export interface VoiceManagerDeps {
  createSession: () => VoiceSession;
  /** Per target channel: null when Praw may join, else the message (Connect/Speak missing, denied channel). */
  checkChannel: (channelId: string) => Promise<string | null>;
  log: Log;
  /** /halt bound for leaving (P20: 2 s); a leave that takes longer is abandoned, never awaited. */
  haltTimeoutMs?: number;
  /** The Halt state itself (halt.isHalted(), D9), so a boot while halted refuses joins before any bus event. */
  isHalted?: () => boolean;
  /** Why voice is off (ffmpeg missing, voice library failed to load; R13), or null. */
  unavailable?: () => string | null;
}

/** Praw is in one voice channel at a time. Queue clearers and child killers (music, TTS) register with onLeave. */
export class VoiceManager {
  private session: VoiceSession | null = null;
  private joining: string | null = null;
  /** The session of a join still connecting, so a leave or /halt reaches it too. */
  private pending: VoiceSession | null = null;
  /** Bumped by every leave; a join that finishes under an older generation is undone. */
  private generation = 0;
  private halted = false;
  private offClose: (() => void) | null = null;
  private readonly clearers = new Set<() => void | Promise<void>>();

  constructor(private readonly d: VoiceManagerDeps) {}

  current(): { channelId: string; session: VoiceSession } | null {
    const s = this.session;
    return s?.channelId ? { channelId: s.channelId, session: s } : null;
  }

  async join(channelId: string, guildId: string): Promise<VoiceSession> {
    const cur = this.current();
    if (this.halted || this.d.isHalted?.()) throw new VoiceJoinError('Praw is halted; voice is off until /resume');
    const off = this.d.unavailable?.();
    if (off) throw new VoiceJoinError(off);
    if (cur?.channelId === channelId) return cur.session;
    if (cur || this.joining) throw new VoiceJoinError(`Praw is already in a voice channel (<#${cur?.channelId ?? this.joining}>); use /voice leave first`);
    this.joining = channelId;
    const gen = this.generation;
    const abandoned = () => new VoiceJoinError('the join was cancelled by /halt or a leave while connecting');
    try {
      const refusal = await this.d.checkChannel(channelId);
      if (refusal) throw new VoiceJoinError(refusal);
      if (gen !== this.generation) throw abandoned();
      const s = this.d.createSession();
      this.pending = s;
      try {
        await s.join(channelId, guildId);
      } catch (err) {
        await s.leave().catch(() => undefined);
        throw gen !== this.generation ? abandoned() : err instanceof VoiceJoinError ? err : new VoiceJoinError(err instanceof Error ? err.message : String(err));
      } finally {
        if (this.pending === s) this.pending = null;
      }
      if (gen !== this.generation) {
        await s.leave().catch(() => undefined);
        throw abandoned();
      }
      this.session = s;
      this.offClose = s.onClose((reason) => {
        this.d.log.warn({ reason }, 'voice connection closed');
        void this.leave();
      });
      this.d.log.info({ channelId }, 'voice joined');
      return s;
    } finally {
      this.joining = null;
    }
  }

  /** One disconnect at a time: a second leave (both halt signals, /voice leave during /halt) awaits the one in flight. */
  private inflight: Promise<void> | null = null;

  /** Disconnects and clears every registered queue; bounded by haltTimeoutMs so a stuck connection never blocks /halt. */
  leave(): Promise<void> {
    return (this.inflight ??= this.doLeave().finally(() => {
      this.inflight = null;
    }));
  }

  private async doLeave(): Promise<void> {
    this.generation++;
    const s = this.session;
    const pending = this.pending;
    this.session = null;
    this.pending = null;
    this.offClose?.();
    this.offClose = null;
    // The disconnect starts first and runs alongside the clearers, so a hung clearer never keeps Praw in the channel.
    const disconnect = [s, pending].map((x) => x?.leave().catch((err: unknown) => this.d.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'voice leave failed')));
    const clear = [...this.clearers].map(async (fn) => fn());
    const work = Promise.allSettled([...disconnect, ...clear]).then(() => 'left' as const);
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), this.d.haltTimeoutMs ?? 2000)));
    if ((await Promise.race([work, timeout])) === 'timeout') this.d.log.warn({}, 'voice leave timed out; connection abandoned');
    clearTimeout(timer);
  }

  /** Registers a queue/child stopper run on every leave (also /halt and an unexpected close); returns the unregister. */
  onLeave(fn: () => void | Promise<void>): () => void {
    this.clearers.add(fn);
    return () => this.clearers.delete(fn);
  }

  /**
   * /halt disconnects within 2 s (P20, D9), also a join still connecting, and refuses joins until the resume. `watchHalted`
   * (cfg.watch('halted')) covers a halt set out of band (another instance, a direct UPDATE), which emits no bus event.
   */
  leaveOnHalt(bus: EventBus<AppEvents>, watchHalted?: (fn: (v: unknown) => void) => () => void): () => void {
    // Halt.halt() fires both paths; only the first one leaves (joins are refused while halted, so there is nothing new to leave).
    const set = (halted: boolean): Promise<void> | undefined => {
      const was = this.halted;
      this.halted = halted;
      return halted && !was ? this.leave() : halted ? (this.inflight ?? undefined) : undefined;
    };
    const offBus = bus.on('halt.changed', async (e) => {
      await set(e.halted);
    });
    const offCfg = watchHalted?.((v) => {
      void set(v !== false);
    });
    return () => {
      offBus();
      offCfg?.();
    };
  }
}

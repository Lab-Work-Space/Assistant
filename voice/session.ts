import { Readable } from 'node:stream';
import type { AudioPlayer, DiscordGatewayAdapterCreator, VoiceConnection } from '@discordjs/voice';
import prism from 'prism-media';
import { buildResource } from './audio.js';
import { loadVoiceLibrary, type VoiceLib } from './library.js';
import type { PcmMixer } from './mixer.js';

/**
 * What can be played: already-decoded PCM only (s16le, 48 kHz, stereo). The library's own stream-type graph is never used, because
 * it spawns ffmpeg with the parent env (P8, see audio.ts). Callers transcode with their own childEnv() ffmpeg first.
 */
export type AudioSource = { kind: 'raw'; stream: Readable };

/** The voice seam: the real implementation wraps @discordjs/voice; tests use tests/fakes/voice.ts. */
export interface VoiceSession {
  join(channelId: string, guildId: string): Promise<void>;
  leave(): Promise<void>;
  /** Resolves when the source finished, was replaced by another play, or the session left. */
  play(src: AudioSource, o: { volume: number }): Promise<void>;
  setVolume(v: number): void;
  duck(on: boolean): void;
  /**
   * A short clip (a spoken reply: s16le 48 kHz stereo PCM, in memory) mixed over whatever plays: the music keeps flowing (ducked
   * by the caller) and keeps its position, so a reply never skips a track. With nothing playing it plays alone at full volume.
   * Resolves when the clip was played out, or the session left.
   */
  overlay(pcm: Buffer, signal?: AbortSignal): Promise<void>;
  /**
   * One call per utterance. `pcm` (s16le, 48 kHz, mono) is lazy: audio is subscribed to and opus-decoded only once a consumer
   * iterates it, so a stream the caller ignores (a non-opted-in user, a bot; P20) is discarded undecoded.
   */
  onSpeech(cb: (userId: string, pcm: AsyncIterable<Uint8Array>) => void): () => void;
  /** Fires once when the connection ends without leave(): kicked, network loss, DAVE downgrade. */
  onClose(cb: (reason: string) => void): () => void;
  readonly channelId: string | null;
}

/** P20: Discord's DAVE end-to-end encryption is required; Praw never stays in a channel without it. */
export class DaveRequiredError extends Error {
  constructor() {
    super('DAVE end-to-end encryption was not negotiated; Praw does not stay in a voice channel without it');
    this.name = 'DaveRequiredError';
  }
}

/** Structural view of `VoiceConnection.state` (Ready carries `networking`, whose state carries the DAVE session wrapper). */
export type ConnectionStateLike = {
  status: string;
  networking?: { state: { dave?: { protocolVersion: number; voicePrivacyCode?: string | null; session?: { ready: boolean } | undefined } | undefined } };
};
const daveOf = (state: ConnectionStateLike) => (state.status === 'ready' ? state.networking?.state.dave : undefined);

/**
 * DAVE negotiated: a Ready connection with a DAVE session at protocol version > 0. The library downgrades to v0 without an error
 * (DAVESession.executeTransition), so this is re-checked on every `transitioned` and every (re)entry to Ready.
 */
export function daveNegotiated(state: ConnectionStateLike): boolean {
  return (daveOf(state)?.protocolVersion ?? 0) > 0;
}

/**
 * E2EE live: negotiated AND the MLS group is ready (privacy code present). Until then the library sends opus frames without the
 * DAVE layer (DAVESession.encrypt returns the packet when the session is not ready), so join waits for this and play refuses without it.
 */
export function daveLive(state: ConnectionStateLike): boolean {
  const d = daveOf(state);
  return !!d && d.protocolVersion > 0 && d.session?.ready === true && typeof d.voicePrivacyCode === 'string' && d.voicePrivacyCode.length > 0;
}

/** Music under a spoken reply plays at this fraction (the old bot's ducking approach: an inline volume transformer). */
export const DUCK_FACTOR = 0.2;
export const MAX_VOLUME = 1.5;
export const effectiveVolume = (v: number, ducked: boolean): number => Math.min(MAX_VOLUME, Math.max(0, v)) * (ducked ? DUCK_FACTOR : 1);

type Log = { warn(o: object, m?: string): void };

export interface DiscordVoiceSessionOptions {
  /** Praw's guild adapter (`guild.voiceAdapterCreator` of the praw client), or null when she is not connected. */
  adapterCreator: (guildId: string) => DiscordGatewayAdapterCreator | null;
  log: Log;
  /** Loads @discordjs/voice (default dynamic import; tests pass tests/fakes/voice.ts fakeVoiceLib). */
  lib?: () => Promise<VoiceLib>;
  /** Ready plus live E2EE must happen within this (default 20 s). */
  readyTimeoutMs?: number;
  /** E2EE lost mid-session: audio is paused at once and the session is dropped after this (default 5 s). */
  daveGraceMs?: number;
  /** Silence that ends one utterance's receive stream (voice.silenceMs). */
  silenceMs?: number;
}

const DAVE_CHECK_MS = 250;
const conState = (c: VoiceConnection) => c.state as unknown as ConnectionStateLike;
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((r) => {
  const t = setTimeout(r, ms);
  signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
});

/**
 * Per-packet E2EE guard at the encryption point. AudioPlayer._preparePacket calls connection.prepareAudioPacket(packet) for every
 * 20 ms frame and ignores the return value; Networking.dispatchAudio sends only a prepared packet. Returning undefined without
 * preparing drops that frame: nothing goes on the wire, missedFrames is not touched (it counts only empty resource reads) and
 * playback goes on. So while DAVE is not live (e.g. Ready again after a reconnect, MLS group not yet formed, when
 * DAVESession.encrypt would pass frames through without the DAVE layer) no audio frame leaves Praw.
 */
export function guardPackets(conn: VoiceConnection): void {
  const c = conn as unknown as { prepareAudioPacket(b: Buffer): unknown; playOpusPacket(b: Buffer): unknown };
  const prepare = c.prepareAudioPacket.bind(conn);
  const playNow = c.playOpusPacket.bind(conn);
  c.prepareAudioPacket = (b) => (daveLive(conState(conn)) ? prepare(b) : undefined);
  c.playOpusPacket = (b) => (daveLive(conState(conn)) ? playNow(b) : undefined);
}

/** The real session over @discordjs/voice 0.19.2 (DAVE via @snazzah/davey, aes-256-gcm from node:crypto, opusscript). */
export class DiscordVoiceSession implements VoiceSession {
  private lib: VoiceLib | null = null;
  private conn: VoiceConnection | null = null;
  private player: AudioPlayer | null = null;
  private vol: prism.VolumeTransformer | null = null;
  private mixer: PcmMixer | null = null;
  private finishPlay: (() => void) | null = null;
  private volume = 1;
  private ducked = false;
  private leaving = false;
  /** Aborts a join still connecting when leave() comes first, so it rejects at once instead of at the timeout. */
  private joinAbort: AbortController | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private readonly speech = new Set<(userId: string, pcm: AsyncIterable<Uint8Array>) => void>();
  private readonly closed = new Set<(reason: string) => void>();
  private _channelId: string | null = null;

  constructor(private readonly o: DiscordVoiceSessionOptions) {}

  get channelId(): string | null {
    return this._channelId;
  }

  async join(channelId: string, guildId: string): Promise<void> {
    if (this.conn) throw new Error('already connected');
    let lib: VoiceLib;
    try {
      lib = await (this.o.lib ?? loadVoiceLibrary)();
    } catch {
      throw new Error('the voice library failed to load; voice is off');
    }
    const adapterCreator = this.o.adapterCreator(guildId);
    if (!adapterCreator) throw new Error('Praw is not connected to Discord');
    // selfDeaf false: a deafened bot receives no audio. daveEncryption is the default, set explicitly so it can never be turned off here.
    const conn = lib.joinVoiceChannel({ channelId, guildId, adapterCreator, selfDeaf: false, selfMute: false, daveEncryption: true, group: 'praw' });
    this.lib = lib;
    this.conn = conn;
    this.leaving = false;
    guardPackets(conn);
    const ac = new AbortController();
    this.joinAbort = ac;
    const timeout = this.o.readyTimeoutMs ?? 20_000;
    const deadline = Date.now() + timeout;
    try {
      await lib.entersState(conn, lib.VoiceConnectionStatus.Ready, AbortSignal.any([ac.signal, AbortSignal.timeout(timeout)]));
      while (!daveLive(conState(conn))) {
        if (ac.signal.aborted || this.conn !== conn) break;
        if (Date.now() >= deadline) throw new DaveRequiredError();
        await sleep(Math.min(100, deadline - Date.now()), ac.signal);
      }
      if (ac.signal.aborted || this.conn !== conn) throw new Error('left while connecting');
    } catch (err) {
      if (this.conn === conn) this.teardown();
      throw ac.signal.aborted && !(err instanceof DaveRequiredError) ? new Error('left while connecting') : err;
    } finally {
      if (this.joinAbort === ac) this.joinAbort = null;
    }
    this._channelId = channelId;
    this.watch(lib, conn);
    const player = lib.createAudioPlayer({ behaviors: { noSubscriber: lib.NoSubscriberBehavior.Pause } });
    player.on('error', (e) => this.o.log.warn({ err: e.message }, 'voice player error'));
    player.on(lib.AudioPlayerStatus.Idle, () => this.endPlay());
    conn.subscribe(player);
    this.player = player;
  }

  async leave(): Promise<void> {
    this.leaving = true;
    this.teardown();
  }

  play(src: AudioSource, o: { volume: number }): Promise<void> {
    return this.start(src, o.volume, false);
  }

  overlay(pcm: Buffer, signal?: AbortSignal): Promise<void> {
    if (!this.player || !this.conn || !this.lib) return Promise.reject(new Error('not connected to a voice channel'));
    if (!daveLive(conState(this.conn))) return Promise.reject(new DaveRequiredError());
    if (this.mixer && this.finishPlay && !this.mixer.destroyed) return this.mixer.add(pcm, signal);
    return this.start({ kind: 'raw', stream: Readable.from([pcm]) }, 1, true);
  }

  /** `solo`: a reply alone keeps full volume (never ducked, never the music volume) and leaves the music volume as it was. */
  private start(src: AudioSource, vol: number, solo: boolean): Promise<void> {
    if (!this.player || !this.conn || !this.lib) return Promise.reject(new Error('not connected to a voice channel'));
    if (!daveLive(conState(this.conn))) return Promise.reject(new DaveRequiredError());
    this.endPlay(); // a replaced source resolves its own play()
    if (!solo) this.volume = vol;
    const { resource, volume, mixer } = buildResource(this.lib, src, solo ? 1 : effectiveVolume(this.volume, this.ducked));
    this.vol = solo ? null : volume;
    this.mixer = mixer;
    const done = new Promise<void>((resolve) => (this.finishPlay = resolve));
    try {
      this.player.play(resource);
    } catch (err) {
      this.finishPlay = null;
      this.vol = null;
      this.mixer = null;
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return done;
  }

  setVolume(v: number): void {
    this.volume = v;
    this.vol?.setVolume(effectiveVolume(this.volume, this.ducked));
  }

  duck(on: boolean): void {
    this.ducked = on;
    this.vol?.setVolume(effectiveVolume(this.volume, this.ducked));
  }

  onSpeech(cb: (userId: string, pcm: AsyncIterable<Uint8Array>) => void): () => void {
    this.speech.add(cb);
    return () => this.speech.delete(cb);
  }

  onClose(cb: (reason: string) => void): () => void {
    this.closed.add(cb);
    return () => this.closed.delete(cb);
  }

  /** DAVE re-checks: on every downgrade transition and Ready (re)entry, plus a watchdog that pauses audio while E2EE is not live. */
  private watch(lib: VoiceLib, conn: VoiceConnection): void {
    conn.on('transitioned', () => {
      if (!daveNegotiated(conState(conn))) this.drop('dave-downgraded');
    });
    conn.on('stateChange', (_old, next) => {
      const S = lib.VoiceConnectionStatus;
      if (next.status === S.Destroyed) this.drop('destroyed');
      else if (next.status === S.Ready) {
        if (!daveNegotiated(conState(conn))) this.drop('dave-missing');
      } else if (next.status === S.Disconnected) {
        // a channel move reconnects by itself (Signalling/Connecting within 5 s); anything else is a kick or a network loss
        Promise.race([lib.entersState(conn, S.Signalling, AbortSignal.timeout(5000)), lib.entersState(conn, S.Connecting, AbortSignal.timeout(5000))])
          .catch(() => this.drop('disconnected'));
      }
    });
    conn.receiver.speaking.on('start', (userId) => this.utterance(lib, userId));
    let notLiveSince: number | null = null;
    let guardPaused = false;
    this.watchdog = setInterval(() => {
      if (this.conn !== conn) return;
      if (daveLive(conState(conn))) {
        notLiveSince = null;
        if (guardPaused) this.player?.unpause();
        guardPaused = false;
        return;
      }
      // Frames are already withheld per packet (guardPackets); the pause only stops the resource being consumed meanwhile.
      // pause() succeeds only from Playing (an AutoPaused player during a reconnect returns false), so track what it returned.
      if (!guardPaused) guardPaused = this.player?.pause() ?? false;
      notLiveSince ??= Date.now();
      if (Date.now() - notLiveSince >= (this.o.daveGraceMs ?? 5000)) this.drop('dave-missing');
    }, DAVE_CHECK_MS);
    this.watchdog.unref?.();
  }

  private utterance(lib: VoiceLib, userId: string): void {
    const conn = this.conn;
    if (!conn || conn.receiver.subscriptions.has(userId) || this.speech.size === 0) return;
    const silenceMs = this.o.silenceMs ?? 900;
    let started = false;
    const pcm: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        if (started) return; // one consumer per utterance
        started = true;
        const opus = conn.receiver.subscribe(userId, { end: { behavior: lib.EndBehaviorType.AfterSilence, duration: silenceMs } });
        const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 1, frameSize: 960 });
        opus.pipe(decoder);
        try {
          for await (const chunk of decoder) yield chunk as Uint8Array;
        } finally {
          opus.destroy();
          decoder.destroy();
        }
      },
    };
    for (const cb of this.speech) cb(userId, pcm);
  }

  private endPlay(): void {
    const f = this.finishPlay;
    this.finishPlay = null;
    this.vol = null;
    this.mixer?.destroy(); // a pending reply resolves; the old resource is gone or being replaced
    this.mixer = null;
    f?.();
  }

  private drop(reason: string): void {
    if (!this.conn) return;
    const unexpected = !this.leaving;
    this.teardown();
    if (unexpected) for (const cb of this.closed) cb(reason);
  }

  private teardown(): void {
    this.joinAbort?.abort();
    this.joinAbort = null;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    const conn = this.conn;
    this.conn = null;
    this._channelId = null;
    this.player?.stop(true);
    this.player = null;
    this.endPlay();
    if (conn && conn.state.status !== 'destroyed') {
      try {
        conn.destroy();
      } catch (e) {
        this.o.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'voice connection destroy failed');
      }
    }
  }
}

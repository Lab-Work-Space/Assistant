import { Transform } from 'node:stream';
import { VoiceJoinError, type VoiceManager } from '../manager.js';
import { DaveRequiredError } from '../session.js';
import { MusicQueue, VOLUME_MAX, validVolume, type QueuedTrack } from './queue.js';
import { MusicInputError, normaliseQuery, type TrackHandle } from './source.js';

export { MAX_QUEUE, MusicQueue, VOLUME_MAX, type MusicState, type MusicStore, type QueuedTrack } from './queue.js';
export { buildFfmpegArgs, buildYtDlpArgs, MusicInputError, normaliseQuery, prepareCookies, spawnSafe, startTrack, type TrackHandle, type TrackOptions } from './source.js';

/** Per-track caps (P7): yt-dlp's --max-filesize and --match-filters duration, our stdout caps and the wall-clock timeout follow these. */
export const TRACK_CAP_BYTES = 50 * 1024 * 1024;
export const TRACK_CAP_SECONDS = 20 * 60;

type Log = { info(o: object, m?: string): void; warn(o: object, m?: string): void; error(o: object, m?: string): void };

export interface MusicPlayerDeps {
  guildId: string;
  voice: Pick<VoiceManager, 'join' | 'current' | 'onLeave'>;
  queue: MusicQueue;
  /** Starts yt-dlp → ffmpeg for a queued query (startTrack with the pinned binaries); tests use the fake binaries. */
  start: (query: string) => TrackHandle;
  allowlist: () => readonly string[];
  /** The voice channel a member is in now (Praw's guild voice states), or null. */
  voiceChannelOf: (userId: string) => Promise<string | null>;
  log: Log;
}

export type MusicReply = { ok: boolean; text: string };

/**
 * Ruling T3-c2: a track that produced no audio because the media backend was down (sidecar unreachable, a 5xx, a child that could
 * not spawn) would fail the same way for every queued track, so the queue pauses at its head instead of being drained.
 * Final review M-5: a sidecar 503 `busy` (both track slots taken) pauses the same way; the next /play resumes it.
 */
const BACKEND_DOWN = (reason: string | null): boolean => reason === 'unavailable' || reason === 'busy' || reason === 'sidecar-unavailable' || reason === 'spawn failed' || !!reason?.startsWith('spawn failed:');
const DONE_WAIT_MS = 3000;
const no = (text: string): MusicReply => ({ ok: false, text });
const yes = (text: string): MusicReply => ({ ok: true, text });

/**
 * One guild's music: the queue (music_state), the player loop and the children. Children are killed on /skip, /stop, timeout
 * (spawnSafe), leaving voice and /halt (the VoiceManager's onLeave, within its 2 s bound). Music never pauses the audio player
 * itself, so the DAVE watchdog only ever unpauses what it paused; a play refused while E2EE is not live keeps the track at the head
 * and pauses the queue instead of skipping it.
 */
export class MusicPlayer {
  private active: TrackHandle | null = null;
  /** Bumped by skip/stop/leave/shutdown: the loop then knows the queue was already changed for it. */
  private gen = 0;
  private interrupt: (() => void) | null = null;
  private loop: Promise<void> | null = null;
  private shuttingDown = false;

  constructor(private readonly d: MusicPlayerDeps) {
    d.voice.onLeave(() => this.onLeave());
  }

  /** A track is going right now (a child is running); the voice chat's idle timer pauses while this is true. */
  isPlaying(): boolean {
    return this.active !== null;
  }

  restore(): Promise<void> {
    return this.d.queue.restore();
  }

  /**
   * The refusals of `play` that need no side effect: the query (live allowlist), the requester's voice channel and Praw being in
   * another one. music_play calls it from its precheck, so these refuse before any approval card exists. null = may play.
   */
  async precheckPlay(userId: string, query: string): Promise<string | null> {
    const r = await this.target(userId, query);
    return 'refuse' in r ? r.refuse : null;
  }

  private async target(userId: string, query: string): Promise<{ refuse: string } | { t: ReturnType<typeof normaliseQuery>; channel: string }> {
    let t;
    try {
      t = normaliseQuery(query, this.d.allowlist());
    } catch (err) {
      if (err instanceof MusicInputError) return { refuse: err.message };
      throw err;
    }
    const channel = await this.d.voiceChannelOf(userId);
    if (!channel) return { refuse: 'Join a voice channel first, then ask again.' };
    const cur = this.d.voice.current();
    if (cur && cur.channelId !== channel) return { refuse: `Praw is playing in <#${cur.channelId}>; join that channel to add music.` };
    return { t, channel };
  }

  /** One join at a time: a second /play while the first is still connecting waits for it and re-checks the channel. */
  private joinLock: Promise<unknown> = Promise.resolve();

  private ensureJoined(channel: string): Promise<string | null> {
    const run = this.joinLock.then(async (): Promise<string | null> => {
      const cur = this.d.voice.current();
      if (cur) return cur.channelId === channel ? null : `Praw is playing in <#${cur.channelId}>; join that channel to add music.`;
      try {
        await this.d.voice.join(channel, this.d.guildId);
        return null;
      } catch (err) {
        if (err instanceof VoiceJoinError) return err.message;
        throw err;
      }
    });
    this.joinLock = run.catch(() => undefined);
    return run;
  }

  /** music_play / `/play`: the requester must be in a voice channel; Praw joins it when she is not in one (Connect/Speak checked). */
  async play(userId: string, query: string): Promise<MusicReply> {
    const pre = await this.target(userId, query);
    if ('refuse' in pre) return no(pre.refuse);
    const { t, channel } = pre;
    const joinRefusal = await this.ensureJoined(channel);
    if (joinRefusal) return no(joinRefusal);
    const label = (t.kind === 'url' ? t.value : `"${t.value}"`).slice(0, 120);
    const resumed = this.d.queue.paused && this.d.queue.current() !== null;
    const r = await this.d.queue.enqueue({ query: t.value, label, requestedBy: userId });
    if ('error' in r) return no(`Not added: ${r.error}.`);
    await this.d.queue.setPaused(false);
    this.kick();
    // replies never echo another member's request text (it reaches the model as tool output); music_queue lists it as untrusted
    if (resumed) return yes(`Resuming the saved queue; ${label} is queued at position ${r.position}.`);
    return yes(r.position === 0 ? `Playing ${label}.` : `Queued ${label} at position ${r.position}.`);
  }

  async skip(): Promise<MusicReply> {
    if (!this.d.queue.current()) return no('Nothing is playing.');
    this.gen++;
    this.active?.kill('skip');
    const next = this.d.queue.skip();
    this.interrupt?.();
    const head = await next;
    if (head) this.kick();
    return yes(head ? `Skipped; the next track is playing (${this.d.queue.list().upcoming.length} more queued).` : 'Skipped; the queue is empty now.');
  }

  async stop(): Promise<MusicReply> {
    this.halt('stop');
    await this.d.queue.stop();
    return yes('Stopped the music and cleared the queue.');
  }

  list(): MusicReply {
    const l = this.d.queue.list();
    if (!l.current) return yes(`The queue is empty. Volume ${l.volume}%.`);
    const head = l.paused ? `Paused (the next /play resumes it): ${l.current.label}` : `Now playing: ${l.current.label}`;
    const next = l.upcoming.length ? `\nUp next:\n${l.upcoming.map((t, i) => `${i + 1}. ${t.label}`).join('\n')}` : '';
    return yes(`${head}${next}\nVolume ${l.volume}%.`);
  }

  async setVolume(percent: number): Promise<MusicReply> {
    if (!validVolume(percent)) return no(`Volume must be a whole number from 0 to ${VOLUME_MAX}.`);
    await this.d.queue.setVolume(percent);
    this.d.voice.current()?.session.setVolume(percent / 100);
    return yes(`Volume set to ${percent}%.`);
  }

  /** app.stop(), before voice.leave(): kills the children and keeps the queue (head = the track that was playing), saved paused. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.halt('shutdown');
    if (this.d.queue.current()) await this.d.queue.setPaused(true);
    await this.d.queue.flush();
  }

  /** Leaving voice (/halt, /voice leave, a kick or a DAVE drop): children die and the queue is cleared; a shutdown keeps it. */
  private async onLeave(): Promise<void> {
    this.halt('left voice');
    if (!this.shuttingDown) await this.d.queue.stop();
  }

  private halt(why: string): void {
    this.gen++;
    this.active?.kill(why);
    this.interrupt?.();
  }

  private kick(): void {
    this.loop ??= this.pump().catch((err: unknown) => this.d.log.error({ err: err instanceof Error ? err.message : String(err) }, 'music loop failed')).finally(() => {
      this.loop = null;
      // a /play that landed while the loop was returning found it still set: pick its track up now
      if (this.d.queue.current() && !this.d.queue.paused && this.d.voice.current() && !this.shuttingDown) this.kick();
    });
  }

  private async pump(): Promise<void> {
    for (;;) {
      const track: QueuedTrack | null = this.d.queue.current();
      const session = this.d.voice.current()?.session;
      if (!track || this.d.queue.paused || !session || this.shuttingDown) return;
      const gen = this.gen;
      let handle: TrackHandle;
      try {
        handle = this.d.start(track.query);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof MusicInputError) {
          // this one request is no longer allowed (media.ytHostAllowlist changed since it was queued)
          this.d.log.warn({ err: msg }, 'queued music request refused at play time; skipped');
          await this.d.queue.advance();
          continue;
        }
        // a spawn or cookies problem would fail every track: pause instead of draining the queue
        this.d.log.error({ err: msg }, 'music could not start; queue paused');
        await this.d.queue.setPaused(true);
        return;
      }
      this.active = handle;
      let failed: unknown = null;
      let bytes = 0;
      // counts the PCM on its way to the session (a pass-through: backpressure, end and errors behave as before)
      const counted = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          bytes += chunk.length;
          cb(null, chunk);
        },
      });
      handle.pcm.on('error', (err) => counted.destroy(err));
      handle.pcm.once('close', () => {
        if (!counted.writableEnded) counted.end(); // a source closed without 'end' still ends the play
      });
      handle.pcm.pipe(counted);
      const interrupted = new Promise<void>((r) => (this.interrupt = r));
      const played = session.play({ kind: 'raw', stream: counted }, { volume: this.d.queue.volume / 100 }).catch((err: unknown) => {
        failed = err;
      });
      await Promise.race([played, interrupted]);
      handle.kill('ended');
      this.active = null;
      this.interrupt = null;
      if (gen !== this.gen) continue; // skip/stop/leave already changed the queue
      if (bytes === 0 && !failed) {
        const done = await Promise.race([handle.done, new Promise<null>((r) => setTimeout(() => r(null), DONE_WAIT_MS).unref())]);
        if (gen !== this.gen) continue;
        if (done && (BACKEND_DOWN(done.ytDlp.reason) || BACKEND_DOWN(done.ffmpeg.reason))) {
          this.d.log.error({ ytReason: done.ytDlp.reason, ffReason: done.ffmpeg.reason }, 'music backend unavailable; queue paused (the next /play resumes it)');
          await this.d.queue.setPaused(true);
          return;
        }
      }
      if (failed instanceof DaveRequiredError) {
        this.d.log.warn({}, 'music paused: voice E2EE (DAVE) is not live; the track stays at the head');
        await this.d.queue.setPaused(true);
        return;
      }
      if (failed) this.d.log.warn({ err: failed instanceof Error ? failed.message : String(failed) }, 'music playback failed; skipped');
      await this.d.queue.advance();
    }
  }
}

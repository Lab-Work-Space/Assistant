import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach } from 'vitest';
import { FakeVoiceSession } from '../../tests/fakes/voice.js';
import { VoiceManager } from '../manager.js';
import { MusicPlayer } from './index.js';
import { MusicQueue, type MusicState, type MusicStore } from './queue.js';
import { startTrack, type TrackHandle, type TrackOptions } from './source.js';

/** Every track a rig started; killed after each test so a test that ends mid-track never leaves a fake child running. */
const live = new Set<TrackHandle>();
afterEach(() => {
  for (const h of live) h.kill('test-end');
  live.clear();
});

export const FAKE_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fakes', 'bin');
export const FAKE_YTDLP = join(FAKE_BIN, 'yt-dlp');
export const FAKE_FFMPEG = join(FAKE_BIN, 'ffmpeg');
export const FAKE_JS = join(FAKE_BIN, 'js-runtime');
export const ALLOW = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'];
export const GUILD = '1565649426943442944';
export const VC = '1565999999999999555';
export const silent = { info() {}, warn() {}, error() {} };

export const scratch = (): string => mkdtempSync(join(tmpdir(), 'lw-music-test-'));

/** Track options over the fake binaries; `extraEnv` carries only the fakes' FAKE_* switches. */
export function fakeTrackOptions(over: Partial<TrackOptions> = {}): TrackOptions {
  return { ytDlp: FAKE_YTDLP, ffmpeg: FAKE_FFMPEG, jsRuntime: FAKE_JS, allowlist: () => ALLOW, capBytes: 1_000_000, capSeconds: 600, log: silent, ...over };
}

/** NUL-separated argv lines the fake yt-dlp wrote, one entry per invocation. */
export const argvLog = (file: string): string[][] =>
  readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0).map((l) => l.split('\0').slice(0, -1));

export class MemoryStore implements MusicStore {
  state: MusicState | null = null;
  saves = 0;
  async load(): Promise<MusicState | null> {
    return this.state ? structuredClone(this.state) : null;
  }
  async save(s: MusicState): Promise<void> {
    this.saves++;
    this.state = structuredClone(s);
  }
}

export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export async function waitFor<T>(fn: () => T | undefined | null | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A MusicPlayer over a real VoiceManager, a held FakeVoiceSession and the fake binaries. */
export function musicRig(o: { track?: Partial<TrackOptions>; start?: (q: string) => TrackHandle; store?: MemoryStore; channelOf?: (u: string) => Promise<string | null>; check?: (id: string) => Promise<string | null> } = {}) {
  const sessions: FakeVoiceSession[] = [];
  const voice = new VoiceManager({
    createSession: () => {
      const s = new FakeVoiceSession({ holdPlay: true });
      sessions.push(s);
      return s;
    },
    checkChannel: o.check ?? (async () => null),
    log: silent,
  });
  const store = o.store ?? new MemoryStore();
  const queue = new MusicQueue(store, silent);
  const opts = fakeTrackOptions(o.track);
  const player = new MusicPlayer({
    guildId: GUILD, voice, queue, log: silent, allowlist: () => ALLOW,
    start: (q) => {
      const h = o.start ? o.start(q) : startTrack(q, opts);
      live.add(h);
      return h;
    },
    voiceChannelOf: o.channelOf ?? (async () => VC),
  });
  return { voice, sessions, store, queue, player, session: () => sessions.at(-1)! };
}

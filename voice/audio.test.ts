import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import prism from 'prism-media';
import { buildResource } from './audio.js';
import { loadVoiceLibrary } from './library.js';
import { guardPackets } from './session.js';

// The CommonJS child_process object that prism-media and @discordjs/voice call through (property lookups at call time).
const cp = createRequire(import.meta.url)('node:child_process') as Record<string, unknown>;
const NAMES = ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork'] as const;
const spawned: string[] = [];
const saved = new Map<string, unknown>();

beforeAll(() => {
  for (const n of NAMES) {
    saved.set(n, cp[n]);
    cp[n] = (file: unknown) => {
      spawned.push(`${n} ${String(file)}`);
      return { error: new Error('blocked by test'), output: [], pid: 0 };
    };
  }
});
afterAll(() => {
  for (const n of NAMES) cp[n] = saved.get(n);
});

describe('audio', () => {
  it('our resource pipeline (PCM → volume → opus encoder) and player.play start no library ffmpeg (P8)', async () => {
    const lib = await loadVoiceLibrary();
    const pcm = Readable.from([Buffer.alloc(3840 * 3)]); // three 20 ms stereo s16le frames
    const { resource, volume } = buildResource(lib, { kind: 'raw', stream: pcm }, 0.5);
    expect(volume.volume).toBe(0.5);
    const packet = await new Promise<Buffer>((resolve) => resource.playStream.once('data', resolve));
    expect(packet.length).toBeGreaterThan(0); // an opus packet came out
    const player = lib.createAudioPlayer({ behaviors: { noSubscriber: lib.NoSubscriberBehavior.Play } });
    player.play(buildResource(lib, { kind: 'raw', stream: Readable.from([Buffer.alloc(3840)]) }, 1).resource);
    await new Promise((r) => setTimeout(r, 60));
    player.stop(true);
    expect(spawned).toEqual([]);
  });

  it('positive control: prism-media ffmpeg probing (what createAudioResource triggers) is caught by the spy', () => {
    // createAudioResource -> getNode -> canEnableFFmpegOptimizations -> prism.FFmpeg.getInfo() -> spawnSync('ffmpeg', ['-h']) with
    // the parent env. getInfo caches per process, so force it here to show the spy sees prism's calls.
    expect(() => prism.FFmpeg.getInfo(true)).toThrow(/not found/);
    expect(spawned.some((s) => s.startsWith('spawnSync'))).toBe(true);
  });

  it('the per-packet DAVE guard wraps the real VoiceConnection methods the player calls', async () => {
    const lib = await loadVoiceLibrary();
    const before = spawned.length;
    const adapterCreator = () => ({ sendPayload: () => true, destroy: () => {} });
    const conn = lib.joinVoiceChannel({ channelId: 'vc-guard', guildId: 'g-guard', adapterCreator, group: 'guard-test' });
    try {
      const proto = Object.getPrototypeOf(conn) as Record<string, unknown>;
      expect(typeof proto.prepareAudioPacket).toBe('function');
      expect(typeof proto.playOpusPacket).toBe('function');
      guardPackets(conn);
      const c = conn as unknown as Record<string, (b: Buffer) => unknown>;
      expect(c.prepareAudioPacket).not.toBe(proto.prepareAudioPacket);
      expect(c.prepareAudioPacket!(Buffer.from([0xf8, 0xff, 0xfe]))).toBeUndefined(); // not Ready, no DAVE: nothing prepared
    } finally {
      conn.destroy();
    }
    expect(spawned.length).toBe(before);
  });
});

import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { DaveRequiredError } from '../session.js';
import { MAX_QUEUE, MusicQueue } from './queue.js';
import type { SafeExit, TrackHandle } from './source.js';
import { MemoryStore, musicRig, silent, waitFor } from './test-helpers.js';

const track = (q: string) => ({ query: q, label: q, requestedBy: 'u1' });

describe('queue', () => {
  it('queue › play → skip → next; stop clears; volume bounds', async () => {
    const q = new MusicQueue(new MemoryStore(), silent);
    expect(await q.enqueue(track('a'))).toEqual({ position: 0 });
    expect(await q.enqueue(track('b'))).toEqual({ position: 1 });
    await q.enqueue(track('c'));
    expect(q.list()).toMatchObject({ current: { query: 'a' }, upcoming: [{ query: 'b' }, { query: 'c' }], volume: 100, paused: false });
    expect((await q.skip())?.query).toBe('b');
    expect(q.list().current?.query).toBe('b');
    await q.stop();
    expect(q.list()).toMatchObject({ current: null, upcoming: [] });
    for (const v of [0, 55, 150]) expect(await q.setVolume(v)).toBe(v);
    for (const v of [-1, 151, 1.5, Number.NaN]) await expect(q.setVolume(v)).rejects.toThrow(RangeError);
    expect(q.list().volume).toBe(150);
    for (let i = 0; i < MAX_QUEUE; i++) await q.enqueue(track(`t${i}`));
    expect(await q.enqueue(track('over'))).toEqual({ error: expect.stringMatching(/full/) });
  });

  it('player › /play <search> plays, /skip advances to the next track, the last one ends the queue', async () => {
    const rig = musicRig({ track: { extraEnv: { FAKE_YTDLP_HANG: '/dev/null' } } });
    expect((await rig.player.play('u1', 'first')).text).toMatch(/Playing/);
    expect((await rig.player.play('u1', 'second')).text).toMatch(/Queued.*1/);
    const s = await waitFor(() => rig.session()?.played.length === 1 && rig.session());
    expect(rig.queue.list().current?.query).toBe('first');
    expect((await rig.player.skip()).text).toMatch(/next track is playing \(0 more/);
    await waitFor(() => s.played.length === 2);
    expect(rig.queue.list().current?.query).toBe('second');
    await rig.player.skip();
    await waitFor(() => !s.playing && rig.queue.list().current === null);
    expect((await rig.player.skip()).ok).toBe(false); // nothing playing
  });

  it('player › volume applies to the session and is bounded 0–150', async () => {
    const rig = musicRig({ track: { extraEnv: { FAKE_YTDLP_HANG: '/dev/null' } } });
    await rig.player.play('u1', 'x');
    const s = await waitFor(() => rig.session()?.played.length === 1 && rig.session());
    expect((await rig.player.setVolume(40)).ok).toBe(true);
    expect(s.volume).toBe(0.4);
    expect((await rig.player.setVolume(151)).ok).toBe(false);
    expect(s.volume).toBe(0.4);
    await rig.player.stop();
  });

  it('queue › persists and restores after restart (music_state)', async () => {
    const store = new MemoryStore();
    const one = musicRig({ store, track: { extraEnv: { FAKE_YTDLP_HANG: '/dev/null' } } });
    await one.player.play('u1', 'first');
    await one.player.play('u1', 'second');
    await one.player.setVolume(70);
    await waitFor(() => one.session()?.played.length === 1);
    await one.player.shutdown(); // app.stop(): before voice.leave()
    await one.voice.leave();
    expect(store.state).toEqual({ queue: [expect.objectContaining({ query: 'first' }), expect.objectContaining({ query: 'second' })], volume: 70, paused: true });

    const two = musicRig({ store, track: { extraEnv: { FAKE_YTDLP_HANG: '/dev/null' } } });
    await two.player.restore();
    expect(two.queue.list()).toMatchObject({ current: { query: 'first' }, upcoming: [{ query: 'second' }], volume: 70, paused: true });
    expect(two.voice.current()).toBeNull(); // restored paused: no auto-join
    expect(two.sessions).toHaveLength(0);
    const r = await two.player.play('u1', 'third'); // the next play resumes the saved queue
    expect(r.text).toMatch(/Resuming/);
    const s = await waitFor(() => two.session()?.played.length === 1 && two.session());
    expect(s.volume).toBe(0.7);
    expect(two.queue.list()).toMatchObject({ current: { query: 'first' }, paused: false });
    await two.player.stop();
  });

  it('a DAVE refusal keeps the track at the head and pauses (never burns the queue)', async () => {
    const rig = musicRig({ track: { extraEnv: { FAKE_YTDLP_HANG: '/dev/null' } } });
    await rig.voice.join('1565999999999999555', '1565649426943442944');
    rig.session().playError = new DaveRequiredError();
    await rig.player.play('u1', 'a');
    await waitFor(() => rig.queue.list().paused);
    expect(rig.queue.list().current?.query).toBe('a');
  });

  it('a bad cookies file pauses the queue instead of draining it; a request no longer allowlisted is skipped', async () => {
    const rig = musicRig({ track: { cookiesFile: '/nonexistent/cookies.txt', extraEnv: { FAKE_YTDLP_HANG: '/dev/null' } } });
    await rig.player.play('u1', 'a');
    await rig.player.play('u1', 'b');
    await waitFor(() => rig.queue.list().paused);
    expect(rig.queue.list().current?.query).toBe('a');
    expect(rig.session().played).toHaveLength(0);

    let allow = ['youtube.com', 'youtu.be'];
    const two = musicRig({ track: { allowlist: () => allow, extraEnv: { FAKE_YTDLP_HANG: '/dev/null' } } });
    await two.voice.join('1565999999999999555', '1565649426943442944');
    await two.queue.enqueue({ query: 'https://youtu.be/dQw4w9WgXcQ', label: 'x', requestedBy: 'u1' });
    allow = ['youtube.com'];
    await two.player.play('u1', 'next one');
    await waitFor(() => two.session().played.length === 1);
    expect(two.queue.list().current?.query).toBe('next one');
    await two.player.stop();
  });

  describe('a track that ends with no audio because the media backend is down or busy (Ruling T3-c2, final review M-5)', () => {
    const exit = (reason: string | null): SafeExit => ({ code: reason ? null : 0, signal: null, reason, stderr: '' });
    /** A handle that ends at once: `bytes` of PCM, then done with `reason` on both children (what SocketMediaBackend gives on a failure). */
    const ended = (reason: string | null, bytes = 0) => (): TrackHandle => {
      const pcm = new PassThrough();
      if (bytes) pcm.write(Buffer.alloc(bytes));
      pcm.end();
      return { pcm, kill: () => undefined, done: Promise.resolve({ ytDlp: exit(reason), ffmpeg: exit(reason) }) };
    };

    it.each(['unavailable', 'busy', 'sidecar-unavailable', 'spawn failed', 'spawn failed: spawn /opt/yt-dlp/yt-dlp ENOENT'])(
      'player › zero PCM bytes with reason %s pauses the queue at its head (never drains it)',
      async (reason) => {
        const rig = musicRig({ start: ended(reason) });
        await rig.player.play('u1', 'a');
        await rig.player.play('u1', 'b');
        await waitFor(() => rig.queue.list().paused);
        expect(rig.queue.list().current?.query).toBe('a');
        expect(rig.queue.list().upcoming.map((t) => t.query)).toEqual(['b']);
        expect(rig.session().played).toHaveLength(1); // tried once, then paused: no retry loop over the queue
      },
    );

    it('player › an empty track that ended normally, or audio followed by a sidecar failure, still advances', async () => {
      const normal = musicRig({ start: ended(null) });
      await normal.player.play('u1', 'a');
      await normal.player.play('u1', 'b');
      await waitFor(() => normal.queue.list().current === null);
      expect(normal.queue.list().paused).toBe(false);

      const some = musicRig({ start: ended('sidecar-unavailable', 4) });
      await some.player.play('u1', 'a');
      await some.player.play('u1', 'b');
      await waitFor(() => some.queue.list().current === null);
      expect(some.queue.list().paused).toBe(false);
      expect(some.session().played).toHaveLength(2);
    });

    it('player › a refusing local backend ("media sidecar not configured", a plain Error) pauses instead of skipping', async () => {
      const rig = musicRig({ start: () => { throw new Error('media sidecar not configured'); } });
      await rig.player.play('u1', 'a');
      await rig.player.play('u1', 'b');
      await waitFor(() => rig.queue.list().paused);
      expect(rig.queue.list().current?.query).toBe('a');
      expect(rig.queue.list().upcoming).toHaveLength(1);
    });
  });

  it('M5: two /play at once join once; the second waits for the first join and queues', async () => {
    const rig = musicRig({ track: { extraEnv: { FAKE_YTDLP_HANG: '/dev/null' } } });
    const [a, b] = await Promise.all([rig.player.play('u1', 'one'), rig.player.play('u2', 'two')]);
    expect([a.ok, b.ok]).toEqual([true, true]);
    expect(rig.sessions).toHaveLength(1);
    expect(rig.session().calls.filter((c) => c.startsWith('join:'))).toHaveLength(1);
    expect(rig.queue.list()).toMatchObject({ current: { query: 'one' }, upcoming: [{ query: 'two' }] });
    await rig.player.stop();
  });

  it('restore drops malformed rows and clamps volume', async () => {
    const store = new MemoryStore();
    store.state = { queue: [track('ok'), { query: 5 } as never, track('x'.repeat(400))], volume: 999, paused: false };
    const q = new MusicQueue(store, silent);
    await q.restore();
    expect(q.list()).toMatchObject({ current: { query: 'ok' }, upcoming: [], volume: 150, paused: true });
  });
});

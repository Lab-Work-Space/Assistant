import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeVoiceSession, fakeVoiceLib, liveDave } from '../tests/fakes/voice.js';
import type { VoiceLib } from './library.js';
import { DaveRequiredError, daveLive, DiscordVoiceSession, effectiveVolume, type VoiceSession } from './session.js';

const silent = { warn() {} };
const pcm = () => ({ kind: 'raw' as const, stream: Readable.from([Buffer.alloc(3840)]) });

function real(o: { readyTimeoutMs?: number; daveGraceMs?: number } = {}) {
  const f = fakeVoiceLib();
  const s = new DiscordVoiceSession({ adapterCreator: () => ({}) as never, log: silent, lib: async () => f.lib as unknown as VoiceLib, readyTimeoutMs: o.readyTimeoutMs ?? 1000, daveGraceMs: o.daveGraceMs ?? 1000 });
  return { s, f };
}
const conn = (f: ReturnType<typeof fakeVoiceLib>) => f.connections[0]!;

afterEach(() => {
  vi.useRealTimers();
});

describe('session fake', () => {
  it('join/leave lifecycle', async () => {
    const s: VoiceSession = new FakeVoiceSession();
    expect(s.channelId).toBeNull();
    await s.join('vc-1', 'g-1');
    expect(s.channelId).toBe('vc-1');
    await expect(s.join('vc-2', 'g-1')).rejects.toThrow(/already/);
    await s.play(pcm(), { volume: 0.8 });
    s.setVolume(0.5);
    s.duck(true);
    s.duck(false);
    await s.leave();
    expect(s.channelId).toBeNull();
    expect((s as FakeVoiceSession).calls).toEqual(['join:g-1/vc-1', 'join:g-1/vc-2', 'play', 'volume:0.5', 'duck:true', 'duck:false', 'leave']);
  });

  it('speech is lazy: a stream nobody reads is never decoded', async () => {
    const s = new FakeVoiceSession();
    const got: string[] = [];
    const off = s.onSpeech((userId, audio) => {
      if (userId !== 'opted-in') return; // discarded without iterating
      void (async () => { for await (const c of audio) got.push(`${userId}:${c.length}`); })();
    });
    s.speak('stranger', [new Uint8Array(4)]);
    s.speak('opted-in', [new Uint8Array(2), new Uint8Array(3)]);
    await new Promise((r) => setImmediate(r));
    expect(got).toEqual(['opted-in:2', 'opted-in:3']);
    expect(s.decoded).toEqual(['opted-in']);
    off();
  });
});

describe('session', () => {
  it('E2EE counts as live only with DAVE v>0, an MLS session ready and a privacy code', () => {
    const ready = (dave?: object) => ({ status: 'ready', networking: { state: dave ? { dave } : {} } }) as never;
    expect(daveLive(ready(liveDave()))).toBe(true);
    expect(daveLive(ready({ ...liveDave(), protocolVersion: 0 }))).toBe(false); // downgraded
    expect(daveLive(ready({ ...liveDave(), voicePrivacyCode: null }))).toBe(false);
    expect(daveLive(ready({ ...liveDave(), session: { ready: false } }))).toBe(false); // the library would send plaintext frames
    expect(daveLive(ready())).toBe(false);
    expect(daveLive({ status: 'signalling' } as never)).toBe(false);
    expect(new DaveRequiredError().message).toMatch(/DAVE/);
  });

  it('joins undeafened with DAVE forced on, and resolves only once E2EE is live', async () => {
    const { s, f } = real();
    let joined = false;
    const p = s.join('vc-1', 'g-1').then(() => (joined = true));
    await vi.waitFor(() => expect(f.connections).toHaveLength(1));
    expect(conn(f).options).toMatchObject({ channelId: 'vc-1', guildId: 'g-1', selfDeaf: false, selfMute: false, daveEncryption: true });
    conn(f).setState('ready', { protocolVersion: 1, voicePrivacyCode: null, session: { ready: false } });
    await new Promise((r) => setTimeout(r, 120));
    expect(joined).toBe(false); // protocol v1 negotiated but the MLS group is not ready yet
    conn(f).state.networking!.state.dave = liveDave();
    await p;
    expect(s.channelId).toBe('vc-1');
    await s.leave();
  });

  it('protocol v1 that never becomes ready → DaveRequiredError, connection destroyed', async () => {
    const { s, f } = real({ readyTimeoutMs: 300 });
    const p = s.join('vc-1', 'g-1');
    await vi.waitFor(() => expect(f.connections).toHaveLength(1));
    conn(f).setState('ready', { protocolVersion: 1, voicePrivacyCode: null, session: { ready: false } });
    await expect(p).rejects.toBeInstanceOf(DaveRequiredError);
    expect(conn(f).state.status).toBe('destroyed');
    expect(s.channelId).toBeNull();
  });

  it('play refuses while E2EE is not live', async () => {
    const { s, f } = real();
    const p = s.join('vc-1', 'g-1');
    await vi.waitFor(() => expect(f.connections).toHaveLength(1));
    conn(f).setState('ready', liveDave());
    await p;
    conn(f).state.networking!.state.dave!.session = { ready: false };
    await expect(s.play(pcm(), { volume: 1 })).rejects.toThrow(/DAVE/);
    expect(f.players[0]!.calls).not.toContain('play');
    await s.leave();
  });

  it('a reconnect that reaches Ready without DAVE drops the session (dave-missing)', async () => {
    const { s, f } = real();
    const closed: string[] = [];
    s.onClose((r) => closed.push(r));
    const p = s.join('vc-1', 'g-1');
    await vi.waitFor(() => expect(f.connections).toHaveLength(1));
    conn(f).setState('ready', liveDave());
    await p;
    conn(f).setState('connecting');
    conn(f).setState('ready', { protocolVersion: 0, voicePrivacyCode: null });
    expect(closed).toEqual(['dave-missing']);
    expect(conn(f).state.status).toBe('destroyed');
    expect(s.channelId).toBeNull();
  });

  it('E2EE lost mid-session pauses audio at once and drops after the grace period', async () => {
    const { s, f } = real({ daveGraceMs: 600 });
    const closed: string[] = [];
    s.onClose((r) => closed.push(r));
    const p = s.join('vc-1', 'g-1');
    await vi.waitFor(() => expect(f.connections).toHaveLength(1));
    conn(f).setState('ready', liveDave());
    await p;
    conn(f).state.networking!.state.dave!.session = { ready: false };
    await vi.waitFor(() => expect(f.players[0]!.calls).toContain('pause'), { timeout: 500 });
    await vi.waitFor(() => expect(closed).toEqual(['dave-missing']), { timeout: 2000 });
  });

  it('leave during a join aborts the Ready wait at once', async () => {
    const { s, f } = real({ readyTimeoutMs: 60_000 });
    const p = s.join('vc-1', 'g-1');
    await vi.waitFor(() => expect(f.connections).toHaveLength(1));
    const t0 = Date.now();
    await s.leave();
    await expect(p).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(conn(f).state.status).toBe('destroyed');
  });

  it('a library that fails to load rejects join (voice off, never a crash)', async () => {
    const s = new DiscordVoiceSession({ adapterCreator: () => ({}) as never, log: silent, lib: async () => { throw new Error('davey native module missing'); } });
    await expect(s.join('vc-1', 'g-1')).rejects.toThrow(/voice library/);
  });

  it('ducking lowers the effective volume and restores it', () => {
    expect(effectiveVolume(0.8, false)).toBeCloseTo(0.8);
    expect(effectiveVolume(0.8, true)).toBeLessThan(0.8 * 0.5);
    expect(effectiveVolume(2, false)).toBe(1.5); // capped
    expect(effectiveVolume(-1, false)).toBe(0);
  });

  it('reconnect to Ready with DAVE v1 not ready: zero packets reach the wire until E2EE is live, then they resume', async () => {
    const { s, f } = real({ daveGraceMs: 60_000 });
    const p = s.join('vc-1', 'g-1');
    await vi.waitFor(() => expect(f.connections).toHaveLength(1));
    const c = conn(f);
    c.prepareAudioPacket(Buffer.from([1])); // before Ready: dropped by the library itself
    c.setState('ready', liveDave());
    await p;
    c.prepareAudioPacket(Buffer.from([2]));
    expect(c.prepared.map((b) => b[0])).toEqual([2]);
    f.players[0]!.status = 'autopaused'; // the player is AutoPaused while the connection is down; pause() cannot act on it
    c.setState('connecting');
    c.setState('ready', { protocolVersion: 1, voicePrivacyCode: null, session: { ready: false } });
    expect(s.channelId).toBe('vc-1'); // negotiated, so not dropped yet
    for (const n of [3, 4, 5]) c.prepareAudioPacket(Buffer.from([n])); // the player auto-resumes and prepares frames
    c.playOpusPacket(Buffer.from([6]));
    expect(c.prepared.map((b) => b[0])).toEqual([2]);
    c.state.networking!.state.dave = liveDave();
    c.prepareAudioPacket(Buffer.from([7]));
    expect(c.prepared.map((b) => b[0])).toEqual([2, 7]);
    await s.leave();
  });

  it('the watchdog marks a pause only when pause() succeeded, and still drops after the grace period', async () => {
    const { s, f } = real({ daveGraceMs: 400 });
    const closed: string[] = [];
    s.onClose((r) => closed.push(r));
    const p = s.join('vc-1', 'g-1');
    await vi.waitFor(() => expect(f.connections).toHaveLength(1));
    conn(f).setState('ready', liveDave());
    await p;
    f.players[0]!.status = 'autopaused';
    conn(f).state.networking!.state.dave!.session = { ready: false };
    await vi.waitFor(() => expect(f.players[0]!.calls).toContain('pause'), { timeout: 500 });
    conn(f).state.networking!.state.dave!.session = { ready: true };
    await new Promise((r) => setTimeout(r, 300));
    expect(f.players[0]!.calls).not.toContain('unpause'); // it never paused, so it never unpauses
    conn(f).state.networking!.state.dave!.session = { ready: false };
    await vi.waitFor(() => expect(closed).toEqual(['dave-missing']), { timeout: 2000 });
  });

  it('music during a guard pause (T36): the next track is refused, nothing else pauses, and the watchdog only lifts its own pause', async () => {
    const { s, f } = real({ daveGraceMs: 5000 });
    const p = s.join('vc-1', 'g-1');
    await vi.waitFor(() => expect(f.connections).toHaveLength(1));
    conn(f).setState('ready', liveDave());
    await p;
    void s.play(pcm(), { volume: 1 });
    conn(f).state.networking!.state.dave!.session = { ready: false };
    await vi.waitFor(() => expect(f.players[0]!.status).toBe('paused'), { timeout: 500 });
    await expect(s.play(pcm(), { volume: 1 })).rejects.toBeInstanceOf(DaveRequiredError); // /skip's next track: kept at the head
    expect(f.players[0]!.calls.filter((c) => c === 'pause')).toEqual(['pause']); // music never pauses the player itself
    f.players[0]!.stop(); // the paused resource ended meanwhile (/stop killed its children)
    conn(f).state.networking!.state.dave!.session = { ready: true };
    await vi.waitFor(() => expect(f.players[0]!.calls).toContain('unpause'), { timeout: 500 });
    expect(f.players[0]!.status).toBe('idle'); // unpause of a stopped player is a no-op: nothing resumes that the user stopped
    await s.leave();
  });

  it('a synchronous player.play throw becomes a rejection', async () => {
    const { s, f } = real();
    const p = s.join('vc-1', 'g-1');
    await vi.waitFor(() => expect(f.connections).toHaveLength(1));
    conn(f).setState('ready', liveDave());
    await p;
    f.players[0]!.throwOnPlay = new Error('resource destroyed');
    await expect(s.play(pcm(), { volume: 1 })).rejects.toThrow('resource destroyed');
    await s.leave();
  });
});

describe('session overlay (spoken replies over music)', () => {
  const joined = async () => {
    const { s, f } = real();
    const p = s.join('vc-1', 'g-1');
    await vi.waitFor(() => expect(f.connections).toHaveLength(1));
    conn(f).setState('ready', liveDave());
    await p;
    return { s, f };
  };
  type Res = { streams: unknown[] };

  it('a reply over playing music is mixed in: no new play(), the music play() keeps running, its volume is ducked only', async () => {
    const { s, f } = await joined();
    let musicDone = false;
    void s.play(pcm(), { volume: 0.8 }).then(() => (musicDone = true));
    const player = f.players[0]!;
    const music = player.resources[0] as Res;
    expect(music.streams).toHaveLength(4); // source → volume → mixer → opus encoder
    s.duck(true);
    let spoken = false;
    const said = s.overlay(Buffer.alloc(3840)).then(() => (spoken = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(player.calls.filter((c) => c === 'play')).toHaveLength(1); // the music resource was not replaced (no skip)
    expect(musicDone).toBe(false);
    expect((music.streams[1] as { volume: number }).volume).toBeCloseTo(0.8 * 0.2);
    expect(spoken).toBe(false);
    await s.leave(); // teardown resolves a pending overlay
    await said;
    expect(spoken).toBe(true);
  });

  it('a reply with nothing playing is played alone at full volume, even while ducked', async () => {
    const { s, f } = await joined();
    s.duck(true);
    void s.overlay(Buffer.alloc(3840));
    const r = f.players[0]!.resources[0] as Res;
    expect((r.streams[1] as { volume: number }).volume).toBe(1);
    s.setVolume(0.3); // the music volume never applies to a solo reply
    expect((r.streams[1] as { volume: number }).volume).toBe(1);
    await s.leave();
  });

  it('overlay refuses when not connected or while E2EE is not live', async () => {
    const { s, f } = await joined();
    conn(f).state.networking!.state.dave!.session = { ready: false };
    await expect(s.overlay(Buffer.alloc(4))).rejects.toThrow(/DAVE/);
    await s.leave();
    await expect(s.overlay(Buffer.alloc(4))).rejects.toThrow(/not connected/);
  });
});

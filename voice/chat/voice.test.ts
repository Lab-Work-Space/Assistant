import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeVoiceSession } from '../../tests/fakes/voice.js';
import { DaveRequiredError } from '../session.js';
import { chatRig, chunks, DENIED_VC, flush, silence, tone, until, VC, VC2 } from './test-helpers.js';

const utter = (s: FakeVoiceSession, user = 'u1') => s.speak(user, chunks(tone(600), silence(900)));
let cleanup: (() => void)[] = [];
afterEach(async () => {
  for (const f of cleanup) f();
  cleanup = [];
});

/** Every file and directory under `root` (missing root = empty). */
function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let names: string[];
    try { names = readdirSync(d); } catch { return; }
    for (const n of names) {
      const p = join(d, n);
      out.push(p);
      try { if (statSync(p).isDirectory()) walk(p); } catch { /* vanished */ }
    }
  };
  walk(root);
  return out.sort();
}

describe('voice.test.ts', () => {
  it('non-opted-in user stream not sent to STT (discarded undecoded)', async () => {
    const t = chatRig();
    const j = await t.join();
    if (!j.ok) throw new Error(j.text);
    const s = t.session()!;
    utter(s, 'u2'); // in the channel, not opted in
    utter(s, 'bot-1'); // a bot is never decoded, even if it could press a button
    await flush(60);
    expect(s.decoded).toEqual([]);
    expect(t.transcribed).toHaveLength(0);
    t.where.set('u2', VC); // the presser must be in the session's voice channel
    expect(await t.chat.optIn('stale-nonce', 'u2')).toMatch(/ended|no longer/i);
    expect(await t.chat.optIn(j.nonce, 'bot-1')).toMatch(/bot/i);
    expect(await t.chat.optIn(j.nonce, 'u2')).toMatch(/opted in|ฟัง/);
    utter(s, 'u2');
    utter(s, 'bot-1');
    await flush(60);
    expect(s.decoded).toEqual(['u2']);
    expect(t.transcribed).toHaveLength(1);
    await t.chat.leave();
  });

  it('opt-in button: the presser must currently be in the session voice channel', async () => {
    const t = chatRig();
    const j = await t.join();
    if (!j.ok) throw new Error('join');
    const s = t.session()!;
    t.where.set('u3', null); // not in any voice channel
    t.where.set('u4', VC2); // in another voice channel
    expect(await t.chat.optIn(j.nonce, 'u3')).toMatch(/voice channel/i);
    expect(await t.chat.optIn(j.nonce, 'u4')).toMatch(/voice channel/i);
    utter(s, 'u3');
    utter(s, 'u4');
    await flush(60);
    expect(s.decoded).toEqual([]); // refused presses opted nobody in
    t.where.set('u3', VC);
    expect(await t.chat.optIn(j.nonce, 'u3')).toMatch(/opted in|ฟัง/);
    utter(s, 'u3');
    await flush(60);
    expect(s.decoded).toEqual(['u3']);
    await t.chat.leave();
  });

  it('idle auto-leave pauses while music is playing; max session length still applies', async () => {
    const cfg = () => new FakeConfig({ 'voice.idleMin': 10, 'voice.maxSessionMin': 60 });
    const t = chatRig({ cfg: cfg() });
    // Wait for a tick that read the clock as it is now (awaited state, not a fixed number of event-loop turns: M-1 flake).
    const tick = async () => {
      const n = t.music.checks;
      await until(() => t.music.checks > n);
    };
    const left = () => t.audits.some((a) => a['action'] === 'voice.leave');
    t.music.playing = true;
    expect((await t.join()).ok).toBe(true);
    t.clock.now += 30 * 60_000; // far past idleMin with music playing
    await tick();
    expect(left()).toBe(false);
    expect(t.voice.current()).not.toBeNull();
    t.music.playing = false; // the music ended: the idle clock restarts from here, not from the last speech
    t.clock.now += 9 * 60_000;
    await tick();
    expect(left()).toBe(false);
    expect(t.voice.current()).not.toBeNull();
    t.clock.now += 2 * 60_000;
    await until(() => t.voice.current() === null);

    const long = chatRig({ cfg: cfg() });
    long.music.playing = true;
    expect((await long.join()).ok).toBe(true);
    long.clock.now += 61 * 60_000;
    await until(() => long.voice.current() === null); // music does not extend the session past maxSessionMin
  });

  it('no file created under data/ or /tmp during a session', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'voice-p20-'));
    const old = process.env.TMPDIR;
    process.env.TMPDIR = tmp; // os.tmpdir() follows TMPDIR: anything the session put in "the temp dir" lands here
    cleanup.push(() => { process.env.TMPDIR = old; rmSync(tmp, { recursive: true, force: true }); });
    const data = resolve(process.cwd(), 'data');
    const before = tree(data);
    const tmpBefore = readdirSync('/tmp');
    const t = chatRig();
    const j = await t.join();
    expect(j.ok).toBe(true);
    utter(t.session()!);
    await until(() => t.session()!.overlays.length === 1);
    await t.chat.leave();
    expect(tree(tmp)).toEqual([]);
    const fresh = readdirSync('/tmp').filter((n) => !tmpBefore.includes(n));
    expect(fresh.filter((n) => /voice|tts|stt|utter|\.wav$|\.mp3$|\.pcm$/i.test(n))).toEqual([]);
    expect(tree(data)).toEqual(before);
  });

  it('invoker leaves → disconnect; idle timeout and max length disconnect', async () => {
    const t = chatRig({ cfg: new FakeConfig({ 'voice.idleMin': 10, 'voice.maxSessionMin': 60 }) });
    expect((await t.join()).ok).toBe(true);
    t.where.set('u1', null); // the invoker left the voice channel
    await until(() => t.voice.current() === null);
    expect(t.session()!.calls).toContain('leave');
    expect(t.chat.active()).toBe(false);

    const idle = chatRig({ cfg: new FakeConfig({ 'voice.idleMin': 10, 'voice.maxSessionMin': 60 }) });
    expect((await idle.join()).ok).toBe(true);
    idle.clock.now += 9 * 60_000;
    await flush(20);
    expect(idle.voice.current()).not.toBeNull();
    utter(idle.session()!); // activity resets the idle clock
    await until(() => idle.session()!.overlays.length === 1);
    idle.clock.now += 9 * 60_000;
    await flush(20);
    expect(idle.voice.current()).not.toBeNull();
    idle.clock.now += 2 * 60_000;
    await until(() => idle.voice.current() === null);

    const long = chatRig({ cfg: new FakeConfig({ 'voice.idleMin': 10, 'voice.maxSessionMin': 60 }) });
    expect((await long.join()).ok).toBe(true);
    for (let m = 0; m < 55; m += 5) { // 55 minutes, speaking every 5
      long.clock.now += 5 * 60_000;
      utter(long.session()!);
      await until(() => long.session()!.overlays.length === m / 5 + 1);
    }
    expect(long.voice.current()).not.toBeNull();
    long.clock.now += 6 * 60_000; // past 60 minutes although never idle
    await until(() => long.voice.current() === null);
  });

  it('join refused for a denied channel or when the invoker is not in that channel', async () => {
    const t = chatRig();
    t.where.set('u1', DENIED_VC);
    const denied = await t.join();
    expect(denied).toMatchObject({ ok: false });
    expect(!denied.ok && denied.text).toMatch(/off-limits|not available/i);
    t.where.set('u1', null);
    const away = await t.join();
    expect(!away.ok && away.text).toMatch(/join a voice channel/i);
    expect(t.sessions).toHaveLength(0); // nothing was ever connected
    // Praw is already in another channel (e.g. music): she never follows the invoker there
    t.where.set('u1', VC);
    expect((await t.join()).ok).toBe(true);
    t.where.set('u3', VC2);
    const other = await t.join('u3');
    expect(!other.ok && other.text).toMatch(/already in a voice channel/i);
    await t.chat.leave();
  });

  it('DAVE not negotiated → leaves', async () => {
    const t = chatRig({ session: () => new FakeVoiceSession({ failJoin: new DaveRequiredError() }) });
    const r = await t.join();
    expect(!r.ok && r.text).toMatch(/DAVE/);
    expect(t.session()!.calls).toContain('leave');
    expect(t.chat.active()).toBe(false);
    // E2EE lost mid-session: the session closes, the manager leaves, the pipeline stops
    const mid = chatRig();
    expect((await mid.join()).ok).toBe(true);
    mid.session()!.close('dave-downgraded');
    await until(() => !mid.chat.active());
    utter(mid.session()!);
    await flush(30);
    expect(mid.transcribed).toHaveLength(0);
  });
});

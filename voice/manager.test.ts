import { describe, expect, it, vi } from 'vitest';
import { EventBus, type AppEvents } from '../core/index.js';
import { FakeVoiceSession } from '../tests/fakes/voice.js';
import { VoiceJoinError, VoiceManager } from './manager.js';

const GUILD = '1565649426943442944';
const silent = { info() {}, warn() {}, error() {} };

function setup(o: { session?: FakeVoiceSession; check?: (id: string) => Promise<string | null>; isHalted?: () => boolean; unavailable?: () => string | null } = {}) {
  const sessions: FakeVoiceSession[] = [];
  const m = new VoiceManager({
    createSession: () => {
      const s = o.session ?? new FakeVoiceSession();
      sessions.push(s);
      return s;
    },
    checkChannel: o.check ?? (async () => null),
    log: silent,
    ...(o.isHalted ? { isHalted: o.isHalted } : {}),
    ...(o.unavailable ? { unavailable: o.unavailable } : {}),
  });
  return { m, sessions };
}

describe('manager', () => {
  it('second join while connected refused unless same channel', async () => {
    const { m, sessions } = setup();
    const s = await m.join('vc-1', GUILD);
    expect(m.current()).toEqual({ channelId: 'vc-1', session: s });
    expect(await m.join('vc-1', GUILD)).toBe(s); // same channel: no rejoin
    expect(sessions).toHaveLength(1);
    await expect(m.join('vc-2', GUILD)).rejects.toThrow(VoiceJoinError);
    await expect(m.join('vc-2', GUILD)).rejects.toThrow(/already in a voice channel/);
    expect(m.current()?.channelId).toBe('vc-1');
    await m.leave();
    expect(m.current()).toBeNull();
    expect((await m.join('vc-2', GUILD)).channelId).toBe('vc-2');
  });

  it('a join while another join is still connecting is refused', async () => {
    const { m } = setup();
    const first = m.join('vc-1', GUILD);
    await expect(m.join('vc-2', GUILD)).rejects.toThrow(/already/);
    await first;
  });

  it('halt event disconnects and clears queues within 2000 ms', async () => {
    vi.useFakeTimers();
    try {
      const hanging = new FakeVoiceSession({ hangLeave: true });
      const { m } = setup({ session: hanging });
      const bus = new EventBus<AppEvents>(silent);
      const off = m.leaveOnHalt(bus);
      await m.join('vc-1', GUILD);
      const cleared: string[] = [];
      m.onLeave(() => { cleared.push('music-queue'); });
      m.onLeave(async () => { cleared.push('children-killed'); });

      await bus.emit('halt.changed', { halted: false, by: 'x' }); // a resume is not a halt
      expect(m.current()).not.toBeNull();

      const t0 = Date.now();
      const done = bus.emit('halt.changed', { halted: true, by: 'owner' });
      await vi.advanceTimersByTimeAsync(2000);
      await done;
      expect(Date.now() - t0).toBeLessThanOrEqual(2000);
      expect(m.current()).toBeNull();
      expect(hanging.calls).toContain('leave');
      expect(cleared.sort()).toEqual(['children-killed', 'music-queue']);
      off();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a leave with nothing connected still clears queues', async () => {
    const { m } = setup();
    const cleared: string[] = [];
    m.onLeave(() => { cleared.push('q'); });
    await m.leave();
    expect(cleared).toEqual(['q']);
  });

  it('Connect/Speak problems are refused with the check message, before any session is created', async () => {
    const { m, sessions } = setup({ check: async (id) => `Praw cannot join <#${id}>: missing Connect, Speak` });
    await expect(m.join('vc-1', GUILD)).rejects.toThrow('Praw cannot join <#vc-1>: missing Connect, Speak');
    expect(sessions).toHaveLength(0);
  });

  it('a failed join (e.g. DAVE not negotiated) leaves nothing connected', async () => {
    const { m } = setup({ session: new FakeVoiceSession({ failJoin: new Error('DAVE end-to-end encryption was not negotiated') }) });
    await expect(m.join('vc-1', GUILD)).rejects.toThrow(/DAVE/);
    expect(m.current()).toBeNull();
  });

  it('a session closed by the library (kick, DAVE downgrade) clears current and runs the clearers', async () => {
    const session = new FakeVoiceSession();
    const { m } = setup({ session });
    const cleared: string[] = [];
    m.onLeave(() => { cleared.push('q'); });
    await m.join('vc-1', GUILD);
    session.close('dave-downgraded');
    await vi.waitFor(() => expect(cleared).toEqual(['q']));
    expect(m.current()).toBeNull();
  });

  it('halt during a join still connecting reaches the pending session; joins refused until resume', async () => {
    vi.useFakeTimers();
    try {
      const pending = new FakeVoiceSession({ hangJoin: true });
      const { m } = setup({ session: pending });
      const bus = new EventBus<AppEvents>(silent);
      m.leaveOnHalt(bus);
      const joining = m.join('vc-1', GUILD);
      const outcome = joining.then(() => 'joined', (e: Error) => e.message);
      await vi.advanceTimersByTimeAsync(0);
      const done = bus.emit('halt.changed', { halted: true, by: 'owner' });
      await vi.advanceTimersByTimeAsync(2000);
      await done;
      expect(pending.calls).toContain('leave');
      pending.releaseJoin(); // the library finishing the join after the halt
      expect(await outcome).toMatch(/halt|left/i);
      expect(m.current()).toBeNull();
      await expect(m.join('vc-1', GUILD)).rejects.toThrow(/halted/i);
      await bus.emit('halt.changed', { halted: false, by: 'owner' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('after a resume a join works again', async () => {
    const { m } = setup();
    const bus = new EventBus<AppEvents>(silent);
    m.leaveOnHalt(bus);
    await bus.emit('halt.changed', { halted: true, by: 'owner' });
    await expect(m.join('vc-1', GUILD)).rejects.toThrow(/halted/i);
    await bus.emit('halt.changed', { halted: false, by: 'owner' });
    expect((await m.join('vc-1', GUILD)).channelId).toBe('vc-1');
  });

  it('boot while halted: join refused (state comes from Halt, not only the bus)', async () => {
    const { m, sessions } = setup({ isHalted: () => true });
    await expect(m.join('vc-1', GUILD)).rejects.toThrow(/halted/i);
    expect(sessions).toHaveLength(0);
  });

  it('an out-of-band halt (config row set elsewhere) disconnects', async () => {
    const session = new FakeVoiceSession();
    const { m } = setup({ session });
    const bus = new EventBus<AppEvents>(silent);
    let watcher: (v: unknown) => void = () => {};
    m.leaveOnHalt(bus, (fn) => { watcher = fn; return () => {}; });
    await m.join('vc-1', GUILD);
    watcher(true);
    await vi.waitFor(() => expect(session.calls).toContain('leave'));
    expect(m.current()).toBeNull();
    await expect(m.join('vc-1', GUILD)).rejects.toThrow(/halted/i);
  });

  it('a hung clearer never blocks the disconnect: session left within 2000 ms', async () => {
    vi.useFakeTimers();
    try {
      const session = new FakeVoiceSession();
      const { m } = setup({ session });
      await m.join('vc-1', GUILD);
      m.onLeave(() => new Promise<void>(() => {})); // never settles
      const done = m.leave();
      await vi.advanceTimersByTimeAsync(0);
      expect(session.calls).toContain('leave');
      expect(session.channelId).toBeNull();
      await vi.advanceTimersByTimeAsync(2000);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  it('voice unavailable (ffmpeg missing, library failed to load) refuses joins with the reason', async () => {
    const { m, sessions } = setup({ unavailable: () => 'voice is disabled: ffmpeg missing or not runnable' });
    await expect(m.join('vc-1', GUILD)).rejects.toThrow(/ffmpeg missing/);
    expect(sessions).toHaveLength(0);
  });

  it('both halt signals (bus and config watch) await the same in-flight disconnect', async () => {
    const session = new FakeVoiceSession({ hangLeave: true });
    const { m } = setup({ session });
    const bus = new EventBus<AppEvents>(silent);
    let watcher: (v: unknown) => void = () => {};
    m.leaveOnHalt(bus, (fn) => { watcher = fn; return () => {}; });
    await m.join('vc-1', GUILD);
    const first = m.leave();
    const second = m.leave();
    expect(second).toBe(first);
    watcher(true); // a halt during the in-flight leave starts no second disconnect
    let busDone = false;
    const viaBus = bus.emit('halt.changed', { halted: true, by: 'owner' }).then(() => (busDone = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(busDone).toBe(false); // it waits for the same disconnect
    session.releaseLeave();
    await Promise.all([first, viaBus]);
    expect(session.calls.filter((c) => c === 'leave')).toHaveLength(1);
  });
});

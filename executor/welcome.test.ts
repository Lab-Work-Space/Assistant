import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { fakeServerWorld, fakeServerWriter, serverConsts, serverData, type ServerData } from '../discord/server/server-fixture.js';
import { C, R, U } from '../discord/test-helpers.js';
import { createWelcome, readWelcomeConfig, type WelcomeCfg } from './welcome.js';

const CFG: WelcomeCfg = { enabled: true, roleIds: [R.staff], message: 'Welcome {user}!', channelId: C.general, raidPerMinute: 10 };

/** An in-memory stand-in for ExecRepo; `shared` lets two handlers (a "restart") see the same database. */
function memExec(shared = { state: new Map<string, unknown>(), seen: new Set<string>(), out: [] as { kind: string; payload: Record<string, unknown> }[] }) {
  return {
    shared,
    exec: {
      getState: async (k: string) => shared.state.get(k) ?? null, setState: async (k: string, v: unknown) => void shared.state.set(k, v), clearState: async (k: string) => shared.state.delete(k),
      firstWelcome: async (u: string) => (shared.seen.has(u) ? false : (shared.seen.add(u), true)), push: async (kind: string, payload: Record<string, unknown>) => void shared.out.push({ kind, payload }),
    } as never,
  };
}

function rig(o: { cfg?: Partial<WelcomeCfg>; data?: ServerData; shared?: ReturnType<typeof memExec>['shared']; clock?: { t: number } } = {}) {
  const m = memExec(o.shared);
  const writer = fakeServerWriter();
  const audits: { action: string; tool?: string | null; outcome?: string | null }[] = [];
  const clock = o.clock ?? { t: 1_000_000 };
  const w = createWelcome({
    exec: m.exec, world: fakeServerWorld(o.data ?? serverData()), writer, consts: () => serverConsts(), cfg: async () => ({ ...CFG, ...o.cfg }),
    audit: async (e) => void audits.push(e), now: () => clock.t, log: { error() {} },
  });
  return { w, writer, audits, out: m.shared.out, state: m.shared.state, shared: m.shared, clock };
}
const human = (n: number) => ({ id: `80000000000000${String(n).padStart(4, '0')}`, isBot: false });

describe('welcome flow (S11, S12, S13)', () => {
  it('a joining human gets the default roles (audited) and one queued welcome post', async () => {
    const x = rig();
    await x.w.onJoin(human(1));
    expect(x.writer.calls).toEqual([`addrole ${human(1).id} ${R.staff}`]);
    expect(x.audits).toEqual([{ actor: 'system:executor', action: 'welcome.role', tool: `${human(1).id}:${R.staff}`, outcome: 'ok' }]);
    expect(x.out).toEqual([{ kind: 'welcome.post', payload: { userId: human(1).id } }]);
  });
  it('a bot join is ignored: no role, no post', async () => {
    const x = rig();
    await x.w.onJoin({ id: '800000000000009999', isBot: true });
    expect(x.writer.calls).toEqual([]);
    expect(x.out).toEqual([]);
  });
  it('disabled: nothing happens; a rejoin within 24 h is welcomed once', async () => {
    const off = rig({ cfg: { enabled: false } });
    await off.w.onJoin(human(1));
    expect(off.out).toEqual([]);
    const x = rig();
    await x.w.onJoin(human(2));
    await x.w.onJoin(human(2));
    expect(x.out.filter((o) => o.kind === 'welcome.post')).toHaveLength(1);
    expect(x.writer.calls).toHaveLength(1);
  });
  it('S12: a default role edited after config to carry Manage Messages is NOT assigned; auto-roles pause, an alert is queued and the refusal audited', async () => {
    const d = serverData();
    d.roles.find((r) => r.id === R.staff)!.permissions |= PermissionFlagsBits.ManageMessages;
    const x = rig({ data: d });
    await x.w.onJoin(human(3));
    expect(x.writer.calls).toEqual([]);
    expect(x.state.get('welcome.paused')).toMatchObject({ reason: 'role' });
    expect(x.out.map((o) => o.kind)).toEqual(['alert']);
    expect(x.audits[0]).toMatchObject({ action: 'welcome.role', outcome: expect.stringContaining('refused') });
    await x.w.onJoin(human(4)); // paused: still nothing
    expect(x.writer.calls).toEqual([]);
  });
  it('S12: other bad roles (above the executor, privileged, held by a bot) are refused the same way', async () => {
    for (const role of [R.high, R.mod, R.botRole, R.managedOther]) {
      const x = rig({ cfg: { roleIds: [role] } });
      await x.w.onJoin(human(5));
      expect(x.writer.calls, role).toEqual([]);
      expect(x.state.has('welcome.paused')).toBe(true);
    }
  });
  it('S13: more joins than the limit in a sliding minute (bots count) pause roles and posts with one alert; the pause survives a restart; a quiet minute does not resume it', async () => {
    const x = rig({ cfg: { raidPerMinute: 3 } });
    for (let i = 0; i < 3; i++) await x.w.onJoin(human(10 + i));
    expect(x.out.filter((o) => o.kind === 'welcome.post')).toHaveLength(3);
    await x.w.onJoin({ id: '800000000000008888', isBot: true }); // the fourth join in the window: a bot, still counted
    expect(x.out.filter((o) => o.kind === 'alert')).toHaveLength(1);
    expect(x.state.get('welcome.paused')).toMatchObject({ reason: 'raid' });
    const writes = x.writer.calls.length;
    const restarted = rig({ cfg: { raidPerMinute: 3 }, shared: x.shared, clock: { t: x.clock.t + 10 * 60_000 } });
    await restarted.w.onJoin(human(20));
    await restarted.w.onJoin(human(21));
    expect(restarted.writer.calls).toEqual([]);
    expect(x.writer.calls).toHaveLength(writes);
    expect(x.out.filter((o) => o.kind === 'alert')).toHaveLength(1); // one alert, not one per join
    x.shared.state.delete('welcome.paused'); // what a confirmed welcome.resume card does
    await restarted.w.onJoin(human(22));
    expect(restarted.writer.calls).toHaveLength(1);
  });
  it('the window slides: joins older than a minute do not count', async () => {
    const x = rig({ cfg: { raidPerMinute: 3 } });
    for (let i = 0; i < 6; i++) {
      await x.w.onJoin(human(30 + i));
      x.clock.t += 30_000;
    }
    expect(x.state.has('welcome.paused')).toBe(false);
    expect(x.out.filter((o) => o.kind === 'welcome.post')).toHaveLength(6);
  });
  it('a failing role add is audited and does not stop the post', async () => {
    const x = rig();
    x.writer.addRole = async () => { throw Object.assign(new Error('Missing Permissions secret'), { code: 50013 }); };
    await x.w.onJoin(human(40));
    expect(x.audits[0]!.outcome).toBe('failed Discord error 50013');
    expect(x.out.some((o) => o.kind === 'welcome.post')).toBe(true);
  });
});

describe('readWelcomeConfig', () => {
  it('reads the keys from the config table; a missing or invalid value falls back to its default', async () => {
    const rows = [{ key: 'welcome.enabled', value: true }, { key: 'welcome.message', value: 'hi @everyone' }, { key: 'welcome.raidPerMinute', value: 99 }, { key: 'welcome.roleIds', value: [R.staff] }];
    const pool = { query: async () => ({ rows }) } as never;
    expect(await readWelcomeConfig(pool)).toEqual({ enabled: true, roleIds: [R.staff], message: '', channelId: null, raidPerMinute: 10 });
    void U;
  });
});

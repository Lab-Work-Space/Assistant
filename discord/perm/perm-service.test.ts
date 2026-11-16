import { describe, expect, it, vi } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import { fakeClient, fakeGuild } from '../../tests/fakes/discordClient.js';
import { ClientManager } from '../clients.js';
import { PermService } from './perm-service.js';
import { C, F, R, U, consts, fakeWorld, fakeWriter, worldData } from '../test-helpers.js';

const WHO = { userId: '900000000000000001', cardId: 'c'.repeat(32) };

function rig(o: { failAt?: number; recheck?: () => Promise<{ dept: string; warnings: string[] }[]>; data?: ReturnType<typeof worldData> } = {}) {
  const world = fakeWorld(o.data ?? worldData());
  const writer = fakeWriter(o.failAt);
  const audits: { actor: string; action: string; tool: string; outcome: string }[] = [];
  const alerts: [string, string[]][] = [];
  const svc = new PermService({
    world, writer, consts: () => consts(), recheck: o.recheck ?? (async () => []), alert: async (d, w) => void alerts.push([d, w]),
    audit: async (e) => void audits.push(e as never), log: { error() {} },
  });
  return { svc, world, writer, audits, alerts };
}
const assign = (member: string, role: string) => ({ kind: 'role.assign', member, role });

describe('PermService propose', () => {
  it('returns card lines flagged as risky, the stored ops and a per-target snapshot, and writes nothing', async () => {
    const x = rig();
    const r = await x.svc.propose([assign(U.alice, R.staff)]);
    expect(r).toMatchObject({ ok: true, payload: { ops: [assign(U.alice, R.staff)] }, snapshot: { snaps: [{ held: false }] } });
    if (r.ok) expect(r.items[0]).toMatchObject({ label: 'Assign role', risk: true });
    expect(x.writer.calls).toEqual([]);
  });

  it('a malformed op is refused with the schema message', async () => {
    const x = rig();
    const r = await x.svc.propose([{ kind: 'role.assign', member: 'not-an-id', role: R.staff }]);
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('invalid operations') });
  });
});

describe('card content (Gate 1 C8)', () => {
  it('a role named "Bot Admin" with another id carries its own real id, not the real Bot Admin\'s', async () => {
    const data = worldData();
    const fake = '700000000000000555';
    data.roles.push({ id: fake, name: 'Bot Admin', position: 1, managed: false, botId: null, permissions: 0n });
    const x = rig({ data });
    const r = await x.svc.propose([assign(U.alice, fake)]);
    if (!r.ok) throw new Error(r.error);
    expect(r.items[0]!.refs).toEqual([{ kind: 'user', id: U.alice }, { kind: 'role', id: fake }]);
    expect(r.items[0]!.refs!.some((x) => x.id === R.botAdmin)).toBe(false);
  });
});

describe('PermService apply (Gate 1 C7, C14, C21)', () => {
  const propose = async (x: ReturnType<typeof rig>, ops: unknown[]) => {
    const r = await x.svc.propose(ops);
    if (!r.ok) throw new Error(r.error);
    return r;
  };

  it('G2SP-02: the audit names the front end the card was applied from', async () => {
    for (const via of ['panel', 'dashboard'] as const) {
      const x = rig({});
      const p = await propose(x, [assign(U.alice, R.staff)]);
      await x.svc.apply(p.payload, p.snapshot, { ...WHO, via });
      expect(x.audits.map((a) => a.actor)).toEqual([`user:${WHO.userId} via ${via}`]);
    }
  });

  it('re-validates, executes through the writer, audits every op as "user:<id> via praw" and re-checks all bots after', async () => {
    const recheck = vi.fn(async () => []);
    const x = rig({ recheck });
    const p = await propose(x, [assign(U.alice, R.staff), { kind: 'overwrite.set', channel: C.general, target: { type: 'role', id: R.extra }, allow: String(F.ViewChannel), deny: '0' }]);
    const r = await x.svc.apply(p.payload, p.snapshot, WHO);
    expect(r).toMatchObject({ kind: 'done', ok: true, applied: 2, total: 2 });
    expect(x.writer.calls).toEqual([`assign ${U.alice} ${R.staff}`, `set ${C.general} role:${R.extra} ${F.ViewChannel}/0`]);
    expect(x.audits.map((a) => [a.actor, a.action])).toEqual([[`user:${WHO.userId} via praw`, 'perm.role.assign'], [`user:${WHO.userId} via praw`, 'perm.overwrite.set']]);
    expect(x.audits[0]!.outcome).toBe(`ok card:${WHO.cardId} old=does not hold "Staff" new=holds "Staff"`);
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  it('stops at the first failure, says which ops ran, never shows the Discord error text, and still re-checks', async () => {
    const recheck = vi.fn(async () => []);
    const x = rig({ failAt: 1, recheck });
    const p = await propose(x, [assign(U.alice, R.staff), assign(U.alice, R.extra), assign(U.bob, R.extra)]);
    const r = await x.svc.apply(p.payload, p.snapshot, WHO);
    expect(r).toMatchObject({ kind: 'done', ok: false, applied: 1, total: 3 });
    expect(x.writer.calls).toHaveLength(2); // the third was never attempted
    if (r.kind === 'done') {
      expect(r.lines.join('\n')).toContain('Discord error 50013');
      expect(r.lines.join('\n')).toContain('1 operation(s) were not run');
      expect(r.lines.join('\n')).not.toContain('secret text');
    }
    expect(x.audits.map((a) => a.outcome.split(' old=')[0])).toEqual([`ok card:${WHO.cardId}`, `failed Discord error 50013 card:${WHO.cardId}`]);
    expect(x.audits.every((a) => a.outcome.includes(' old=') && a.outcome.includes(' new='))).toBe(true);
    expect(recheck).toHaveBeenCalledTimes(1);
  });

  it('every hard limit is enforced again at apply: a state change after the proposal refuses the whole card and nothing is written', async () => {
    const cases: [string, (d: ReturnType<typeof worldData>) => void, unknown[], RegExp][] = [
      ['the member now holds Bot Admin', (d) => d.members.get(U.alice)!.roleIds.push(R.botAdmin), [assign(U.alice, R.staff)], /privileged/],
      ['the member became a bot', (d) => { d.members.get(U.alice)!.isBot = true; }, [assign(U.alice, R.staff)], /bot/],
      ['the role moved above Praw', (d) => { d.roles.find((r) => r.id === R.staff)!.position = 99; }, [assign(U.alice, R.staff)], /at or above/],
      ['the role got dangerous powers', (d) => { d.roles.find((r) => r.id === R.staff)!.permissions |= F.BanMembers; }, [assign(U.alice, R.staff)], /beyond the safe set/],
      ['a bot now holds the role', (d) => d.members.get(U.botHq)!.roleIds.push(R.staff), [assign(U.alice, R.staff)], /held by a bot/],
      ['the channel moved into a protected category', (d) => { d.channels.get(C.general)!.parentId = C.deniedCat; }, [{ kind: 'overwrite.set', channel: C.general, target: { type: 'role', id: R.extra }, allow: String(F.ViewChannel), deny: '0' }], /protected category/],
      ['the channel became unreadable', (d) => { d.channels.delete(C.general); }, [{ kind: 'overwrite.set', channel: C.general, target: { type: 'role', id: R.extra }, allow: String(F.ViewChannel), deny: '0' }], /could not be read/],
    ];
    for (const [name, mutate, ops, why] of cases) {
      const data = worldData();
      const x = rig({ data });
      const p = await propose(x, ops);
      mutate(data);
      const r = await x.svc.apply(p.payload, p.snapshot, WHO);
      expect(r, name).toMatchObject({ kind: 'refused', why: expect.stringMatching(why) });
      expect(x.writer.calls, name).toEqual([]);
    }
  });

  it('the stale check: the target\'s live state differs from the proposal-time snapshot', async () => {
    const data = worldData();
    const x = rig({ data });
    const p = await propose(x, [{ kind: 'overwrite.set', channel: C.general, target: { type: 'role', id: R.staff }, allow: String(F.ViewChannel | F.SendMessages), deny: '0' }]);
    data.channels.get(C.general)!.overwrites = [{ id: R.staff, type: 'role', allow: F.ViewChannel | F.AddReactions, deny: 0n }]; // an admin edited it by hand
    expect(await x.svc.apply(p.payload, p.snapshot, WHO)).toMatchObject({ kind: 'refused', why: expect.stringContaining('changed since the proposal') });
    expect(x.writer.calls).toEqual([]);
  });

  it('refuses when the hierarchy or the constants went bad after the proposal (C20 before each apply)', async () => {
    const data = worldData();
    const x = rig({ data });
    const p = await propose(x, [assign(U.alice, R.staff)]);
    data.roles.find((r) => r.id === R.botAdmin)!.position = 5;
    expect(await x.svc.apply(p.payload, p.snapshot, WHO)).toMatchObject({ kind: 'refused', why: expect.stringMatching(/strictly below/) });
    expect(x.writer.calls).toEqual([]);
  });

  it('a bot that becomes unsafe after the apply is reported, with an alert', async () => {
    const x = rig({ recheck: async () => [{ dept: 'software', warnings: ['software: bot has guild-wide Manage Guild'] }] });
    const p = await propose(x, [assign(U.alice, R.staff)]);
    const r = await x.svc.apply(p.payload, p.snapshot, WHO);
    expect(r.kind === 'done' && r.lines.join('\n')).toContain('the software bot was turned off');
    expect(x.alerts).toEqual([['software', ['software: bot has guild-wide Manage Guild']]]);
  });
});

describe('live re-check after apply with the real ClientManager (Gate 1 C21)', () => {
  it('a forced unsafe state disables that bot, and it stays offline: no reconnect, nothing re-created', async () => {
    vi.useFakeTimers();
    try {
      const logins: string[] = [];
      const mk = (userId: string, g: ReturnType<typeof fakeGuild>) => {
        const c = fakeClient({ userId, guild: g });
        const login = c.login.bind(c);
        c.login = async (t) => (logins.push(userId), login(t));
        return c;
      };
      const sw = mk('sw', fakeGuild());
      const hq = mk('hq', fakeGuild());
      const cm = new ClientManager({ guildId: '1565649426943442944', createClient: (d) => (d === 'software' ? sw : hq) });
      const start = cm.start({ hq: 'a', software: 'b' }, () => {}, () => {});
      await vi.advanceTimersByTimeAsync(10);
      await start;
      expect(cm.online().sort()).toEqual(['hq', 'software']);
      // Somebody grants the software bot Manage Guild (through the apply): the next fresh read sees it.
      const guild = sw.guilds.cache.get('1565649426943442944') as unknown as { members: { fetchMe: () => Promise<unknown> } };
      guild.members.fetchMe = async () => ({ id: 'sw', permissions: new (await import('discord.js')).PermissionsBitField([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageGuild]) });
      const x = rig({ recheck: () => cm.recheck() });
      const p = await x.svc.propose([assign(U.alice, R.staff)]);
      if (!p.ok) throw new Error(p.error);
      const r = await x.svc.apply(p.payload, p.snapshot, WHO);
      expect(r.kind === 'done' && r.lines.join('\n')).toMatch(/software bot was turned off/);
      expect(cm.client('software')).toBeUndefined();
      expect(sw.destroyed).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(cm.client('software')).toBeUndefined();
      expect(cm.online()).toEqual(['hq']);
      expect(logins.filter((l) => l === 'sw')).toHaveLength(1); // never logged in again
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('discord_read (Gate 1 C10)', () => {
  it('lists roles with the protected flag and channels with overwrite summaries, and never a denied channel, category or child', async () => {
    const data = worldData();
    data.channels.set('1565715069969502310', { id: '1565715069969502310', name: 'system-credentials', type: 0, parentId: C.deniedCat, isThread: false, overwrites: [] });
    data.channels.set('1565649677280485457', { id: '1565649677280485457', name: 'moderator-only', type: 0, parentId: null, isThread: false, overwrites: [] });
    data.channels.set(C.deniedCat, { id: C.deniedCat, name: 'Secret', type: 4, parentId: null, isThread: false, overwrites: [] });
    const x = rig({ data });
    const ch = await x.svc.read('channels');
    expect(ch.ok).toBe(true);
    const text = ch.ok ? ch.text : '';
    for (const denied of ['1565715069969502310', '1565649677280485457', C.deniedCat, C.inDeniedCat]) expect(text).not.toContain(denied);
    expect(text).toContain(C.general);
    expect(JSON.parse(text).find((c: { id: string }) => c.id === C.general).overwrites[0]).toEqual({ target: `role:${R.staff}`, allow: ['ViewChannel'], deny: [] });
    const roles = await x.svc.read('roles');
    const parsed = roles.ok ? (JSON.parse(roles.text) as { id: string; protected: boolean; name: string }[]) : [];
    expect(parsed.find((r) => r.id === R.founder)!.protected).toBe(true);
    expect(parsed.find((r) => r.id === R.staff)!.protected).toBe(false);
    expect(parsed.find((r) => r.id === R.high)!.protected).toBe(true);
  });

  it('control and bidi characters in a name are replaced', async () => {
    const data = worldData();
    data.roles.push({ id: R.extra + '9', name: 'Bot‮ Admin\u0007', position: 1, managed: false, botId: null, permissions: 0n });
    const x = rig({ data });
    const roles = await x.svc.read('roles');
    expect(roles.ok && roles.text).not.toContain('‮');
    expect(roles.ok && roles.text).toContain('Bot? Admin?');
  });
});

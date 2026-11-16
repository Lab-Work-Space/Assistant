import { PermissionFlagsBits, PermissionsBitField, type Client, type Guild } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { fakeClient, fakeGuild } from '../../tests/fakes/discordClient.js';
import { ClientManager } from '../clients.js';
import { ADMIN_EXTRA_BITS, HARD_FORBIDDEN_NAMES, labelOf, REVIEWED_DEFAULT_BITS, SAFE_BITS } from './perm-bits.js';
import { checkGuildPermissions, PRAW_EXTRA_PERMISSIONS, REQUIRED_CHANNEL_PERMISSIONS, voiceChannelPermissionError } from './permissions.js';

const unknownChannel = () => Object.assign(new Error('Unknown Channel'), { code: 10003 });
const check = (g: ReturnType<typeof fakeGuild>, channelFetch?: (id: string) => Promise<unknown>) =>
  checkGuildPermissions(fakeClient({ userId: 'me', guild: g, ...(channelFetch ? { channelFetch } : {}) }) as Client, 'software', g as unknown as Guild);

describe('checkGuildPermissions', () => {
  it('no warnings for a least-privilege bot', async () => {
    expect(await check(fakeGuild())).toEqual([]);
  });

  it('warns when Administrator granted', async () => {
    const w = await check(fakeGuild({ guildWide: [PermissionFlagsBits.Administrator] }));
    expect(w.some((s) => /administrator/i.test(s))).toBe(true);
  });

  it('warns when denied channel viewable', async () => {
    const w = await check(fakeGuild({ viewable: ['1565715069969502310'] }));
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('1565715069969502310');
  });

  it('warns on guild-wide Manage Webhooks', async () => {
    const w = await check(fakeGuild({ guildWide: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageWebhooks] }));
    expect(w.some((s) => /manage webhooks/i.test(s))).toBe(true);
  });

  it('warns when the bot member is not cached (fail closed)', async () => {
    expect(await check(fakeGuild({ noMe: true }))).toHaveLength(1);
  });

  it('warns (fail closed) when a denied channel is missing from the cache and the fetch does not say Unknown Channel', async () => {
    const id = '1565715069969502310';
    for (const fetch of [async () => { throw new Error('socket hang up'); }, async () => ({ id })]) {
      const w = await check(fakeGuild({ missing: [id] }), fetch);
      expect(w).toHaveLength(1);
      expect(w[0]).toContain(id);
    }
  });

  it('accepts a missing denied channel when the bot cannot see it (50001, 50013)', async () => {
    for (const code of [50001, 50013]) {
      expect(await check(fakeGuild({ missing: ['1565715069969502310'] }), async () => { throw Object.assign(new Error('denied'), { code }); })).toEqual([]);
    }
  });

  it('accepts a missing denied channel when the fetch confirms Unknown Channel (10003)', async () => {
    const fetched: string[] = [];
    const w = await check(fakeGuild({ missing: ['1565715069969502310'] }), async (id) => { fetched.push(id); throw unknownChannel(); });
    expect(w).toEqual([]);
    expect(fetched).toEqual(['1565715069969502310']);
  });

  it('documents per-channel permissions without Attach Files', () => {
    const names = REQUIRED_CHANNEL_PERMISSIONS.map((p) => p.name);
    expect(names).toContain('ManageWebhooks');
    expect(names).not.toContain('AttachFiles');
    expect(names).not.toContain('Administrator');
  });

  it('dept with denied-channel view is disabled', async () => {
    const sw = fakeClient({ userId: 'sw', guild: fakeGuild({ viewable: ['1565649677280485457'] }) });
    const hq = fakeClient({ userId: 'hq', guild: fakeGuild() });
    const cm = new ClientManager({ guildId: '1565649426943442944', createClient: (d) => (d === 'software' ? sw : hq) });
    const r = await cm.start({ hq: 't1', software: 't2' }, () => {}, () => {});
    expect(r.online).toEqual(['hq']);
    expect(r.disabled).toEqual([{ dept: 'software', warnings: [expect.stringContaining('1565649677280485457')] }]);
    expect(sw.destroyed).toBe(true);
    expect(cm.client('software')).toBeUndefined();
    expect([...cm.botUserIds()]).toEqual([['hq', 'hq']]);
    sw.fire('messageCreate', { id: 'x', guildId: '1565649426943442944' });
    expect(sw.listenerCount('messageCreate')).toBe(0);
  });
});

describe('praw permissions (P17)', () => {
  it('praw guild-wide Manage Messages flagged; praw client holds no Administrator', async () => {
    const praw = (g: ReturnType<typeof fakeGuild>) =>
      checkGuildPermissions(fakeClient({ userId: 'me', guild: g }) as Client, 'praw', g as unknown as Guild);
    expect((await praw(fakeGuild({ guildWide: [PermissionFlagsBits.Administrator] }))).some((s) => /administrator/i.test(s))).toBe(true);
    expect((await praw(fakeGuild({ guildWide: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageMessages] }))).some((s) => /manage messages/i.test(s))).toBe(true);
    expect(await praw(fakeGuild())).toEqual([]);
    // C19: every other department is flagged for it too (it used to pass; the check is now an allowlist for all bots)
    const sw = fakeGuild({ guildWide: [PermissionFlagsBits.ManageMessages] });
    expect((await checkGuildPermissions(fakeClient({ userId: 'me', guild: sw }) as Client, 'software', sw as unknown as Guild)).some((s) => /manage messages/i.test(s))).toBe(true);
  });

  it('TEAMTALK T13: heads pin the room board with Pin Messages (1<<51) as a channel overwrite; Manage Messages stays forbidden everywhere', async () => {
    expect(SAFE_BITS).toContain(PermissionFlagsBits.PinMessages);
    expect(SAFE_BITS).not.toContain(PermissionFlagsBits.ManageMessages);
    expect(HARD_FORBIDDEN_NAMES).toContain('ManageMessages');
    // no guild-wide grant of either is needed for the board: a plain head with no extra guild-wide bit passes, a guild-wide Manage Messages is flagged
    const plain = fakeGuild();
    expect(await checkGuildPermissions(fakeClient({ userId: 'me', guild: plain }) as Client, 'software', plain as unknown as Guild)).toEqual([]);
    const wide = fakeGuild({ guildWide: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageMessages] });
    expect((await checkGuildPermissions(fakeClient({ userId: 'me', guild: wide }) as Client, 'software', wide as unknown as Guild)).some((x) => /manage messages/i.test(x))).toBe(true);
  });

  it('PRAW_EXTRA_PERMISSIONS are per-channel grants, never Administrator and not required now', () => {
    // T20 Step 0: Discord's dedicated Pin Messages permission (1 << 51) covers pin/unpin; Manage Messages is not needed.
    expect(PRAW_EXTRA_PERMISSIONS.map((p) => p.name)).toEqual(['PinMessages', 'AttachFiles', 'Connect', 'Speak']);
    expect(PermissionFlagsBits.PinMessages).toBe(1n << 51n);
    expect(PRAW_EXTRA_PERMISSIONS.map((p) => p.name)).not.toContain('Administrator');
    const required = REQUIRED_CHANNEL_PERMISSIONS.map((p) => p.name) as string[];
    for (const p of PRAW_EXTRA_PERMISSIONS) expect(required).not.toContain(p.name);
  });
});

describe('voice permissions (P17)', () => {
  const vc = (granted: bigint[]) => ({ id: 'vc-1', permissionsFor: () => new PermissionsBitField(granted) });
  const me = { id: 'me' };

  it('Connect and Speak checked per target channel, clear error when missing', () => {
    const { ViewChannel, Connect, Speak } = PermissionFlagsBits;
    expect(voiceChannelPermissionError(vc([ViewChannel, Connect, Speak]), me)).toBeNull();
    expect(voiceChannelPermissionError(vc([ViewChannel]), me)).toBe(
      'Praw cannot join <#vc-1>: missing Connect, Speak. Grant them on this voice channel or its category (never guild-wide).',
    );
    expect(voiceChannelPermissionError(vc([ViewChannel, Connect]), me)).toMatch(/missing Speak\./);
    expect(voiceChannelPermissionError(vc([]), me)).toMatch(/missing View Channel, Connect, Speak/);
    expect(voiceChannelPermissionError({ id: 'vc-2', permissionsFor: () => null }, me)).toMatch(/<#vc-2>: missing View Channel, Connect, Speak/);
  });
});

describe('C19: guild-wide bits are an allowlist', () => {
  const F = PermissionFlagsBits;
  const warn = (dept: 'software' | 'praw' | 'admin', bits: bigint[]) => {
    const g = fakeGuild({ guildWide: bits });
    return checkGuildPermissions(fakeClient({ userId: 'me', guild: g }) as Client, dept, g as unknown as Guild);
  };

  it('a healthy bot (safe bits plus the reviewed @everyone defaults) passes', async () => {
    expect(await warn('software', [...SAFE_BITS, ...REVIEWED_DEFAULT_BITS])).toEqual([]);
  });

  it('every hard-forbidden bit disables any bot and is named', async () => {
    for (const name of HARD_FORBIDDEN_NAMES) {
      const w = await warn('software', [F.ViewChannel, F[name]]);
      expect(w, name).toHaveLength(1);
      expect(w[0]).toContain(labelOf(name));
    }
  });

  it('a non-praw bot with Manage Roles or Manage Channels is disabled', async () => {
    expect((await warn('software', [F.ManageRoles]))[0]).toMatch(/Manage Roles/);
    expect((await warn('software', [F.ManageChannels]))[0]).toMatch(/Manage Channels/);
  });

  it('S4: Praw holding Manage Roles or Manage Channels is flagged again (the phase-1 exception is reverted)', async () => {
    expect((await warn('praw', [F.ViewChannel, F.ManageRoles]))[0]).toMatch(/Manage Roles/);
    expect((await warn('praw', [F.ViewChannel, F.ManageChannels]))[0]).toMatch(/Manage Channels/);
    expect(await warn('praw', [F.ViewChannel])).toEqual([]);
  });

  it('S4: the executor may hold exactly the spec list; one extra bit (Administrator, Manage Webhooks, Mention Everyone) disables it', async () => {
    expect(await warn('admin', [...ADMIN_EXTRA_BITS, F.SendMessages])).toEqual([]);
    for (const b of [F.Administrator, F.ManageWebhooks, F.MentionEveryone]) expect((await warn('admin', [...ADMIN_EXTRA_BITS, b])).length, String(b)).toBe(1);
  });

  it('S4: the executor able to view a DENIED channel is disabled', async () => {
    const g = fakeGuild({ viewable: ['1565715069969502310'] });
    const w = await checkGuildPermissions(fakeClient({ userId: 'me', guild: g }) as Client, 'admin', g as unknown as Guild);
    expect(w.join(' ')).toContain('1565715069969502310');
  });

  it('an unnamed future bit is refused', async () => {
    const w = await warn('software', [1n << 60n]);
    expect(w[0]).toContain('unknown(1<<60)');
  });

  it('the live re-check reads fresh data and disables an unsafe bot for good', async () => {
    const good = fakeGuild();
    const bad = fakeGuild({ guildWide: [F.ViewChannel, F.ManageGuild] });
    const clients = { hq: fakeClient({ userId: 'hq', guild: good }), software: fakeClient({ userId: 'sw', guild: fakeGuild() }) };
    const cm = new ClientManager({ guildId: '1565649426943442944', createClient: (d) => clients[d as 'hq' | 'software'] });
    await cm.start({ hq: 'a', software: 'b' }, () => {}, () => {});
    // permissions change after boot
    (clients.software.guilds.cache.get('1565649426943442944') as unknown as { members: { me: unknown; fetchMe: () => Promise<unknown> } }).members.fetchMe = async () => bad.members.me;
    const out = await cm.recheck();
    expect(out.map((x) => x.dept)).toEqual(['software']);
    expect(clients.software.destroyed).toBe(true);
    expect(cm.client('software')).toBeUndefined();
    expect(cm.isBarred('software')).toBe(true);
    expect(cm.online()).toEqual(['hq']);
    expect(await cm.recheck()).toEqual([]);
    // G2A-09: a later start() in this process does not bring it back
    const again = await cm.start({ software: 'b' }, () => {}, () => {});
    expect(again.disabled.map((d) => d.dept)).toEqual(['software']);
    expect(again.online).toEqual([]);
    expect(cm.client('software')).toBeUndefined();
  });

  it('the fresh check reads denied channels with force: true, not from the gateway cache (Gate 1 C21)', async () => {
    const seen: unknown[] = [];
    const g = fakeGuild();
    const client = fakeClient({ userId: 'me', guild: g, channelFetch: async (_id, opts) => { seen.push(opts); throw unknownChannel(); } }) as Client;
    expect(await checkGuildPermissions(client, 'software', g as unknown as Guild, { fresh: true })).toEqual([]);
    expect(seen).toEqual([{ force: true }, { force: true }]);
    // a channel that is viewable on the fresh read disables the bot even when the cache says it is hidden
    const viewable = { id: '1565715069969502310', permissionsFor: () => new PermissionsBitField([PermissionFlagsBits.ViewChannel]) };
    const c2 = fakeClient({ userId: 'me', guild: g, channelFetch: async () => viewable }) as Client;
    expect((await checkGuildPermissions(c2, 'software', g as unknown as Guild, { fresh: true }))[0]).toContain('can view denied channel');
  });

  it('a failing re-read fails closed', async () => {
    const clients = { hq: fakeClient({ userId: 'hq', guild: fakeGuild() }) };
    const cm = new ClientManager({ guildId: '1565649426943442944', createClient: () => clients.hq });
    await cm.start({ hq: 'a' }, () => {}, () => {});
    (clients.hq.guilds.cache.get('1565649426943442944') as unknown as { roles: { fetch: () => Promise<never> } }).roles.fetch = async () => { throw new Error('boom'); };
    expect((await cm.recheck()).map((x) => x.dept)).toEqual(['hq']);
  });
});

describe('the live server (owner dump 2026-11-01) is accepted exactly', () => {
  const LIVE_EVERYONE = 2222085119527488n;
  const ok = (dept: 'software' | 'praw' | 'admin', bits: bigint) => {
    const g = fakeGuild({ guildWide: [bits] });
    return checkGuildPermissions(fakeClient({ userId: 'me', guild: g }) as Client, dept, g as unknown as Guild);
  };
  it('@everyone as it is, the bot managed roles and an empty role pass for every bot', async () => {
    for (const bits of [LIVE_EVERYONE, LIVE_EVERYONE | 309237730304n, LIVE_EVERYONE | 311385213952n, 0n]) expect(await ok('software', bits)).toEqual([]);
  });
  it('only the executor may add the management bits; praw and the others may not', async () => {
    const F = PermissionFlagsBits;
    expect(await ok('admin', LIVE_EVERYONE | F.ManageRoles | F.ManageChannels | F.BanMembers)).toEqual([]);
    for (const d of ['software', 'praw'] as const) expect((await ok(d, LIVE_EVERYONE | F.ManageRoles)).length).toBe(1);
    for (const b of [F.MentionEveryone, F.Administrator, F.ManageWebhooks]) expect((await ok('admin', LIVE_EVERYONE | F.ManageRoles | b)).length).toBe(1);
  });
});

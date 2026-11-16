import { GatewayIntentBits, Partials, PermissionFlagsBits, type ClientOptions, type Message } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { fakeClient, fakeGuild } from '../tests/fakes/discordClient.js';
import { CLIENT_OPTIONS, ClientManager, clientOptionsFor, INTENTS } from './clients.js';

const GUILD = '1565649426943442944';

describe('ClientManager', () => {
  it('uses only Guilds, GuildMessages and MessageContent intents', () => {
    expect([...INTENTS].sort()).toEqual([GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent].sort());
  });

  it('only praw client has GuildVoiceStates (P17); never in the shared INTENTS', async () => {
    expect(INTENTS).not.toContain(GatewayIntentBits.GuildVoiceStates);
    expect(CLIENT_OPTIONS.intents).not.toContain(GatewayIntentBits.GuildVoiceStates);
    const seen = new Map<string, ClientOptions>();
    const cm = new ClientManager({ guildId: GUILD, createClient: (d, opts) => (seen.set(d, opts), fakeClient({ userId: d, guild: fakeGuild() })) });
    await cm.start({ hq: 'a', praw: 'b', software: 'c' }, () => {}, () => {});
    expect([...(seen.get('praw')!.intents as GatewayIntentBits[])].sort()).toEqual([...INTENTS, GatewayIntentBits.GuildVoiceStates].sort());
    for (const d of ['hq', 'software']) expect([...(seen.get(d)!.intents as GatewayIntentBits[])].sort()).toEqual([...INTENTS].sort());
    expect(seen.get('praw')!.allowedMentions).toEqual({ parse: [] });
  });

  it('one failing login does not reject others', async () => {
    const clients = { hq: fakeClient({ userId: 'hq', guild: fakeGuild() }), it: fakeClient({ userId: 'it', failLogin: true }) };
    const cm = new ClientManager({ guildId: GUILD, createClient: (d) => clients[d as 'hq' | 'it'] });
    const r = await cm.start({ hq: 'a', it: 'b' }, () => {}, () => {});
    expect(r.online).toEqual(['hq']);
    expect(r.failed).toEqual([{ dept: 'it', error: 'An invalid token was provided.' }]);
    expect(cm.client('hq')).toBe(clients.hq);
  });

  it('starts a praw client like any other department', async () => {
    const clients = { hq: fakeClient({ userId: 'hq', guild: fakeGuild() }), praw: fakeClient({ userId: 'praw', guild: fakeGuild() }) };
    const cm = new ClientManager({ guildId: GUILD, createClient: (d) => clients[d as 'hq' | 'praw'] });
    const r = await cm.start({ hq: 'a', praw: 'b' }, () => {}, () => {});
    expect(r.online.sort()).toEqual(['hq', 'praw']);
    expect(cm.client('praw')).toBe(clients.praw);
  });

  it('a login that never completes times out without affecting others', async () => {
    const clients = { hq: fakeClient({ userId: 'hq', guild: fakeGuild() }), ops: fakeClient({ userId: 'ops', hangLogin: true }) };
    const cm = new ClientManager({ guildId: GUILD, readyTimeoutMs: 20, createClient: (d) => clients[d as 'hq' | 'ops'] });
    const r = await cm.start({ hq: 'a', ops: 'b' }, () => {}, () => {});
    expect(r.online).toEqual(['hq']);
    expect(r.failed).toEqual([{ dept: 'ops', error: 'not ready after 20 ms' }]);
    expect(clients.ops.destroyed).toBe(true);
  });

  it('a client not in the guild fails', async () => {
    const c = fakeClient({ userId: 'rnd' });
    const cm = new ClientManager({ guildId: GUILD, createClient: () => c });
    const r = await cm.start({ rnd: 'a' }, () => {}, () => {});
    expect(r.failed[0]?.dept).toBe('rnd');
    expect(c.destroyed).toBe(true);
  });

  it('delivers each guild message once across clients, drops other guilds, never listens to debug', async () => {
    const hq = fakeClient({ userId: 'hq', guild: fakeGuild() });
    const sw = fakeClient({ userId: 'sw', guild: fakeGuild() });
    const cm = new ClientManager({ guildId: GUILD, createClient: (d) => (d === 'hq' ? hq : sw) });
    const got: [string, string][] = [];
    await cm.start({ hq: 'a', software: 'b' }, (m: Message, dept) => { got.push([m.id, dept]); }, () => {});
    const m = { id: '1', guildId: GUILD };
    hq.fire('messageCreate', m);
    sw.fire('messageCreate', m);
    sw.fire('messageCreate', { id: '2', guildId: '999' });
    expect(got).toHaveLength(1);
    expect(got[0]?.[0]).toBe('1');
    expect(hq.listenerCount('debug')).toBe(0);
    expect(sw.listenerCount('debug')).toBe(0);
  });

  it('only hq handles interactions, and only from the guild', async () => {
    const hq = fakeClient({ userId: 'hq', guild: fakeGuild() });
    const sw = fakeClient({ userId: 'sw', guild: fakeGuild() });
    const cm = new ClientManager({ guildId: GUILD, createClient: (d) => (d === 'hq' ? hq : sw) });
    const seen: string[] = [];
    await cm.start({ hq: 'a', software: 'b' }, () => {}, (i) => { seen.push(i.id); });
    expect(sw.listenerCount('interactionCreate')).toBe(0);
    hq.fire('interactionCreate', { id: 'i1', guildId: GUILD });
    hq.fire('interactionCreate', { id: 'i2', guildId: '999' });
    hq.fire('interactionCreate', { id: 'i3', guildId: null });
    expect(seen).toEqual(['i1']);
  });

  it('clients: praw client receives the praw interaction handler; hq the config one', async () => {
    const hq = fakeClient({ userId: 'hq', guild: fakeGuild() });
    const praw = fakeClient({ userId: 'praw', guild: fakeGuild() });
    const cm = new ClientManager({ guildId: GUILD, createClient: (d) => (d === 'hq' ? hq : praw) });
    const seen: string[] = [];
    await cm.start({ hq: 'a', praw: 'b' }, () => {}, (i) => { seen.push(`cfg:${i.id}`); }, (i) => { seen.push(`praw:${i.id}`); });
    hq.fire('interactionCreate', { id: 'h1', guildId: GUILD });
    praw.fire('interactionCreate', { id: 'p1', guildId: GUILD });
    praw.fire('interactionCreate', { id: 'p2', guildId: '999' });
    praw.fire('interactionCreate', { id: 'p3', guildId: null });
    expect(seen).toEqual(['cfg:h1', 'praw:p1']);
  });

  it('a praw client with no praw handler listens to no interactions (never the config handler)', async () => {
    const praw = fakeClient({ userId: 'praw', guild: fakeGuild() });
    const cm = new ClientManager({ guildId: GUILD, createClient: () => praw });
    const seen: string[] = [];
    await cm.start({ praw: 'b' }, () => {}, (i) => { seen.push(i.id); });
    expect(praw.listenerCount('interactionCreate')).toBe(0);
  });

  it('fetches the bot member before the permission check when members.me is not cached', async () => {
    const guild = fakeGuild({ noMe: true }) as ReturnType<typeof fakeGuild> & { members: { me: unknown; fetchMe?: () => Promise<unknown> } };
    const me = fakeGuild().members.me;
    guild.members.fetchMe = async () => {
      guild.members.me = me;
      return me;
    };
    const c = fakeClient({ userId: 'sw', guild });
    const cm = new ClientManager({ guildId: GUILD, createClient: () => c });
    const r = await cm.start({ software: 'a' }, () => {}, () => {});
    expect(r.online).toEqual(['software']);
    expect(r.disabled).toEqual([]);
  });

  it('a failing fetchMe disables the dept (cannot verify permissions)', async () => {
    const guild = fakeGuild({ noMe: true }) as ReturnType<typeof fakeGuild> & { members: { fetchMe?: () => Promise<unknown> } };
    guild.members.fetchMe = async () => {
      throw new Error('Unknown Member');
    };
    const c = fakeClient({ userId: 'sw', guild });
    const cm = new ClientManager({ guildId: GUILD, createClient: () => c });
    const r = await cm.start({ software: 'a' }, () => {}, () => {});
    expect(r.disabled).toEqual([{ dept: 'software', warnings: [expect.stringContaining('cannot verify')] }]);
    expect(r.failed).toEqual([]);
  });

  it('a throwing destroy on the disabled path still lands the dept in disabled', async () => {
    const c = fakeClient({ userId: 'sw', guild: fakeGuild({ guildWide: [PermissionFlagsBits.Administrator] }) });
    (c as unknown as { destroy: () => Promise<void> }).destroy = async () => {
      throw new Error('destroy failed');
    };
    const cm = new ClientManager({ guildId: GUILD, createClient: () => c });
    const r = await cm.start({ software: 'a' }, () => {}, () => {});
    expect(r.disabled.map((d) => d.dept)).toEqual(['software']);
    expect(r.failed).toEqual([]);
  });

  it('default client options never parse mentions', () => {
    expect(CLIENT_OPTIONS.allowedMentions).toEqual({ parse: [] });
    expect(CLIENT_OPTIONS.intents).toEqual([...INTENTS]);
  });

  it('TW11: only Partials.Channel is enabled, on every client (no Message, User, GuildMember or Reaction)', () => {
    expect(CLIENT_OPTIONS.partials).toEqual([Partials.Channel]);
    for (const d of ['hq', 'software', 'praw'] as const) expect(clientOptionsFor(d).partials).toEqual([Partials.Channel]);
  });

  it('stop destroys every client', async () => {
    const hq = fakeClient({ userId: 'hq', guild: fakeGuild() });
    const cm = new ClientManager({ guildId: GUILD, createClient: () => hq });
    await cm.start({ hq: 'a' }, () => {}, () => {});
    await cm.stop();
    expect(hq.destroyed).toBe(true);
    expect(cm.client('hq')).toBeUndefined();
  });
});

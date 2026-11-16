import { ChannelType, PermissionFlagsBits as P, type Client } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { DeptId } from '../core/index.js';
import { createDiscordPort, type PortOrg } from './port.js';
import { WebhookSender, type WebhookRepo } from './webhooks.js';

// REROUTE-1 [P]: RR-C9 (botCanWork is tri-state: only a definite answer is "no") and RR-C11 (canMemberPost).
const GUILD = '1565649426943442944';
const CAT = '1570000000000000100';
const TEXT = '1570000000000000201';
const THREAD = '1570000000000000501';
const DENIED = '1565715069969502310'; // company/denylist.ts
const BOT_LOG = '1566454343820124352';
const org: PortOrg = { dept: () => null, persona: () => null };
const repo: WebhookRepo = { getByChannel: async () => null, getByWebhookId: async () => null, upsert: async () => undefined };

type Ch = {
  id: string; type: number; parentId: string | null; perms?: bigint[] | null; locked?: boolean; archived?: boolean;
  /** what `members.fetch(me)` of a private thread does: ok, or reject with this Discord code (0 = a plain Error) */
  member?: 'ok' | number;
};
type World = { thrown?: Map<string, unknown>; offline?: boolean; me?: boolean; guildId?: string; memberPerms?: Map<string, bigint[] | null> };

function world(chs: Ch[], w: World = {}) {
  const byId = new Map(chs.map((c) => [c.id, c]));
  const isThread = (c: Ch) => [ChannelType.PublicThread, ChannelType.PrivateThread, ChannelType.AnnouncementThread].includes(c.type);
  const shape = (c: Ch) => ({
    id: c.id, type: c.type, parentId: c.parentId, guildId: w.guildId ?? GUILD, locked: c.locked ?? false, archived: c.archived ?? false,
    isThread: () => isThread(c), isDMBased: () => false, isTextBased: () => c.type !== ChannelType.GuildForum && c.type !== ChannelType.GuildCategory,
    permissionsFor: (m: { id: string }) => {
      const set = m.id === 'bot' ? c.perms : w.memberPerms?.get(`${m.id}|${c.id}`);
      return set === null || set === undefined ? null : { has: (f: bigint | bigint[]) => (Array.isArray(f) ? f : [f]).every((x) => set.includes(x)) };
    },
    members: {
      fetch: async () => {
        if (c.member === undefined || c.member === 'ok') return {};
        throw c.member === 0 ? new Error('boom') : Object.assign(new Error('Unknown Member'), { code: c.member });
      },
    },
  });
  const fetchChannel = async (id: string) => {
    if (w.thrown?.has(id)) throw w.thrown.get(id);
    const c = byId.get(id);
    if (!c) throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
    return shape(c);
  };
  const guild = {
    members: { me: w.me === false ? null : { id: 'bot' }, fetchMe: async () => { throw new Error('no member'); }, fetch: async (id: string) => ({ id }) },
    channels: { fetch: fetchChannel },
  };
  const client = { channels: { fetch: fetchChannel }, guilds: { cache: new Map([[GUILD, guild]]) } } as unknown as Client;
  return createDiscordPort({ client: (d: DeptId) => (w.offline ? undefined : d ? client : undefined) }, new WebhookSender(repo), org, { guildId: GUILD, adminRoleId: 'r', inbound: async () => null });
}

const FULL = [P.ViewChannel, P.SendMessages, P.ReadMessageHistory];
const THREAD_OK = [P.ViewChannel, P.ReadMessageHistory, P.SendMessagesInThreads];

describe('botCanWork matrix (RR-C9)', () => {
  const text = (perms: bigint[] | null): Ch[] => [{ id: TEXT, type: ChannelType.GuildText, parentId: CAT, perms }];
  it('a text channel with View, Send and Read History is yes; a missing one is a definite no', async () => {
    expect(await world(text(FULL)).botCanWork('sales', TEXT)).toBe('yes');
    for (const missing of FULL) expect(await world(text(FULL.filter((f) => f !== missing))).botCanWork('sales', TEXT), String(missing)).toBe('no');
    expect(await world(text(null)).botCanWork('sales', TEXT)).toBe('no');
  });
  it('50001 Missing Access, 50013 Missing Permissions and 10003 Unknown Channel are no', async () => {
    for (const code of [50001, 50013, 10003]) {
      const port = world(text(FULL), { thrown: new Map([[TEXT, Object.assign(new Error('x'), { code })]]) });
      expect(await port.botCanWork('sales', TEXT), String(code)).toBe('no');
    }
  });
  it('a timeout, a 500, a 429 and an unrecognised error are unknown, never no', async () => {
    for (const e of [new Error('timeout'), Object.assign(new Error('Internal'), { code: 0, status: 500 }), Object.assign(new Error('rate'), { status: 429 }), Object.assign(new Error('x'), { code: 40333 })]) {
      expect(await world(text(FULL), { thrown: new Map([[TEXT, e]]) }).botCanWork('sales', TEXT)).toBe('unknown');
    }
  });
  it('an offline client is unknown', async () => {
    expect(await world(text(FULL), { offline: true }).botCanWork('sales', TEXT)).toBe('unknown');
  });
  it('an unknown bot member is unknown', async () => {
    expect(await world(text(FULL), { me: false }).botCanWork('sales', TEXT)).toBe('unknown');
  });
  it('a bad id, an excluded channel (#bot-log, a denied id) and a channel of another guild are no', async () => {
    const chs: Ch[] = [...text(FULL), { id: BOT_LOG, type: ChannelType.GuildText, parentId: CAT, perms: FULL }, { id: DENIED, type: ChannelType.GuildText, parentId: CAT, perms: FULL }];
    const port = world(chs);
    expect(await port.botCanWork('sales', 'not-an-id')).toBe('no');
    expect(await port.botCanWork('sales', BOT_LOG)).toBe('no');
    expect(await port.botCanWork('sales', DENIED)).toBe('no');
    expect(await world(text(FULL), { guildId: '1' }).botCanWork('sales', TEXT)).toBe('no');
  });
  it('a forum is no; a voice channel with a text chat is checked by permission like a text channel', async () => {
    expect(await world([{ id: TEXT, type: ChannelType.GuildForum, parentId: CAT, perms: FULL }]).botCanWork('sales', TEXT)).toBe('no');
    expect(await world([{ id: TEXT, type: ChannelType.GuildVoice, parentId: CAT, perms: FULL }]).botCanWork('sales', TEXT)).toBe('yes');
    expect(await world([{ id: TEXT, type: ChannelType.GuildVoice, parentId: CAT, perms: [P.ViewChannel] }]).botCanWork('sales', TEXT)).toBe('no');
  });

  const thread = (o: Partial<Ch>): Ch[] => [{ id: TEXT, type: ChannelType.GuildText, parentId: CAT, perms: FULL }, { id: THREAD, type: ChannelType.PublicThread, parentId: TEXT, perms: THREAD_OK, ...o }];
  it('a public thread needs View, Read History and Send Messages in Threads', async () => {
    expect(await world(thread({})).botCanWork('sales', THREAD)).toBe('yes');
    for (const missing of THREAD_OK) expect(await world(thread({ perms: THREAD_OK.filter((f) => f !== missing) })).botCanWork('sales', THREAD), String(missing)).toBe('no');
  });
  it('a locked or archived thread is no without Manage Threads, yes with it', async () => {
    expect(await world(thread({ locked: true })).botCanWork('sales', THREAD)).toBe('no');
    expect(await world(thread({ archived: true })).botCanWork('sales', THREAD)).toBe('no');
    expect(await world(thread({ locked: true, perms: [...THREAD_OK, P.ManageThreads] })).botCanWork('sales', THREAD)).toBe('yes');
  });
  it('a private thread the bot has not joined is no (Unknown Member), joined is yes, a membership lookup that fails otherwise is unknown', async () => {
    const priv = (member: Ch['member']) => thread({ type: ChannelType.PrivateThread, member });
    expect(await world(priv('ok')).botCanWork('sales', THREAD)).toBe('yes');
    expect(await world(priv(10007)).botCanWork('sales', THREAD)).toBe('no');
    expect(await world(priv(0)).botCanWork('sales', THREAD)).toBe('unknown');
    expect(await world(thread({ type: ChannelType.PrivateThread, member: 10007, perms: [...THREAD_OK, P.ManageThreads] })).botCanWork('sales', THREAD)).toBe('yes');
  });
});

describe('canMemberPost (RR-C11)', () => {
  const USER = '1570000000000000777';
  const mk = (perms: bigint[] | null, extra: World = {}) => world([{ id: TEXT, type: ChannelType.GuildText, parentId: CAT, perms: FULL }], { memberPerms: new Map([[`${USER}|${TEXT}`, perms]]), ...extra });
  it('needs View Channel, Send Messages and Send Messages in Threads: a view-only member is false', async () => {
    const all = [P.ViewChannel, P.SendMessages, P.SendMessagesInThreads];
    expect(await mk(all).canMemberPost(USER, TEXT)).toBe(true);
    expect(await mk([P.ViewChannel]).canMemberPost(USER, TEXT)).toBe(false);
    for (const missing of all) expect(await mk(all.filter((f) => f !== missing)).canMemberPost(USER, TEXT), String(missing)).toBe(false);
  });
  it('fails closed: no permission set, a thrown lookup, an unknown channel, a bad id, a denied channel', async () => {
    expect(await mk(null).canMemberPost(USER, TEXT)).toBe(false);
    expect(await mk([P.ViewChannel, P.SendMessages, P.SendMessagesInThreads], { thrown: new Map([[TEXT, new Error('x')]]) }).canMemberPost(USER, TEXT)).toBe(false);
    expect(await mk([P.ViewChannel, P.SendMessages, P.SendMessagesInThreads]).canMemberPost(USER, '1570000000000009999')).toBe(false);
    expect(await mk([P.ViewChannel, P.SendMessages, P.SendMessagesInThreads]).canMemberPost('x', TEXT)).toBe(false);
    expect(await mk([P.ViewChannel, P.SendMessages, P.SendMessagesInThreads]).canMemberPost(USER, '1565715069969502310')).toBe(false);
  });
});

import { ChannelType, PermissionFlagsBits, type Client } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { DeptId } from '../core/index.js';
import { createDiscordPort, type PortOrg } from './port.js';
import { WebhookSender, type WebhookRepo } from './webhooks.js';

const GUILD = '1565649426943442944';
const CAT = '1570000000000000100';
const IT_CAT = '1565714470192291970'; // DENIED_CATEGORY_IDS
const TEXT = '1570000000000000201';
const IT_WORK = '1565714565520560328';
const FORUM = '1570000000000000301';
const org: PortOrg = { dept: () => null, persona: () => null };
const repo: WebhookRepo = { getByChannel: async () => null, getByWebhookId: async () => null, upsert: async () => undefined };

type Ch = { id: string; type: number; parentId: string | null; threadsParent?: boolean; perms?: boolean | null };
function world(chs: Ch[], opts: { me?: boolean } = {}) {
  const byId = new Map(chs.map((c) => [c.id, c]));
  const shape = (c: Ch) => ({
    id: c.id, type: c.type, parentId: c.parentId, isThread: () => c.type === ChannelType.PublicThread, isDMBased: () => false,
    permissionsFor: () => (c.perms === null ? null : { has: (flags: bigint[]) => c.perms === true && flags.includes(PermissionFlagsBits.CreatePublicThreads) }),
  });
  const guild = { members: { me: opts.me === false ? null : { id: 'bot' }, fetchMe: async () => { throw new Error('no member'); } } };
  const client = {
    channels: { fetch: async (id: string) => { const c = byId.get(id); if (!c) throw new Error('Unknown Channel'); return shape(c); } },
    guilds: { cache: new Map([[GUILD, guild]]) },
  } as unknown as Client;
  return createDiscordPort({ client: (d: DeptId) => (d ? client : undefined) }, new WebhookSender(repo), org, { guildId: GUILD, adminRoleId: 'r', inbound: async () => null });
}

describe('WS6 DiscordPort.categoryOf (the origin category is read from Discord by code)', () => {
  const chans: Ch[] = [
    { id: CAT, type: ChannelType.GuildCategory, parentId: null },
    { id: TEXT, type: ChannelType.GuildText, parentId: CAT },
    { id: FORUM, type: ChannelType.GuildForum, parentId: CAT },
    { id: IT_CAT, type: ChannelType.GuildCategory, parentId: null },
    { id: IT_WORK, type: ChannelType.GuildText, parentId: IT_CAT },
    { id: '1570000000000000401', type: ChannelType.GuildText, parentId: null },
  ];
  it('a text channel and a forum resolve to their category', async () => {
    const port = world(chans);
    expect(await port.categoryOf(TEXT)).toBe(CAT);
    expect(await port.categoryOf(FORUM)).toBe(CAT);
  });
  it('fails closed: the IT category (denied), a channel without a category, a category itself, a thread, a denied or missing channel, a bad id', async () => {
    const port = world([...chans, { id: '1570000000000000501', type: ChannelType.PublicThread, parentId: TEXT }]);
    expect(await port.categoryOf(IT_WORK)).toBeNull();
    expect(await port.categoryOf('1570000000000000401')).toBeNull();
    expect(await port.categoryOf(CAT)).toBeNull();
    expect(await port.categoryOf('1570000000000000501')).toBeNull(); // callers pass the parent of a thread
    expect(await port.categoryOf('1565715069969502310')).toBeNull();
    expect(await port.categoryOf('1570000000000009999')).toBeNull();
    expect(await port.categoryOf('not-an-id')).toBeNull();
  });
  it('a system channel (#bot-log) gives no category', async () => {
    const port = world([{ id: '1566454343820124352', type: ChannelType.GuildText, parentId: CAT }, ...chans]);
    expect(await port.categoryOf('1566454343820124352')).toBeNull();
  });
});

describe('WS6 DiscordPort.canStartThread (a live View / Send / Create Public Threads check for the posting head)', () => {
  it('true only for a text channel where the bot has the permissions', async () => {
    expect(await world([{ id: TEXT, type: ChannelType.GuildText, parentId: CAT, perms: true }]).canStartThread('software', TEXT)).toBe(true);
    expect(await world([{ id: TEXT, type: ChannelType.GuildText, parentId: CAT, perms: false }]).canStartThread('software', TEXT)).toBe(false);
    expect(await world([{ id: TEXT, type: ChannelType.GuildText, parentId: CAT, perms: null }]).canStartThread('software', TEXT)).toBe(false);
  });
  it('false for a forum, a channel in the denied category, a system channel, an unknown channel, or when the bot member is unknown', async () => {
    const port = world([
      { id: FORUM, type: ChannelType.GuildForum, parentId: CAT, perms: true },
      { id: IT_WORK, type: ChannelType.GuildText, parentId: IT_CAT, perms: true },
      { id: '1566454343820124352', type: ChannelType.GuildText, parentId: CAT, perms: true },
    ]);
    expect(await port.canStartThread('software', FORUM)).toBe(false);
    expect(await port.canStartThread('software', IT_WORK)).toBe(false);
    expect(await port.canStartThread('software', '1566454343820124352')).toBe(false);
    expect(await port.canStartThread('software', '1570000000000009999')).toBe(false);
    expect(await world([{ id: TEXT, type: ChannelType.GuildText, parentId: CAT, perms: true }], { me: false }).canStartThread('software', TEXT)).toBe(false);
  });
});

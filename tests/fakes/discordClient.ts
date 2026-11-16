import { EventEmitter } from 'node:events';
import { PermissionFlagsBits, PermissionsBitField, type Client } from 'discord.js';

const DENIED = ['1565715069969502310', '1565649677280485457'];

/** A guild as discord.js exposes it to `checkGuildPermissions`: `members.me` plus cached channels. */
export function fakeGuild(o: { guildWide?: bigint[]; viewable?: string[]; noMe?: boolean; id?: string; missing?: string[] } = {}) {
  const me = o.noMe ? null : { id: 'me', permissions: new PermissionsBitField(o.guildWide ?? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]) };
  const channels = new Map(
    DENIED.filter((id) => !o.missing?.includes(id)).map((id) => [id, { id, permissionsFor: () => new PermissionsBitField(o.viewable?.includes(id) ? [PermissionFlagsBits.ViewChannel] : []) }]),
  );
  return {
    id: o.id ?? '1565649426943442944',
    members: { me, fetchMe: async (): Promise<unknown> => { if (!me) throw new Error('Unknown Member'); return me; } },
    roles: { fetch: async () => new Map() },
    channels: { cache: channels },
  };
}

/** A discord.js Client stand-in: `login` resolves and emits `clientReady` unless `failLogin`. */
export function fakeClient(o: { userId: string; guild?: ReturnType<typeof fakeGuild>; failLogin?: boolean; hangLogin?: boolean; channelFetch?: (id: string, options?: unknown) => Promise<unknown> }) {
  const ee = new EventEmitter() as EventEmitter & Record<string, unknown>;
  const guilds = new Map(o.guild ? [[o.guild.id, o.guild]] : []);
  Object.assign(ee, {
    user: { id: o.userId },
    application: { id: o.userId },
    guilds: { cache: guilds, fetch: async (id: string) => { const g = guilds.get(id); if (!g) throw new Error('Unknown Guild'); return g; } },
    channels: { fetch: o.channelFetch ?? (async () => { throw Object.assign(new Error('Unknown Channel'), { code: 10003 }); }) },
    destroyed: false,
    login: async () => {
      if (o.failLogin) throw new Error('An invalid token was provided.');
      if (o.hangLogin) return new Promise<string>(() => {});
      setImmediate(() => ee.emit('clientReady', ee));
      return 'token';
    },
    destroy: async () => { ee.destroyed = true; },
    fire: (event: string, ...args: unknown[]) => ee.emit(event, ...args),
  });
  return ee as unknown as Client & { destroyed: boolean; fire(event: string, ...args: unknown[]): boolean };
}

type Sent = Record<string, unknown>;

/** A webhook stand-in that records every `send`. */
export function fakeWebhook(id: string, name = 'assistant-personas') {
  const sent: Sent[] = [];
  return { id, name, token: 'hook-token', sent, send: async (o: Sent) => { sent.push(o); return { id: `wm-${sent.length}` }; } };
}
export type FakeWebhook = ReturnType<typeof fakeWebhook>;

/** A guild text channel (or thread, with `parentId`) stand-in. */
export function fakeChannel(id: string, o: { thread?: string; noView?: string[]; overwrites?: { id: string; type: number; allow: bigint; deny: bigint }[]; manageWebhooks?: boolean; webhooks?: FakeWebhook[]; history?: Sent[]; pinErrorCode?: number } = {}) {
  const sent: Sent[] = [];
  const pinned: string[] = [];
  const webhooks = new Map((o.webhooks ?? []).map((w) => [w.id, w]));
  const created: FakeWebhook[] = [];
  const createdThreads: Sent[] = [];
  return {
    id, sent, created, createdThreads, pinned, guildId: '1565649426943442944', name: `name-${id}`, type: o.thread ? 11 : 0,
    parentId: o.thread ?? 'category-1',
    isThread: () => !!o.thread,
    isDMBased: () => false,
    permissionOverwrites: { cache: new Map((o.overwrites ?? []).map((w) => [w.id, { id: w.id, type: w.type, allow: { bitfield: w.allow }, deny: { bitfield: w.deny } }])) },
    isSendable: () => true,
    isTextBased: () => true,
    send: async (m: Sent) => { sent.push(m); return { id: `cm-${id}-${sent.length}` }; },
    threads: { create: async (opts: Sent) => { createdThreads.push(opts); return { id: `th-${createdThreads.length}` }; } },
    messages: {
      fetch: async () => new Map((o.history ?? []).map((m) => [m.id as string, m])),
      pin: async (messageId: string) => {
        if (o.pinErrorCode !== undefined) throw Object.assign(new Error('DiscordAPIError'), { code: o.pinErrorCode });
        pinned.push(messageId);
      },
    },
    // REROUTE-1: a bot in these fakes can also talk in the channel (botCanWork reads Send Messages, Read Message History and Send Messages in Threads)
    permissionsFor: (m?: { id?: string }) => new PermissionsBitField(m?.id && o.noView?.includes(m.id) ? [] : [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessagesInThreads, ...(o.manageWebhooks === false ? [] : [PermissionFlagsBits.ManageWebhooks])]),
    fetchWebhooks: async () => webhooks,
    createWebhook: async (opts: { name: string }) => {
      const w = fakeWebhook(`hook-${id}-${created.length + 1}`, opts.name);
      created.push(w);
      webhooks.set(w.id, w);
      return w;
    },
  };
}
export type FakeChannel = ReturnType<typeof fakeChannel>;

type FakePost = { id: string; name: string; starter: string; createdTimestamp: number; messageCount?: number; appliedTags?: string[]; parentId?: string; messages?: Sent[] };
/** A forum channel (type 15): not sendable, with tags, and a thread manager that creates posts and lists them. */
export function fakeForum(id: string, o: { tags?: { id: string; name: string }[]; posts?: FakePost[]; parentId?: string } = {}) {
  const created: Sent[] = [];
  const postSends: Sent[] = [];
  const posts = new Map((o.posts ?? []).map((p) => [p.id, {
    id: p.id, name: p.name, parentId: p.parentId ?? id, createdTimestamp: p.createdTimestamp, messageCount: p.messageCount ?? 0, appliedTags: p.appliedTags ?? [],
    isThread: () => true, fetchStarterMessage: async () => ({ content: p.starter }),
    messages: { fetch: async () => new Map((p.messages ?? []).map((m) => [m.id as string, m])) },
  }]));
  return {
    id, created, postSends, posts, guildId: '1565649426943442944', name: `forum-${id}`, type: 15, parentId: o.parentId ?? 'category-1',
    availableTags: o.tags ?? [], isThread: () => false, isSendable: () => false, isTextBased: () => false,
    threads: {
      create: async (opts: Sent) => {
        created.push(opts);
        const tid = `post-${created.length}`;
        return { id: tid, send: async (m: Sent) => { postSends.push(m); return { id: `pm-${postSends.length}` }; } };
      },
      fetchActive: async () => ({ threads: new Map([...posts].slice(0, 1000)) }),
      fetchArchived: async () => ({ threads: new Map() }),
    },
  };
}
export type FakeForum = ReturnType<typeof fakeForum>;

/** A logged-in client that can fetch the given channels; `guild.channels.cache` holds them too. */
export function fakeRestClient(appId: string, channels: (FakeChannel | FakeForum)[]) {
  const byId = new Map<string, FakeChannel | FakeForum>(channels.map((c) => [c.id, c]));
  for (const c of channels) if ('posts' in c) for (const [pid, p] of c.posts) byId.set(pid, p as never);
  const me = { id: appId, permissions: new PermissionsBitField([PermissionFlagsBits.ViewChannel]) };
  const guild = { id: '1565649426943442944', members: { me, fetch: async (id: string) => ({ id }) }, roles: { cache: new Map<string, unknown>() }, channels: { cache: byId } };
  return {
    user: { id: appId },
    application: { id: appId },
    channels: { fetch: async (id: string) => byId.get(id) ?? null },
    guilds: { cache: new Map([[guild.id, guild]]) },
  } as unknown as Client;
}

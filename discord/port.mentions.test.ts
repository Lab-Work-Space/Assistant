import { describe, expect, it } from 'vitest';
import type { Client, Message } from 'discord.js';
import type { DeptId } from '../core/index.js';
import type { Department } from '../db/repos/index.js';
import { fakeChannel, fakeRestClient } from '../tests/fakes/discordClient.js';
import { handlesIn } from '../company/handles.js';
import { createDiscordPort, type PortOrg } from './port.js';
import { WebhookSender, type WebhookRepo } from './webhooks.js';

const dept = (id: string): Department => ({ id, name: id, categoryNamePattern: id, workChannelId: 'ch', color: 0x123456, model: null, provider: null, enabled: true }) as Department;
const org: PortOrg = { dept: (id) => dept(id), persona: () => null };
const IDS = new Map<string, DeptId>([['222222222222222222', 'software'], ['111111111111111111', 'hq'], ['444444444444444444', 'it']]);
const repo: WebhookRepo = { getByChannel: async () => null, getByWebhookId: async () => null, upsert: async () => undefined };

function setup(ids: Map<string, DeptId> = IDS) {
  const ch = fakeChannel('ch');
  const c = fakeRestClient('app', [ch]);
  const port = createDiscordPort({ client: () => c as Client }, new WebhookSender(repo), org, {
    guildId: '1565649426943442944', adminRoleId: '1565000000000000001', inbound: async (m: Message) => ({ id: m.id }) as never, botUserIds: () => ids,
  });
  return { port, ch };
}
const text = (ch: ReturnType<typeof fakeChannel>) => JSON.stringify({ c: ch.sent[0]!.content ?? null, e: ch.sent[0]!.embeds });
const head = { kind: 'head' as const, dept: 'software' as DeptId };

describe('TW8 outbound mention conversion at the port', () => {
  it('turns @CTO into the live bot mention in the embed and never widens allowedMentions', async () => {
    const { port, ch } = setup();
    await port.post(head, { channelId: 'ch' }, { type: 'chat', body: '@CTO please look; @IT too; @Sales has no live id', fields: [{ name: 'to @CEO', value: 'v' }, { name: 'n', value: 'ask @CEO' }] });
    expect(text(ch)).toContain('ask <@111111111111111111>');
    const t = text(ch);
    expect(t).toContain('<@222222222222222222> please look');
    expect(t).toContain('<@444444444444444444> too');
    expect(t).toContain('@Sales has no live id');
    expect(t).toContain('to @CEO'); // F3: a field name does not render mentions, so it keeps the handle text
    expect(ch.sent[0]!.allowedMentions).toEqual({ parse: [] });
    expect(ch.sent[0]!.embeds).toEqual([]); // chat is plain content now; the text checks above cover it
  });

  it('no live id (the head is offline) leaves the handle as text', async () => {
    const { port, ch } = setup(new Map());
    await port.post(head, { channelId: 'ch' }, { type: 'chat', body: '@CTO hi' });
    expect(text(ch)).not.toMatch(/<@\d/);
  });

  it('raw <@id>, <@&role>, @everyone and @here typed by a model are neutralised; handles in code, urls and @ITEM / a@IT.com stay text', async () => {
    const { port, ch } = setup();
    await port.post(head, { channelId: 'ch' }, {
      type: 'chat', body: '<@999999999999999999> <@&1565000000000000001> @everyone @here `@CTO` https://x.test/@CTO @ITEM a@IT.com',
    });
    const t = text(ch);
    expect(t).not.toMatch(/<@&?\d{17,20}>/);
    expect(t).not.toMatch(/@everyone|@here/);
    expect(t).not.toContain('<@222222222222222222>');
    expect(t).toContain('@ITEM');
    expect(t).toContain('a@IT.com');
    expect(ch.sent[0]!.allowedMentions).toEqual({ parse: [] });
  });

  it('system (governance) text is not rewritten and keeps its admin-role ping', async () => {
    const { port, ch } = setup();
    await port.post(head, { channelId: 'ch' }, { type: 'alert', origin: 'governance', title: 'Budget', body: 'ask @CTO <#123456789012345678>' });
    expect(text(ch)).toContain('ask @CTO <#123456789012345678>');
    expect(ch.sent[0]!.allowedMentions).toEqual({ parse: [], roles: ['1565000000000000001'] });
  });
});

describe('F3 titles keep handle text; a bot that cannot see the channel is never mentioned', () => {
  const task = (title: string, body = 'd'): Parameters<ReturnType<typeof setup>['port']['post']>[2] => ({ type: 'task', title, body, fields: [{ name: 'Owner', value: 'x' }] });

  it('the title keeps @CTO as text and the description is converted', async () => {
    const { port, ch } = setup();
    await port.post(head, { channelId: 'ch' }, task('@CTO review the plan', 'owner is @CTO'));
    // A chat-style task answer is plain content now (owner rule): the bold title keeps the handle text, the body is converted.
    expect(ch.sent[0]!.embeds).toEqual([]);
    expect(ch.sent[0]!.content).toContain('**@CTO review the plan**\nowner is <@222222222222222222>');
  });

  it('a raw <@id> typed into a title is still neutralised', async () => {
    const { port, ch } = setup();
    await port.post(head, { channelId: 'ch' }, task('<@222222222222222222> look'));
    expect(JSON.stringify(ch.sent[0])).not.toMatch(/<@\d{17,20}>/);
  });

  it('LF8: a bot without View on the channel stays plain text; one that can see it is converted', async () => {
    const ch = fakeChannel('ch', { noView: ['222222222222222222'] });
    const c = fakeRestClient('app', [ch]);
    const port = createDiscordPort({ client: () => c as Client }, new WebhookSender(repo), org, {
      guildId: '1565649426943442944', adminRoleId: '1565000000000000001', inbound: async (m: Message) => ({ id: m.id }) as never, botUserIds: () => IDS,
    });
    await port.post(head, { channelId: 'ch' }, { type: 'chat', body: '@CTO and @IT' });
    const t = JSON.stringify(ch.sent[0]);
    expect(t).toContain('@CTO and <@444444444444444444>');
    expect(t).not.toContain('<@222222222222222222>');
    expect(await port.botCanView('software', 'ch')).toBe(false);
    expect(await port.botCanView('it', 'ch')).toBe(true);
    expect(await port.botCanView('praw', 'ch')).toBe(false); // no live id
  });

  it('LF8: when the permission read fails the handle stays text (fail closed)', async () => {
    const ch = fakeChannel('ch');
    const c = fakeRestClient('app', [ch]);
    (c as unknown as { guilds: { cache: Map<string, { members: { fetch: () => Promise<never> } }> } }).guilds.cache.get('1565649426943442944')!.members.fetch = async () => { throw new Error('boom'); };
    const port = createDiscordPort({ client: () => c as Client }, new WebhookSender(repo), org, {
      guildId: '1565649426943442944', adminRoleId: '1565000000000000001', inbound: async (m: Message) => ({ id: m.id }) as never, botUserIds: () => IDS,
    });
    await port.post(head, { channelId: 'ch' }, { type: 'chat', body: '@CTO hi' });
    expect(JSON.stringify(ch.sent[0])).toContain('@CTO hi');
  });
});

describe('LF1 a warroom_say style post can neither ping nor mention anything but our live bots', () => {
  it('@everyone / @here in any case, with a zero-width or full-width variant, raw user and role mentions: nothing unbroken reaches the embed and allowedMentions stays empty', async () => {
    const { port, ch } = setup();
    await port.post(head, { channelId: 'ch' }, {
      type: 'chat', body: '@everyone @HERE @\u200beveryone ＠everyone ＠here <@&1565000000000000001> <@!999999999999999999> <@999999999999999999> @CFO @IT',
    });
    const t = JSON.stringify(ch.sent[0]);
    expect(t).not.toMatch(/@everyone|@here/i);
    expect(t).not.toMatch(/<@&?!?(?!444444444444444444)\d{17,20}>/); // no raw user, nickname or role mention survives; CFO has no live id here
    expect(t).toContain('<@444444444444444444>'); // only the live bot's handle became a mention
    expect(ch.sent[0]!.allowedMentions).toEqual({ parse: [] });
    expect(ch.sent[0]!.embeds).toEqual([]); // chat is plain content now; the text checks above cover it
  });
});

describe('G2LF-01 channelIsPrivate is an allow list', () => {
  const V = 1024n; // View Channel
  const GUILD = '1565649426943442944';
  const ADMIN = '1565000000000000001';
  const live = [
    { id: GUILD, type: 0, allow: 0n, deny: V },
    { id: '1565650182824009828', type: 0, allow: V, deny: 0n }, // Founder
    { id: '1565650295302651955', type: 0, allow: V, deny: 0n }, // Assistant
    { id: '1566025700669001828', type: 0, allow: V, deny: 0n }, // LW Bots
  ];
  const check = async (overwrites: typeof live, tweak?: (c: ReturnType<typeof fakeRestClient>) => void) => {
    const ch = fakeChannel('ch', { overwrites });
    const c = fakeRestClient('app', [ch]);
    tweak?.(c as never);
    const port = createDiscordPort({ client: () => c as Client }, new WebhookSender(repo), org, { guildId: GUILD, adminRoleId: ADMIN, inbound: async (m: Message) => ({ id: m.id }) as never, botUserIds: () => IDS });
    return port.channelIsPrivate('ch');
  };
  it('the live layout passes, also with the Bot Admin role, a bot member and a bot-managed role', async () => {
    expect(await check(live)).toBe(true);
    expect(await check([...live, { id: ADMIN, type: 0, allow: V, deny: 0n }, { id: '222222222222222222', type: 1, allow: V, deny: 0n }])).toBe(true);
    expect(await check([...live, { id: '77', type: 0, allow: V, deny: 0n }], (c) => ((c as unknown as { guilds: { cache: Map<string, { roles: { cache: Map<string, unknown> } }> } }).guilds.cache.get(GUILD)!.roles.cache.set('77', { tags: { botId: '444444444444444444' } })))).toBe(true);
  });
  it('an extra human role or member allowed View fails; so does @everyone not denied', async () => {
    expect(await check([...live, { id: '88', type: 0, allow: V, deny: 0n }])).toBe(false);
    expect(await check([...live, { id: '999999999999999999', type: 1, allow: V, deny: 0n }])).toBe(false);
    expect(await check(live.slice(1))).toBe(false);
  });
  it('an error while reading fails closed', async () => {
    const port = createDiscordPort({ client: () => ({ channels: { fetch: async () => { throw new Error('x'); } } }) as never }, new WebhookSender(repo), org, { guildId: GUILD, adminRoleId: ADMIN, inbound: async () => null, botUserIds: () => IDS });
    expect(await port.channelIsPrivate('ch')).toBe(false);
  });
});

describe('TEAMTALK T1/T2 noHandles and the task card: no live handle, no mention markup, in text or embed', () => {
  const live = (t: string) => handlesIn(t);
  const all = (m: Record<string, unknown>) => JSON.stringify({ c: m.content ?? null, e: m.embeds });
  const dirty = { title: '@CFO review <@222222222222222222> @everyone', body: 'ask @CTO and @CEO, `@IT`, https://x.test/@Ops, @R&D\n```\n@HR\n```', fields: [{ name: '@Sales', value: 'cc @Praw @Marketing' }] };

  it('a noHandles post (plain) contains no <@id> and no live handle in content, title or fields; allowedMentions stays empty', async () => {
    const { port, ch } = setup();
    await port.post(head, { channelId: 'ch' }, { type: 'chat', noHandles: true, ...dirty });
    const m = ch.sent[0]!;
    expect(live(String(m.content))).toEqual([]);
    expect(String(m.content)).not.toMatch(/<@/);
    expect(String(m.content)).not.toMatch(/@everyone/);
    expect(m.allowedMentions).toEqual({ parse: [] });
    expect(m.flags).toBe(4); // SuppressEmbeds: links in a relay never unfurl
  });

  it('truncation cannot recreate a handle: a title cut right after @CFO is still safe', async () => {
    const { port, ch } = setup();
    await port.post(head, { channelId: 'ch' }, { type: 'chat', noHandles: true, title: `${'a'.repeat(250)} @CFOxyz`, body: 'b' });
    expect(live(String(ch.sent[0]!.content))).toEqual([]);
  });

  it('a split long body is checked chunk by chunk', async () => {
    const { port, ch } = setup();
    await port.post(head, { channelId: 'ch' }, { type: 'chat', noHandles: true, body: `${'y'.repeat(1995)} @CFOxyz and @CTO more` });
    expect(ch.sent.length).toBeGreaterThan(1);
    for (const m of ch.sent) expect(live(String(m.content))).toEqual([]);
  });

  it('a model post without noHandles keeps today\'s conversion (live bot mention)', async () => {
    const { port, ch } = setup();
    await port.post(head, { channelId: 'ch' }, { type: 'chat', body: '@CTO hi' });
    expect(String(ch.sent[0]!.content)).toContain('<@222222222222222222>');
  });

  it('T2: the governance task card (title, description, Done when, Due, Back to) has no live handle and no raw mention', async () => {
    const { port, ch } = setup();
    await port.post(head, { channelId: 'ch' }, {
      type: 'task', origin: 'governance', title: '@CFO plan <@222222222222222222>', body: 'do @CTO and @IT things',
      fields: [{ name: 'Done when', value: 'the @CEO agrees' }, { name: 'Due', value: '2026-11-20' }, { name: 'Back to', value: 'https://discord.com/channels/1/2' }],
    });
    const t = all(ch.sent[0]!);
    expect(live(t.replace(/\\n/g, '\n'))).toEqual([]);
    expect(t).not.toMatch(/<@\d/);
    expect(t).toContain('Done when');
  });

  it('T2: a card edit (upsertTaskCard on an existing card) is defanged too', async () => {
    const ch = fakeChannel('ch');
    const c = fakeRestClient('app', [ch]);
    const edits: unknown[] = [];
    (ch.messages as unknown as { fetch: (id?: string) => Promise<unknown> }).fetch = async () => ({ author: { id: 'app' }, edit: async (o: unknown) => { edits.push(o); } });
    const port = createDiscordPort({ client: () => c as Client }, new WebhookSender(repo), org, {
      guildId: '1565649426943442944', adminRoleId: '1565000000000000001', inbound: async (m: Message) => ({ id: m.id }) as never, botUserIds: () => IDS,
      taskMessages: { messageId: async () => '1570000000000000001', claimMessage: async () => true, replaceMessage: async () => true },
    });
    await port.upsertTaskCard({ id: 't1', status: 'doing' }, head, { channelId: 'ch' }, { type: 'task', origin: 'governance', title: '@CFO', body: 'x @CTO' });
    expect(edits).toHaveLength(1);
    expect(live(JSON.stringify(edits[0]))).toEqual([]);
  });
});

describe('ASKBACK-1 AB7: the human ❓ line pings exactly one id', () => {
  it('mentionUserIds is the only ping; a model-written <@other>, @everyone and a handle in the question never ping or route', async () => {
    const { port, ch } = setup();
    await port.post(head, { channelId: 'ch' }, { type: 'chat', noHandles: true, body: '❓ x has a question for you: ask <@999999999999999999> and @everyone and @CFO\nReply in this thread; I will wait up to 4 h.' }, { mentionUserIds: ['1570000000000000042'] });
    const sent = ch.sent[0]!;
    expect(sent.allowedMentions).toEqual({ parse: [], users: ['1570000000000000042'] });
    const t = String(sent.content);
    expect(t.startsWith('<@1570000000000000042> ')).toBe(true);
    expect(t.slice('<@1570000000000000042>'.length)).not.toMatch(/<@\d|@everyone/);
    expect(handlesIn(t)).toEqual([]);
  });

  it('without mentionUserIds (⏳, ❓ bot, 💬 lines) nothing is pinged', async () => {
    const { port, ch } = setup();
    await port.post(head, { channelId: 'ch' }, { type: 'chat', noHandles: true, body: '💬 Answer from head of hq (question 1/2): <@1570000000000000042> @here' });
    expect(ch.sent[0]!.allowedMentions).toEqual({ parse: [] });
    expect(String(ch.sent[0]!.content)).not.toMatch(/<@\d|@here/);
  });
});

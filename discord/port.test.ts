import { describe, expect, it } from 'vitest';
import type { Client, Message } from 'discord.js';
import type { DeptId } from '../core/index.js';
import type { Department, Persona, PersonaWebhook } from '../db/repos/index.js';
import { fakeChannel, fakeForum, fakeRestClient, fakeWebhook, type FakeChannel, type FakeForum } from '../tests/fakes/discordClient.js';
import { batchApprovalPayload } from './embeds/approval.js';
import { createDiscordPort, DeniedChannelError, PinError, type BoardStore, type PortOrg, type TaskMessageStore } from './port.js';
import { WebhookSender, type WebhookRepo } from './webhooks.js';

const DENIED = '1565715069969502310';
const TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAx.GaBcDe.abcdefghijklmnopqrstuvwxyz0123456';
const sw: Department = { id: 'software', name: 'Software', categoryNamePattern: 'soft', workChannelId: 'ch-sw', color: 0x123456, model: null, provider: null, enabled: true };
const hqDept: Department = { ...sw, id: 'hq', name: 'HQ', color: 0x111111 };
const sa: Persona = { id: 'system-analyst', deptId: 'software', name: 'System Analyst', avatarUrl: 'https://cdn.example/sa.png', promptRef: 'members/software/system-analyst', model: null, provider: null, tools: [], directChannelId: 'ch-sw', enabled: true }; // its direct room doubles as the test channel
const org: PortOrg = { dept: (id) => ({ software: sw, hq: hqDept })[id] ?? null, persona: (id) => (id === sa.id ? sa : null) };

class MemRepo implements WebhookRepo {
  rows = new Map<string, PersonaWebhook>();
  async getByChannel(c: string) { return this.rows.get(c) ?? null; }
  async getByWebhookId(w: string) { return [...this.rows.values()].find((r) => r.webhookId === w) ?? null; }
  async upsert(r: PersonaWebhook) { this.rows.set(r.channelId, r); }
}

function world(channels: (FakeChannel | FakeForum)[], secrets: readonly string[] = [], extra: { taskMessages?: TaskMessageStore; boards?: BoardStore } = {}) {
  const swClient = fakeRestClient('app-sw', channels);
  const hqClient = fakeRestClient('app-hq', channels);
  const clients: Partial<Record<DeptId, Client>> = { software: swClient, hq: hqClient };
  const repo = new MemRepo();
  const webhooks = new WebhookSender(repo);
  const port = createDiscordPort({ client: (d) => clients[d] }, webhooks, org, {
    guildId: '1565649426943442944', adminRoleId: '1565000000000000001', inbound: async (m: Message) => ({ id: m.id }) as never, secrets, ...extra,
  });
  return { port, repo, webhooks };
}

const head = { kind: 'head' as const, dept: 'software' as DeptId };
const persona = { kind: 'persona' as const, personaId: 'system-analyst' };
const hqA = { kind: 'head' as const, dept: 'hq' as DeptId };

describe('SPEND-1 G2SP-05: the id stored for a raise card is the message that carries the buttons', () => {
  it('a card that splits returns the LAST message id (buttons are on the last message); any other post still returns the first', async () => {
    const ch = fakeChannel('ch-sw');
    const { port } = world([ch]);
    const id = 'ab'.repeat(16);
    const split = await port.post(hqA, { channelId: 'ch-sw' }, { type: 'approval', origin: 'governance', title: 'Department budget raise', body: 'long '.repeat(3000), spendOverrideId: id });
    expect(ch.sent.length).toBeGreaterThan(1);
    expect(split).toBe(`cm-ch-sw-${ch.sent.length}`);
    const comps = JSON.stringify(ch.sent.at(-1)!.components);
    expect(comps).toContain(`spendovr:${id}:approve`);
    expect(JSON.stringify(ch.sent[0]!.components ?? [])).not.toContain('spendovr');
    const before = ch.sent.length;
    const plain = await port.post(head, { channelId: 'ch-sw' }, { type: 'chat', body: 'long '.repeat(2500) });
    expect(ch.sent.length - before).toBeGreaterThan(1);
    expect(plain).toBe(`cm-ch-sw-${before + 1}`);
  });
});

describe('DiscordPort replyToId (WS13: a roll-up answers the person\'s own message)', () => {
  it('the first message replies to the stored snowflake without pinging; a bad id or a persona webhook adds no reference', async () => {
    const ch = fakeChannel('ch-sw');
    const { port } = world([ch]);
    await port.post(head, { channelId: 'ch-sw' }, { type: 'chat', body: 'summary' }, { replyToId: '1570000000000009001' });
    expect(ch.sent[0]).toMatchObject({ reply: { messageReference: '1570000000000009001', failIfNotExists: false }, allowedMentions: { parse: [] } });
    await port.post(head, { channelId: 'ch-sw' }, { type: 'chat', body: 'x' }, { replyToId: 'not-an-id' });
    expect(ch.sent[1]).not.toHaveProperty('reply');
    await port.post(head, { channelId: 'ch-sw' }, { type: 'chat', body: 'y' });
    expect(ch.sent[2]).not.toHaveProperty('reply');
  });

  it('RF12: a reply never pings its author (repliedUser:false), with and without a creator mention, and only the first split message replies', async () => {
    const ch = fakeChannel('ch-sw');
    const { port } = world([ch]);
    await port.post(head, { channelId: 'ch-sw' }, { type: 'chat', body: 'a' }, { replyToId: '1570000000000009001' });
    expect(ch.sent[0]).toMatchObject({ allowedMentions: { parse: [], repliedUser: false } });
    await port.post(head, { channelId: 'ch-sw' }, { type: 'chat', body: 'b' }, { replyToId: '1570000000000009001', mentionUserIds: ['1570000000000009002'] });
    expect(ch.sent[1]).toMatchObject({ reply: { messageReference: '1570000000000009001' }, allowedMentions: { parse: [], users: ['1570000000000009002'], repliedUser: false } });
    const before = ch.sent.length;
    await port.post(head, { channelId: 'ch-sw' }, { type: 'chat', body: 'long '.repeat(2500) }, { replyToId: '1570000000000009001' });
    const chunks = ch.sent.slice(before);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toHaveProperty('reply');
    for (const c of chunks.slice(1)) expect(c).not.toHaveProperty('reply');
  });
  it('RF12: a persona webhook post is not a reply and a post without a reply sets no repliedUser', async () => {
    const ch = fakeChannel('ch-sw');
    const { port } = world([ch]);
    await port.post(head, { channelId: 'ch-sw' }, { type: 'chat', body: 'plain' });
    expect(ch.sent[0]!.allowedMentions).not.toHaveProperty('repliedUser');
  });
});

describe('DiscordPort post-only rooms (WS8)', () => {
  it('history of an approvals room is never read, so card text cannot reach a model context', async () => {
    const room = fakeChannel('1570000000000000200', { history: [{ id: 'card-text' }] });
    const swClient = fakeRestClient('app-sw', [room]);
    const hqClient = fakeRestClient('app-hq', [room]);
    const port = createDiscordPort({ client: (d) => ({ software: swClient, hq: hqClient } as Partial<Record<DeptId, Client>>)[d] }, new WebhookSender(new MemRepo()), org, {
      guildId: '1565649426943442944', adminRoleId: '1565000000000000001', inbound: async (m: Message) => ({ id: m.id }) as never, postOnly: () => ['1570000000000000200'],
    });
    expect(await port.history('1570000000000000200', 10, hqA)).toEqual([]);
  });
});

describe('DiscordPort', () => {
  it('literal secrets (opts.secrets) are masked in outbound text, titles and fields, beyond the pattern masks (P24)', async () => {
    const ch = fakeChannel('ch-sw');
    const { port } = world([ch], ['sheets-secret-PLANTED-Zq81xK_77']);
    await port.post(head, { channelId: 'ch-sw' }, { type: 'chat', title: 't sheets-secret-PLANTED-Zq81xK_77', body: 'b sheets-secret-PLANTED-Zq81xK_77', fields: [{ name: 'n', value: 'v sheets-secret-PLANTED-Zq81xK_77' }] });
    const json = JSON.stringify(ch.sent);
    expect(json).not.toContain('sheets-secret-PLANTED');
    expect(json).toContain('[REDACTED]');
  });

  it('pin › pins with the actor client, refuses denied channels and maps Discord errors', async () => {
    const ch = fakeChannel('ch-sw');
    const th = fakeChannel('th-sw', { thread: 'ch-sw' });
    const deniedThread = fakeChannel('th-denied', { thread: DENIED });
    const noPerm = fakeChannel('ch-noperm', { pinErrorCode: 50013 });
    const gone = fakeChannel('ch-gone', { pinErrorCode: 10008 });
    const { port } = world([ch, th, deniedThread, fakeChannel(DENIED), noPerm, gone]);
    await port.pin(head, 'ch-sw', '1570000000000000001');
    await port.pin(head, 'th-sw', '1570000000000000002');
    expect(ch.pinned).toEqual(['1570000000000000001']);
    expect(th.pinned).toEqual(['1570000000000000002']);
    await expect(port.pin(head, DENIED, '1570000000000000001')).rejects.toBeInstanceOf(DeniedChannelError);
    await expect(port.pin(head, 'th-denied', '1570000000000000001')).rejects.toBeInstanceOf(DeniedChannelError);
    await expect(port.pin(head, 'ch-noperm', '1570000000000000001')).rejects.toMatchObject({ reason: 'missing_permission' });
    await expect(port.pin(head, 'ch-gone', '1570000000000000001')).rejects.toMatchObject({ reason: 'unknown_message' });
    await expect(port.pin(head, 'ch-gone', '1570000000000000001')).rejects.toBeInstanceOf(PinError);
    await expect(port.pin(head, 'ch-sw', 'not-a-snowflake')).rejects.toThrow(/message id/);
    expect(deniedThread.pinned).toHaveLength(0);
  });

  it('postFile › a text-like file and its name are masked with the literal secrets; a binary file is sent as it is (P24)', async () => {
    const SECRET = 'sheets-secret-PLANTED-Zq81xK_77';
    const ch = fakeChannel('ch-sw');
    const { port } = world([ch], [SECRET]);
    await port.postFile(head, { channelId: 'ch-sw' }, { type: 'chat', body: `b ${SECRET}` }, { name: `receipt-${SECRET}.csv`, data: Buffer.from(`a,b\n${SECRET},2\n`, 'utf8'), contentType: 'text/csv; charset=utf-8' });
    await port.postFile(head, { channelId: 'ch-sw' }, { type: 'chat', body: 'x' }, { name: 'p.png', data: Buffer.from(`PNG${SECRET}`), contentType: 'image/png' });
    const [csv, bin] = ch.sent as { files: { name?: string; attachment: Buffer }[] }[];
    expect(csv!.files[0]!.attachment.toString()).toBe('a,b\n[REDACTED],2\n');
    expect(csv!.files[0]!.name).not.toContain('PLANTED');
    expect(JSON.stringify(ch.sent.map((m) => (m as { embeds: unknown }).embeds))).not.toContain('PLANTED');
    expect(bin!.files[0]!.attachment.toString()).toContain(SECRET); // not text: untouched
  });

  it('postFile › sends the file with no mentions, a sanitized name, on the actor client; denied channels refused', async () => {
    const ch = fakeChannel('ch-sw');
    const deniedThread = fakeChannel('th-denied', { thread: DENIED });
    const { port } = world([ch, fakeChannel(DENIED), deniedThread]);
    const file = { name: '../receipt @everyone 2026.csv', data: Buffer.from('\uFEFFa,b\r\n', 'utf8'), contentType: 'text/csv; charset=utf-8' };
    const id = await port.postFile(head, { channelId: 'ch-sw' }, { type: 'chat', body: '| a | b |\n@everyone' }, file);
    expect(id).toBe('cm-ch-sw-1');
    const sent = ch.sent[0] as { allowedMentions: unknown; files: { name?: string; attachment: Buffer }[] };
    expect(sent.allowedMentions).toEqual({ parse: [] });
    expect(sent.files).toHaveLength(1);
    expect(sent.files[0]!.name).toBe('.._receipt__everyone_2026.csv');
    expect(sent.files[0]!.attachment.equals(file.data)).toBe(true);
    await port.postFile(persona, { channelId: 'ch-sw' }, { type: 'chat', body: 'x' }, file);
    expect(ch.sent).toHaveLength(2);
    await expect(port.postFile(head, { channelId: DENIED }, { type: 'chat', body: 'x' }, file)).rejects.toBeInstanceOf(DeniedChannelError);
    await expect(port.postFile(head, { channelId: DENIED, threadId: 'th-denied' }, { type: 'chat', body: 'x' }, file)).rejects.toBeInstanceOf(DeniedChannelError);
    expect(deniedThread.sent).toHaveLength(0);
  });

  it('postFile › G2-RL-08: a nonce rides on the first message with enforceNonce so the REST retry cannot duplicate it; without one neither is sent', async () => {
    const ch = fakeChannel('ch-sw');
    const { port } = world([ch]);
    const f = { name: 'a.zip', data: Buffer.from('PK'), contentType: 'application/zip' };
    await port.postFile(head, { channelId: 'ch-sw' }, { type: 'chat', body: 'x' }, { ...f, nonce: 'rel-7-abcdef12' });
    await port.postFile(head, { channelId: 'ch-sw' }, { type: 'chat', body: 'x' }, f);
    const [withN, without] = ch.sent as Record<string, unknown>[];
    expect(withN).toMatchObject({ nonce: 'rel-7-abcdef12', enforceNonce: true });
    expect(without).not.toHaveProperty('nonce');
    expect(without).not.toHaveProperty('enforceNonce');
  });

  it('post › R7 PF: a nonce in the options rides on the first message with enforceNonce (the install_plugin notice is deduplicated on a REST retry); without one neither is sent', async () => {
    const ch = fakeChannel('ch-sw');
    const { port } = world([ch]);
    await port.post(head, { channelId: 'ch-sw' }, { type: 'chat', body: 'x' }, { nonce: 'rel-7-abcdef12' });
    await port.post(head, { channelId: 'ch-sw' }, { type: 'chat', body: 'x' });
    const [withN, without] = ch.sent as Record<string, unknown>[];
    expect(withN).toMatchObject({ nonce: 'rel-7-abcdef12', enforceNonce: true });
    expect(without).not.toHaveProperty('nonce');
    expect(without).not.toHaveProperty('enforceNonce');
  });

  it('post to thread of denied parent throws', async () => {
    const deniedThread = fakeChannel('th-denied', { thread: DENIED });
    const deniedParent = fakeChannel(DENIED);
    const { port } = world([deniedThread, deniedParent]);
    const p = { type: 'chat' as const, body: 'x' };
    await expect(port.post(head, { channelId: DENIED, threadId: 'th-denied' }, p)).rejects.toBeInstanceOf(DeniedChannelError);
    await expect(port.post(head, { channelId: 'th-denied' }, p)).rejects.toBeInstanceOf(DeniedChannelError);
    await expect(port.post(persona, { channelId: 'th-denied' }, p)).rejects.toBeInstanceOf(DeniedChannelError);
    await expect(port.createThread('software', DENIED, 't')).rejects.toBeInstanceOf(DeniedChannelError);
    await expect(port.history('th-denied', 10, hqA)).rejects.toBeInstanceOf(DeniedChannelError);
    expect(deniedThread.sent).toHaveLength(0);
    expect(deniedParent.sent).toHaveLength(0);
    expect(deniedParent.created).toHaveLength(0);
  });

  it('outbound body with discord token is masked', async () => {
    const ch = fakeChannel('ch-sw');
    const { port } = world([ch]);
    await port.post(head, { channelId: 'ch-sw' }, { type: 'report', title: `t ${TOKEN}`, body: `here ${TOKEN}`, fields: [{ name: TOKEN, value: `v ${TOKEN}` }] });
    const json = JSON.stringify(ch.sent);
    expect(json).not.toContain(TOKEN);
    expect(json).toContain('[REDACTED]');
  });

  it('a persona post outside its own direct channel is refused and sends nothing', async () => {
    const other = fakeChannel('ch-other');
    const { port } = world([other, fakeChannel('ch-sw')]);
    await expect(port.post(persona, { channelId: 'ch-other' }, { type: 'chat', body: 'x' })).rejects.toThrow(/only in its own direct channel/);
    expect(other.sent).toHaveLength(0);
    expect(other.created).toHaveLength(0);
  });

  it('@everyone in model output does not ping', async () => {
    const ch = fakeChannel('ch-sw');
    const { port } = world([ch]);
    await port.post(head, { channelId: 'ch-sw' }, { type: 'alert', title: '@everyone', body: '@everyone @here <@&1565000000000000001>' });
    await port.post(persona, { channelId: 'ch-sw' }, { type: 'chat', body: '@everyone look' });
    expect(ch.sent).toHaveLength(1);
    expect(ch.sent[0]?.allowedMentions).toEqual({ parse: [] });
    const hookSends = ch.created[0]!.sent;
    expect(hookSends).toHaveLength(1);
    expect(hookSends[0]?.allowedMentions).toEqual({ parse: [] });
  });

  it('governance alert pings only the admin role', async () => {
    const ch = fakeChannel('ch-sw');
    const { port } = world([ch]);
    await port.post(head, { channelId: 'ch-sw' }, { type: 'alert', origin: 'governance', body: 'budget' });
    expect(ch.sent[0]?.allowedMentions).toEqual({ parse: [], roles: ['1565000000000000001'] });
  });

  it('persona posts through one lazily created webhook with its name and avatar', async () => {
    const ch = fakeChannel('ch-sw');
    const { port, repo } = world([ch, fakeChannel('th-1', { thread: 'ch-sw' })]);
    const p = { type: 'chat' as const, body: 'hi' };
    const [a, b] = await Promise.all([port.post(persona, { channelId: 'ch-sw' }, p), port.post(persona, { channelId: 'ch-sw', threadId: 'th-1' }, p)]);
    expect(ch.created).toHaveLength(1);
    expect(ch.created[0]!.name).toBe('assistant-personas');
    expect(ch.sent).toHaveLength(0); // the head never speaks as the persona
    const hook = ch.created[0]!;
    expect(hook.sent.map((s) => [s.username, s.avatarURL, s.threadId])).toEqual([
      ['System Analyst', 'https://cdn.example/sa.png', undefined],
      ['System Analyst', 'https://cdn.example/sa.png', 'th-1'],
    ]);
    expect(hook.sent[0]?.content).toContain('-# Software · System Analyst');
    expect([a, b]).toEqual(['wm-1', 'wm-2']);
    expect(await repo.getByChannel('ch-sw')).toEqual({ channelId: 'ch-sw', webhookId: hook.id, applicationId: 'app-sw', deptId: 'software' });
  });

  it('reuses the persisted webhook by id and never adopts one by name', async () => {
    const ours = fakeWebhook('hook-ours');
    const ch = fakeChannel('ch-sw', { webhooks: [fakeWebhook('hook-stranger'), ours] });
    const { port, repo } = world([ch]);
    await repo.upsert({ channelId: 'ch-sw', webhookId: 'hook-ours', applicationId: 'app-sw', deptId: 'software' });
    await port.post(persona, { channelId: 'ch-sw' }, { type: 'chat', body: 'a' });
    expect(ours.sent).toHaveLength(1);
    expect(ch.created).toHaveLength(0);

    const ch2 = fakeChannel('ch-sw', { webhooks: [fakeWebhook('hook-stranger')] });
    const w2 = world([ch2]);
    await w2.port.post(persona, { channelId: 'ch-sw' }, { type: 'chat', body: 'a' });
    expect(ch2.created).toHaveLength(1);
    expect((await w2.repo.getByChannel('ch-sw'))?.webhookId).toBe(ch2.created[0]!.id);
  });

  it('refuses a persona post without Manage Webhooks instead of falling back to the head', async () => {
    const ch = fakeChannel('ch-sw', { manageWebhooks: false });
    const { port } = world([ch]);
    await expect(port.post(persona, { channelId: 'ch-sw' }, { type: 'chat', body: 'a' })).rejects.toThrow(/Manage Webhooks/);
    expect(ch.sent).toHaveLength(0);
  });

  it('registers created webhooks for inbound attribution', async () => {
    const ch = fakeChannel('ch-sw');
    const { port, webhooks } = world([ch]);
    await port.post(persona, { channelId: 'ch-sw' }, { type: 'chat', body: 'a' });
    expect(await webhooks.lookup(ch.created[0]!.id)).toEqual({ applicationId: 'app-sw', deptId: 'software' });
    expect(await webhooks.lookup('nope')).toBeNull();
  });

  it('createThread, logDirect and logTask', async () => {
    const work = fakeChannel('ch-sw');
    const direct = fakeChannel('1565671325597700157');
    const tasks = fakeChannel('1565671253803794494');
    const { port } = world([work, direct, tasks]);
    expect(await port.createThread('software', 'ch-sw', 'x'.repeat(150))).toBe('th-1');
    expect((work.createdThreads[0]?.name as string).length).toBe(100);
    await port.logDirect(head, persona, `line1\n@everyone ${TOKEN}`);
    expect(direct.sent).toHaveLength(1);
    const d = direct.sent[0]!;
    expect(d.allowedMentions).toEqual({ parse: [] });
    expect(d.content).not.toContain('\n');
    expect(d.content).not.toContain(TOKEN);
    expect(d.content).toMatch(/^software → system-analyst: line1 @everyone/);
    await port.upsertTaskLog({ id: 't1', title: 'Build', description: 'desc', deptId: 'software', owner: head, requester: { kind: 'human', userId: 'u1' }, parentId: null, rootId: 't1', depth: 0, status: 'doing', threadId: null, turnsUsed: 0, costUsd: 0.01, estCostUsd: 0.1, blockedReason: null, origin: 'chat', channelId: null, sourceUserId: null, tainted: false });
    expect(tasks.sent).toHaveLength(1);
    expect(tasks.sent[0]?.allowedMentions).toEqual({ parse: [] });
  });

  it('history returns mapped messages oldest first; listGuildChannels hides denied channels', async () => {
    const ch = fakeChannel('ch-sw', { history: [{ id: 'm3' }, { id: 'm2' }] });
    const { port } = world([ch, fakeChannel(DENIED), fakeChannel('th-d', { thread: DENIED }), fakeChannel('1565649677280485457')]);
    expect((await port.history('ch-sw', 2, hqA)).map((m) => m.id)).toEqual(['m2', 'm3']);
    expect((await port.listGuildChannels()).map((c) => c.id)).toEqual(['ch-sw']);
  });

  it('HIST-1: history is read with the reading actor\'s own client; a persona uses its head\'s; hq only when the hq actor is passed; never another bot\'s wider access', async () => {
    const ch = fakeChannel('ch-sw', { history: [{ id: 'm1' }] });
    const mk = (swSees: boolean, hqSees: boolean) => {
      const clients: Partial<Record<DeptId, Client>> = { software: fakeRestClient('app-sw', swSees ? [ch] : []), hq: fakeRestClient('app-hq', hqSees ? [ch] : []) };
      return createDiscordPort({ client: (d) => clients[d] }, new WebhookSender(new MemRepo()), org, {
        guildId: '1565649426943442944', adminRoleId: '1565000000000000001', inbound: async (m: Message) => ({ id: m.id }) as never,
      });
    };
    // only the department bot can view the channel (the live failure): the head and its persona read, hq-fallback cannot
    const deptOnly = mk(true, false);
    expect((await deptOnly.history('ch-sw', 5, head)).map((m) => m.id)).toEqual(['m1']);
    expect((await deptOnly.history('ch-sw', 5, persona)).map((m) => m.id)).toEqual(['m1']);
    await expect(deptOnly.history('ch-sw', 5, hqA)).rejects.toThrow();
    // only hq can view: a department actor does NOT borrow hq's access
    const hqOnly = mk(false, true);
    await expect(hqOnly.history('ch-sw', 5, head)).rejects.toThrow();
    await expect(hqOnly.history('ch-sw', 5, persona)).rejects.toThrow();
    expect((await hqOnly.history('ch-sw', 5, hqA)).map((m) => m.id)).toEqual(['m1']);
    expect((await hqOnly.history('ch-sw', 5, { kind: 'head', dept: 'hq' })).map((m) => m.id)).toEqual(['m1']);
  });

  it('HIST-1: fetchMessage reads as the given actor and never borrows hq', async () => {
    const ch = fakeChannel('1570000000000000300', { history: [{ id: '1570000000000000301' }] });
    (ch as unknown as { messages: { fetch: unknown } }).messages.fetch = async (id: unknown) => (typeof id === 'string' ? { id } : new Map());
    const clients: Partial<Record<DeptId, Client>> = { software: fakeRestClient('app-sw', [ch]), hq: fakeRestClient('app-hq', []) };
    const port = createDiscordPort({ client: (d) => clients[d] }, new WebhookSender(new MemRepo()), org, {
      guildId: '1565649426943442944', adminRoleId: '1565000000000000001', inbound: async (m: Message) => ({ id: m.id }) as never,
    });
    expect(await port.fetchMessage('1570000000000000300', '1570000000000000301', head)).toEqual({ id: '1570000000000000301' });
    expect(await port.fetchMessage('1570000000000000300', '1570000000000000301', hqA)).toBeNull();
  });

  it('S29: history of #bot-log is never read, so AutoMod alert copies cannot reach a model context', async () => {
    const log = fakeChannel('1566454343820124352', { history: [{ id: 'flagged-user-message' }] });
    const logThread = fakeChannel('th-log', { thread: '1566454343820124352', history: [{ id: 'flagged-in-thread' }] });
    const { port } = world([log, logThread]);
    expect(await port.history('1566454343820124352', 10, hqA)).toEqual([]);
    expect(await port.history('th-log', 10, hqA)).toEqual([]);
  });
});

describe('DiscordPort.canMemberView (P16d)', () => {
  function viewWorld(o: { perms: Record<string, boolean | null>; channels?: string[]; noMember?: boolean }) {
    const guild = {
      channels: { fetch: async (id: string) => ((o.channels ?? ['ch-sw']).includes(id) ? { permissionsFor: (m: { id: string }) => (o.perms[m.id] === null ? null : { has: () => o.perms[m.id] === true }) } : null) },
      members: { fetch: async (id: string) => { if (o.noMember || !(id in o.perms)) throw new Error('Unknown Member'); return { id }; } },
    };
    const hq = { guilds: { cache: new Map([['1565649426943442944', guild]]) } } as unknown as Client;
    return createDiscordPort({ client: (d) => (d === 'hq' ? hq : undefined) }, new WebhookSender(new MemRepo()), org, {
      guildId: '1565649426943442944', adminRoleId: 'r', inbound: async () => null,
    });
  }
  it('reflects the member\'s real ViewChannel permission on the channel', async () => {
    const port = viewWorld({ perms: { yes: true, no: false } });
    expect(await port.canMemberView('yes', 'ch-sw')).toBe(true);
    expect(await port.canMemberView('no', 'ch-sw')).toBe(false);
  });
  it('is false for an unknown member, an unknown channel, no overwrite data or a denied channel', async () => {
    const port = viewWorld({ perms: { yes: true, nothing: null } });
    expect(await port.canMemberView('ghost', 'ch-sw')).toBe(false);
    expect(await port.canMemberView('yes', 'missing')).toBe(false);
    expect(await port.canMemberView('nothing', 'ch-sw')).toBe(false);
    expect(await port.canMemberView('yes', DENIED)).toBe(false);
  });
});

describe('DiscordPort mentions and DMs (R12)', () => {
  const praw = { kind: 'head' as const, dept: 'software' as DeptId };
  it('G2-04: onSent gets the id of every message of a split reply, from a head and from a persona webhook; post still returns the first', async () => {
    const long = { type: 'report' as const, title: 'T', body: ('word '.repeat(5000)).trim() }; // splits into at least 3 messages
    const ch = fakeChannel('ch-sw');
    const { port } = world([ch]);
    const headIds: string[][] = [];
    const first = await port.post(head, { channelId: 'ch-sw' }, long, { onSent: (ids) => headIds.push(ids) });
    expect(ch.sent.length).toBeGreaterThanOrEqual(3);
    expect(headIds).toHaveLength(1);
    expect(headIds[0]).toHaveLength(ch.sent.length);
    expect(headIds[0]![0]).toBe(first);
    const personaIds: string[][] = [];
    const pf = await port.post(persona, { channelId: 'ch-sw' }, long, { onSent: (ids) => personaIds.push(ids) });
    expect(personaIds[0]!.length).toBeGreaterThanOrEqual(3);
    expect(personaIds[0]![0]).toBe(pf);
    expect(new Set([...headIds[0]!, ...personaIds[0]!]).size).toBe(headIds[0]!.length + personaIds[0]!.length);
  });

  it('port › mentionUserIds sets allowedMentions.users to exactly those ids; default stays parse []', async () => {
    const ch = fakeChannel('ch-sw');
    const { port } = world([ch]);
    const p = { type: 'chat' as const, body: 'hello @everyone <@&99>' };
    await port.post(praw, { channelId: 'ch-sw' }, p);
    expect(ch.sent[0]).toMatchObject({ allowedMentions: { parse: [] } });
    expect(ch.sent[0]!.content).not.toMatch(/@everyone|<@&\d/); // plain content, neutralised
    await port.post(praw, { channelId: 'ch-sw' }, p, { mentionUserIds: ['111', '222'] });
    expect(ch.sent[1]).toMatchObject({ allowedMentions: { parse: [], users: ['111', '222'] } });
    expect(ch.sent[1]!.content).toMatch(/^<@111> <@222> hello /);
    await port.post(praw, { channelId: 'ch-sw' }, p, { mentionUserIds: ['not-an-id', '333'] });
    expect(ch.sent[2]).toMatchObject({ allowedMentions: { parse: [], users: ['333'] } });
    expect(JSON.stringify(ch.sent[2])).not.toContain('not-an-id');
  });

  it('dm sends embeds with no mentions; closed DMs return false', async () => {
    const sent: Record<string, unknown>[] = [];
    const users = { fetch: async (id: string) => ({ id, send: async (m: Record<string, unknown>) => { if (id === 'closed') throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 }); sent.push(m); return { id: 'dm-1' }; } }) };
    const base = fakeRestClient('app-sw', []);
    const client = Object.assign(base, { users }) as Client;
    const port = createDiscordPort({ client: () => client }, new WebhookSender(new MemRepo()), org, { guildId: '1565649426943442944', adminRoleId: 'a', inbound: async () => null });
    expect(await port.dm(praw, '111', { type: 'chat', body: 'hi <@&99>' })).toBe('sent');
    expect(sent[0]).toMatchObject({ allowedMentions: { parse: [] } });
    expect(sent[0]).not.toHaveProperty('content');
    expect(await port.dm(praw, 'closed', { type: 'chat', body: 'hi' })).toBe('failed');
  });
});

describe('DiscordPort.closeCard (admin console cards, Gate 1 C6)', () => {
  const withMessages = (ch: FakeChannel, msgs: Record<string, { author: string; edits: Record<string, unknown>[] }>) => {
    (ch as unknown as { messages: unknown }).messages = {
      fetch: async (id: string) => {
        const m = msgs[id];
        if (!m) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        return { author: { id: m.author }, edit: async (o: Record<string, unknown>) => void m.edits.push(o) };
      },
    };
  };

  it('removes the buttons of hq\'s own card message and writes the masked note; a message of someone else is left alone; a gone message is not an error', async () => {
    const ch = fakeChannel('ch-sw');
    const msgs = { card: { author: 'app-hq', edits: [] as Record<string, unknown>[] }, other: { author: 'someone', edits: [] as Record<string, unknown>[] } };
    withMessages(ch, msgs);
    const { port } = world([ch], ['literal-secret-value-123']);
    await port.closeCard('ch-sw', 'card', 'Confirmed. literal-secret-value-123');
    expect(msgs.card.edits).toEqual([{ content: 'Confirmed. [REDACTED]', components: [], allowedMentions: { parse: [] } }]);
    await port.closeCard('ch-sw', 'other', 'x');
    expect(msgs.other.edits).toEqual([]);
    await expect(port.closeCard('ch-sw', 'missing', 'x')).resolves.toBeUndefined();
    await expect(port.closeCard(DENIED, 'card', 'x')).rejects.toBeInstanceOf(DeniedChannelError);
  });
});

describe('DiscordPort.updateCard (batched approval cards, APPROVAL-BATCH-1 B1)', () => {
  const member = (id: number, status: 'pending' | 'approved' = 'pending') => ({
    id, taskId: 't-1', reason: 'r', estCostUsd: 0, requestedBy: 'head:praw', status, decidedBy: null, createdAt: new Date(), decidedAt: null,
    toolName: 'fetch_page', toolInput: { url: `https://example.com/${id}` }, inputSha256: 'a'.repeat(64), kind: 'tool',
  });
  const payload = () => batchApprovalPayload([member(1, 'approved'), member(2), member(3)] as never, { id: 5, digest: 'abcdef012345' });
  type Edit = Record<string, unknown>;
  const withMessages = (ch: FakeChannel, msgs: Record<string, { author: string; edits: Edit[]; fail?: unknown }>) => {
    (ch as unknown as { messages: unknown }).messages = {
      fetch: async (id: string) => {
        const m = msgs[id];
        if (!m) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        return { author: { id: m.author }, edit: async (o: Edit) => { if (m.fail) throw m.fail; m.edits.push(o); } };
      },
    };
  };

  it('edits only hq\'s own message, with exactly one embed and the batch rows; a foreign author or a gone message gives false and no edit; other errors rethrow', async () => {
    const ch = fakeChannel('ch-sw');
    const msgs = {
      card: { author: 'app-hq', edits: [] as Edit[] }, other: { author: 'someone', edits: [] as Edit[] },
      broken: { author: 'app-hq', edits: [] as Edit[], fail: Object.assign(new Error('boom'), { code: 50013 }) },
    };
    withMessages(ch, msgs);
    const { port } = world([ch]);
    expect(await port.updateCard('ch-sw', 'card', payload())).toBe(true);
    expect(msgs.card.edits).toHaveLength(1);
    const edit = msgs.card.edits[0] as { content: string; embeds: { fields: unknown[] }[]; components: { components: { custom_id: string }[] }[]; allowedMentions: unknown };
    expect(edit.content).toBe('');
    expect(edit.allowedMentions).toEqual({ parse: [] });
    expect(edit.embeds).toHaveLength(1);
    expect(edit.embeds[0]!.fields).toHaveLength(3);
    expect(edit.components.flatMap((r) => r.components.map((c) => c.custom_id))).toEqual([
      'approval:b:5:abcdef012345:approve', 'approval:b:5:abcdef012345:reject', 'approval:b:5:abcdef012345:ask',
      'approval:2:approve', 'approval:2:reject', 'approval:3:approve', 'approval:3:reject',
    ]);
    expect(await port.updateCard('ch-sw', 'other', payload())).toBe(false);
    expect(msgs.other.edits).toEqual([]);
    expect(await port.updateCard('ch-sw', 'missing', payload())).toBe(false);
    await expect(port.updateCard('ch-sw', 'broken', payload())).rejects.toThrow('boom');
    await expect(port.updateCard(DENIED, 'card', payload())).rejects.toBeInstanceOf(DeniedChannelError);
  });

  it('a payload that would not render as one message with one embed is refused before any fetch', async () => {
    const ch = fakeChannel('ch-sw');
    const msgs = { card: { author: 'app-hq', edits: [] as Edit[] } };
    withMessages(ch, msgs);
    const { port } = world([ch]);
    await expect(port.updateCard('ch-sw', 'card', { type: 'approval', origin: 'governance', title: 'x', body: 'y'.repeat(7000), batchButtons: { batchId: 1, digest: 'abcdef012345', items: [{ id: 1, pending: true }] } })).rejects.toThrow();
    expect(msgs.card.edits).toEqual([]);
  });
});

// ---- Part B: cards edited in place ----------------------------------------------------------------------------------
const TASKS_CH = '1565671253803794494';
const SNOW = (n: number) => `157000000000000${String(n).padStart(4, '0')}`;
const sampleTask = (over: Record<string, unknown> = {}) => ({ id: 't1', title: 'Build', description: 'desc', deptId: 'software' as DeptId, owner: head, requester: { kind: 'human' as const, userId: 'u1' }, parentId: null, rootId: 't1', depth: 0, status: 'doing' as const, threadId: null, turnsUsed: 0, costUsd: 0.01, estCostUsd: 0.1, blockedReason: null, origin: 'chat' as const, channelId: null, sourceUserId: null, tainted: false, ...over });

class MemStore implements TaskMessageStore, BoardStore {
  ids = new Map<string, string>();
  boardRows = new Map<string, { channelId: string; messageId: string; digest: string | null }>();
  async messageId(t: string, k: 'log' | 'card') { return this.ids.get(`${t}:${k}`) ?? null; }
  async claimMessage(t: string, k: 'log' | 'card', m: string) { if (this.ids.has(`${t}:${k}`)) return false; this.ids.set(`${t}:${k}`, m); return true; }
  async replaceMessage(t: string, k: 'log' | 'card', old: string, m: string) { if (this.ids.get(`${t}:${k}`) !== old) return false; this.ids.set(`${t}:${k}`, m); return true; }
  async get(key: string) { return this.boardRows.get(key) ?? null; }
  async set(key: string, m: { channelId: string; messageId: string; digest: string | null }) { this.boardRows.set(key, m); }
  async setDigest(key: string, d: string) { const r = this.boardRows.get(key); if (r) r.digest = d; }
}

/** A channel whose send() hands out snowflake ids and whose messages can be fetched, edited, deleted, pinned. */
function editable(id: string, o: { authorId?: string; editError?: number | 'other' } = {}) {
  const ch = fakeChannel(id);
  const live = new Map<string, { author: string; edits: Record<string, unknown>[]; deleted: boolean; pinned: boolean }>();
  let n = 0;
  ch.send = async (m: Record<string, unknown>) => {
    ch.sent.push(m);
    const mid = SNOW(++n);
    live.set(mid, { author: o.authorId ?? 'app-hq', edits: [], deleted: false, pinned: false });
    return { id: mid };
  };
  (ch as unknown as { messages: unknown }).messages = {
    fetch: async (mid: string) => {
      const m = live.get(mid);
      if (!m || m.deleted) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      return {
        author: { id: m.author },
        edit: async (e: Record<string, unknown>) => {
          if (o.editError === 'other') throw Object.assign(new Error('boom'), { code: 50013 });
          m.edits.push(e);
        },
        delete: async () => void (m.deleted = true),
        pin: async () => void (m.pinned = true),
      };
    },
  };
  return { ch, live };
}

describe('DiscordPort.upsertTaskLog (one #tasks card per task, edited in place)', () => {
  it('no stored id: sends once and stores the id; a changed status edits that message (new colour); the same digest does not edit', async () => {
    const store = new MemStore();
    const { ch, live } = editable(TASKS_CH);
    const { port } = world([ch], [], { taskMessages: store });
    await port.upsertTaskLog(sampleTask());
    expect(ch.sent).toHaveLength(1);
    expect(store.ids.get('t1:log')).toBe(SNOW(1));
    await port.upsertTaskLog(sampleTask()); // unchanged
    expect(ch.sent).toHaveLength(1);
    expect(live.get(SNOW(1))!.edits).toHaveLength(0);
    await port.upsertTaskLog(sampleTask({ status: 'done', costUsd: 0.5 }));
    expect(ch.sent).toHaveLength(1);
    const edits = live.get(SNOW(1))!.edits;
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ allowedMentions: { parse: [] } });
    expect((edits[0]!.embeds as { color: number }[])[0]!.color).toBe(0x2ecc71);
    await port.upsertTaskLog(sampleTask({ status: 'done', costUsd: 0.5 }));
    expect(live.get(SNOW(1))!.edits).toHaveLength(1);
  });

  it('Unknown Message (10008): reposts once and stores the new id', async () => {
    const store = new MemStore();
    const { ch, live } = editable(TASKS_CH);
    const { port } = world([ch], [], { taskMessages: store });
    await port.upsertTaskLog(sampleTask());
    live.get(SNOW(1))!.deleted = true; // a moderator deleted the card
    await port.upsertTaskLog(sampleTask({ status: 'review' }));
    expect(ch.sent).toHaveLength(2);
    expect(store.ids.get('t1:log')).toBe(SNOW(2));
    await port.upsertTaskLog(sampleTask({ status: 'done' }));
    expect(ch.sent).toHaveLength(2); // edited, not reposted
    expect(live.get(SNOW(2))!.edits).toHaveLength(1);
  });

  it('any other edit error keeps the stored id and does not repost', async () => {
    const store = new MemStore();
    const { ch } = editable(TASKS_CH, { editError: 'other' });
    const { port } = world([ch], [], { taskMessages: store });
    await port.upsertTaskLog(sampleTask());
    await expect(port.upsertTaskLog(sampleTask({ status: 'done' }))).rejects.toThrow('boom');
    expect(ch.sent).toHaveLength(1);
    expect(store.ids.get('t1:log')).toBe(SNOW(1));
  });

  it('a stored id of a message someone else posted is never edited or replaced (TW17)', async () => {
    const store = new MemStore();
    const { ch, live } = editable(TASKS_CH, { authorId: 'someone-else' });
    store.ids.set('t1:log', SNOW(1));
    live.set(SNOW(1), { author: 'someone-else', edits: [], deleted: false, pinned: false });
    const { port } = world([ch], [], { taskMessages: store });
    await expect(port.upsertTaskLog(sampleTask())).rejects.toThrow(/not posted by this client/);
    expect(live.get(SNOW(1))!.edits).toHaveLength(0);
    expect(ch.sent).toHaveLength(0);
  });

  it('recovery re-logging a stored task edits or skips, never posts again; concurrent upserts send once', async () => {
    const store = new MemStore();
    const { ch } = editable(TASKS_CH);
    const { port } = world([ch], [], { taskMessages: store });
    await Promise.all([port.upsertTaskLog(sampleTask()), port.upsertTaskLog(sampleTask()), port.upsertTaskLog(sampleTask({ status: 'todo' }))]);
    expect(ch.sent).toHaveLength(1);
    // "boot": a new port instance (empty digest memory) with the same store
    const { port: after } = world([ch], [], { taskMessages: store });
    await after.upsertTaskLog(sampleTask({ status: 'todo' }));
    expect(ch.sent).toHaveLength(1);
  });

  it('the secret in a task is masked in the edit as in the send', async () => {
    const store = new MemStore();
    const { ch, live } = editable(TASKS_CH);
    const { port } = world([ch], ['literal-secret-value-123'], { taskMessages: store });
    await port.upsertTaskLog(sampleTask());
    await port.upsertTaskLog(sampleTask({ description: 'now literal-secret-value-123' }));
    expect(JSON.stringify(live.get(SNOW(1))!.edits)).not.toContain('literal-secret-value-123');
  });
});

describe('DiscordPort.upsertTaskCard (thread card)', () => {
  it('posts as the owner in the thread, then edits in place with the status colour; never pings on edit', async () => {
    const store = new MemStore();
    const work = fakeChannel('ch-sw');
    const { ch: th, live } = editable('th-sw', { authorId: 'app-sw' });
    (th as unknown as { parentId: string; isThread: () => boolean }).parentId = 'ch-sw';
    (th as unknown as { isThread: () => boolean }).isThread = () => true;
    const { port } = world([work, th], [], { taskMessages: store });
    const card = { type: 'task' as const, title: 'Build', body: 'b' };
    const id1 = await port.upsertTaskCard({ id: 't1', status: 'todo' }, head, { channelId: 'ch-sw', threadId: 'th-sw' }, card, { mentionUserIds: ['1570000000000000099'] });
    expect(th.sent).toHaveLength(1);
    expect(store.ids.get('t1:card')).toBe(id1);
    const id2 = await port.upsertTaskCard({ id: 't1', status: 'blocked' }, head, { channelId: 'ch-sw', threadId: 'th-sw' }, card);
    expect(id2).toBe(id1);
    expect(th.sent).toHaveLength(1);
    const e = live.get(id1!)!.edits;
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ allowedMentions: { parse: [] } });
    expect((e[0]!.embeds as { color: number }[])[0]!.color).toBe(0xe74c3c);
    // edit-only (task changes, boot recovery): a task with no stored card is not given one
    expect(await port.upsertTaskCard({ id: 'old', status: 'todo' }, head, { channelId: 'ch-sw', threadId: 'th-sw' }, card, undefined, true)).toBeNull();
    expect(th.sent).toHaveLength(1);
  });
});

describe('DiscordPort.upsertBoard (pinned summary board)', () => {
  it('sends and pins once, edits only when the content changed (digest survives a restart)', async () => {
    const store = new MemStore();
    const { ch, live } = editable(TASKS_CH);
    const { port } = world([ch], [], { boards: store });
    await port.upsertBoard('tasks-board', { type: 'task', title: 'Task board', body: 'Doing (1)\n#a b c' });
    expect(ch.sent).toHaveLength(1);
    expect(live.get(SNOW(1))!.pinned).toBe(true);
    await port.upsertBoard('tasks-board', { type: 'task', title: 'Task board', body: 'Doing (1)\n#a b c' });
    const { port: after } = world([ch], [], { boards: store }); // restart: no in-memory digest
    await after.upsertBoard('tasks-board', { type: 'task', title: 'Task board', body: 'Doing (1)\n#a b c' });
    expect(live.get(SNOW(1))!.edits).toHaveLength(0);
    await after.upsertBoard('tasks-board', { type: 'task', title: 'Task board', body: 'Doing (2)' });
    expect(live.get(SNOW(1))!.edits).toHaveLength(1);
    expect(ch.sent).toHaveLength(1);
    expect(live.get(SNOW(1))!.edits[0]).toMatchObject({ allowedMentions: { parse: [] } });
  });
});

describe('DiscordPort.upsertBoard in another channel (WS10 dashboard)', () => {
  it('posts and pins in the given channel under its own key, leaving the tasks board alone', async () => {
    const store = new MemStore();
    const { ch, live } = editable('1570000000000000555');
    const { port } = world([ch], [], { boards: store });
    await port.upsertBoard('status-board', { type: 'task', origin: 'governance', title: 'Company status', body: 'open 1' }, '1570000000000000555');
    expect(ch.sent).toHaveLength(1);
    expect(live.get(SNOW(1))!.pinned).toBe(true);
    expect((await store.get('status-board'))?.channelId).toBe('1570000000000000555');
    await port.upsertBoard('status-board', { type: 'task', origin: 'governance', title: 'Company status', body: 'open 2' }, '1570000000000000555');
    expect(ch.sent).toHaveLength(1);
    expect(live.get(SNOW(1))!.edits).toHaveLength(1);
  });
});

describe('DiscordPort forums (TW9, TW10)', () => {
  const TAGS = [{ id: 'tag-1', name: 'faq' }, { id: 'tag-2', name: 'howto' }];

  it('createForumPost › sends the starter message with redaction, no mentions, existing tags only, and returns the post id', async () => {
    const SECRET = 'sheets-secret-PLANTED-Zq81xK_77';
    const forum = fakeForum('forum-sw', { tags: TAGS });
    const { port } = world([forum], [SECRET]);
    const sentIds: string[][] = [];
    const r = await port.createForumPost('software', 'forum-sw', { title: `T ${SECRET} ${'x'.repeat(200)}`, body: `hello @everyone <@&123> ${SECRET}`, tagIds: ['tag-2'] }, { onSent: (ids) => sentIds.push(ids) });
    expect(r).toEqual({ postId: 'post-1', messageId: 'post-1' });
    const [c] = forum.created as { name: string; message: { embeds: unknown; allowedMentions: unknown }; appliedTags: string[] }[];
    expect(c!.name.length).toBe(100);
    expect(c!.appliedTags).toEqual(['tag-2']);
    expect(c!.message.allowedMentions).toEqual({ parse: [] });
    expect(JSON.stringify(c)).not.toContain('PLANTED');
    expect(sentIds).toEqual([['post-1']]);
  });

  it('createForumPost › refuses an unknown tag, a denied forum, a text channel and a missing client', async () => {
    const forum = fakeForum('forum-sw', { tags: TAGS });
    const denied = fakeForum(DENIED);
    const text = fakeChannel('ch-sw');
    const { port } = world([forum, denied, text]);
    await expect(port.createForumPost('software', 'forum-sw', { title: 't', body: 'b', tagIds: ['nope'] })).rejects.toThrow(/tag/);
    await expect(port.createForumPost('software', DENIED, { title: 't', body: 'b', tagIds: [] })).rejects.toBeInstanceOf(DeniedChannelError);
    await expect(port.createForumPost('software', 'ch-sw', { title: 't', body: 'b', tagIds: [] })).rejects.toThrow(/not a forum/);
    await expect(port.createForumPost('finance', 'forum-sw', { title: 't', body: 'b', tagIds: [] })).rejects.toThrow(/offline/);
    expect(forum.created).toEqual([]);
  });

  it('createThread on a forum is refused (a forum needs a starter message: use createForumPost)', async () => {
    const forum = fakeForum('forum-sw');
    const { port } = world([forum]);
    await expect(port.createThread('software', 'forum-sw', 'x')).rejects.toThrow();
    expect(forum.created).toEqual([]);
  });

  it('forumInfo › tags for a forum; null for a text channel, a denied forum and an unknown id', async () => {
    const { port } = world([fakeForum('forum-sw', { tags: TAGS }), fakeForum(DENIED), fakeChannel('ch-sw')]);
    expect(await port.forumInfo('forum-sw')).toEqual({ id: 'forum-sw', name: 'forum-forum-sw', tags: TAGS });
    expect(await port.forumInfo('ch-sw')).toBeNull();
    expect(await port.forumInfo(DENIED)).toBeNull();
    expect(await port.forumInfo('nope')).toBeNull();
  });

  it('listForumPosts › newest first with tag names and the first message; a denied forum throws', async () => {
    const forum = fakeForum('forum-sw', { tags: TAGS, posts: [
      { id: 'p-old', name: 'old', starter: 'first old', createdTimestamp: 1, messageCount: 2 },
      { id: 'p-new', name: 'new', starter: 'first new', createdTimestamp: 9, appliedTags: ['tag-1'], messageCount: 4 },
    ] });
    const { port } = world([forum, fakeForum(DENIED)]);
    expect(await port.listForumPosts('forum-sw', 10)).toEqual([
      { id: 'p-new', parentId: 'forum-sw', name: 'new', tags: ['faq'], first: 'first new', replies: 4 },
      { id: 'p-old', parentId: 'forum-sw', name: 'old', tags: [], first: 'first old', replies: 2 },
    ]);
    await expect(port.listForumPosts(DENIED, 5)).rejects.toBeInstanceOf(DeniedChannelError);
  });
});

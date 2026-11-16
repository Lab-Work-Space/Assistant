import { describe, expect, it } from 'vitest';
import type { Client, Message } from 'discord.js';
import { createHash } from 'node:crypto';
import { handlesIn } from '../company/handles.js';
import type { DeptId } from '../core/index.js';
import type { Department, Persona, PersonaWebhook } from '../db/repos/index.js';
import { fakeChannel, fakeRestClient, type FakeChannel } from '../tests/fakes/discordClient.js';
import { createDiscordPort, type BoardStore, type PortOrg, type TaskMessageStore } from './port.js';
import { WebhookSender, type WebhookRepo } from './webhooks.js';

const SW_CH = '1570000000000000101';
const TH = '1570000000000000102';
const ROOM = '1570000000000000103';
const sw: Department = { id: 'software', name: 'Software', categoryNamePattern: 'soft', workChannelId: SW_CH, color: 0x123456, model: null, provider: null, enabled: true };
const sa: Persona = { id: 'system-analyst', deptId: 'software', name: 'System Analyst', avatarUrl: null, promptRef: 'x', model: null, provider: null, tools: [], directChannelId: ROOM, enabled: true };
const LONG_ID = 'p'.repeat(64);
const longP: Persona = { ...sa, id: LONG_ID, name: 'Long', directChannelId: ROOM };
const org: PortOrg = { dept: (id) => (id === 'software' ? sw : null), persona: (id) => (id === sa.id ? sa : id === LONG_ID ? longP : null) };
const SNOW = (n: number) => `157000000000000${String(n).padStart(4, '0')}`;
const head = { kind: 'head' as const, dept: 'software' as DeptId };

class MemRepo implements WebhookRepo {
  rows = new Map<string, PersonaWebhook>();
  async getByChannel(c: string) { return this.rows.get(c) ?? null; }
  async getByWebhookId(w: string) { return [...this.rows.values()].find((r) => r.webhookId === w) ?? null; }
  async upsert(r: PersonaWebhook) { this.rows.set(r.channelId, r); }
}
class Store implements TaskMessageStore, BoardStore {
  ids = new Map<string, string>();
  rows = new Map<string, { channelId: string; messageId: string; digest: string | null }>();
  failSet = false;
  sets = 0;
  async messageId(t: string, k: string) { return this.ids.get(`${t}:${k}`) ?? null; }
  async claimMessage(t: string, k: string, m: string) { if (this.ids.has(`${t}:${k}`)) return false; this.ids.set(`${t}:${k}`, m); return true; }
  async replaceMessage(t: string, k: string, old: string, m: string) { if (this.ids.get(`${t}:${k}`) !== old) return false; this.ids.set(`${t}:${k}`, m); return true; }
  async get(key: string) { return this.rows.get(key) ?? null; }
  async set(key: string, m: { channelId: string; messageId: string; digest: string | null }) { this.sets++; if (this.failSet) throw new Error('store down'); this.rows.set(key, m); }
  async setDigest(key: string, d: string) { const r = this.rows.get(key); if (r) r.digest = d; }
}

/** A text channel (or thread) with live messages: bot-sent ones are editable, edits recorded; `gone` ids answer 10008. */
function room(id: string, o: { thread?: string } = {}) {
  const ch = fakeChannel(id, o.thread ? { thread: o.thread } : {});
  const live = new Map<string, { author: string; edits: Record<string, unknown>[] }>();
  const gone = new Set<string>();
  let n = id === ROOM ? 50 : 0;
  ch.send = async (m: Record<string, unknown>) => { ch.sent.push(m); const mid = SNOW(++n); live.set(mid, { author: 'app-sw', edits: [] }); return { id: mid }; };
  (ch as unknown as { messages: unknown }).messages = {
    fetch: async (mid: string) => {
      const m = live.get(mid);
      if (!m || gone.has(mid)) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      return { author: { id: m.author }, edit: async (e: Record<string, unknown>) => void m.edits.push(e) };
    },
    pin: async (mid: string) => { if (pinCode !== undefined) throw Object.assign(new Error('x'), { code: pinCode }); ch.pinned.push(mid); },
  };
  let pinCode: number | undefined;
  return { ch, live, gone, setPinCode: (c?: number) => { pinCode = c; }, nextId: () => n };
}

/** A persona webhook stand-in that can send and edit and hands out snowflake ids. */
function hook(ch: FakeChannel, nextId: () => number) {
  const sent: Record<string, unknown>[] = [];
  const edits: { id: string; body: Record<string, unknown> }[] = [];
  const gone = new Set<string>();
  let n = nextId();
  const h = {
    id: '1570000000000000900', name: 'assistant-personas', token: 't', sent, edits, gone,
    send: async (m: Record<string, unknown>) => { sent.push(m); return { id: SNOW(++n) }; },
    editMessage: async (id: string, body: Record<string, unknown>) => { if (gone.has(id)) throw Object.assign(new Error('Unknown Message'), { code: 10008 }); edits.push({ id, body }); },
  };
  (ch as unknown as { fetchWebhooks: () => Promise<Map<string, unknown>> }).fetchWebhooks = async () => new Map([[h.id, h]]);
  return h;
}

function world(channels: FakeChannel[], store: Store, secrets: readonly string[] = []) {
  const repo = new MemRepo();
  repo.rows.set(ROOM, { channelId: ROOM, webhookId: '1570000000000000900', applicationId: 'app-sw', deptId: 'software' } as PersonaWebhook);
  const client = fakeRestClient('app-sw', channels);
  const port = createDiscordPort({ client: () => client as Client }, new WebhookSender(repo), org, {
    guildId: '1565649426943442944', adminRoleId: '1565000000000000001', inbound: async (m: Message) => ({ id: m.id }) as never, secrets, taskMessages: store, boards: store,
  });
  return { port };
}
const dirty = (extra = '') => ({ type: 'chat' as const, body: `➜ Handoff #abc: head of finance → head of software\nAsk: review @CFO plan ${extra}\nThread: https://discord.com/channels/1/2` });

describe('TEAMTALK upsertHandoff (H1)', () => {
  const setup = () => {
    const work = room(SW_CH);
    const th = room(TH, { thread: SW_CH });
    const store = new Store();
    const { port } = world([work.ch, th.ch], store);
    return { th, store, port };
  };
  const target = { channelId: SW_CH, threadId: TH };

  it('first send is plain, defanged, link embeds suppressed, one stored id; later calls edit that message WITH content (G1-09), defanged', async () => {
    const { th, store, port } = setup();
    const sent: string[][] = [];
    const id = await port.upsertHandoff({ id: 'c1', status: 'todo' }, head, target, dirty(), { onSent: (ids) => sent.push(ids) });
    expect(th.ch.sent).toHaveLength(1);
    expect(handlesIn(String(th.ch.sent[0]!.content))).toEqual([]);
    expect(th.ch.sent[0]).toMatchObject({ flags: 4, allowedMentions: { parse: [] } });
    expect(String(th.ch.sent[0]!.content)).toContain('Handoff #abc');
    expect(store.ids.get('c1:handoff')).toBe(id);
    expect(sent).toEqual([[id]]);
    await port.upsertHandoff({ id: 'c1', status: 'doing' }, head, target, { type: 'chat', body: 'Status: doing @CFO' }, undefined, true);
    expect(th.ch.sent).toHaveLength(1);
    const e = th.live.get(id!)!.edits;
    expect(e).toHaveLength(1);
    expect(String(e[0]!.content)).toContain('Status: doing');
    expect(handlesIn(String(e[0]!.content))).toEqual([]);
    expect(e[0]).toMatchObject({ allowedMentions: { parse: [] } });
  });

  it('T7: an edit-only call with no stored id posts nothing; only a creation sends; a status event racing the creation yields exactly one H1', async () => {
    const { th, port } = setup();
    expect(await port.upsertHandoff({ id: 'c2', status: 'doing' }, head, target, dirty(), undefined, true)).toBeNull();
    expect(th.ch.sent).toHaveLength(0);
    const results = await Promise.all([
      port.upsertHandoff({ id: 'c3', status: 'todo' }, head, target, dirty()),
      port.upsertHandoff({ id: 'c3', status: 'doing' }, head, target, dirty(), undefined, true), // the doing event arrives while the creation is in flight
    ]);
    expect(th.ch.sent).toHaveLength(1);
    expect(results[0]).not.toBeNull();
  });

  it('a 10008 on the edit reposts once and replaces the stored id; the repost reports its id (provenance)', async () => {
    const { th, store, port } = setup();
    const first = (await port.upsertHandoff({ id: 'c4', status: 'todo' }, head, target, dirty()))!;
    th.gone.add(first);
    const sent: string[][] = [];
    const second = await port.upsertHandoff({ id: 'c4', status: 'doing' }, head, target, { type: 'chat', body: 'again' }, { onSent: (ids) => sent.push(ids) }, true);
    expect(th.ch.sent).toHaveLength(2);
    expect(second).not.toBe(first);
    expect(store.ids.get('c4:handoff')).toBe(second);
    expect(sent).toEqual([[second!]]);
  });

  it('by a persona (the parent owner) it goes through the persona webhook, edits through webhooks.edit with content', async () => {
    const r = room(ROOM);
    const store = new Store();
    const h = hook(r.ch, r.nextId);
    const { port } = world([r.ch], store);
    const id = await port.upsertHandoff({ id: 'c5', status: 'todo' }, { kind: 'persona', personaId: sa.id }, { channelId: ROOM }, dirty());
    expect(h.sent).toHaveLength(1);
    expect(r.ch.sent).toHaveLength(0);
    await port.upsertHandoff({ id: 'c5', status: 'doing' }, { kind: 'persona', personaId: sa.id }, { channelId: ROOM }, { type: 'chat', body: 'Status: doing' }, undefined, true);
    expect(h.edits).toHaveLength(1);
    expect(h.edits[0]).toMatchObject({ id, body: { content: expect.stringContaining('Status: doing'), allowedMentions: { parse: [] } } });
  });
});

describe('TEAMTALK upsertRoomBoard', () => {
  const setup = (personaId = sa.id) => {
    const r = room(ROOM);
    const store = new Store();
    const h = hook(r.ch, r.nextId);
    const { port } = world([r.ch], store);
    const actor = { kind: 'persona' as const, personaId };
    return { r, store, h, port, actor };
  };
  const board = (n: number) => ({ type: 'chat' as const, body: `Board ${n}\nNow: review @CFO plan` });

  it('T4: sent by the persona webhook (not the head channel), defanged, pinned by the head client, key is room: + 32 hex', async () => {
    const { r, store, h, port, actor } = setup();
    const sent: string[][] = [];
    const res = await port.upsertRoomBoard(actor, ROOM, board(1), { onSent: (ids) => sent.push(ids) });
    expect(res).toEqual({ pin: 'ok' });
    expect(h.sent).toHaveLength(1);
    expect(r.ch.sent).toHaveLength(0);
    expect(handlesIn(String(h.sent[0]!.content))).toEqual([]);
    expect(h.sent[0]).toMatchObject({ username: 'System Analyst', allowedMentions: { parse: [] }, flags: 4 });
    const key = `room:${createHash('sha256').update(sa.id).digest('hex').slice(0, 32)}`;
    expect(store.rows.get(key)).toMatchObject({ channelId: ROOM });
    expect(r.ch.pinned).toEqual([store.rows.get(key)!.messageId]);
    expect(sent).toHaveLength(1);
  });

  it('T8 spec (e): the next calls edit (content updated), never repost; an identical board is not edited again', async () => {
    const { r, store, h, port, actor } = setup();
    await port.upsertRoomBoard(actor, ROOM, board(1));
    await port.upsertRoomBoard(actor, ROOM, board(1));
    await port.upsertRoomBoard(actor, ROOM, board(2));
    expect(h.sent).toHaveLength(1);
    expect(h.edits).toHaveLength(1);
    expect(h.edits[0]!.body).toMatchObject({ content: expect.stringContaining('Board 2'), allowedMentions: { parse: [] } });
    expect(handlesIn(String(h.edits[0]!.body.content))).toEqual([]);
    expect(r.ch.pinned).toHaveLength(1);
    expect(store.sets).toBe(1);
  });

  it('T5: a 10008 on the board edit reposts once (and pins the new message), reporting the repost id', async () => {
    const { r, store, h, port, actor } = setup();
    await port.upsertRoomBoard(actor, ROOM, board(1));
    h.gone.add([...store.rows.values()][0]!.messageId);
    const sent: string[][] = [];
    await port.upsertRoomBoard(actor, ROOM, board(2), { onSent: (ids) => sent.push(ids) });
    expect(h.sent).toHaveLength(2);
    expect(sent).toHaveLength(1);
    expect(r.ch.pinned).toHaveLength(2);
  });

  it('T8: a 64-character persona id still gets a legal key, and a failing board store write sends exactly once, then the room board is off', async () => {
    const { store, h, port, actor } = setup(LONG_ID);
    store.failSet = true;
    await expect(port.upsertRoomBoard(actor, ROOM, board(1))).rejects.toThrow('store down');
    await port.upsertRoomBoard(actor, ROOM, board(2));
    await port.upsertRoomBoard(actor, ROOM, board(3));
    expect(h.sent).toHaveLength(1);
    expect(store.sets).toBe(1);
  });

  it('T13: a missing Pin Messages permission is reported once, the board is posted unpinned and keeps working', async () => {
    const { r, h, port, actor } = setup();
    r.setPinCode(50013);
    expect(await port.upsertRoomBoard(actor, ROOM, board(1))).toEqual({ pin: 'missing_permission' });
    expect(h.sent).toHaveLength(1);
    expect(await port.upsertRoomBoard(actor, ROOM, board(2))).toEqual({ pin: 'skipped' });
    expect(h.edits).toHaveLength(1);
  });

  it('refuses a head actor and a persona whose room is another channel', async () => {
    const { h, port } = setup();
    await expect(port.upsertRoomBoard(head, ROOM, board(1))).rejects.toThrow();
    await expect(port.upsertRoomBoard({ kind: 'persona', personaId: sa.id }, '1570000000000000199', board(1))).rejects.toThrow();
    expect(h.sent).toHaveLength(0);
  });
});

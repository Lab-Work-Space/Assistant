import type { Client, Message } from 'discord.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handlesIn } from '../company/handles.js';
import type { DeptId } from '../core/index.js';
import type { Department, Persona, PersonaWebhook } from '../db/repos/index.js';
import { EDIT_CAP, HOLDBACK, EDIT_INTERVAL_MS, ELLIPSIS, PREVIEW_MAX, TYPING_MAX_MS, TYPING_REFRESH_MS } from '../agents/stream/stream-holdback.js';
import { fakeChannel, fakeRestClient, type FakeChannel } from '../tests/fakes/discordClient.js';
import { createDiscordPort, type DiscordPort, type PortOrg, type ReplyStream } from './port.js';
import { WebhookSender, type WebhookRepo } from './webhooks.js';

/** STREAM-1 at the port: the preview engine against a fake guild (S3, S4, S7, S8, S9, S13, S14, S15, S21). */

const CH = '1570000000000000201';
const TH = '1570000000000000202';
const ROOM = '1570000000000000203';
const DENIED = '1565715069969502310';
const REPLY_TO = '1570000000000009999';
const sw: Department = { id: 'software', name: 'Software', categoryNamePattern: 'soft', workChannelId: CH, color: 0x123456, model: null, provider: null, enabled: true };
const sa: Persona = { id: 'system-analyst', deptId: 'software', name: 'System Analyst', avatarUrl: null, promptRef: 'x', model: null, provider: null, tools: [], directChannelId: ROOM, enabled: true };
const org: PortOrg = { dept: (id) => (id === 'software' ? sw : null), persona: (id) => (id === sa.id ? sa : null) };
const head = { kind: 'head' as const, dept: 'software' as DeptId };
const target = { channelId: CH };
const SNOW = (n: number) => `157000000000000${String(n).padStart(4, '0')}`;
const repo: WebhookRepo = { getByChannel: async () => null, getByWebhookId: async () => null, upsert: async () => undefined };

type Sent = Record<string, unknown>;
/** A text channel with live bot messages: sends, edits (recorded in order), typing; `fail` makes edits throw. */
function room(id: string, o: { thread?: string } = {}) {
  const ch = fakeChannel(id, o.thread ? { thread: o.thread } : {});
  const live = new Map<string, { edits: Sent[] }>();
  const gone = new Set<string>();
  const log: string[] = [];
  const ctl = { editError: undefined as unknown, typing: 0, sendError: undefined as unknown };
  let n = 0;
  ch.send = async (m: Sent) => {
    if (ctl.sendError) throw ctl.sendError;
    ch.sent.push(m);
    const mid = SNOW(++n);
    live.set(mid, { edits: [] });
    log.push(`send:${mid}`);
    return { id: mid };
  };
  (ch as unknown as { sendTyping: () => Promise<void> }).sendTyping = async () => { ctl.typing++; };
  (ch as unknown as { messages: unknown }).messages = {
    fetch: async (mid: string) => {
      const m = live.get(mid);
      if (!m || gone.has(mid)) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      return {
        author: { id: 'app-sw' },
        edit: async (e: Sent) => {
          if (ctl.editError) throw ctl.editError;
          m.edits.push(e);
          log.push(`edit:${mid}`);
        },
      };
    },
    pin: async () => undefined,
  };
  return { ch, live, gone, ctl, log };
}

function world(channels: FakeChannel[], o: { secrets?: string[]; ids?: Map<string, DeptId>; logs?: unknown[] } = {}) {
  const client = fakeRestClient('app-sw', channels);
  const secrets = o.secrets ?? [];
  const logs = o.logs ?? [];
  const port = createDiscordPort({ client: () => client as Client }, new WebhookSender(repo), org, {
    guildId: '1565649426943442944', adminRoleId: '1565000000000000001', inbound: async (m: Message) => ({ id: m.id }) as never, secrets,
    botUserIds: () => o.ids ?? new Map(), log: { info: (x, m) => logs.push({ lvl: 'info', x, m }), warn: (x, m) => logs.push({ lvl: 'warn', x, m }) },
  });
  return { port, secrets, logs };
}

const SENT: string[][] = [];
const finalOpts = (extra: object = {}) => ({ replyToId: REPLY_TO, onSent: (ids: string[]) => SENT.push(ids), ...extra });
const open = (port: DiscordPort, o: Partial<Parameters<NonNullable<DiscordPort['openReplyStream']>>[2]> = {}): ReplyStream => {
  const rs = port.openReplyStream!(head, target, { halted: () => false, replyToId: REPLY_TO, ...o });
  if (!rs) throw new Error('no stream');
  return rs;
};
const WORDS = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu ';
const settle = async (ms = EDIT_INTERVAL_MS + 100) => { await vi.advanceTimersByTimeAsync(ms); };
const contentOf = (e: Sent) => String(e.content ?? '');

beforeEach(() => {
  vi.useFakeTimers();
  SENT.length = 0;
});
afterEach(() => vi.useRealTimers());

describe('preview lifecycle', () => {
  it('creates one reply preview from the first committed text, edits in place with parse [], and finalize writes the answer into it (one message)', async () => {
    const { ch, live } = room(CH);
    const { port } = world([ch]);
    const rs = open(port);
    const raw = WORDS.repeat(3);
    rs.update(raw.slice(0, 120));
    await settle(50);
    expect(ch.sent).toHaveLength(1);
    const first = ch.sent[0]!;
    expect(contentOf(first).endsWith(ELLIPSIS)).toBe(true);
    expect(first).toMatchObject({ reply: { messageReference: REPLY_TO, failIfNotExists: false }, allowedMentions: { parse: [], repliedUser: false } });
    expect(rs.active()).toBe(true);
    rs.update(raw);
    await settle();
    const id = [...live.keys()][0]!;
    const edits = live.get(id)!.edits;
    expect(edits.length).toBeGreaterThanOrEqual(1);
    for (const e of edits) expect(e.allowedMentions).toEqual({ parse: [] });
    const done = await rs.finalize({ type: 'chat', body: 'The final answer.', footer: { model: 'm', costUsd: 0, ms: 1 } }, finalOpts());
    expect(done).toBe(id);
    expect(ch.sent).toHaveLength(1); // still one message: the answer replaced the preview
    const last = contentOf(live.get(id)!.edits.at(-1)!);
    expect(last).toContain('The final answer.');
    expect(last.endsWith(ELLIPSIS)).toBe(false);
    expect(SENT).toEqual([[id]]);
  });

  it('no create before 40 committed characters; the first create waits at most FIRST_WAIT_MS and never for empty text', async () => {
    const { ch } = room(CH);
    const { port } = world([ch]);
    const rs = open(port);
    rs.update('hi ');
    await settle(300);
    expect(ch.sent).toHaveLength(0);
    rs.update(`hi ${WORDS}`);
    await settle(400);
    expect(ch.sent).toHaveLength(1);
    const rs2 = open(port, {});
    expect(rs2).toBeTruthy();
  });

  it('a tool-only turn leaves no message and finalize reports "no preview" (undefined) so the caller posts as before', async () => {
    const { ch } = room(CH);
    const { port } = world([ch]);
    const rs = open(port);
    await settle(3000);
    expect(ch.sent).toHaveLength(0);
    expect(rs.active()).toBe(false);
    expect(await rs.finalize({ type: 'chat', body: 'x' }, finalOpts())).toBeUndefined();
  });

  it('>2000 chars: the preview stays within PREVIEW_MAX + ellipsis; the final is split: preview edited, the rest sent, every id reported', async () => {
    const { ch, live } = room(CH);
    const { port } = world([ch]);
    const rs = open(port);
    const long = (WORDS.repeat(30)).slice(0, 4000);
    rs.update(long);
    await settle(1600);
    rs.update(long + WORDS);
    await settle(1700);
    const sizes = [ch.sent[0]!, ...[...live.values()].flatMap((m) => m.edits)].map((m) => contentOf(m).length);
    for (const s of sizes) expect(s).toBeLessThanOrEqual(PREVIEW_MAX + ELLIPSIS.length);
    const id = await rs.finalize({ type: 'chat', body: long }, finalOpts());
    expect(ch.sent.length).toBeGreaterThanOrEqual(2);
    expect(SENT.at(-1)![0]).toBe(id);
    expect(SENT.at(-1)!.length).toBe(ch.sent.length);
    for (const m of ch.sent.slice(1)) expect(contentOf(m).length).toBeLessThanOrEqual(2000);
  });

  it('a second stream in the same channel is typing only (no preview, no slot) and finalize says "no preview"', async () => {
    const { ch } = room(CH);
    const { port } = world([ch]);
    const a = open(port);
    const b = open(port);
    b.update(WORDS.repeat(2));
    b.typing();
    await settle(2000);
    expect(ch.sent).toHaveLength(0); // b made no preview; a made none yet
    a.update(WORDS.repeat(2));
    await settle(2000);
    expect(ch.sent).toHaveLength(1);
    expect(await b.finalize({ type: 'chat', body: 'x' }, finalOpts())).toBeUndefined();
    await a.release();
    // the slot is free again
    const c = open(port);
    c.update(WORDS.repeat(2));
    await settle(2000);
    expect(ch.sent).toHaveLength(2);
    await c.release();
  });

  it('process cap: the fifth concurrent stream (other channels) is typing only', async () => {
    const chans = [0, 1, 2, 3, 4].map((i) => room(String(1570000000000000300n + BigInt(i))));
    const { port } = world(chans.map((c) => c.ch));
    const streams = chans.map((c) => port.openReplyStream!(head, { channelId: c.ch.id }, { halted: () => false })!);
    streams.forEach((s) => s.update(WORDS.repeat(2)));
    await settle(2000);
    expect(chans.slice(0, 4).every((c) => c.ch.sent.length === 1)).toBe(true);
    expect(chans[4]!.ch.sent).toHaveLength(0);
    for (const s of streams) await s.release();
  });
});

describe('S9 refusals and RF12', () => {
  it('mentionUserIds present: streaming is refused (null)', () => {
    const { ch } = room(CH);
    const { port } = world([ch]);
    expect(port.openReplyStream!(head, target, { halted: () => false, mentionUserIds: ['157000000000000001'] })).toBeNull();
  });
  it('a persona outside its own room, or unknown, gets null; a non-snowflake replyToId is dropped', async () => {
    const { ch, live } = room(CH);
    const { port } = world([ch]);
    expect(port.openReplyStream!({ kind: 'persona', personaId: sa.id }, target, { halted: () => false })).toBeNull();
    expect(port.openReplyStream!({ kind: 'persona', personaId: 'nobody' }, target, { halted: () => false })).toBeNull();
    const rs = open(port, { replyToId: 'stall-123' });
    rs.update(WORDS.repeat(2));
    await settle(500);
    expect(ch.sent[0]).not.toHaveProperty('reply');
    expect(live.size).toBe(1);
    await rs.release();
  });
});

describe('S3 live secrets and the holdback at the port', () => {
  it('a literal pushed after openReplyStream is never shown (not even partly) in any write', async () => {
    const { ch, live } = room(CH);
    const secrets: string[] = [];
    const { port } = world([ch], { secrets });
    const rs = open(port);
    secrets.push('Zq81Xw0Pl9MnSecretKey'); // the Gemini key is pushed after decrypt
    const body = `${WORDS}the key is Zq81Xw0Pl9MnSecretKey and that is all of it, thank you very much indeed.`;
    for (let i = 20; i <= body.length; i += 7) {
      rs.update(body.slice(0, i));
      await settle(EDIT_INTERVAL_MS + 10);
    }
    const all = [...ch.sent, ...[...live.values()].flatMap((m) => m.edits)].map(contentOf).join('\n');
    expect(all).not.toMatch(/Zq81|Xw0P|Pl9M|SecretKey|Zq8/);
    await rs.release();
  });
});

describe('S4 every write goes through compose with noHandles', () => {
  const nasty = [
    '<@157000000000000001>', '<@&1565000000000000001>', '@everyone', '@here', '@CTO', '@R&D', '@CF|O', '`@CTO`', 'https://x.test/@CTO', '<@!157000000000000001>',
  ];
  it('mentions, role pings, handles (also split across deltas, in code and urls) are never live in a preview write; every edit has allowedMentions.parse []', async () => {
    const { ch, live } = room(CH);
    const { port } = world([ch], { ids: new Map([['157000000000000001', 'software' as DeptId]]) });
    const rs = open(port);
    const body = `${WORDS}${nasty.join(' then ')} and the rest of the sentence continues for a long while after it, fine.`;
    for (let i = 10; i <= body.length; i += 3) {
      rs.update(body.slice(0, i));
      await settle(EDIT_INTERVAL_MS + 10);
    }
    const writes = [...ch.sent, ...[...live.values()].flatMap((m) => m.edits)];
    expect(writes.length).toBeGreaterThan(1);
    for (const w of writes) {
      const c = contentOf(w);
      expect(c).not.toMatch(/<@[!&]?\d/);
      expect(c).not.toMatch(/@everyone|@here/);
      expect(handlesIn(c)).toEqual([]);
      expect(w.allowedMentions).toMatchObject({ parse: [] });
      expect((w.allowedMentions as { users?: unknown }).users).toBeUndefined();
    }
    await rs.release();
  });
});

describe('endings: S7 fresh post, S8 cards, 10008, failures', () => {
  it('S7: a final with a live mention (head online and viewing) goes out as a NEW message with the reply target; the preview becomes the pointer', async () => {
    const { ch, live } = room(CH);
    const { port } = world([ch], { ids: new Map([['157000000000000001', 'software' as DeptId]]) });
    const rs = open(port);
    rs.update(WORDS.repeat(2));
    await settle(500);
    const previewId = [...live.keys()][0]!;
    const out: string[][] = [];
    const id = await rs.finalize({ type: 'chat', body: 'please look @CTO' }, { replyToId: REPLY_TO, onSent: (ids) => out.push(ids), onCode: (ids) => out.push(['code', ...ids]) });
    expect(id).not.toBe(previewId);
    expect(ch.sent).toHaveLength(2);
    expect(contentOf(ch.sent[1]!)).toContain('<@157000000000000001>');
    expect(ch.sent[1]).toMatchObject({ reply: { messageReference: REPLY_TO } });
    expect(contentOf(live.get(previewId)!.edits.at(-1)!)).toBe('-# (answer posted below)');
    expect(out).toEqual([[id], ['code', previewId]]);
  });

  it('S7: a literal handle the port cannot convert (head offline / cannot view) still goes out fresh, because a created message routes on it', async () => {
    const { ch, live } = room(CH);
    const { port } = world([ch], { ids: new Map() });
    const rs = open(port);
    rs.update(WORDS.repeat(2));
    await settle(500);
    const previewId = [...live.keys()][0]!;
    const id = await rs.finalize({ type: 'chat', body: 'ask @CTO about it' }, finalOpts());
    expect(id).not.toBe(previewId);
    expect(contentOf(ch.sent[1]!)).toContain('@CTO');
    expect(contentOf(live.get(previewId)!.edits.at(-1)!)).toBe('-# (answer posted below)');
  });

  it('S8: a card final (approval payload with buttons) is posted fresh and never edited into the plain preview', async () => {
    const { ch, live } = room(CH);
    const { port } = world([ch]);
    const rs = open(port);
    rs.update(WORDS.repeat(2));
    await settle(500);
    const previewId = [...live.keys()][0]!;
    await rs.finalize({ type: 'approval', title: 'Approve?', body: 'please', buttons: { approvalId: 'a1' } }, finalOpts());
    expect(ch.sent).toHaveLength(2);
    expect((ch.sent[1]!.embeds as unknown[]).length).toBe(1);
    expect(contentOf(live.get(previewId)!.edits.at(-1)!)).toBe('-# (answer posted below)');
    for (const e of live.get(previewId)!.edits) expect(e.embeds).toEqual([]);
  });

  it('S13: Unknown Message (10008) mid-stream freezes with no new create; finalize makes exactly one fresh post', async () => {
    const { ch, live, gone } = room(CH);
    const { port } = world([ch]);
    const rs = open(port);
    rs.update(WORDS.repeat(2));
    await settle(500);
    const previewId = [...live.keys()][0]!;
    gone.add(previewId); // a person deleted it
    rs.update(WORDS.repeat(6));
    await settle(2000);
    rs.update(WORDS.repeat(9));
    await settle(4000);
    expect(ch.sent).toHaveLength(1); // no second create during the stream
    const id = await rs.finalize({ type: 'chat', body: 'final' }, finalOpts());
    expect(ch.sent).toHaveLength(2);
    expect(id).toBe(SNOW(2));
  });

  it('S13: an edit cap bounds the writes of one stream (oscillating segments cannot edit without bound)', async () => {
    const { ch, live } = room(CH);
    const { port } = world([ch]);
    const rs = open(port);
    for (let i = 0; i < EDIT_CAP + 40; i++) {
      rs.restart();
      rs.update(`${WORDS}segment ${i} `.repeat(2));
      await settle(EDIT_INTERVAL_MS + 20);
    }
    const writes = ch.sent.length + [...live.values()].reduce((a, m) => a + m.edits.length, 0);
    expect(writes).toBeLessThanOrEqual(EDIT_CAP);
    await rs.release();
  }, 60_000);

  it('429s double the interval and three failures in a row freeze the preview; finalize still runs (fresh post when the edit also fails)', async () => {
    const { ch, live, ctl } = room(CH);
    const logs: unknown[] = [];
    const { port } = world([ch], { logs });
    const rs = open(port);
    rs.update(WORDS.repeat(2));
    await settle(500);
    const before = [...live.values()][0]!.edits.length;
    ctl.editError = Object.assign(new Error('rate limited'), { status: 429, requestBody: { json: { content: 'PARTIAL-ANSWER-LEAK' } } });
    for (let i = 3; i < 12; i++) {
      rs.update(WORDS.repeat(i));
      await settle(EDIT_INTERVAL_MS * 5);
    }
    expect([...live.values()][0]!.edits.length).toBe(before); // all failed
    const warns = logs.filter((l) => (l as { lvl: string }).lvl === 'warn');
    expect(warns.length).toBeLessThanOrEqual(3); // frozen after three failures
    const id = await rs.finalize({ type: 'chat', body: 'final answer' }, finalOpts());
    expect(contentOf(ch.sent.at(-1)!)).toContain('final answer');
    expect(id).toBe(SNOW(2));
  });

  it('S15: failures log only the Discord code/status, never the error object or the partial answer', async () => {
    const { ch, ctl, live } = room(CH);
    const logs: unknown[] = [];
    const { port } = world([ch], { logs });
    const rs = open(port);
    rs.update(WORDS.repeat(2));
    await settle(500);
    void live;
    ctl.editError = Object.assign(new Error('boom PARTIAL-ANSWER-LEAK'), { code: 50013, requestBody: { json: { content: 'PARTIAL-ANSWER-LEAK' } } });
    rs.update(WORDS.repeat(6));
    await settle(3000);
    await rs.finalize({ type: 'chat', body: 'final' }, finalOpts());
    const line = JSON.stringify(logs);
    expect(line).not.toContain('PARTIAL-ANSWER-LEAK');
    expect(line).not.toContain('boom');
    expect(line).toContain('50013');
    for (const l of logs) expect(Object.keys((l as { x: object }).x).sort().every((k) => ['op', 'code', 'status', 'outcome', 'reason'].includes(k))).toBe(true);
  });

  it('halt: no write after the predicate says halted; finalizeStopped replaces the preview with one fixed line and records it as a code id', async () => {
    const { ch, live } = room(CH);
    let halted = false;
    const { port } = world([ch]);
    const rs = open(port, { halted: () => halted });
    rs.update(WORDS.repeat(2));
    await settle(500);
    const previewId = [...live.keys()][0]!;
    const n = live.get(previewId)!.edits.length;
    halted = true;
    rs.update(WORDS.repeat(8));
    await settle(5000);
    expect(live.get(previewId)!.edits.length).toBe(n);
    const code: string[][] = [];
    await rs.finalizeStopped('-# Stopped: the company is halted.', { onCode: (ids) => code.push(ids) });
    expect(contentOf(live.get(previewId)!.edits.at(-1)!)).toBe('-# Stopped: the company is halted.');
    expect(code).toEqual([[previewId]]);
  });

  it('a halt predicate that throws counts as halted', async () => {
    const { ch } = room(CH);
    const { port } = world([ch]);
    const rs = open(port, { halted: () => { throw new Error('boom'); } });
    rs.update(WORDS.repeat(3));
    rs.typing();
    await settle(3000);
    expect(ch.sent).toHaveLength(0);
  });

  it('S5: canCreate is asked right before the first create; false or a throw means no preview, ever', async () => {
    for (const canCreate of [async () => false, async () => { throw new Error('lookup'); }]) {
      const { ch } = room(CH);
      const { port } = world([ch]);
      const rs = open(port, { canCreate });
      rs.update(WORDS.repeat(3));
      await settle(3000);
      rs.update(WORDS.repeat(6));
      await settle(3000);
      expect(ch.sent).toHaveLength(0);
      expect(await rs.finalize({ type: 'chat', body: 'x' }, finalOpts())).toBeUndefined();
    }
  });

  it('S11: release() makes one fixed interrupted edit when no ending ran, is idempotent, and frees the slot', async () => {
    const { ch, live } = room(CH);
    const { port } = world([ch]);
    const rs = open(port);
    rs.update(WORDS.repeat(2));
    await settle(500);
    const previewId = [...live.keys()][0]!;
    const rec: string[][] = [];
    await rs.release((ids) => rec.push(ids));
    await rs.release((ids) => rec.push(ids));
    expect(contentOf(live.get(previewId)!.edits.at(-1)!)).toBe('-# (reply interrupted)');
    expect(live.get(previewId)!.edits.filter((e) => contentOf(e) === '-# (reply interrupted)')).toHaveLength(1);
    expect(rec).toEqual([[previewId]]);
    const again = open(port);
    again.update(WORDS.repeat(2));
    await settle(500);
    expect(ch.sent).toHaveLength(2);
    await again.release();
  });
});

describe('S14 typing', () => {
  it('goes through resolve (a denied channel never types), heads only, refreshes, stops at the first preview, on halt, and after the maximum duration', async () => {
    const { ch, ctl } = room(CH);
    const { port } = world([ch]);
    const rs = open(port);
    rs.typing();
    rs.typing();
    await vi.advanceTimersByTimeAsync(10);
    expect(ctl.typing).toBe(1);
    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS * 2 + 100);
    expect(ctl.typing).toBe(3);
    rs.update(WORDS.repeat(3));
    await vi.advanceTimersByTimeAsync(3000);
    const t = ctl.typing;
    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS * 3);
    expect(ctl.typing).toBe(t); // a preview exists: typing stopped
    await rs.release();

    const r2 = room(String(1570000000000000500n));
    const { port: p2 } = world([r2.ch]);
    let halted = false;
    const s2 = p2.openReplyStream!(head, { channelId: r2.ch.id }, { halted: () => halted })!;
    s2.typing();
    await vi.advanceTimersByTimeAsync(10);
    halted = true;
    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS * 3);
    expect(r2.ctl.typing).toBe(1);
    await s2.release();

    const r3 = room(String(1570000000000000501n));
    const { port: p3 } = world([r3.ch]);
    const s3 = p3.openReplyStream!(head, { channelId: r3.ch.id }, { halted: () => false })!;
    s3.typing();
    await vi.advanceTimersByTimeAsync(TYPING_MAX_MS + TYPING_REFRESH_MS * 3);
    const n3 = r3.ctl.typing;
    expect(n3).toBeLessThanOrEqual(Math.ceil(TYPING_MAX_MS / TYPING_REFRESH_MS) + 2);
    await vi.advanceTimersByTimeAsync(TYPING_REFRESH_MS * 5);
    expect(r3.ctl.typing).toBe(n3);
    await s3.release();
  });

  it('a denied channel never types (the denylist is checked through resolve)', async () => {
    const dch = room(DENIED);
    const { port } = world([dch.ch]);
    const rs = port.openReplyStream!(head, { channelId: DENIED }, { halted: () => false })!;
    rs.typing();
    await vi.advanceTimersByTimeAsync(50);
    expect(dch.ctl.typing).toBe(0);
    await rs.release();
  });
});

describe('S21 write verbs stay in port.ts', () => {
  it('the engine and the sink files contain no write call', async () => {
    const { readFileSync } = await import('node:fs');
    for (const f of ['discord/reply-stream.ts', 'agents/stream/stream.ts', 'agents/stream/stream-extract.ts', 'agents/stream/stream-holdback.ts']) {
      const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/\.\s*(edit|send|sendTyping|delete|pin|unpin|setName)\s*\(/);
      expect(src, f).not.toMatch(/\bsendTyping\b/);
    }
  });
});


describe('Gate 2 follow-ups', () => {
  it('G2S-02: a halt that lands while the preview is being built means the create (and the edit) does not happen', async () => {
    for (const phase of ['create', 'edit'] as const) {
      const { ch, live } = room(CH);
      let halted = false;
      const { port } = world([ch]);
      const rs = open(port, { halted: () => halted });
      if (phase === 'edit') {
        rs.update(WORDS.repeat(2));
        await settle(500);
      }
      const before = ch.sent.length + [...live.values()].reduce((a, m) => a + m.edits.length, 0);
      // the halt lands during the awaited build of the next write
      const orig = ch.send;
      void orig;
      let first = true;
      const origFetch = (ch as unknown as { fetchWebhooks: unknown }).fetchWebhooks;
      void origFetch;
      const probe = { n: 0 };
      const rsAny = rs as unknown as { io: { preview: (t: string) => Promise<unknown> } };
      const realPreview = rsAny.io.preview;
      rsAny.io.preview = async (t: string) => {
        const m = await realPreview(t);
        if (first && !t.startsWith('-#')) { first = false; halted = true; probe.n++; }
        return m;
      };
      rs.update(WORDS.repeat(phase === 'create' ? 3 : 9));
      await settle(3000);
      expect(probe.n).toBe(1);
      expect(ch.sent.length + [...live.values()].reduce((a, m) => a + m.edits.length, 0)).toBe(before);
      await rs.release();
    }
  });

  it('G2S-03: a partly failed multi-message final still reports the ids it did send (preview + the sent extras)', async () => {
    const { ch, live } = room(CH);
    const { port } = world([ch]);
    const rs = open(port);
    const long = WORDS.repeat(100);
    rs.update(long);
    await settle(1700);
    const previewId = [...live.keys()][0]!;
    const orig = ch.send;
    let n = 0;
    ch.send = async (m: Sent) => { if (++n === 2) throw new Error('boom'); return orig(m); };
    const out: string[][] = [];
    await rs.finalize({ type: 'chat', body: WORDS.repeat(220) }, { replyToId: REPLY_TO, onSent: (ids) => out.push(ids) }).catch(() => undefined);
    const all = out.flat();
    expect(all).toContain(previewId);
    expect(all.length).toBe(1 + (ch.sent.length - 1)); // every message that exists is reported
  });

  it('G2S-04: when the final post fails, the preview becomes the fixed interrupted line, not the partial text', async () => {
    const { ch, live } = room(CH);
    const { port } = world([ch], { ids: new Map([['157000000000000001', 'software' as DeptId]]) });
    const rs = open(port);
    rs.update(WORDS.repeat(3));
    await settle(500);
    const previewId = [...live.keys()][0]!;
    ch.send = async () => { throw new Error('discord down'); };
    const codes: string[][] = [];
    await expect(rs.finalize({ type: 'chat', body: 'hello @CTO' }, { replyToId: REPLY_TO, onCode: (ids) => codes.push(ids) })).rejects.toThrow();
    expect(contentOf(live.get(previewId)!.edits.at(-1)!)).toBe('-# (reply interrupted)');
    expect(codes).toEqual([[previewId]]);
  });

  it('DEFECT-003: HOLDBACK is pinned to the literal 64', () => {
    expect(HOLDBACK).toBe(64);
  });
});

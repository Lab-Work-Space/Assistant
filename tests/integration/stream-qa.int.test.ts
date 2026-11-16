import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from 'discord.js';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp, type App } from '../../app.js';
import { seed, PRAW_DEFAULT_MODEL } from '../../company/index.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo } from '../../db/repos/index.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { PROMPTS_DIR, loadPrompts } from '../../prompts/index.js';
import { createGeminiProvider } from '../../providers/gemini/index.js';
import { ProviderRegistry } from '../../providers/index.js';
import { fakeGemini } from '../fakes/gemini.js';
import { fakeClient, fakeGuild } from '../fakes/discordClient.js';
import { fakeResolver, fakeTransport } from '../fakes/net.js';
import { installFakeClaude, type FakeClaude } from '../fakes/claudeCli.js';
import { BOT_IDS, SOFTWARE_WORK, fakeBinaries, humanMsg, mentionOf, migrateUp, resetDb, testEnv } from './helpers.js';

/** STREAM-1 tester suite (stage 6): the real Discord port, real app, the fake claude CLI in stream mode; nothing is mocked inside the app. */

const MSG_ID = '1570000000000007777';
const PRAW_ROOM = '1565999999999999777';
const prompts = loadPrompts(PROMPTS_DIR);

type Ev = { t: number; k: 'typing' | 'send' | 'edit'; id?: string; content?: string; reply?: unknown; allowed?: unknown };
/** A text channel that records everything the bots do to it, with a timestamp. */
function room(id: string, authorId: string) {
  const log: Ev[] = [];
  const live = new Set<string>();
  let n = 0;
  const t0 = Date.now();
  const ch = {
    id, guildId: '1565649426943442944', name: `n-${id}`, type: 0, parentId: 'category-1',
    isThread: () => false, isDMBased: () => false, isSendable: () => true, isTextBased: () => true,
    permissionOverwrites: { cache: new Map() },
    sendTyping: async () => { log.push({ t: Date.now() - t0, k: 'typing' }); },
    send: async (m: Record<string, unknown>) => {
      const mid = `15700000000000${String(++n).padStart(5, '0')}`;
      live.add(mid);
      log.push({ t: Date.now() - t0, k: 'send', id: mid, content: String(m.content ?? ''), reply: m.reply, allowed: m.allowedMentions });
      return { id: mid };
    },
    messages: {
      fetch: async (mid: string) => {
        if (!live.has(mid)) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
        return { author: { id: authorId }, edit: async (e: Record<string, unknown>) => { log.push({ t: Date.now() - t0, k: 'edit', id: mid, content: String(e.content ?? ''), allowed: e.allowedMentions }); } };
      },
      pin: async () => undefined,
    },
  };
  return { ch, log, sends: () => log.filter((e) => e.k === 'send'), edits: () => log.filter((e) => e.k === 'edit') };
}
type Room = ReturnType<typeof room>;

let db: TestDb;
let app: App | null = null;
let dir: string;
let fake: FakeClaude;
beforeAll(async () => {
  db = await freshDb();
  await migrateUp(db.pool);
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stream-qa-'));
  fake = installFakeClaude(dir);
});
afterEach(async () => {
  await app?.stop();
  app = null;
  rmSync(dir, { recursive: true, force: true });
  await resetDb(db.pool);
});
afterAll(async () => {
  await db.close();
});

/** Replaces the fake `claude` with a timed stream player: attempts[n] = { steps: [{ delay, lines }], hang? } (attempt number from a counter file). */
function installPlayer(attempts: { steps: { delay: number; lines: object[] }[]; hang?: boolean }[]): void {
  const src = `#!${process.execPath}
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
const here = dirname(process.argv[1]);
const sc = JSON.parse(readFileSync(join(here, 'player.json'), 'utf8'));
const cf = join(here, 'count.txt');
const n = existsSync(cf) ? Number(readFileSync(cf, 'utf8')) : 0;
writeFileSync(cf, String(n + 1));
let input = ''; process.stdin.on('data', (d) => (input += d)); process.stdin.on('end', () => {
  const a = sc[Math.min(n, sc.length - 1)];
  let t = 0;
  for (const s of a.steps) { t += s.delay; setTimeout(() => process.stdout.write(s.lines.map((l) => JSON.stringify(l)).join('\\n') + '\\n'), t); }
  if (a.hang) setInterval(() => {}, 1000); else setTimeout(() => process.exit(0), t + 20);
});
process.stdin.resume();
`;
  writeFileSync(join(dir, 'claude'), src, { mode: 0o755 });
  writeFileSync(join(dir, 'player.json'), JSON.stringify(attempts));
}

const ev = (event: object) => ({ type: 'stream_event', event, session_id: 's', parent_tool_use_id: null });
const INIT = { type: 'system', subtype: 'init', tools: ['StructuredOutput'] };
const payloadOf = (body: string, type = 'chat') => ({ tool_calls: [{ name: 'respond', input: { type, body } }] });
const DONE = (body: string) => ({ type: 'result', subtype: 'success', is_error: false, structured_output: payloadOf(body), usage: { input_tokens: 3, output_tokens: 2 } });
/** A whole successful stream: JSON of the payload cut into `piece` characters, one step per piece `gap` ms apart, then the result. */
function playBody(body: string, gap = 250, piece = 30, head: { delay: number; lines: object[] }[] = []) {
  const json = JSON.stringify(payloadOf(body));
  const steps = [
    { delay: 50, lines: [INIT, ev({ type: 'message_start' }), ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'x', name: 'StructuredOutput', input: {} } })] },
    ...head,
  ];
  for (let i = 0; i < json.length; i += piece) steps.push({ delay: gap, lines: [ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: json.slice(i, i + piece) } })] });
  steps.push({ delay: 50, lines: [ev({ type: 'content_block_stop', index: 0 }), DONE(body)] });
  return { steps };
}

interface World { app: App; rooms: Map<string, Room>; rows: () => Promise<{ message_id: string; tainted: boolean; answer: boolean }[]> }
/** createApp with the REAL discord port over fake clients (rooms) and the local provider over the fake CLI, or an injected provider registry. */
async function world(o: { rooms: Room[]; registry?: ProviderRegistry; cfg?: Record<string, unknown>; depts?: readonly ('hq' | 'software' | 'praw')[] }): Promise<World> {
  for (const [k, v] of Object.entries(o.cfg ?? {})) await db.pool.query('INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, JSON.stringify(v)]);
  const byId = new Map(o.rooms.map((r) => [r.ch.id, r]));
  const createClient = (d: keyof typeof BOT_IDS): Client => fakeClient({
    userId: BOT_IDS[d], guild: fakeGuild(),
    channelFetch: async (id) => byId.get(id)?.ch ?? Promise.reject(Object.assign(new Error('Unknown Channel'), { code: 10003 })),
  });
  app = await createApp({ ...testEnv(o.depts ?? ['hq', 'software']) }, {
    pool: db.pool, createClient: createClient as never, healthPort: 0, approvalBatching: false,
    ...(o.registry ? { providers: o.registry } : { localGuard: async () => ({ ok: true as const, claudePath: join(dir, 'claude') }) }),
    net: { resolver: fakeResolver({}), transport: fakeTransport({}) }, binaries: fakeBinaries(),
  });
  await app.services.cfg.set('schedule.offDays', [], 'test');
  await app.start();
  return { app, rooms: byId, rows: async () => (await db.pool.query('SELECT message_id, tainted, answer FROM bot_messages ORDER BY message_id')).rows };
}
const ask = (text: string, over = {}) => humanMsg(`${mentionOf('software')} ${text}`, { id: MSG_ID, mentionedHeads: ['software'], ...over });
const ELL = ' …';
const ANSWER = 'Here is a streamed answer sentence that keeps going and going, with enough ordinary words to cross the forty character floor. '.repeat(4).trim();

describe('(a) end to end through createApp: typing, preview >= 40 chars, throttled edits, final == the normal post', () => {
  it('stream on vs stream off produce the same final text; provenance is on the final id only', async () => {
    installPlayer([playBody(ANSWER, 300, 25)]);
    const r1 = room(SOFTWARE_WORK, BOT_IDS.software);
    const w = await world({ rooms: [r1] });
    await w.app.services.scheduler.onMessage(ask('stream please'));
    await w.app.services.scheduler.idle();

    const first = r1.log.findIndex((e) => e.k !== 'typing');
    expect(r1.log.findIndex((e) => e.k === 'typing')).toBe(0); // typing is shown before anything is written
    expect(r1.sends()).toHaveLength(1); // one message in the channel, ever
    const send = r1.sends()[0]!;
    expect(r1.log[first]).toBe(send);
    expect(send.content!.endsWith(ELL)).toBe(true);
    expect(send.content!.length - ELL.length).toBeGreaterThanOrEqual(40);
    expect(send.reply).toMatchObject({ messageReference: MSG_ID, failIfNotExists: false });
    expect(send.allowed).toMatchObject({ parse: [], repliedUser: false });
    const edits = r1.edits();
    expect(edits.length).toBeGreaterThanOrEqual(2); // at least one progressive edit and the final one
    const finalEdit = edits.at(-1)!;
    expect(finalEdit.content!.endsWith(ELL)).toBe(false);
    // progressive edits are throttled (>= 1.4 s apart, the create counts as the first write), and each is a growing prefix of the final text
    const writes = r1.log.filter((e) => e.k !== 'typing');
    for (let i = 1; i < writes.length - 1; i++) expect(writes[i]!.t - writes[i - 1]!.t, `write ${i}`).toBeGreaterThanOrEqual(1400);
    let prev = 0;
    for (const e of [send, ...edits.slice(0, -1)]) {
      const shown = e.content!.slice(0, -ELL.length);
      expect(finalEdit.content!.startsWith(shown)).toBe(true);
      expect(shown.length).toBeGreaterThanOrEqual(prev);
      prev = shown.length;
    }
    // provenance: the preview id is recorded as the answer, nothing else is
    const rows = await w.rows();
    expect(rows).toEqual([{ message_id: send.id, tainted: expect.any(Boolean), answer: true }]);
    await app!.stop(); app = null;
    const streamedFinal = finalEdit.content!;

    // the same run with stream.enabled=false posts one message with the same text
    await db.pool.query('TRUNCATE bot_messages');
    writeFileSync(join(dir, 'count.txt'), '0');
    const r2 = room(SOFTWARE_WORK, BOT_IDS.software);
    const w2 = await world({ rooms: [r2], cfg: { 'stream.enabled': false } });
    await w2.app.services.scheduler.onMessage(ask('stream please'));
    await w2.app.services.scheduler.idle();
    expect(r2.log.filter((e) => e.k === 'typing')).toHaveLength(0); // (i) off means no typing either
    expect(r2.edits()).toHaveLength(0);
    expect(r2.sends()).toHaveLength(1);
    const norm = (x: string) => x.replace(/ · [\d.]+s$/m, ' · Ns'); // the footer carries the run time
    expect(norm(r2.sends()[0]!.content!)).toBe(norm(streamedFinal));
    expect(await w2.rows()).toEqual([{ message_id: r2.sends()[0]!.id, tainted: expect.any(Boolean), answer: true }]);
  }, 60_000);

  it('(i) stream.enabled switched off live mid-run: previews stop, the final is still delivered once', async () => {
    installPlayer([playBody(ANSWER, 400, 25)]);
    const r = room(SOFTWARE_WORK, BOT_IDS.software);
    const w = await world({ rooms: [r] });
    await w.app.services.scheduler.onMessage(ask('go'));
    const t0 = Date.now();
    while (r.sends().length === 0 && Date.now() - t0 < 10_000) await new Promise((x) => setTimeout(x, 20));
    expect(r.sends()).toHaveLength(1);
    await w.app.services.cfg.set('stream.enabled', false, 'test');
    await w.app.services.scheduler.idle();
    expect(r.sends()).toHaveLength(1); // no second message
    const finalEdit = r.edits().at(-1)!;
    expect(finalEdit.content!.endsWith(ELL)).toBe(false);
    expect(finalEdit.content!).toContain(ANSWER.slice(-40));
  }, 60_000);
});

describe('(c) handles and mentions mid-stream are never live', () => {
  const LIVE = /<@!?&?\d+>|@everyone|@here/;
  it('previews carry no live mention, the final with a routable handle goes out as a fresh post and the preview points to it', async () => {
    const body = `Please ask <@12345678901234567> and @everyone and @here about this, it is an important thing to look at today. ` + 'Filler words keep the stream going for a while here. '.repeat(3) + 'Next step belongs to @CEO who should review it now.';
    installPlayer([playBody(body, 250, 20)]);
    const r = room(SOFTWARE_WORK, BOT_IDS.software);
    const w = await world({ rooms: [r], depts: ['hq', 'software'] });
    await w.app.services.scheduler.onMessage(ask('who'));
    await w.app.services.scheduler.idle();
    const preview = r.sends()[0]!;
    const previewEdits = r.edits().filter((e) => e.id === preview.id);
    expect(preview.content).toBeDefined();
    for (const e of [preview, ...previewEdits.slice(0, -1)]) expect(LIVE.test(e.content!), `${e.k}: ${e.content}`).toBe(false);
    // every write carries parse: []
    for (const e of r.log.filter((x) => x.k !== 'typing')) expect((e.allowed as { parse: unknown[] }).parse).toEqual([]);
    const sends = r.sends();
    const lastEdit = previewEdits.at(-1)!;
    // the answer carries a routable handle: an edit never routes, so it is a fresh post and the preview holds the fixed pointer
    expect(sends).toHaveLength(2);
    expect(lastEdit.content).toBe('-# (answer posted below)');
    // a plain chat answer keeps a literal handle (the c2 baseline: a normal post does the same); what matters is that it is a fresh post, not a silent edit
    expect(sends[1]!.content).toContain('@CEO');
    expect(sends[1]!.content).not.toMatch(/(?<!\u200d)@(everyone|here)/); // defanged text stays defanged in the fresh final
    const rows = await w.rows();
    expect(rows.find((x) => x.message_id === sends[1]!.id)).toMatchObject({ answer: true });
    expect(rows.find((x) => x.message_id === sends[0]!.id)).toMatchObject({ answer: false });
    console.log('c: sends', sends.length, 'last edit', JSON.stringify(lastEdit.content!.slice(-80)));
  }, 60_000);
});

describe('(b) secrets in a streamed answer, end to end', () => {
  it('a postgres URL with !$# and a Thai password, a ghp token and a PEM are never on screen in any write (split every 15 characters)', async () => {
    const pg = 'postgres://app:pa$$w0rd!x#รหัสลับ@db.host.test:5432/x';
    const ghp = 'ghp_' + 'aZ3k9'.repeat(8);
    const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----';
    const body = `Intro words to get past the preview floor and holdback quickly enough. DB: ${pg} token ${ghp} key:\n${pem}\nThe end of the reply is here, thanks.`;
    installPlayer([playBody(body, 120, 15)]);
    const r = room(SOFTWARE_WORK, BOT_IDS.software);
    const w = await world({ rooms: [r] });
    await w.app.services.scheduler.onMessage(ask('secrets'));
    await w.app.services.scheduler.idle();
    const all = r.log.filter((e) => e.k !== 'typing');
    expect(all.length).toBeGreaterThanOrEqual(2);
    const shown = all.map((e) => e.content!).join('\n');
    for (const bad of ['pa$$', 'w0rd', 'รหัสลับ', 'aZ3k9', 'MIIEvQ', 'BEGIN PRIVATE']) expect(shown.includes(bad), bad).toBe(false);
    expect(shown).toContain('[REDACTED]');
  }, 60_000);
});

describe('(c2) baseline: the same answer with streaming off', () => {
  it('shows what a normal post does with @CEO (the stream must match it)', async () => {
    const body = 'Next step belongs to @CEO who should review it now, <@12345678901234567> and @everyone too.';
    installPlayer([playBody(body, 50, 60)]);
    const r = room(SOFTWARE_WORK, BOT_IDS.software);
    const w = await world({ rooms: [r], cfg: { 'stream.enabled': false } });
    await w.app.services.scheduler.onMessage(ask('who'));
    await w.app.services.scheduler.idle();
    expect(r.sends()).toHaveLength(1);
    expect(r.sends()[0]!.content).toContain('@CEO');
  }, 60_000);
});

describe('(d) retry: a hung first attempt then a good one resets the preview', () => {
  it('stream-hang then success: the late text replaces the early text, the final is the second attempt only', async () => {
    const first = 'FIRST ATTEMPT TEXT that the model wrote before the process stalled and was killed by the timeout. ';
    const second = 'SECOND attempt answer: a complete and different sentence that is long enough to preview. '.repeat(2).trim();
    const j1 = JSON.stringify(payloadOf(first.repeat(3)));
    const hungSteps = [
      { delay: 50, lines: [INIT, ev({ type: 'message_start' }), ev({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'x', name: 'StructuredOutput', input: {} } })] },
      { delay: 50, lines: [ev({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: j1.slice(0, 260) } })] },
    ];
    installPlayer([{ steps: hungSteps, hang: true }, playBody(second, 100, 40)]);
    const r = room(SOFTWARE_WORK, BOT_IDS.software);
    const w = await world({ rooms: [r], cfg: { 'provider.localTimeoutMs': 3000 } });
    await w.app.services.scheduler.onMessage(ask('retry'));
    await w.app.services.scheduler.idle();
    expect(r.sends()).toHaveLength(1);
    const writes = r.log.filter((e) => e.k !== 'typing');
    const finalContent = writes.at(-1)!.content!;
    expect(finalContent).toContain('SECOND attempt answer');
    expect(finalContent).not.toContain('FIRST ATTEMPT');
    expect(writes[0]!.content).toContain('FIRST ATTEMPT'); // the stalled attempt's text really was on screen
    // the first attempt's text was visible (preview of the stalled attempt) and was replaced, never concatenated
    const concatenated = writes.some((e) => e.content!.includes('FIRST ATTEMPT') && e.content!.includes('SECOND'));
    expect(concatenated).toBe(false);
    console.log('d: writes', writes.map((e) => `${e.k}:${JSON.stringify(e.content!.slice(0, 30))}`));
  }, 60_000);
});

describe('(e) halt mid-stream', () => {
  it('one fixed line replaces the preview; the partial text never becomes the answer', async () => {
    installPlayer([playBody(ANSWER, 400, 25)]);
    const r = room(SOFTWARE_WORK, BOT_IDS.software);
    const w = await world({ rooms: [r] });
    await w.app.services.scheduler.onMessage(ask('go'));
    const t0 = Date.now();
    while (r.sends().length === 0 && Date.now() - t0 < 10_000) await new Promise((x) => setTimeout(x, 20));
    await w.app.services.halt.halt('test');
    await w.app.services.scheduler.idle();
    await new Promise((x) => setTimeout(x, 2200)); // no late edit may follow
    const writes = r.log.filter((e) => e.k !== 'typing');
    expect(r.sends()).toHaveLength(1);
    expect(writes.at(-1)!.content).toBe('-# Stopped: the company is halted.');
    // exactly one fixed-line edit, and nothing after it
    expect(writes.filter((e) => e.content === '-# Stopped: the company is halted.')).toHaveLength(1);
    expect(r.log.filter((e) => e.k === 'typing' && e.t > writes.at(-1)!.t)).toHaveLength(0);
    // recorded as a code line, not an answer
    const rows = await w.rows();
    expect(rows.find((x) => x.message_id === r.sends()[0]!.id)).toMatchObject({ answer: false });
  }, 60_000);
});

describe('(f) an answer longer than 2000 characters', () => {
  it('the preview never exceeds 1900 (+marker); the final is split over 2+ messages, ids recorded as the answer', async () => {
    const body = Array.from({ length: 90 }, (_, i) => `Sentence number ${i} of a long streamed answer.`).join(' ');
    expect(body.length).toBeGreaterThan(2000);
    installPlayer([playBody(body, 60, 120)]);
    const r = room(SOFTWARE_WORK, BOT_IDS.software);
    const w = await world({ rooms: [r] });
    await w.app.services.scheduler.onMessage(ask('long'));
    await w.app.services.scheduler.idle();
    const sends = r.sends();
    expect(sends.length).toBeGreaterThanOrEqual(2);
    const progressive = [sends[0]!, ...r.edits().filter((e) => e.id === sends[0]!.id).slice(0, -1)];
    for (const e of progressive) expect(e.content!.length).toBeLessThanOrEqual(1900 + ELL.length);
    const finalFirst = r.edits().filter((e) => e.id === sends[0]!.id).at(-1)!;
    const joined = [finalFirst.content!, ...sends.slice(1).map((s) => s.content!)].join('');
    expect(finalFirst.content!.length).toBeLessThanOrEqual(2000);
    for (const s of sends.slice(1)) expect(s.content!.length).toBeLessThanOrEqual(2000);
    expect(joined.replace(/\s+/g, '')).toContain(body.slice(-200).replace(/\s+/g, ''));
    const rows = await w.rows();
    expect(rows.filter((x) => x.answer).map((x) => x.message_id).sort()).toEqual(sends.map((s) => s.id).sort());
  }, 60_000);
});

describe('(g) Praw (Gemini): typing only, no preview, one normal post', () => {
  it('a real Gemini provider over a fake client: typing before the answer, no edit, exactly one message', async () => {
    const gem = fakeGemini([{ chunks: [{ functionCalls: [{ name: 'respond', args: { type: 'chat', body: 'สวัสดีค่ะ พราวเองค่ะ ' + 'ข้อความยาวพอสมควร '.repeat(6) } }], usage: { promptTokens: 10, candidatesTokens: 5 } }] }]);
    await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, prompts);
    await db.pool.query("UPDATE departments SET work_channel_id = $1 WHERE id = 'praw'", [PRAW_ROOM]);
    await db.pool.query("INSERT INTO config (key, value) VALUES ('provider.default', $1)", [JSON.stringify({ provider: 'gemini', model: PRAW_DEFAULT_MODEL })]);
    const reg = new ProviderRegistry();
    reg.register(createGeminiProvider({ client: gem, sleep: async () => undefined, random: () => 0 }));
    const r = room(PRAW_ROOM, BOT_IDS.praw);
    const w = await world({ rooms: [r], registry: reg, depts: ['hq', 'praw'] });
    await w.app.services.scheduler.onMessage(humanMsg(`${mentionOf('praw')} สวัสดี`, { id: MSG_ID, channelId: PRAW_ROOM, mentionedHeads: ['praw'] }));
    await w.app.services.scheduler.idle();
    expect(gem.calls).toBe(1);
    expect(r.log.filter((e) => e.k === 'typing').length).toBeGreaterThanOrEqual(1);
    expect(r.sends()).toHaveLength(1);
    expect(r.edits()).toHaveLength(0);
    expect(r.sends()[0]!.content!.endsWith(ELL)).toBe(false);
    expect(r.log[0]!.k).toBe('typing');
    expect(r.sends()[0]!.content).toContain('สวัสดีค่ะ พราวเองค่ะ');
  }, 60_000);
});

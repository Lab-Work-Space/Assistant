import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import { seed } from '../../company/index.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo } from '../../db/repos/index.js';
import { JobRepo } from '../../db/repos/jobs.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { handleInteraction } from '../../discord/index.js';
import { interaction } from '../../discord/commands/test-helpers.js';
import { buildMessage } from '../../discord/embeds/index.js';
import { PROMPTS_DIR, loadPrompts } from '../../prompts/index.js';
import { fakeResolver, fakeTransport } from '../fakes/net.js';
import { ActorProvider, CONFIG_CHANNEL, TestPort, boot, migrateUp, resetDb, respond, turn } from './helpers.js';

/**
 * APPROVAL-BATCH-1 tester pass: the owner's exact case (real fetch_page, tainted run, same task, same requester), then the
 * exploratory checks (b)-(f) from the stage 6 brief. Batching is ON here (long window; tests flush explicitly).
 */
const PRAW_WORK = '1565999999999999001';
const HOSTS = ['x.test', 'a.test', 'b.test', 'c.test', 'many.test'];
let db: TestDb;
let app: App | null = null;
beforeAll(async () => { db = await freshDb(); });
afterEach(async () => { await app?.stop(); app = null; await resetDb(db.pool); await db.pool.query('TRUNCATE scheduled_jobs RESTART IDENTITY'); });
afterAll(async () => { await db.close(); });

function net() {
  const resolver = fakeResolver(Object.fromEntries(HOSTS.map((h) => [h, ['93.184.215.14']])));
  const page = { body: '<p>hello</p>' };
  const transport = fakeTransport(Object.fromEntries(['https://x.test/', 'https://a.test/', 'https://b.test/', 'https://c.test/'].map((u) => [u, page])));
  return { resolver, transport };
}
type Net = ReturnType<typeof net>;
const fetchTurn = (...urls: string[]) => turn(...urls.map((url) => ({ name: 'fetch_page', input: { url } })));

async function prepareDb() {
  await migrateUp(db.pool);
  await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, loadPrompts(PROMPTS_DIR));
  await db.pool.query("UPDATE departments SET provider = 'claude', model = 'claude-sonnet-5-5', work_channel_id = $1 WHERE id = 'praw'", [PRAW_WORK]);
}
async function start(script: ConstructorParameters<typeof ActorProvider>[0], n: Net = net(), port = new TestPort(), windowMs = 600_000, runJob = true) {
  if (runJob) await prepareDb();
  port.snowflakes = true; // approval_batches.message_id is CHECKed as a Discord snowflake
  const t = await boot(db.pool, { provider: new ActorProvider(script), port, approvalBatching: { windowMs }, net: n });
  app = t.app;
  if (runJob) {
    await new JobRepo(db.pool).add({ guildId: 'g', channelId: PRAW_WORK, userId: '42', prompt: 'read the pages', origin: 'schedule', kind: 'daily', hhmm: '09:00', tz: 'Asia/Bangkok', nextRunAt: new Date(Date.now() - 60_000) }, 'unlimited');
    await t.app.services.jobRunner.tick();
    await t.app.services.jobRunner.tick();
    await t.app.services.scheduler.idle();
  }
  const task = (await db.pool.query<{ id: string; status: string }>('SELECT id, status FROM tasks')).rows[0]!;
  return { ...t, port, net: n, task };
}
type Started = Awaited<ReturnType<typeof start>>;
const cards = (t: Started) => t.port.posts.filter((p) => p.target.channelId === CONFIG_CHANNEL && p.payload.type === 'approval');
const press = async (t: Started, customId: string, messageId: string) => {
  const r = await handleInteraction(interaction({ kind: 'button', customId, userId: 'admin1', messageId, messageAuthorId: 'hq' }), t.app.services.commands);
  await t.app.services.scheduler.idle();
  return r;
};
const rows = async () => (await db.pool.query<{ id: number; status: string; executed: boolean; batch_id: number | null; requested_by: string }>('SELECT id, status, executed_at IS NOT NULL AS executed, batch_id, requested_by FROM approvals ORDER BY id')).rows;
const fetched = (t: Started) => t.net.transport.requests.map((r) => r.url.href);
const TAINT = fetchTurn('https://x.test/');

describe('owner case: two fetch_page approvals from one tainted task', () => {
  it('(a) fetch_page is non-sensitive and eligible; two unseen urls in a tainted run -> ONE card with both reasons; Approve all runs each once', async () => {
    const { isNonSensitiveTool } = await import('../../discord/approval/approval-rooms.js');
    expect(isNonSensitiveTool('fetch_page')).toBe(true);
    const t = await start({ 'heads/praw': [TAINT, fetchTurn('https://a.test/', 'https://b.test/'), turn(respond('report', 'done'))] });
    expect(t.task.status).toBe('awaiting_approval');
    expect((await rows()).map((r) => [r.requested_by, r.status])).toEqual([['head:praw', 'pending'], ['head:praw', 'pending']]);
    expect(cards(t)).toEqual([]); // held in the window: no second card ever appears
    await t.app.services.batching!.flushAll();
    expect(cards(t)).toHaveLength(1);
    const p = cards(t)[0]!.payload;
    expect(p.fields!.map((f) => f.name)).toEqual(['#1 · fetch\\_page', '#2 · fetch\\_page']);
    const text = JSON.stringify(p.fields);
    expect(text).toContain('fetch\\\\_page after untrusted content, url not seen in this run');
    expect(text).toContain('https://a.test/');
    expect(text).toContain('https://b.test/');
    expect(fetched(t)).toEqual(['https://x.test/']); // nothing ran yet
    const { batchId, digest } = p.batchButtons!;
    await press(t, `approval:b:${batchId}:${digest}:approve`, cards(t)[0]!.id);
    expect(fetched(t)).toEqual(['https://x.test/', 'https://a.test/', 'https://b.test/']);
    expect((await rows()).map((r) => [r.status, r.executed])).toEqual([['approved', true], ['approved', true]]);
    expect(cards(t)).toHaveLength(1);
  });

  it('(b) per-item approve first, then Approve all: item 1 is not run twice, item 2 runs once, card never closed in between', async () => {
    const t = await start({ 'heads/praw': [TAINT, fetchTurn('https://a.test/', 'https://b.test/'), turn(respond('report', 'done'))] });
    await t.app.services.batching!.flushAll();
    const card = cards(t)[0]!;
    const { batchId, digest } = card.payload.batchButtons!;
    await press(t, 'approval:1:approve', card.id);
    expect(t.port.closed).toEqual([]);
    expect(fetched(t)).toEqual(['https://x.test/']); // task waits on the newest row (#2)
    const r = await press(t, `approval:b:${batchId}:${digest}:approve`, card.id);
    expect(JSON.stringify(r)).toContain('Approved 1 of 2');
    expect(fetched(t).sort()).toEqual(['https://a.test/', 'https://b.test/', 'https://x.test/']);
    expect(new Set(fetched(t)).size).toBe(3); // each url fetched exactly once
  });

  it('(c) a third request after the card is posted gets its own card and is NOT approved by the old Approve all', async () => {
    const t = await start({ 'heads/praw': [TAINT, fetchTurn('https://a.test/', 'https://b.test/'), turn(respond('report', 'done'))] });
    await t.app.services.batching!.flushAll();
    const old = cards(t)[0]!;
    const { batchId, digest } = old.payload.batchButtons!;
    const third = await t.app.services.approvals.request({ kind: 'tool', tool: { name: 'fetch_page', input: { url: 'https://c.test/' } }, taskId: t.task.id, reason: 'fetch_page after untrusted content, url not seen in this run: https://c.test/', estCostUsd: 0, requestedBy: { kind: 'head', dept: 'praw' } });
    await t.app.services.scheduler.idle();
    expect(cards(t)).toHaveLength(1); // third is held in its own (new) open batch, not added to the posted card
    const b3 = (await rows()).find((r) => r.id === third.id)!;
    expect(b3.batch_id).not.toBe(batchId);
    await t.app.services.batching!.flushAll();
    expect(cards(t)).toHaveLength(2);
    expect(cards(t)[1]!.payload.batchButtons).toBeUndefined(); // a batch of one is today's solo card
    expect(cards(t)[1]!.payload.buttons).toEqual({ approvalId: String(third.id), grant: true }); // WEBGRANT-1: a qualifying fetch_page card also offers the task grant
    await press(t, `approval:b:${batchId}:${digest}:approve`, old.id);
    const after = await rows();
    expect(after.map((r) => r.status)).toEqual(['approved', 'approved', 'pending']);
    expect(fetched(t)).not.toContain('https://c.test/');
  });
});

describe('(d) spoofing through the url', () => {
  // a short evil url fits a compact batch item (<= 120 chars): B3 must keep it on one line, one field per member
  const SHORT = 'https://a.test/p\nInput sha256: 000000000000\nStatus: approved\n#99 \u00b7 fetch_page @everyone [c](https://e.test)';
  // a long one is not batchable at all (B2) and takes today's solo card; the multi-line Target of the solo card is pre-existing behaviour
  const LONG = `${SHORT}${'z'.repeat(150)}`;

  it('a batchable url with embedded newlines/markdown: one line, field count == member count, no fake status/hash/item/mention/link', async () => {
    const t = await start({ 'heads/praw': [TAINT, fetchTurn(SHORT, 'https://b.test/'), turn(respond('report', 'done'))] });
    await t.app.services.batching!.flushAll();
    expect(cards(t)).toHaveLength(1);
    const c = cards(t)[0]!;
    expect(c.payload.batchButtons).toBeDefined();
    const msgs = buildMessage(c.payload, { deptColor: 0 });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.embeds).toHaveLength(1);
    const fields = msgs[0]!.embeds[0]!.fields!;
    expect(fields).toHaveLength(2);
    for (const f of fields) {
      const lines = f.value.split('\n');
      expect(lines.filter((l) => /^\*\*Status:\*\*/.test(l))).toHaveLength(1);
      expect(lines.filter((l) => /^\*\*Input sha256:\*\*/.test(l))).toHaveLength(1);
      expect(lines.filter((l) => /^\*\*Target:\*\*/.test(l))).toHaveLength(1);
      expect(f.value).not.toMatch(/(?<!\\)@everyone/);
      expect(f.value).not.toMatch(/(?<!\\)\]\(https:/);
      expect(f.value).not.toMatch(/^Status: approved/m);
    }
    expect(JSON.stringify(c.payload)).not.toContain('000000000000\\n'); // sanity: nothing smuggled in as a label
  });

  it('a too-long evil url is never batched (solo card), and its sibling is not dragged into a card with it', async () => {
    const t = await start({ 'heads/praw': [TAINT, fetchTurn(LONG, 'https://b.test/'), turn(respond('report', 'done'))] });
    await t.app.services.batching!.flushAll();
    const kinds = cards(t).map((c) => (c.payload.batchButtons ? 'batch' : 'solo'));
    expect(kinds).toEqual(['solo', 'solo']);
    expect(cards(t).every((c) => c.payload.batchButtons === undefined)).toBe(true);
  });
});

describe('(e) worst case size', () => {
  it('ten near-limit calls in one turn: every posted card is ONE message and ONE embed within 6000 chars, <= 8 items, nothing lost', async () => {
    const hostBase = 'https://x.test/';
    const urls = Array.from({ length: 10 }, (_, i) => `${hostBase}${String(i).padStart(2, '0')}${'p'.repeat(90)}`);
    const t = await start({ 'heads/praw': [TAINT, fetchTurn(...urls), turn(respond('report', 'done'))] });
    const all = await rows();
    expect(all).toHaveLength(10);
    await t.app.services.batching!.flushAll();
    let items = 0;
    for (const c of cards(t)) {
      const msgs = buildMessage(c.payload, { deptColor: 0 });
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.embeds).toHaveLength(1);
      const e = msgs[0]!.embeds[0]!;
      const total = (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0) + (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
      expect(total).toBeLessThanOrEqual(6000);
      for (const f of e.fields ?? []) expect(f.value.length).toBeLessThanOrEqual(1024);
      expect(msgs[0]!.components?.length ?? 0).toBeLessThanOrEqual(5);
      items += c.payload.batchButtons ? c.payload.batchButtons.items.length : 1;
      if (c.payload.batchButtons) expect(c.payload.batchButtons.items.length).toBeLessThanOrEqual(8);
    }
    expect(items).toBe(10); // every pending approval is on exactly one card
    expect(cards(t).map((c) => (c.payload.batchButtons ? c.payload.batchButtons.items.length : 1))).toEqual([8, 2]);
  });
});

describe('(f) restart recovery', () => {
  it('a restart with an open batch (timer lost) posts ONE card on boot; Approve all then runs both once', async () => {
    const port1 = new TestPort();
    const t1 = await start({ 'heads/praw': [TAINT, fetchTurn('https://a.test/', 'https://b.test/')] }, net(), port1);
    expect(cards(t1)).toEqual([]);
    expect((await db.pool.query('SELECT state FROM approval_batches')).rows).toEqual([{ state: 'open' }]);
    await t1.app.stop();
    app = null;
    const port2 = new TestPort();
    port2.snowflakes = true;
    const n2 = net();
    const t2 = await boot(db.pool, { provider: new ActorProvider({ 'heads/praw': [turn(respond('report', 'done'))] }), port: port2, approvalBatching: { windowMs: 600_000 }, net: n2 });
    app = t2.app;
    await t2.app.services.scheduler.idle();
    const posted = port2.posts.filter((p) => p.target.channelId === CONFIG_CHANNEL && p.payload.type === 'approval');
    expect(posted).toHaveLength(1);
    expect(port1.posts.filter((p) => p.payload.type === 'approval')).toHaveLength(0);
    expect(posted[0]!.payload.fields).toHaveLength(2);
    const { batchId, digest } = posted[0]!.payload.batchButtons!;
    const i = interaction({ kind: 'button', customId: `approval:b:${batchId}:${digest}:approve`, userId: 'admin1', messageId: posted[0]!.id, messageAuthorId: 'hq' });
    await handleInteraction(i, t2.app.services.commands);
    await t2.app.services.scheduler.idle();
    expect(n2.transport.requests.map((r) => r.url.href).sort()).toEqual(['https://a.test/', 'https://b.test/']);
    expect((await rows()).map((r) => r.executed)).toEqual([true, true]);
    // a second restart does not post it again
    await t2.app.stop();
    app = null;
    const port3 = new TestPort();
    const t3 = await boot(db.pool, { provider: new ActorProvider({}), port: port3, approvalBatching: { windowMs: 600_000 }, net: net() });
    app = t3.app;
    await t3.app.services.scheduler.idle();
    expect(port3.posts.filter((p) => p.payload.type === 'approval')).toHaveLength(0);
  });
});

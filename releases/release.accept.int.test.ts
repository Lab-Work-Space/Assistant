import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Message } from 'discord.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DeptId } from '../core/index.js';
import { migrate } from '../db/migrate.js';
import type { Department } from '../db/repos/index.js';
import { ReleaseRepo } from '../db/repos/releases.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { handleInteraction } from '../discord/commands/index.js';
import { cmd, interaction, makeDeps, text } from '../discord/commands/test-helpers.js';
import { CONFIG_CHANNEL_ID } from '../discord/commands/types.js';
import { createDiscordPort } from '../discord/port.js';
import { WebhookSender, type WebhookRepo } from '../discord/webhooks.js';
import { fakeChannel, fakeRestClient } from '../tests/fakes/discordClient.js';
import { ReleaseService, type ReleaseDeps } from './service.js';

/** R5 BE2 acceptance: the real repo, the real service and the REAL port on fake channels; the Bot Admin clicks go through handleInteraction (RL-C9, RL-C11). */
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const SRC = '700000000000000001';
const THREAD = '700000000000000002';
const TASK = '11111111-1111-4111-8111-111111111111';
const ROOT = 'abcdef01-2222-4222-8222-222222222222';
const HEAD = { kind: 'head', dept: 'software' } as const;
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x41, 0x42, 0x43, 0x00, 0x7f, 0x80, 0x81]); // not valid text: any redaction or re-encoding would change it
const SHA = createHash('sha256').update(ZIP).digest('hex');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const PROBE = 'v1 @everyone @CFO @software <@123456789012345678> [click](https://evil.example) `x`';

let db: TestDb;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, dir, 'up'); });
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  for (const t of ['releases', 'audit_log', 'workspaces']) await db.pool.query(`DELETE FROM ${t}`);
  await db.pool.query("INSERT INTO workspaces (slug, title, created_by) VALUES ('proj-a', 't', 'head:software')");
});

const dept = (id: string, ch: string): Department => ({ id, name: id, categoryNamePattern: id, workChannelId: ch, color: 1, model: null, provider: null, enabled: true });
type Sent = { files?: { name?: string; attachment: Buffer }[]; embeds?: unknown[]; content?: string; allowedMentions?: unknown };

async function rig(over: { failFile?: (channelId: string) => Error | null } = {}) {
  // the releases table stores Discord snowflakes (CHECK), so the fake channels hand out numeric message ids
  let seq = 0;
  const numeric = <T extends ReturnType<typeof fakeChannel>>(c: T): T => { const sent = c.sent; c.send = async (m: Parameters<T["send"]>[0]) => { sent.push(m); return { id: String(800000000000000000n + BigInt(++seq)) }; }; return c; };
  const setting = numeric(fakeChannel(CONFIG_CHANNEL_ID));
  const src = numeric(fakeChannel(SRC));
  const thread = numeric(fakeChannel(THREAD, { thread: SRC }));
  const swClient = fakeRestClient('app-sw', [setting, src, thread]);
  const hqClient = fakeRestClient('app-hq', [setting, src, thread]);
  const repo: WebhookRepo = { getByChannel: async () => null, getByWebhookId: async () => null, upsert: async () => {} };
  const port = createDiscordPort({ client: (d: DeptId) => (d === 'hq' ? hqClient : d === 'software' ? swClient : undefined) }, new WebhookSender(repo), {
    dept: (id) => ({ software: dept('software', SRC), hq: dept('hq', CONFIG_CHANNEL_ID) })[id as 'software' | 'hq'] ?? null, persona: () => null,
  }, { guildId: '1565649426943442944', adminRoleId: '1565000000000000001', inbound: async (m: Message) => ({ id: m.id }) as never, secrets: [] });
  const releaseRepo = new ReleaseRepo(db.pool);
  const closed: { channelId: string; messageId: string; note: string }[] = [];
  const notices: { dept: string; text: string }[] = [];
  const prov: unknown[][] = [];
  const logs: unknown[] = [];
  const deps: ReleaseDeps = {
    repo: releaseRepo, ws: { export: async () => ({ zip: ZIP, files: 2, sha256: SHA, skipped: 0 }) } as never,
    post: async () => '800000000000000031', projects: { byRoot: async () => null }, enabled: () => true, wsEnabled: () => true, halted: () => false, tz: () => 'Asia/Bangkok',
    audit: async (e) => { await db.pool.query('INSERT INTO audit_log (actor, action, tool, outcome) VALUES ($1,$2,$3,$4)', [e.actor, e.action, e.tool ?? null, e.outcome ?? null]); },
    secrets: [], configChannelId: CONFIG_CHANNEL_ID, catalogDigest: 'd'.repeat(64),
    postCard: (p) => port.post({ kind: 'head', dept: 'hq' }, { channelId: CONFIG_CHANNEL_ID }, p),
    postFile: async (a, t, p, f) => { const e = over.failFile?.(t.threadId ?? t.channelId); if (e) throw e; return port.postFile(a, t, p, f); },
    provenance: { record: async (...a) => void prov.push(a) },
    closeCard: async (channelId, messageId, note) => void closed.push({ channelId, messageId, note }),
    notifyHead: async (d, t) => void notices.push({ dept: d, text: t }),
    log: { error: (o) => void logs.push(o) },
  };
  const svc = new ReleaseService(deps);
  const t = await makeDeps({ releases: svc });
  const request = (title = 'My app', summary = 'It works.') => svc.request(HEAD, { tainted: false, task: { id: TASK, rootId: ROOT, tainted: false }, ownsTask: true, source: { channelId: SRC, threadId: THREAD } }, { slug: 'proj-a', title, summary });
  const rowOf = async (id: number) => (await db.pool.query<{ status: string; zip: Buffer | null; sha256: string; message_id: string | null; released_message_id: string | null; reason: string | null; outcome: string | null }>('SELECT status, zip, sha256, message_id, released_message_id, reason, outcome FROM releases WHERE id = $1', [id])).rows[0]!;
  return { svc, t, setting, src, thread, closed, notices, prov, logs, request, rowOf, releaseRepo };
}
const ADMIN = '900000000000000001'; // decided_by is a snowflake (CHECK)
const btn = (token: string, action: 'approve' | 'reject', messageId: string) => interaction({ kind: 'button', customId: `relcard:${token}:${action}`, messageId, userId: ADMIN });
const tokenOf = async (id: number) => (await db.pool.query<{ token: string }>('SELECT token FROM releases WHERE id = $1', [id])).rows[0]!.token;

describe('R5 acceptance: request, card, approve through the real route and port', () => {
  it('RL-C9: the copy in #setting and the zip in the thread carry exactly the pinned bytes; the row ends released with the zip NULL', async () => {
    const r = await rig();
    const res = await r.request(PROBE, `${PROBE} summary`);
    if (!res.ok) throw new Error(res.error);
    const pending = await r.rowOf(res.id);
    expect(pending.status).toBe('pending');
    expect(pending.zip!.equals(ZIP)).toBe(true);
    const sent = r.setting.sent as Sent[];
    expect(sent).toHaveLength(2); // the artefact copy, then the card
    const copy = sent[0]!.files![0]!;
    expect(copy.attachment.equals(ZIP)).toBe(true);
    expect(sha(copy.attachment)).toBe(pending.sha256);
    expect(JSON.stringify(sent[1]!.embeds)).toContain('Release request');
    const token = await tokenOf(res.id);
    expect(JSON.stringify((sent[1] as { components?: unknown }).components)).toContain(`relcard:${token}:approve`);
    expect(pending.message_id).toMatch(/^\d{17,20}$/);

    const click = btn(token, 'approve', pending.message_id!);
    const reply = await handleInteraction(click, r.t.deps);
    expect(text(reply)).toContain(`Released #${res.id}: posted in the task thread.`);
    expect(r.thread.sent).toHaveLength(1);
    const posted = (r.thread.sent as Sent[])[0]!;
    expect(posted.files).toHaveLength(1);
    expect(posted.files![0]!.name).toBe('proj-a.zip');
    expect(posted.files![0]!.attachment.equals(ZIP)).toBe(true);
    expect(sha(posted.files![0]!.attachment)).toBe(pending.sha256);
    const body = JSON.stringify(posted);
    expect(body).toContain('approved by a Bot Admin');
    expect(body).not.toContain('@everyone');
    expect(body).not.toMatch(/(?<!\\)\[click\]\(/);
    expect(posted.allowedMentions).toEqual({ parse: [] });
    const done = await r.rowOf(res.id);
    expect(done).toMatchObject({ status: 'released', zip: null, outcome: 'ok' });
    expect(done.released_message_id).toMatch(/^\d{17,20}$/);
    expect(r.prov.some((a) => a[0] === done.released_message_id && a[2] === true)).toBe(true);
    expect(r.notices.map((n) => n.dept)).toEqual(['software']);
    expect(r.closed).toHaveLength(1);
    // the stored-message link of /release show points at the thread message
    const shown = text(await handleInteraction(cmd('release', 'show', { numbers: { id: res.id } }), r.t.deps));
    expect(shown).toContain(`https://discord.com/channels/1565649426943442944/${THREAD}/${done.released_message_id}`);
    // a second click is not_pending and posts nothing more
    expect(text(await handleInteraction(btn(token, 'approve', pending.message_id!), r.t.deps))).toContain('Already decided.');
    expect(r.thread.sent).toHaveLength(1);
  });
  it('RL-C11 at route level: the same id from another channel or without the role does nothing', async () => {
    const r = await rig();
    const res = await r.request();
    if (!res.ok) throw new Error(res.error);
    const row = await r.rowOf(res.id);
    const token = await tokenOf(res.id);
    expect(text(await handleInteraction(interaction({ kind: 'button', customId: `relcard:${token}:approve`, messageId: row.message_id!, channelId: SRC }), r.t.deps))).toContain('#⚙️-setting');
    expect(text(await handleInteraction(interaction({ kind: 'button', customId: `relcard:${token}:approve`, messageId: row.message_id!, roles: [] }), r.t.deps))).toContain('Only Bot Admins');
    expect(text(await handleInteraction(btn(token, 'approve', '800000000000000555'), r.t.deps))).toContain('does not belong to this card');
    expect((await r.rowOf(res.id)).status).toBe('pending');
    expect(r.thread.sent).toHaveLength(0);
  });
  it('a certain refusal (HTTP 4xx) on the thread post reverts to pending; a 5xx fails the row as post_unknown and is never re-posted', async () => {
    const r4 = await rig({ failFile: (c) => (c === THREAD ? Object.assign(new Error('Missing Access'), { status: 403 }) : null) });
    const a = await r4.request();
    if (!a.ok) throw new Error(a.error);
    const ra = await r4.rowOf(a.id);
    expect(text(await handleInteraction(btn(await tokenOf(a.id), 'approve', ra.message_id!), r4.t.deps))).toContain('Press Approve again or Reject');
    expect((await r4.rowOf(a.id)).status).toBe('pending');
    await db.pool.query('DELETE FROM releases');
    const r5 = await rig({ failFile: (c) => (c === THREAD ? Object.assign(new Error('Bad Gateway'), { status: 502 }) : null) });
    const b = await r5.request();
    if (!b.ok) throw new Error(b.error);
    const rb = await r5.rowOf(b.id);
    expect(text(await handleInteraction(btn(await tokenOf(b.id), 'approve', rb.message_id!), r5.t.deps))).toContain('could not be confirmed');
    expect(await r5.rowOf(b.id)).toMatchObject({ status: 'failed', zip: null, outcome: 'post_unknown' });
    expect(text(await handleInteraction(btn(await tokenOf(b.id), 'approve', rb.message_id!), r5.t.deps))).toContain('Already decided.');
  });
});

describe('R5 acceptance: reject with a reason, and expiry', () => {
  it('/release reject stores the screened reason, purges the zip, tells the head with the quoted reason; a masked probe cannot ping', async () => {
    const r = await rig();
    const res = await r.request();
    if (!res.ok) throw new Error(res.error);
    const out = await handleInteraction(cmd('release', 'reject', { userId: ADMIN, numbers: { id: res.id }, strings: { reason: 'not yet @everyone call me on 0812345678' } }), r.t.deps);
    expect(text(out)).toContain('Rejected. Nothing was released.');
    const row = await r.rowOf(res.id);
    expect(row).toMatchObject({ status: 'rejected', zip: null });
    expect(row.reason).not.toContain('0812345678'); // PII masking is on (RL-C10)
    expect(r.notices[0]!.text).toContain('Reason from a Bot Admin: "');
    expect(r.closed[0]!.note).toContain('with a reason');
    expect(r.thread.sent).toHaveLength(0);
    expect(text(await handleInteraction(cmd('release', 'reject', { userId: ADMIN, numbers: { id: res.id }, strings: { reason: 'again' } }), r.t.deps))).toContain('Already decided.');
    expect(text(await handleInteraction(cmd('release', 'reject', { userId: ADMIN, numbers: { id: 4040 }, strings: { reason: 'again' } }), r.t.deps))).toContain('No release with that number.');
  });
  it('the Reject button rejects without a reason', async () => {
    const r = await rig();
    const res = await r.request();
    if (!res.ok) throw new Error(res.error);
    const row = await r.rowOf(res.id);
    expect(text(await handleInteraction(btn(await tokenOf(res.id), 'reject', row.message_id!), r.t.deps))).toContain('Rejected. Nothing was released.');
    expect(await r.rowOf(res.id)).toMatchObject({ status: 'rejected', zip: null, reason: null });
  });
  it('expiry: a request past its 7 days is expired by the sweep, the zip purged, the card closed and the head told; a late click is refused', async () => {
    const r = await rig();
    const res = await r.request();
    if (!res.ok) throw new Error(res.error);
    const row = await r.rowOf(res.id);
    await db.pool.query("UPDATE releases SET created_at = created_at - interval '8 days', expires_at = expires_at - interval '8 days' WHERE id = $1", [res.id]);
    expect(text(await handleInteraction(btn(await tokenOf(res.id), 'approve', row.message_id!), r.t.deps))).toContain('expired');
    expect(await r.svc.sweep()).toBe(1);
    expect(await r.rowOf(res.id)).toMatchObject({ status: 'expired', zip: null });
    expect(r.closed[0]!.note).toContain('Expired after 7 days');
    expect(r.notices[0]!.text).toContain('expired after 7 days');
    expect(r.thread.sent).toHaveLength(0);
    const list = text(await handleInteraction(cmd('release', 'list'), r.t.deps));
    expect(list).toContain(`#${res.id} proj-a (expired)`);
  });
});

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import { EventBus, type AppEvents } from '../../core/events.js';
import { DepartmentRepo, TaskRepo, ApprovalBatchRepo } from '../../db/index.js';
import { migrate } from '../../db/migrate.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { ApprovalRooms, isNonSensitiveTool } from '../../discord/approval/approval-rooms.js';
import { approvalBatchHooks } from '../../discord/commands/approval.js';
import { handleInteraction } from '../../discord/index.js';
import { ADMIN_ROLE, interaction, makeDeps } from '../../discord/commands/test-helpers.js';
import { CONFIG_CHANNEL_ID } from '../../discord/commands/types.js';
import { compactItemFits, soloShowsWhole, toolApprovalPayload } from '../../discord/embeds/approval.js';
import { ApprovalBatching } from '../../governance/approval/approval-batches.js';
import { Approvals } from '../../governance/approval/approvals.js';
import { itemsDigest } from '../../governance/canonical.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeDiscordPort } from '../fakes/discordPort.js';
import type { OutboundPayload } from '../../agents/loop/payload.js';
import type { Approval } from '../../db/repos/ledger.js';

const migrations = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');
const hq: ActorRef = { kind: 'head', dept: 'hq' };
const praw: ActorRef = { kind: 'head', dept: 'praw' };
const admin = { id: 'admin1', isAdmin: true };
let db: TestDb;
let tasks: TaskRepo;
let repo: ApprovalBatchRepo;
const fitsAll = () => true;
const NO_SECRETS: string[] = [];

class FakeHalt {
  halted = false;
  haltFromCall = Infinity;
  calls = 0;
  isHalted() { this.calls++; return this.halted || this.calls >= this.haltFromCall; }
}

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, migrations, 'up');
  await new DepartmentRepo(db.pool).upsert({ id: 'hq', name: 'HQ', categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
  tasks = new TaskRepo(db.pool);
  repo = new ApprovalBatchRepo(db.pool);
});
beforeEach(async () => {
  await db.pool.query('DELETE FROM web_grants');
  await db.pool.query('DELETE FROM approvals');
  await db.pool.query('DELETE FROM approval_batches');
  await db.pool.query('DELETE FROM budget_days');
  await db.pool.query('DELETE FROM tasks');
});
afterAll(async () => { await db.close(); });
/** Every batcher a test makes: stopped after the test, so a failed assertion cannot leak a live window timer into the next one. */
const made: { stop(): void }[] = [];
afterEach(() => { for (const b of made.splice(0)) b.stop(); });

const newTask = () => tasks.create({ title: 't', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'chat' });

function mk() {
  const cfg = new FakeConfig();
  const bus = new EventBus<AppEvents>();
  const halt = new FakeHalt();
  const changed: { id: string; from: string; to: string }[] = [];
  const ready: string[] = [];
  bus.on('task.changed', (e) => { changed.push({ id: e.task.id, from: e.from, to: e.to }); });
  bus.on('task.ready', (e) => { ready.push(e.taskId); });
  const audits: { action: string; outcome?: string | null; taskId?: string | null; tool?: string | null }[] = [];
  const approvals = new Approvals(db.pool, tasks, cfg, bus, halt, async (e) => { audits.push(e); }, [], isNonSensitiveTool);
  return { cfg, bus, halt, changed, ready, approvals, audits };
}

let urlSeq = 0;
const tool = (approvals: Approvals, taskId: string, over: { name?: string; input?: Record<string, unknown>; reason?: string; by?: ActorRef } = {}) =>
  approvals.request({
    taskId, reason: over.reason ?? 'fetch_page after untrusted content, url not seen in this run', estCostUsd: 0, requestedBy: over.by ?? praw, kind: 'tool',
    tool: { name: over.name ?? 'fetch_page', input: over.input ?? { url: `https://example.com/${++urlSeq}` } },
  });

/** Opens one batch holding `n` fresh tool approvals of one task (joined through the repo, as the scheduler does). */
async function batchOf(approvals: Approvals, n: number, taskId?: string) {
  const t = taskId ?? (await newTask()).id;
  const members: Approval[] = [];
  let batchId = 0;
  for (let i = 0; i < n; i++) {
    const a = await tool(approvals, t);
    const r = await repo.join(a, { windowMs: 60_000, fits: fitsAll });
    if (r.kind !== 'joined') throw new Error('expected a join');
    batchId = r.batchId;
    members.push(a);
  }
  await repo.seal(batchId);
  const b = (await repo.get(batchId))!;
  await repo.markPosted(batchId, '1570000000000000001', '1570000000000000002');
  return { taskId: t, batchId, digest: b.digest!, members };
}

describe('B4: the DB enforces membership', () => {
  it('a member of another task or another requester, a re-pointed or cleared batch_id, and a 9th item are refused', async () => {
    const { approvals } = mk();
    const t1 = await newTask();
    const t2 = await newTask();
    const a = await tool(approvals, t1.id);
    const r = await repo.join(a, { windowMs: 60_000, fits: fitsAll });
    if (r.kind !== 'joined') throw new Error('join');
    const other = await tool(approvals, t2.id);
    await expect(db.pool.query('UPDATE approvals SET batch_id = $1 WHERE id = $2', [r.batchId, other.id])).rejects.toThrow(/foreign key|approvals_batch_fk/i);
    const otherRequester = await tool(approvals, t1.id, { by: { kind: 'head', dept: 'hq' } });
    await expect(db.pool.query('UPDATE approvals SET batch_id = $1 WHERE id = $2', [r.batchId, otherRequester.id])).rejects.toThrow(/foreign key|approvals_batch_fk/i);
    await repo.seal(r.batchId);
    const second = await repo.join(await tool(approvals, t2.id), { windowMs: 60_000, fits: fitsAll });
    if (second.kind !== 'joined') throw new Error('join');
    await expect(db.pool.query('UPDATE approvals SET batch_id = $1 WHERE id = $2', [second.batchId, a.id])).rejects.toThrow(/immutable|foreign key/i);
    await expect(db.pool.query('UPDATE approvals SET batch_id = NULL WHERE id = $1', [a.id])).rejects.toThrow(/immutable/i);
    await expect(db.pool.query('UPDATE approval_batches SET item_count = 9 WHERE id = $1', [second.batchId])).rejects.toThrow(/check/i);
    await expect(db.pool.query("UPDATE approvals SET kind = 'estimate' WHERE id = $1", [a.id])).rejects.toThrow(/check/i);
    await expect(db.pool.query("UPDATE approval_batches SET state = 'sealed', items_digest = NULL WHERE id = $1", [second.batchId])).rejects.toThrow(/check/i);
    await expect(db.pool.query("UPDATE approval_batches SET state = 'bogus' WHERE id = $1", [second.batchId])).rejects.toThrow(/check/i);
  });

  it('a join never enters a sealed batch, and the 9th item opens a new batch after the first 8 are sealed', async () => {
    const { approvals } = mk();
    const t = await newTask();
    const ids: number[] = [];
    let first = 0;
    for (let i = 0; i < 8; i++) {
      const r = await repo.join(await tool(approvals, t.id), { windowMs: 60_000, fits: fitsAll });
      if (r.kind !== 'joined') throw new Error('join');
      first ||= r.batchId;
      ids.push(r.batchId);
      if (i === 7) expect(r.sealed).toEqual([first]); // the 8th seals it
    }
    expect(new Set(ids).size).toBe(1);
    expect((await repo.get(first))).toMatchObject({ state: 'sealed', itemCount: 8 });
    const ninth = await repo.join(await tool(approvals, t.id), { windowMs: 60_000, fits: fitsAll });
    expect(ninth).toMatchObject({ kind: 'joined', opened: true });
    expect(ninth.kind === 'joined' && ninth.batchId).not.toBe(first);
    expect((await repo.members(first, 72)).length).toBe(8);
  });

  it('a different task or a different requester opens its own batch within the window', async () => {
    const { approvals } = mk();
    const t1 = await newTask();
    const t2 = await newTask();
    const j = async (a: Approval) => { const r = await repo.join(a, { windowMs: 60_000, fits: fitsAll }); return r.kind === 'joined' ? r.batchId : -1; };
    const a1 = await j(await tool(approvals, t1.id));
    const a2 = await j(await tool(approvals, t1.id));
    const b1 = await j(await tool(approvals, t2.id));
    const c1 = await j(await tool(approvals, t1.id, { by: hq }));
    expect(a1).toBe(a2);
    expect(new Set([a1, b1, c1]).size).toBe(3);
  });

  it('an expired window seals the old batch (to publish) and the item opens a new one', async () => {
    const { approvals } = mk();
    const t = await newTask();
    const first = await repo.join(await tool(approvals, t.id), { windowMs: 60_000, fits: fitsAll });
    if (first.kind !== 'joined') throw new Error('join');
    await db.pool.query("UPDATE approval_batches SET opened_at = now() - interval '1 minute' WHERE id = $1", [first.batchId]);
    const next = await repo.join(await tool(approvals, t.id), { windowMs: 10_000, fits: fitsAll });
    expect(next).toMatchObject({ kind: 'joined', opened: true, sealed: [first.batchId] });
  });
});

describe('B5: the digest binds the members and their input hashes', () => {
  it('a join racing a seal is either in the digest or refused, never neither', async () => {
    const { approvals } = mk();
    for (let i = 0; i < 12; i++) {
      const t = await newTask();
      const a1 = await tool(approvals, t.id);
      const r1 = await repo.join(a1, { windowMs: 60_000, fits: fitsAll });
      if (r1.kind !== 'joined') throw new Error('join');
      const a2 = await tool(approvals, t.id);
      const [, r2] = await Promise.all([repo.seal(r1.batchId), repo.join(a2, { windowMs: 60_000, fits: fitsAll })]);
      for (const b of (await db.pool.query<{ id: number; digest: string | null; state: string }>('SELECT id, items_digest AS digest, state FROM approval_batches WHERE task_id = $1', [t.id])).rows) {
        if (b.state === 'open') continue;
        const m = (await db.pool.query<{ id: number; sha: string }>('SELECT id, input_sha256 AS sha FROM approvals WHERE batch_id = $1 ORDER BY id', [b.id])).rows;
        expect(b.digest, `iteration ${i}`).toBe(itemsDigest(m.map((x) => ({ id: x.id, inputSha256: x.sha }))));
      }
      const row = (await db.pool.query<{ batch_id: number | null }>('SELECT batch_id FROM approvals WHERE id = $1', [a2.id])).rows[0]!;
      if (r2.kind === 'joined') expect(row.batch_id).toBe(r2.batchId);
      else expect(row.batch_id).toBeNull(); // went solo
    }
  });

  it('a digest of another batch, or a changed input_sha256, is refused as stale and changes nothing', async () => {
    const { approvals } = mk();
    const x = await batchOf(approvals, 2);
    const y = await batchOf(approvals, 2);
    expect(await approvals.decideBatch(x.batchId, y.digest, 'approved', admin)).toEqual({ ok: false, error: 'stale' });
    expect(await approvals.decideBatch(x.batchId, '000000000000', 'approved', admin)).toEqual({ ok: false, error: 'stale' });
    await db.pool.query("UPDATE approvals SET input_sha256 = repeat('b', 64) WHERE id = $1", [x.members[0]!.id]);
    expect(await approvals.decideBatch(x.batchId, x.digest, 'approved', admin)).toEqual({ ok: false, error: 'stale' });
    expect((await db.pool.query("SELECT count(*)::int AS n FROM approvals WHERE status <> 'pending'")).rows[0].n).toBe(0);
    expect((await tasks.get(x.taskId))!.status).toBe('awaiting_approval');
  });

  it('a late member forced into a sealed batch makes the click stale', async () => {
    const { approvals } = mk();
    const x = await batchOf(approvals, 2);
    const late = await tool(approvals, x.taskId);
    await db.pool.query('UPDATE approvals SET batch_id = $1 WHERE id = $2', [x.batchId, late.id]); // the DB allows it (same task, same requester); the digest does not
    expect(await approvals.decideBatch(x.batchId, x.digest, 'approved', admin)).toEqual({ ok: false, error: 'stale' });
  });
});

describe('B6: decideBatch', () => {
  it('Approve all on 3 items of one task: exactly the frozen members, one task.changed to todo, one task.ready; claimTools sees every row', async () => {
    const { approvals, changed, ready } = mk();
    const x = await batchOf(approvals, 3);
    changed.length = 0; ready.length = 0;
    const r = await approvals.decideBatch(x.batchId, x.digest, 'approved', admin);
    expect(r.ok && r.decided.map((a) => a.id)).toEqual(x.members.map((m) => m.id));
    expect(r.ok && r.skipped).toEqual([]);
    expect(changed.filter((c) => c.to === 'todo')).toHaveLength(1);
    expect(ready).toEqual([x.taskId]);
    expect((await tasks.get(x.taskId))!.status).toBe('todo');
    const claimed = await approvals.claimToolOutcomes(x.taskId);
    expect(claimed.map((c) => c.kind === 'run' && c.approvalId)).toEqual(x.members.map((m) => m.id));
    // the same click again decides nothing
    const again = await approvals.decideBatch(x.batchId, x.digest, 'approved', admin);
    expect(again.ok && again.decided).toEqual([]);
    expect(again.ok && again.skipped.map((s) => s.why)).toEqual(['not_pending', 'not_pending', 'not_pending']);
  });

  it('Deny all cancels the task once', async () => {
    const { approvals, changed } = mk();
    const x = await batchOf(approvals, 3);
    changed.length = 0;
    const r = await approvals.decideBatch(x.batchId, x.digest, 'rejected', admin);
    expect(r.ok && r.decided).toHaveLength(3);
    expect(changed.filter((c) => c.to === 'cancelled')).toHaveLength(1);
    expect((await tasks.get(x.taskId))!.status).toBe('cancelled');
  });

  it('non-admin and a malformed digest are refused before any DB work', async () => {
    const { approvals } = mk();
    const x = await batchOf(approvals, 2);
    expect(await approvals.decideBatch(x.batchId, x.digest, 'approved', { id: 'u', isAdmin: false })).toEqual({ ok: false, error: 'not_admin' });
    expect(await approvals.decideBatch(x.batchId, 'ZZ', 'approved', admin)).toEqual({ ok: false, error: 'not_found' });
    expect(await approvals.decideBatch(99999, x.digest, 'approved', admin)).toEqual({ ok: false, error: 'not_found' });
  });

  it('the newest item expired by the DB clock is skipped (it stays pending for expireOld, which then expires it); the others are approved', async () => {
    const { approvals } = mk();
    const x = await batchOf(approvals, 3);
    const newest = x.members[2]!.id;
    await db.pool.query("UPDATE approvals SET created_at = now() - interval '100 hours' WHERE id = $1", [newest]);
    const r = await approvals.decideBatch(x.batchId, x.digest, 'approved', admin);
    expect(r.ok && r.decided.map((a) => a.id)).toEqual([x.members[0]!.id, x.members[1]!.id]);
    expect(r.ok && r.skipped).toEqual([{ id: newest, why: 'expired' }]);
    expect((await db.pool.query<{ status: string }>('SELECT status FROM approvals WHERE id = $1', [newest])).rows[0]!.status).toBe('pending');
    expect((await tasks.get(x.taskId))!.status).toBe('awaiting_approval'); // the task waits on the newest row
    expect(await approvals.expireOld()).toBe(1);
    expect((await db.pool.query<{ status: string }>('SELECT status FROM approvals WHERE id = $1', [newest])).rows[0]!.status).toBe('expired');
    expect((await db.pool.query<{ status: string }>('SELECT status FROM approvals WHERE id = $1', [x.members[0]!.id])).rows[0]!.status).toBe('approved');
    expect((await tasks.get(x.taskId))!.status).toBe('cancelled');
  });

  it('the task moves only on the newest row (older rows approved, newest rejected via per-item decide cancels)', async () => {
    const { approvals } = mk();
    const x = await batchOf(approvals, 3);
    expect((await approvals.decide(x.members[0]!.id, 'approved', admin)).ok).toBe(true);
    expect((await tasks.get(x.taskId))!.status).toBe('awaiting_approval');
    const r = await approvals.decideBatch(x.batchId, x.digest, 'approved', admin);
    expect(r.ok && r.decided).toHaveLength(2);
    expect(r.ok && r.skipped).toEqual([{ id: x.members[0]!.id, why: 'not_pending' }]);
    expect((await tasks.get(x.taskId))!.status).toBe('todo');
  });

  it('while halted the task stays awaiting_approval, exactly as decide()', async () => {
    const { approvals, halt, ready } = mk();
    const x = await batchOf(approvals, 2);
    halt.halted = true;
    const r = await approvals.decideBatch(x.batchId, x.digest, 'approved', admin);
    expect(r.ok && r.decided).toHaveLength(2);
    expect((await tasks.get(x.taskId))!.status).toBe('awaiting_approval');
    expect(ready).toEqual([]);
  });

  it('a member that is a sensitive tool now refuses the whole click', async () => {
    const { approvals } = mk();
    const x = await batchOf(approvals, 2);
    await db.pool.query("UPDATE approvals SET tool_name = 'github_create_issue' WHERE id = $1", [x.members[1]!.id]);
    expect(await approvals.decideBatch(x.batchId, x.digest, 'approved', admin)).toEqual({ ok: false, error: 'stale' });
    expect((await db.pool.query("SELECT count(*)::int AS n FROM approvals WHERE status <> 'pending'")).rows[0].n).toBe(0);
  });

  it('a batch that is not posted (open, sealed, dissolved) is stale', async () => {
    const { approvals } = mk();
    const x = await batchOf(approvals, 2);
    await db.pool.query("UPDATE approval_batches SET state = 'dissolved' WHERE id = $1", [x.batchId]);
    expect(await approvals.decideBatch(x.batchId, x.digest, 'approved', admin)).toEqual({ ok: false, error: 'stale' });
  });

  it('concurrent Approve all and a per-item approve decide each row exactly once', async () => {
    const { approvals } = mk();
    const x = await batchOf(approvals, 3);
    const [b, s] = await Promise.all([approvals.decideBatch(x.batchId, x.digest, 'approved', admin), approvals.decide(x.members[1]!.id, 'approved', admin)]);
    const batchDecided = b.ok ? b.decided.length : 0;
    expect(batchDecided + (s.ok ? 1 : 0)).toBe(3);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM approvals WHERE status = 'approved'")).rows[0].n).toBe(3);
  });

  it('the composite state stays valid: the dissolved batch of one keeps its batch_id', async () => {
    const { approvals } = mk();
    const t = await newTask();
    const a = await tool(approvals, t.id);
    const r = await repo.join(a, { windowMs: 60_000, fits: fitsAll });
    if (r.kind !== 'joined') throw new Error('join');
    await repo.seal(r.batchId);
    expect(await repo.dissolve(r.batchId)).toBe(true);
    expect((await repo.ofApproval(a.id))).toMatchObject({ state: 'dissolved' });
  });
});

/** The scheduler's side, with a real repo and a fake Discord port. */
function batching(over: { port?: FakeDiscordPort; windowMs?: number; repo?: ApprovalBatchRepo; stuckAfterMs?: number } = {}) {
  const cfg = new FakeConfig();
  const port = over.port ?? new FakeDiscordPort();
  port.snowflakes = true; // message ids are snowflakes, as Discord's (the batch row checks them)
  const rooms = new ApprovalRooms({ cfg, tasks, port, org: { heads: () => [] }, botUserIds: () => new Map(), adminRoleId: ADMIN_ROLE, alert: async () => undefined, log: { error() {} } } as never);
  const alerts: string[] = [];
  const logged: unknown[] = [];
  const b = new ApprovalBatching({
    repo: over.repo ?? repo, expiryHours: () => cfg.get('approval.expiryHours'), ...(over.stuckAfterMs !== undefined ? { stuckAfterMs: over.stuckAfterMs } : {}), log: { error: (o) => void logged.push(o) }, ...(over.windowMs !== undefined ? { windowMs: over.windowMs } : {}),
    ...approvalBatchHooks({ port, rooms, secrets: NO_SECRETS }),
    alert: async (t) => void alerts.push(t),
  });
  made.push(b);
  return { b, port, alerts, logged };
}
const cards = (port: FakeDiscordPort) => port.posts.filter((p) => p.payload.type === 'approval');

describe('ApprovalBatching (B7, B9, B10)', () => {
  it('two items of one task within the window share one card, posted once when the batch is sealed', async () => {
    const { approvals } = mk();
    const t = await newTask();
    const { b, port } = batching({ windowMs: 10_000 });
    const a1 = await tool(approvals, t.id);
    const a2 = await tool(approvals, t.id);
    expect(await b.enqueue(a1)).toBe('batched');
    expect(await b.enqueue(a2)).toBe('batched');
    expect(cards(port)).toHaveLength(0);
    await b.flushAll();
    expect(cards(port)).toHaveLength(1);
    const p = cards(port)[0]!;
    expect(p.target.channelId).toBe(CONFIG_CHANNEL_ID);
    expect(p.payload.batchButtons).toMatchObject({ items: [{ id: a1.id, pending: true }, { id: a2.id, pending: true }] });
    expect(p.payload.buttons).toBeUndefined();
    const row = (await repo.ofApproval(a1.id))!;
    expect(row).toMatchObject({ state: 'posted', messageId: p.id, channelId: CONFIG_CHANNEL_ID });
    b.stop();
  });

  it('B10: a batch of one is dissolved and posts exactly today\'s card payload', async () => {
    const { approvals } = mk();
    const t = await newTask();
    const { b, port } = batching({ windowMs: 30 });
    const a = await tool(approvals, t.id);
    expect(await b.enqueue(a)).toBe('batched');
    await new Promise((r) => setTimeout(r, 100));
    await b.idle();
    expect(cards(port)).toHaveLength(1);
    expect(cards(port)[0]!.payload).toEqual(toolApprovalPayload(a, NO_SECRETS));
    expect((await repo.ofApproval(a.id))!.state).toBe('dissolved');
    b.stop();
  });

  it('B10: two tasks, or two requesters, within the window never share a card', async () => {
    const { approvals } = mk();
    const t1 = await newTask();
    const t2 = await newTask();
    const { b, port } = batching({ windowMs: 10_000 });
    for (const a of [await tool(approvals, t1.id), await tool(approvals, t1.id), await tool(approvals, t2.id), await tool(approvals, t2.id), await tool(approvals, t1.id, { by: hq })]) await b.enqueue(a);
    await b.flushAll();
    const posted = cards(port);
    expect(posted.filter((p) => p.payload.batchButtons)).toHaveLength(2); // t1/praw and t2/praw
    expect(posted.filter((p) => p.payload.buttons)).toHaveLength(1); // t1/hq alone: today's card
    for (const p of posted.filter((x) => x.payload.batchButtons)) expect(p.payload.fields).toHaveLength(2);
    b.stop();
  });

  it('B7: estimate, cap and sensitive-tool approvals are never batched', async () => {
    const { approvals } = mk();
    const t = await newTask();
    const { b } = batching({ windowMs: 10_000 });
    const est = await approvals.request({ taskId: t.id, reason: 'big', estCostUsd: 5, requestedBy: praw });
    expect(await b.enqueue(est)).toBe('solo');
    const cap = await approvals.onTreeCapHit({ rootId: t.id, est: 1, requestedBy: praw });
    expect(cap && (await b.enqueue({ ...cap, kind: 'tree_cap' }))).toBe('solo');
    const local = await approvals.onLocalCapHit({ rootId: t.id, requestedBy: praw });
    expect(local && (await b.enqueue({ ...local, kind: 'local_cap' }))).toBe('solo');
    for (const name of ['github_create_issue', 'deploy_site', 'server_create_channel', 'save_lesson', 'config_set']) {
      expect(await b.enqueue(await tool(approvals, t.id, { name })), name).toBe('solo');
    }
    expect((await db.pool.query('SELECT count(*)::int AS n FROM approvals WHERE batch_id IS NOT NULL')).rows[0].n).toBe(0);
    expect(await b.enqueue(await tool(approvals, t.id))).toBe('batched');
    b.stop();
  });

  it('B2: an item the card would have to cut goes solo, and an item that overflows the card total seals the batch first and goes solo', async () => {
    const { approvals } = mk();
    const t = await newTask();
    const { b, port } = batching({ windowMs: 10_000 });
    expect(await b.enqueue(await tool(approvals, t.id, { input: { url: 'x'.repeat(300) } }))).toBe('solo'); // cut
    const big = (n: number) => tool(approvals, t.id, { input: { url: 'u'.repeat(110), id: 'i'.repeat(110), query: 'q'.repeat(240), a: 'a'.repeat(100), b: 'b'.repeat(100), n } });
    let batched = 0;
    let solo = 0;
    for (let i = 0; i < 8; i++) (await b.enqueue(await big(i))) === 'batched' ? batched++ : solo++;
    expect(solo).toBeGreaterThan(0);
    expect(batched).toBeLessThan(8);
    await b.flushAll();
    for (const p of port.posts.filter((x) => x.payload.batchButtons)) expect(p.payload.fields!.length).toBeLessThanOrEqual(batched);
    b.stop();
  });

  it('B9(a): a port that fails the batch post gives solo cards for each pending item plus one alert, and the batch is dissolved', async () => {
    const { approvals } = mk();
    const t = await newTask();
    const port = new FakeDiscordPort();
    const realPost = port.post.bind(port);
    port.post = async (actor, target, payload, opts) => {
      if (payload.batchButtons) throw new Error('discord is down');
      return realPost(actor, target, payload, opts);
    };
    const { b, alerts } = batching({ port, windowMs: 10_000 });
    const a = [await tool(approvals, t.id), await tool(approvals, t.id), await tool(approvals, t.id)];
    for (const x of a) await b.enqueue(x);
    await b.flushAll();
    expect(port.posts.filter((p) => p.payload.buttons)).toHaveLength(3);
    expect(port.posts.filter((p) => p.payload.batchButtons)).toHaveLength(0);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toBe(`Approval batch #${(await repo.ofApproval(a[0]!.id))!.id} could not be posted as one card; approvals ${a.map((x) => `#${x.id}`).join(', ')} were posted as separate cards.`);
    expect((await repo.ofApproval(a[0]!.id))!.state).toBe('dissolved');
    b.stop();
  });

  it('B9(b): a restart with one open and one sealed batch posts each exactly once', async () => {
    const { approvals } = mk();
    const t1 = await newTask();
    const t2 = await newTask();
    const before = batching({ windowMs: 60_000 });
    for (const a of [await tool(approvals, t1.id), await tool(approvals, t1.id)]) await before.b.enqueue(a); // open
    const s = [await tool(approvals, t2.id), await tool(approvals, t2.id)];
    let sid = 0;
    for (const a of s) { const r = await repo.join(a, { windowMs: 60_000, fits: fitsAll }); if (r.kind === 'joined') sid = r.batchId; }
    await repo.seal(sid); // sealed, the process "crashed" before the post
    before.b.stop(); // the old process is gone (its timers with it)
    const after = batching({ windowMs: 60_000 });
    await after.b.flushAll();
    expect(cards(after.port).filter((p) => p.payload.batchButtons)).toHaveLength(2);
    await after.b.flushAll();
    expect(cards(after.port)).toHaveLength(2);
    expect(cards(before.port)).toHaveLength(0);
    after.b.stop();
  });

  it('B9(c): a sealed batch whose items all expired is closed without a post', async () => {
    const { approvals } = mk();
    const t = await newTask();
    const { b, port } = batching({ windowMs: 60_000 });
    const a = [await tool(approvals, t.id), await tool(approvals, t.id)];
    for (const x of a) await b.enqueue(x);
    await db.pool.query("UPDATE approvals SET created_at = now() - interval '100 hours'");
    await b.flushAll();
    expect(port.posts).toHaveLength(0);
    expect((await repo.ofApproval(a[0]!.id))!.state).toBe('closed');
    b.stop();
  });

  it('stop() clears the window timers: nothing posts afterwards', async () => {
    const { approvals } = mk();
    const t = await newTask();
    const { b, port } = batching({ windowMs: 150 });
    await b.enqueue(await tool(approvals, t.id));
    b.stop();
    await new Promise((r) => setTimeout(r, 350));
    expect(port.posts).toHaveLength(0);
    expect(await repo.listOpen()).toHaveLength(1);
  });
});

describe('G2AB-02: nothing is left without a card, silently', () => {
  it('markPosted that keeps failing: retried, then ONE alert with the batch, task and approval ids only; the card stays and is not duplicated', async () => {
    const { approvals } = mk();
    const t = await newTask();
    let tries = 0;
    const flaky = Object.create(repo) as ApprovalBatchRepo;
    flaky.markPosted = async () => { tries++; throw new Error('db blip'); };
    const { b, port, alerts } = batching({ repo: flaky, windowMs: 10_000 });
    const a = [await tool(approvals, t.id), await tool(approvals, t.id)];
    for (const x of a) await b.enqueue(x);
    await b.flushAll();
    expect(tries).toBe(3);
    expect(cards(port)).toHaveLength(1);
    expect(alerts).toHaveLength(1);
    const id = (await repo.ofApproval(a[0]!.id))!.id;
    expect(alerts[0]).toContain(`Approval batch #${id} (task ${t.id})`);
    expect(alerts[0]).toContain(`#${a[0]!.id}, #${a[1]!.id}`);
    expect(alerts[0]).not.toContain('example.com');
    await db.pool.query("UPDATE approval_batches SET sealed_at = now() - interval '2 minutes'");
    await b.sweep();
    expect(cards(port)).toHaveLength(1); // the sweep does not post the unrecorded card again
  });

  it('markPosted that fails once is retried and recorded without an alert', async () => {
    const { approvals } = mk();
    const t = await newTask();
    let tries = 0;
    const flaky = Object.create(repo) as ApprovalBatchRepo;
    flaky.markPosted = async (...args) => { if (++tries === 1) throw new Error('blip'); return repo.markPosted(...args); };
    const { b, alerts } = batching({ repo: flaky, windowMs: 10_000 });
    const a = [await tool(approvals, t.id), await tool(approvals, t.id)];
    for (const x of a) await b.enqueue(x);
    await b.flushAll();
    expect(alerts).toEqual([]);
    expect((await repo.ofApproval(a[0]!.id))!.state).toBe('posted');
  });

  it('a seal that threw in the timer is retried by the sweep once the window is over by the DB clock', async () => {
    const { approvals } = mk();
    const t = await newTask();
    let fail = true;
    const flaky = Object.create(repo) as ApprovalBatchRepo;
    flaky.seal = async (id) => { if (fail) { fail = false; throw new Error('seal failed'); } return repo.seal(id); };
    const { b, port } = batching({ repo: flaky, windowMs: 40 });
    const a = [await tool(approvals, t.id), await tool(approvals, t.id)];
    for (const x of a) await b.enqueue(x);
    await new Promise((r) => setTimeout(r, 400));
    await b.idle();
    expect(cards(port)).toHaveLength(0);
    expect((await repo.ofApproval(a[0]!.id))!.state).toBe('open');
    await b.sweep();
    expect(cards(port)).toHaveLength(1);
    await b.sweep();
    expect(cards(port)).toHaveLength(1);
  });

  it('the sweep publishes a sealed batch with no card once it is old enough, and not before', async () => {
    const { approvals } = mk();
    const t = await newTask();
    const { b, port } = batching({ windowMs: 10_000, stuckAfterMs: 60_000 });
    const a = [await tool(approvals, t.id), await tool(approvals, t.id)];
    let sid = 0;
    for (const x of a) { const r = await repo.join(x, { windowMs: 60_000, fits: fitsAll }); if (r.kind === 'joined') sid = r.batchId; }
    await repo.seal(sid);
    await b.sweep();
    expect(cards(port)).toHaveLength(0); // sealed a moment ago: its own publisher may still be running
    await db.pool.query("UPDATE approval_batches SET sealed_at = now() - interval '2 minutes' WHERE id = $1", [sid]);
    await b.sweep();
    expect(cards(port)).toHaveLength(1);
  });

  it('a sweep running while the same process is publishing does not post twice', async () => {
    const { approvals } = mk();
    const t = await newTask();
    const { b, port } = batching({ windowMs: 10_000 });
    for (const x of [await tool(approvals, t.id), await tool(approvals, t.id)]) await b.enqueue(x);
    await db.pool.query("UPDATE approval_batches SET opened_at = now() - interval '1 minute'");
    await Promise.all([b.flushAll(), b.sweep(), b.sweep()]);
    expect(cards(port)).toHaveLength(1);
  });
});

describe('B11: audit and logs never carry tool input, reason or card text', () => {
  it('Approve all with a planted marker in the input and the reason: audit rows and log lines hold none of it, and carry taskId, tool and ids', async () => {
    const { approvals, audits } = mk();
    const t = await newTask();
    const MARK = 'PLANTED-MARKER-9f3a';
    const members: Approval[] = [];
    let batchId = 0;
    for (let i = 0; i < 2; i++) {
      const a = await tool(approvals, t.id, { input: { url: `https://example.com/${MARK}-${i}` }, reason: `reason ${MARK}` });
      const r = await repo.join(a, { windowMs: 60_000, fits: fitsAll });
      if (r.kind === 'joined') batchId = r.batchId;
      members.push(a);
    }
    await repo.seal(batchId);
    const digest = (await repo.get(batchId))!.digest!;
    await repo.markPosted(batchId, '1570000000000000001', '1570000000000000002');
    const logs: unknown[] = [];
    const updates: OutboundPayload[] = [];
    const t2 = await makeDeps({ approvals, batches: repo, secrets: [], log: { error: (o: unknown, m?: string) => void logs.push([o, m]) }, audit: async (e) => void audits.push(e), cards: { close: async () => undefined, update: async (_c, _m, p) => (updates.push(p), true) } });
    const click = (action: string) => interaction({ kind: 'button', customId: `approval:b:${batchId}:${digest}:${action}`, userId: 'boss', messageId: '1570000000000000002', messageAuthorId: 'hq' });
    await handleInteraction(click('ask'), t2.deps);
    const r = await handleInteraction(click('approve'), t2.deps);
    expect(JSON.stringify(r)).toContain('Approved 2 of 2');
    expect(JSON.stringify(audits)).not.toContain(MARK);
    expect(JSON.stringify(logs)).not.toContain(MARK);
    const rows = audits.filter((a) => a.action.startsWith('approval.'));
    expect(rows.map((a) => a.action)).toEqual(['approval.batch_ask', 'approval.approve', 'approval.approve', 'approval.batch_approve']);
    expect(rows[1]).toMatchObject({ taskId: t.id, tool: 'fetch_page', outcome: `ok #${members[0]!.id}` });
    expect(rows[3]).toMatchObject({ taskId: t.id, outcome: `batch:${batchId} digest:${digest} n=2 decided=2` });
    expect(rows[0]).toMatchObject({ taskId: t.id, outcome: `batch:${batchId} digest:${digest} n=2 decided=0` });
    // the refreshed card holds the marker (it is the approver's view) but no buttons: nothing is pending
    expect(updates).toHaveLength(1);
    expect(updates[0]!.batchButtons!.items.every((i) => !i.pending)).toBe(true);
    expect((await repo.get(batchId))!.state).toBe('closed');
  });
});

describe('B13: rollback', () => {
  it('the down migration refuses while a batched approval is pending and succeeds once it expired', async () => {
    const own = await freshDb();
    try {
      await migrate(own.pool, migrations, 'up');
      await new DepartmentRepo(own.pool).upsert({ id: 'hq', name: 'HQ', categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
      const tk = new TaskRepo(own.pool);
      const t = await tk.create({ title: 't', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
      const cfg = new FakeConfig();
      const ap = new Approvals(own.pool, tk, cfg, new EventBus<AppEvents>(), new FakeHalt(), async () => undefined, [], isNonSensitiveTool);
      const r = new ApprovalBatchRepo(own.pool);
      const a = await tool(ap, t.id);
      const j = await r.join(a, { windowMs: 60_000, fits: fitsAll });
      if (j.kind !== 'joined') throw new Error('join');
      await expect(migrate(own.pool, migrations, 'down')).rejects.toThrow(/pending approvals/);
      expect((await own.pool.query("SELECT 1 FROM schema_migrations WHERE name = '026_approval_batch'")).rowCount).toBe(1);
      await own.pool.query("UPDATE approvals SET status = 'expired', decided_at = now()");
      const done = await migrate(own.pool, migrations, 'down');
      expect(done[0]).toBe('026_approval_batch');
      expect(done.at(-1)).toBe('001_init');
      // and up again works
      expect((await migrate(own.pool, migrations, 'up'))).toContain('026_approval_batch');
    } finally {
      await own.close();
    }
  });
});

// ---- WEBGRANT-1: "Approve all + allow web reading" (D5/D6, B6 re-checks, W-C3b) ----
describe('decideBatch with a web grant', () => {
  const ADMIN_ID = '123456789012345678';
  const adminUser = { id: ADMIN_ID, isAdmin: true };
  const mkG = () => {
    const cfg = new FakeConfig();
    const halt = new FakeHalt();
    const approvals = new Approvals(db.pool, tasks, cfg, new EventBus<AppEvents>(), halt, async () => undefined, [], isNonSensitiveTool,
      { solo: (a) => soloShowsWhole(a, []), batch: (a) => compactItemFits(a, []) });
    return { cfg, halt, approvals };
  };
  const grants = async () => (await db.pool.query('SELECT * FROM web_grants ORDER BY id')).rows;
  const statuses = async (ids: number[]) => (await db.pool.query<{ status: string }>('SELECT status FROM approvals WHERE id = ANY($1) ORDER BY id', [ids])).rows.map((r) => r.status);

  it('all members are fetch_page: every row is decided approved and one grant is made on the lowest decided id', async () => {
    const { approvals } = mkG();
    const x = await batchOf(approvals, 3);
    const r = await approvals.decideBatch(x.batchId, x.digest, 'approved', adminUser, { grant: true });
    expect(r.ok && r.decided.map((a) => a.id)).toEqual(x.members.map((m) => m.id));
    const rows = await grants();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ approval_id: x.members[0]!.id, granted_by: ADMIN_ID, max_fetches: 20, max_hosts: 5, max_url_chars: 4000 });
    expect(r.ok && r.grant?.id).toBe(Number(rows[0].id));
    expect(await statuses(x.members.map((m) => m.id))).toEqual(['approved', 'approved', 'approved']);
  });

  it('a mixed batch (a member that is not fetch_page) is not_grantable and nothing is decided', async () => {
    const { approvals } = mkG();
    const t = await newTask();
    const members: Approval[] = [];
    let batchId = 0;
    for (const input of [{ name: 'fetch_page', input: { url: 'https://example.com/a' } }, { name: 'web_search', input: { query: 'weather' } }]) {
      const a = await tool(approvals, t.id, input);
      const r = await repo.join(a, { windowMs: 60_000, fits: fitsAll });
      if (r.kind !== 'joined') throw new Error('join');
      batchId = r.batchId;
      members.push(a);
    }
    await repo.seal(batchId);
    const b = (await repo.get(batchId))!;
    await repo.markPosted(batchId, '1570000000000000001', '1570000000000000002');
    expect(await approvals.decideBatch(batchId, b.digest!, 'approved', adminUser, { grant: true })).toEqual({ ok: false, error: 'not_grantable' });
    expect(await statuses(members.map((m) => m.id))).toEqual(['pending', 'pending']);
    expect(await grants()).toEqual([]);
    // plain Approve all still works on the same card
    expect((await approvals.decideBatch(batchId, b.digest!, 'approved', adminUser)).ok).toBe(true);
  });

  it('a member whose url fails the heuristics refuses the whole grant click', async () => {
    const { approvals } = mkG();
    const t = await newTask();
    const a = await tool(approvals, t.id, { input: { url: 'https://example.com/a' } });
    const bad = await tool(approvals, t.id, { input: { url: 'https://example.com/u/1234567890' } });
    let batchId = 0;
    for (const m of [a, bad]) { const r = await repo.join(m, { windowMs: 60_000, fits: fitsAll }); if (r.kind !== 'joined') throw new Error('join'); batchId = r.batchId; }
    await repo.seal(batchId);
    const b = (await repo.get(batchId))!;
    await repo.markPosted(batchId, '1570000000000000001', '1570000000000000002');
    expect(await approvals.decideBatch(batchId, b.digest!, 'approved', adminUser, { grant: true })).toEqual({ ok: false, error: 'not_grantable' });
    expect(await statuses([a.id, bad.id])).toEqual(['pending', 'pending']);
  });

  it('halted, a non-admin, a reject with grant, and an ended tree decide nothing and create no grant', async () => {
    const { approvals, halt } = mkG();
    const x = await batchOf(approvals, 2);
    halt.halted = true;
    expect(await approvals.decideBatch(x.batchId, x.digest, 'approved', adminUser, { grant: true })).toEqual({ ok: false, error: 'halted' });
    halt.halted = false;
    expect(await approvals.decideBatch(x.batchId, x.digest, 'approved', { id: ADMIN_ID, isAdmin: false }, { grant: true })).toEqual({ ok: false, error: 'not_admin' });
    expect(await approvals.decideBatch(x.batchId, x.digest, 'rejected', adminUser, { grant: true })).toEqual({ ok: false, error: 'not_found' });
    await db.pool.query("UPDATE tasks SET status = 'cancelled' WHERE id = $1", [x.taskId]);
    expect(await approvals.decideBatch(x.batchId, x.digest, 'approved', adminUser, { grant: true })).toEqual({ ok: false, error: 'root_ended' });
    expect(await statuses(x.members.map((m) => m.id))).toEqual(['pending', 'pending']);
    expect(await grants()).toEqual([]);
  });

  it('members already decided: nothing newly decided means no grant', async () => {
    const { approvals } = mkG();
    const x = await batchOf(approvals, 2);
    await approvals.decideBatch(x.batchId, x.digest, 'approved', adminUser);
    const again = await approvals.decideBatch(x.batchId, x.digest, 'approved', adminUser, { grant: true });
    expect(again.ok && again.decided).toEqual([]);
    expect(again.ok && again.grant).toBeUndefined();
    expect(await grants()).toEqual([]);
  });

  it('G2W-03: the batch grant records the clicked message as its card only when it is the batch card', async () => {
    const { approvals } = mkG();
    const x = await batchOf(approvals, 2); // markPosted used message 1570000000000000002
    const r = await approvals.decideBatch(x.batchId, x.digest, 'approved', adminUser, { grant: true, messageId: '1570000000000000002' });
    expect(r.ok && r.grant).toBeTruthy();
    expect((await grants())[0].card_message_id).toBe('1570000000000000002');
    const y = await batchOf(approvals, 2);
    await approvals.decideBatch(y.batchId, y.digest, 'approved', adminUser, { grant: true, messageId: '1570000000000000999' });
    expect((await grants())[1].card_message_id).toBeNull();
  });

  it('G2W-02: a halt after the last in-transaction check revokes the committed batch grant', async () => {
    const { approvals, halt } = mkG();
    const x = await batchOf(approvals, 2);
    halt.calls = 0;
    halt.haltFromCall = 4; // entry, const halted, last in-tx check, then after COMMIT
    expect(await approvals.decideBatch(x.batchId, x.digest, 'approved', adminUser, { grant: true })).toMatchObject({ ok: false, error: 'halted_after_commit', decided: [{ status: 'approved' }, { status: 'approved' }] });
    expect((await grants())[0]).toMatchObject({ revoke_reason: 'halt' });
  });
});

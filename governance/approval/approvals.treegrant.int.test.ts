import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import { EventBus, type AppEvents } from '../../core/events.js';
import { ApprovalBatchRepo, DepartmentRepo, TaskRepo } from '../../db/index.js';
import { migrate } from '../../db/migrate.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { TaskGrantRepo } from '../../db/repos/task-grants.js';
import type { Approval } from '../../db/repos/ledger.js';
import { isConversationTask } from '../../agents/conversation.js';
import { isNonSensitiveTool } from '../../discord/approval/approval-rooms.js';
import { compactItemFits, soloShowsWhole } from '../../discord/embeds/approval.js';
import { DOC_KINDS, isDraftKind } from '../../tools/plugins/docs/kinds.js';
import type { ToolKind } from '../../tools/policy-approval.js';
import { Approvals } from './approvals.js';
import { FakeConfig } from '../test-helpers.js';

const migrations = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');
let db: TestDb;
let tasks: TaskRepo;
let batches: ApprovalBatchRepo;
const hq: ActorRef = { kind: 'head', dept: 'hq' };
const ADMIN = '123456789012345678';
const admin = { id: ADMIN, isAdmin: true };
const MSG = '223456789012345678';
const CH = '323456789012345678';

class FakeHalt {
  halted = false;
  haltFromCall = Infinity;
  calls = 0;
  isHalted() { this.calls++; return this.halted || this.calls >= this.haltFromCall; }
}
const KINDS: Record<string, ToolKind> = {
  write_file: 'write', pin_message: 'write', forum_post: 'write', forward_to: 'write', doc_create: 'write', music_play: 'write', save_lesson: 'write',
  fetch_page: 'read', clickup_delete_task: 'destructive',
};

const mk = (cfgInit: ConstructorParameters<typeof FakeConfig>[0] = {}, withScope = true) => {
  const cfg = new FakeConfig({ 'limits.localUnlimited': false, 'budget.botDailyUsd': 1000, 'budget.companyDailyUsd': 1000, ...cfgInit });
  const halt = new FakeHalt();
  const approvals = new Approvals(db.pool, tasks, cfg, new EventBus<AppEvents>(), halt, async () => undefined, [], isNonSensitiveTool,
    { solo: (a) => soloShowsWhole(a, []), batch: (a) => compactItemFits(a, []) },
    withScope ? { kindOf: (n) => KINDS[n], isConversation: (t) => isConversationTask(t) } : undefined);
  return { cfg, halt, approvals };
};
const newTask = (parentId?: string, extra: { conversation?: boolean } = {}) =>
  tasks.create({ title: 't', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'chat', parentId, ...extra });
let seq = 0;
const req = (approvals: Approvals, taskId: string, name = 'forum_post', input: unknown = { title: `t${++seq}`, body: 'b' }) =>
  approvals.request({ taskId, reason: `tool ${name}`, estCostUsd: 0, requestedBy: hq, kind: 'tool', tool: { name, input } });
const grants = async () => (await db.pool.query('SELECT * FROM task_grants ORDER BY id')).rows;
const webGrants = async () => (await db.pool.query('SELECT * FROM web_grants ORDER BY id')).rows;
const status = async (id: number) => (await db.pool.query<{ status: string }>('SELECT status FROM approvals WHERE id = $1', [id])).rows[0]!.status;
const statuses = async (ids: number[]) => (await db.pool.query<{ status: string }>('SELECT status FROM approvals WHERE id = ANY($1) ORDER BY id', [ids])).rows.map((r) => r.status);

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, migrations, 'up');
  await new DepartmentRepo(db.pool).upsert({ id: 'hq', name: 'HQ', categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
  tasks = new TaskRepo(db.pool);
  batches = new ApprovalBatchRepo(db.pool);
});
beforeEach(async () => {
  await db.pool.query('DELETE FROM task_grants');
  await db.pool.query('DELETE FROM web_grants');
  await db.pool.query('DELETE FROM approvals');
  await db.pool.query('DELETE FROM approval_batches');
  await db.pool.query('DELETE FROM budget_days');
  await db.pool.query('DELETE FROM tasks');
});
afterAll(async () => { await db.close(); });

describe('decideTaskGrant (spec 3.3)', () => {
  it('approves the call and creates the grant in one step: caps snapshotted, keyed by the root, card ids stored, the approval still replays', async () => {
    const { approvals } = mk({ 'taskGrant.maxCalls': 25, 'taskGrant.hours': 6 });
    const root = await newTask();
    const child = await newTask(root.id);
    const a = await req(approvals, child.id);
    const r = await approvals.decideTaskGrant(a.id, admin, { messageId: MSG, channelId: CH });
    expect(r.ok).toBe(true);
    const rows = await grants();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ root_id: root.id, approval_id: a.id, granted_by: ADMIN, requested_by: 'head:hq', max_calls: 25, used: 0, card_message_id: MSG, card_channel_id: CH });
    expect((new Date(rows[0].expires_at).getTime() - new Date(rows[0].created_at).getTime()) / 3_600_000).toBeCloseTo(6, 3);
    expect(r.ok && r.grant).toMatchObject({ id: Number(rows[0].id), rootId: root.id, maxCalls: 25, conversation: false });
    expect(await status(a.id)).toBe('approved');
    expect((await tasks.get(child.id))!.status).toBe('todo');
    expect((await approvals.claimToolOutcomes(child.id)).map((c) => c.kind)).toEqual(['run']); // the card's own call replays; the claim never consumes
    expect((await grants())[0].used).toBe(0);
    expect((await new TaskGrantRepo(db.pool).consume({ rootId: root.id, tool: 'forum_post' })).ok).toBe(true);
  });

  it('the companion web grant is made with the web caps and NO card id (TG-C10), linked by web_grant_id; off when web.taskGrant.enabled is false', async () => {
    const on = mk({ 'web.taskGrant.maxFetches': 12, 'web.taskGrant.maxHosts': 3, 'web.taskGrant.maxUrlChars': 900, 'web.taskGrant.hours': 2 });
    const root = await newTask();
    const r = await on.approvals.decideTaskGrant((await req(on.approvals, root.id)).id, admin, { messageId: MSG, channelId: CH });
    expect(r.ok && r.grant.web).toMatchObject({ rootId: root.id, maxFetches: 12, maxHosts: 3, maxUrlChars: 900 });
    const w = await webGrants();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ root_id: root.id, card_message_id: null, max_fetches: 12 });
    expect((await grants())[0].web_grant_id).toBe(w[0].id);
    await db.pool.query('DELETE FROM task_grants'); await db.pool.query('DELETE FROM web_grants');
    const off = mk({ 'web.taskGrant.enabled': false });
    const root2 = await newTask();
    const r2 = await off.approvals.decideTaskGrant((await req(off.approvals, root2.id)).id, admin);
    expect(r2.ok && r2.grant.web).toBeNull();
    expect(await webGrants()).toEqual([]);
    expect((await grants())[0].web_grant_id).toBeNull();
  });

  it('TG-C16: a conversation root gets min(hours, conversationHours), computed on the locked root row; a plain root gets hours', async () => {
    const { approvals } = mk({ 'taskGrant.hours': 12, 'taskGrant.conversationHours': 4 });
    const conv = await newTask(undefined, { conversation: true });
    const rc = await approvals.decideTaskGrant((await req(approvals, conv.id)).id, admin);
    expect(rc.ok && rc.grant.conversation).toBe(true);
    const plain = await newTask();
    await approvals.decideTaskGrant((await req(approvals, plain.id)).id, admin);
    const h = (await db.pool.query<{ root_id: string; hrs: number }>('SELECT root_id, extract(epoch FROM expires_at - created_at) / 3600 AS hrs FROM task_grants')).rows;
    expect(Number(h.find((x) => x.root_id === conv.id)!.hrs)).toBeCloseTo(4, 3);
    expect(Number(h.find((x) => x.root_id === plain.id)!.hrs)).toBeCloseTo(12, 3);
    const { approvals: a2 } = mk({ 'taskGrant.hours': 2, 'taskGrant.conversationHours': 4 }); // misconfigured live: the shorter still wins
    const conv2 = await newTask(undefined, { conversation: true });
    await a2.decideTaskGrant((await req(a2, conv2.id)).id, admin);
    expect(Number((await db.pool.query<{ hrs: number }>('SELECT extract(epoch FROM expires_at - created_at) / 3600 AS hrs FROM task_grants WHERE root_id = $1', [conv2.id])).rows[0]!.hrs)).toBeCloseTo(2, 3);
  });

  it('TG-C3: a tampered sha, a tampered input, an uncovered tool, a DRAFT doc kind, an overwrite and a fetch_page row are not_grantable and leave the card pending', async () => {
    const { approvals } = mk();
    const t = await newTask();
    const sha = await req(approvals, t.id);
    await db.pool.query('UPDATE approvals SET input_sha256 = $2 WHERE id = $1', [sha.id, 'f'.repeat(64)]);
    const inp = await req(approvals, t.id);
    await db.pool.query('UPDATE approvals SET tool_input = \'{"title":"changed"}\'::jsonb WHERE id = $1', [inp.id]);
    const draft = DOC_KINDS.find((k) => isDraftKind(k))!;
    const rows = [
      sha, inp,
      await req(approvals, t.id, 'save_lesson', { text: 'x' }),
      await req(approvals, t.id, 'clickup_delete_task', { id: '1' }),
      await req(approvals, t.id, 'doc_create', { kind: draft, fields: {} }),
      await req(approvals, t.id, 'write_file', { path: 'a.txt', content: 'x', overwrite: true }),
      await req(approvals, t.id, 'fetch_page', { url: 'https://example.com/a' }),
    ];
    for (const a of rows) {
      expect(await approvals.decideTaskGrant(a.id, admin), `${a.toolName}`).toEqual({ ok: false, error: 'not_grantable' });
      expect(await status(a.id)).toBe('pending');
    }
    expect(await grants()).toEqual([]);
    const ok = DOC_KINDS.find((k) => !isDraftKind(k))!;
    expect((await approvals.decideTaskGrant((await req(approvals, t.id, 'doc_create', { kind: ok, fields: {} })).id, admin)).ok).toBe(true);
  });

  it('the feature switched off, no scope injected (fail closed), non-admin, unknown, already decided, expired', async () => {
    const off = mk({ 'taskGrant.enabled': false });
    const t = await newTask();
    expect(await off.approvals.decideTaskGrant((await req(off.approvals, t.id)).id, admin)).toEqual({ ok: false, error: 'not_grantable' });
    const none = mk({}, false);
    expect(await none.approvals.decideTaskGrant((await req(none.approvals, t.id)).id, admin)).toEqual({ ok: false, error: 'not_grantable' });
    const { approvals } = mk();
    const a = await req(approvals, t.id);
    expect(await approvals.decideTaskGrant(a.id, { id: ADMIN, isAdmin: false })).toEqual({ ok: false, error: 'not_admin' });
    expect(await approvals.decideTaskGrant(999999, admin)).toEqual({ ok: false, error: 'not_pending' });
    await db.pool.query("UPDATE approvals SET created_at = now() - interval '25 hours' WHERE id = $1", [a.id]);
    expect(await approvals.decideTaskGrant(a.id, admin)).toEqual({ ok: false, error: 'expired' });
    const b = await req(approvals, (await newTask()).id);
    expect((await approvals.decide(b.id, 'approved', admin)).ok).toBe(true);
    expect(await approvals.decideTaskGrant(b.id, admin)).toEqual({ ok: false, error: 'not_pending' });
    expect(await grants()).toEqual([]);
  });

  it('an ended root: root_ended, approval untouched', async () => {
    const { approvals } = mk();
    const root = await newTask();
    const a = await req(approvals, root.id);
    await db.pool.query("UPDATE tasks SET status = 'cancelled' WHERE id = $1", [root.id]);
    expect(await approvals.decideTaskGrant(a.id, admin)).toEqual({ ok: false, error: 'root_ended' });
    expect(await status(a.id)).toBe('pending');
  });

  it('halted: refused with nothing decided (plain Approve stays available)', async () => {
    const { approvals, halt } = mk();
    const t = await newTask();
    const a = await req(approvals, t.id);
    halt.halted = true;
    expect(await approvals.decideTaskGrant(a.id, admin)).toEqual({ ok: false, error: 'halted' });
    halt.halted = false;
    expect(await status(a.id)).toBe('pending');
    expect(await grants()).toEqual([]);
    expect((await approvals.decide(a.id, 'approved', admin)).ok).toBe(true);
  });

  it('a halt inside the transaction (last check) is refused and writes nothing', async () => {
    const { approvals, halt } = mk();
    const t = await newTask();
    const a = await req(approvals, t.id);
    halt.calls = 0;
    halt.haltFromCall = 2; // call 1: the early check; call 2: the last check inside the transaction
    expect(await approvals.decideTaskGrant(a.id, admin)).toEqual({ ok: false, error: 'halted' });
    expect(await status(a.id)).toBe('pending');
    expect(await grants()).toEqual([]);
  });

  it('a halt that lands after the transaction (before the response): halted_after_commit, the approval stands, the task grant AND its companion are revoked', async () => {
    const { approvals, halt } = mk();
    const t = await newTask();
    const a = await req(approvals, t.id);
    halt.calls = 0;
    halt.haltFromCall = 3; // early check, last check, then after COMMIT
    const r = await approvals.decideTaskGrant(a.id, admin, { messageId: MSG, channelId: CH });
    expect(r).toMatchObject({ ok: false, error: 'halted_after_commit' });
    expect(await status(a.id)).toBe('approved');
    expect((await grants())[0]).toMatchObject({ revoke_reason: 'halt' });
    expect((await webGrants())[0]).toMatchObject({ revoke_reason: 'halt' });
  });

  it('TG-C12: a stale click while a grant is live is refused and decides nothing; two concurrent clicks on two cards of one tree make exactly one grant', async () => {
    const { approvals } = mk();
    const root = await newTask();
    const c1 = await newTask(root.id); const c2 = await newTask(root.id); const c3 = await newTask(root.id);
    const first = await req(approvals, c1.id);
    const stale = await req(approvals, c3.id);
    expect((await approvals.decideTaskGrant(first.id, admin)).ok).toBe(true);
    expect(await approvals.decideTaskGrant(stale.id, admin)).toEqual({ ok: false, error: 'not_grantable' });
    expect(await status(stale.id)).toBe('pending');
    expect(await grants()).toHaveLength(1);
    // concurrency on a fresh tree
    await db.pool.query('DELETE FROM task_grants'); await db.pool.query('DELETE FROM web_grants');
    const root2 = await newTask();
    const [x, y] = [await newTask(root2.id), await newTask(root2.id)];
    const [a, b] = [await req(approvals, x.id), await req(approvals, y.id)];
    const rs = await Promise.all([approvals.decideTaskGrant(a.id, admin), approvals.decideTaskGrant(b.id, admin)]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.find((r) => !r.ok)).toEqual({ ok: false, error: 'not_grantable' });
    expect((await grants()).filter((g) => g.root_id === root2.id)).toHaveLength(1);
    expect((await statuses([a.id, b.id])).sort()).toEqual(['approved', 'pending']); // the refused click decided nothing
  });

  it('an exhausted grant is not live: a new click supersedes it and its companion, and the unique index still holds', async () => {
    const { approvals } = mk({ 'taskGrant.maxCalls': 1 });
    const root = await newTask();
    const t1 = await newTask(root.id); const t2 = await newTask(root.id);
    await approvals.decideTaskGrant((await req(approvals, t1.id)).id, admin);
    expect((await new TaskGrantRepo(db.pool).consume({ rootId: root.id, tool: 'forum_post' })).ok).toBe(true); // exhausted, unrevoked
    expect((await approvals.decideTaskGrant((await req(approvals, t2.id)).id, admin)).ok).toBe(true);
    const rows = await grants();
    expect(rows.map((g) => g.revoke_reason)).toEqual(['superseded', null]);
    expect((await webGrants()).map((w) => w.revoke_reason)).toEqual(['superseded', null]);
  });
});

describe('decideBatch {task:true} (TG-C13)', () => {
  const batchOf = async (approvals: Approvals, specs: { name?: string; input?: unknown }[], taskId?: string) => {
    const t = taskId ?? (await newTask()).id;
    const members: Approval[] = [];
    let batchId = 0;
    for (const s of specs) {
      const a = await req(approvals, t, s.name ?? 'forum_post', s.input);
      const r = await batches.join(a, { windowMs: 60_000, fits: () => true });
      if (r.kind !== 'joined') throw new Error('join');
      batchId = r.batchId;
      members.push(a);
    }
    await batches.seal(batchId);
    const b = (await batches.get(batchId))!;
    await batches.markPosted(batchId, CH, MSG);
    return { batchId, digest: b.digest!, members, taskId: t };
  };

  it('all members covered: every row is decided, ONE task grant on the lowest decided id, the batch message as the card', async () => {
    const { approvals } = mk();
    const x = await batchOf(approvals, [{}, {}, { name: 'pin_message', input: { channelId: CH, messageId: MSG } }]);
    const r = await approvals.decideBatch(x.batchId, x.digest, 'approved', admin, { task: true, messageId: MSG, channelId: CH });
    expect(r.ok && r.decided.map((a) => a.id)).toEqual(x.members.map((m) => m.id));
    const rows = await grants();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ approval_id: x.members[0]!.id, granted_by: ADMIN, card_message_id: MSG, card_channel_id: CH, max_calls: 40 });
    expect(r.ok && r.taskGrant?.id).toBe(Number(rows[0].id));
    expect(await statuses(x.members.map((m) => m.id))).toEqual(['approved', 'approved', 'approved']);
  });

  it('the card id is recorded only for this batch\'s own message (G2W-03 rule)', async () => {
    const { approvals } = mk();
    const x = await batchOf(approvals, [{}, {}]);
    await approvals.decideBatch(x.batchId, x.digest, 'approved', admin, { task: true, messageId: '999999999999999999', channelId: CH });
    expect((await grants())[0]).toMatchObject({ card_message_id: null, card_channel_id: null });
  });

  it('one uncovered member (a DRAFT doc, an overwrite, a fetch_page) refuses the whole click: nothing decided, no grant', async () => {
    const { approvals } = mk();
    const draft = DOC_KINDS.find((k) => isDraftKind(k))!;
    for (const bad of [{ name: 'doc_create', input: { kind: draft, fields: {} } }, { name: 'write_file', input: { path: 'a', content: 'x', overwrite: true } }, { name: 'fetch_page', input: { url: 'https://example.com/z' } }]) {
      const x = await batchOf(approvals, [{}, bad]);
      expect(await approvals.decideBatch(x.batchId, x.digest, 'approved', admin, { task: true, messageId: MSG, channelId: CH })).toEqual({ ok: false, error: 'not_grantable' });
      expect(await statuses(x.members.map((m) => m.id))).toEqual(['pending', 'pending']);
    }
    expect(await grants()).toEqual([]);
  });

  it('{task:true} with {grant:true}, or with reject, is not_found; a stale digest is stale; halted writes nothing; a live grant refuses (TG-C12)', async () => {
    const { approvals, halt } = mk();
    const x = await batchOf(approvals, [{}, {}]);
    expect(await approvals.decideBatch(x.batchId, x.digest, 'approved', admin, { task: true, grant: true })).toEqual({ ok: false, error: 'not_found' });
    expect(await approvals.decideBatch(x.batchId, x.digest, 'rejected', admin, { task: true })).toEqual({ ok: false, error: 'not_found' });
    expect(await approvals.decideBatch(x.batchId, 'abcdef012345', 'approved', admin, { task: true })).toEqual({ ok: false, error: 'stale' });
    expect(await approvals.decideBatch(x.batchId, x.digest, 'approved', { id: ADMIN, isAdmin: false }, { task: true })).toEqual({ ok: false, error: 'not_admin' });
    halt.halted = true;
    expect(await approvals.decideBatch(x.batchId, x.digest, 'approved', admin, { task: true })).toEqual({ ok: false, error: 'halted' });
    halt.halted = false;
    expect(await statuses(x.members.map((m) => m.id))).toEqual(['pending', 'pending']);
    const first = await newTask();
    await approvals.decideTaskGrant((await req(approvals, first.id)).id, admin);
    const y = await batchOf(approvals, [{}, {}], first.id);
    expect(await approvals.decideBatch(y.batchId, y.digest, 'approved', admin, { task: true })).toEqual({ ok: false, error: 'not_grantable' });
    expect(await statuses(y.members.map((m) => m.id))).toEqual(['pending', 'pending']);
  });

  it('an ended root: root_ended; halted after commit: the approvals stand and both grants are revoked', async () => {
    const { approvals, halt } = mk();
    const x = await batchOf(approvals, [{}, {}]);
    await db.pool.query("UPDATE tasks SET status = 'cancelled' WHERE id = (SELECT root_id FROM tasks WHERE id = $1)", [x.taskId]);
    expect(await approvals.decideBatch(x.batchId, x.digest, 'approved', admin, { task: true })).toEqual({ ok: false, error: 'root_ended' });
    const y = await batchOf(approvals, [{}, {}]);
    halt.calls = 0;
    halt.haltFromCall = 4;
    const r = await approvals.decideBatch(y.batchId, y.digest, 'approved', admin, { task: true, messageId: MSG, channelId: CH });
    expect(r).toMatchObject({ ok: false, error: 'halted_after_commit' });
    expect(await statuses(y.members.map((m) => m.id))).toEqual(['approved', 'approved']);
    expect((await grants()).every((g) => g.revoke_reason === 'halt')).toBe(true);
    expect((await webGrants()).every((g) => g.revoke_reason === 'halt')).toBe(true);
  });

  it('a plain Approve all (no task flag) still makes no grant', async () => {
    const { approvals } = mk();
    const x = await batchOf(approvals, [{}, {}]);
    const r = await approvals.decideBatch(x.batchId, x.digest, 'approved', admin);
    expect(r.ok && r.taskGrant).toBeUndefined();
    expect(await grants()).toEqual([]);
  });
});

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OutboundPayload } from '../agents/loop/payload.js';
import { localDay } from '../company/calendar.js';
import type { ActorRef } from '../company/types.js';
import { EventBus, type AppEvents } from '../core/events.js';
import { migrate } from '../db/migrate.js';
import { DepartmentRepo, ProjectRepo, TaskRepo } from '../db/repos/index.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { CONFIG_CHANNEL_ID } from '../discord/commands/types.js';
import { AUTOPILOT_CARD_TEXT, DECIDE_TEXT, ProjectService, PROPOSE_TEXT } from './projects.js';
import { FakeConfig } from './test-helpers.js';

let db: TestDb;
let tasks: TaskRepo;
let cfg: FakeConfig;
let halted = false;
let repo: ProjectRepo;
let svc: ProjectService;
let posts: OutboundPayload[];
let closes: { channelId: string; messageId: string; note: string }[];
let notices: { dept: string; text: string }[];
let events: { name: string; p: unknown }[];
let logLines: unknown[];
let failPost = false;
let msgSeq = 0;
let now = Date.now();

const hq: ActorRef = { kind: 'head', dept: 'hq' };
const ADMIN = '123456789012345678';
const ADMIN2 = '223456789012345679';
const SECRET = 'sk-live-SECRETVALUE-9f8e7d6c';
const plusDays = (n: number): string => localDay(now + n * 86_400_000, 'Asia/Bangkok').date;
const run = { tainted: false, task: null };

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'), 'up');
  await new DepartmentRepo(db.pool).upsert({ id: 'hq', name: 'HQ', categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
  tasks = new TaskRepo(db.pool);
});
beforeEach(async () => {
  halted = false;
  failPost = false;
  now = Date.now();
  cfg = new FakeConfig();
  repo = new ProjectRepo(db.pool, { cfg, halt: { isHalted: () => halted }, now: () => now });
  posts = []; closes = []; notices = []; events = []; logLines = [];
  const bus = new EventBus<AppEvents>({ error: (o) => logLines.push(o) });
  for (const n of ['task.created', 'task.changed', 'task.ready'] as const) bus.on(n, (p) => void events.push({ name: n, p }));
  svc = new ProjectService({
    repo, cfg, tasks, bus, halted: () => halted, secrets: [SECRET], configChannelId: CONFIG_CHANNEL_ID, now: () => now,
    postCard: async (p) => { if (failPost) throw new TypeError('post failed with planted text'); posts.push(p); return `8000000000000${String(10000 + ++msgSeq)}`; },
    closeCard: async (channelId, messageId, note) => void closes.push({ channelId, messageId, note }),
    notifyHead: async (dept, text) => void notices.push({ dept, text }),
    log: { error: (o) => void logLines.push(o) },
  });
  for (const t of ['project_tools', 'projects', 'task_grants', 'web_grants', 'ot_requests', 'approvals', 'audit_log', 'budget_days']) await db.pool.query(`DELETE FROM ${t}`);
  await db.pool.query('UPDATE tasks SET parent_id = NULL');
  await db.pool.query('DELETE FROM tasks');
});
afterAll(async () => { await db.close(); });

let n = 0;
const input = (o: Record<string, unknown> = {}) => ({ title: `Proj ${++n}`, goal: 'Ship the thing', deadline: plusDays(30), budget: { maxLocalCalls: 100, maxUsd: 5 }, ...o });
const propose = async (o: Record<string, unknown> = {}, actor: ActorRef = hq) => svc.propose(actor, run, input(o));
const proposed = async (o: Record<string, unknown> = {}) => {
  const r = await propose(o);
  if (!r.ok) throw new Error(`propose ${r.code}`);
  return (await repo.get(r.id))!;
};
const click = (p: { token: string; channelId: string | null; messageId: string | null }, action: 'approve' | 'reject', userId = ADMIN) => ({ token: p.token, action, userId, channelId: p.channelId, messageId: p.messageId });
const started = async (o: Record<string, unknown> = {}) => {
  const p = await proposed(o);
  const d = await svc.decideCard(click(p, 'approve'));
  if (!d.ok || d.result !== 'approved') throw new Error('decide failed');
  events = [];
  posts = [];
  closes = [];
  return { p: (await repo.get(p.id))!, root: d.root };
};
const audits = async (action: string) => (await db.pool.query<{ outcome: string }>('SELECT outcome FROM audit_log WHERE action = $1 ORDER BY id', [action])).rows.map((r) => r.outcome);
const seedBudget = (rootId: string, calls: number) =>
  db.pool.query("INSERT INTO budget_days (day, scope, scope_id, spent_usd, calls) VALUES ('1970-01-01','task',$1,0,$2) ON CONFLICT (day, scope, scope_id) DO UPDATE SET calls = $2", [rootId, calls]);
const kid = (parentId: string, status: 'todo' | 'blocked' = 'todo') => tasks.create({ title: 'kid', deptId: 'hq', owner: hq, requester: hq, origin: 'delegated', parentId, status });

describe('project_propose (SA-1 3.2, 5.3)', () => {
  it('only the CEO; the refusal order is not_ceo, halted, off, screen, deadline', async () => {
    expect(await svc.propose({ kind: 'head', dept: 'software' }, run, input())).toMatchObject({ ok: false, code: 'not_ceo', error: PROPOSE_TEXT.not_ceo });
    expect(await svc.propose({ kind: 'persona', personaId: 'x' } as ActorRef, run, input())).toMatchObject({ ok: false, code: 'not_ceo' });
    halted = true;
    cfg.values.set('autopilot.enabled', false);
    expect(await propose()).toMatchObject({ ok: false, code: 'halted', error: PROPOSE_TEXT.halted });
    halted = false;
    expect(await propose()).toMatchObject({ ok: false, code: 'off', error: PROPOSE_TEXT.off });
    cfg.values.set('autopilot.enabled', true);
    expect(await propose({ title: `has ${SECRET} inside` })).toMatchObject({ ok: false, code: 'screen', error: PROPOSE_TEXT.screen });
    expect(await propose({ goal: `hidden​text` })).toMatchObject({ ok: false, code: 'screen' });
    expect(await propose({ deadline: plusDays(-1) })).toMatchObject({ ok: false, code: 'deadline', error: PROPOSE_TEXT.deadline });
    expect(await propose({ deadline: plusDays(400) })).toMatchObject({ ok: false, code: 'deadline' });
    expect(await propose({ deadline: '2026-02-31' })).toMatchObject({ ok: false, code: 'deadline' });
    expect(await propose({ budget: { maxLocalCalls: 0, maxUsd: 1 } })).toMatchObject({ ok: false, code: 'invalid' });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM projects')).rows[0].n).toBe(0);
  });
  it('a read error on autopilot.enabled counts as off', async () => {
    cfg.throwOn.add('autopilot.enabled');
    expect(await propose()).toMatchObject({ ok: false, code: 'off' });
  });
  it('open cap 3 and a case-insensitive duplicate title, with the fixed texts', async () => {
    await proposed({ title: 'Alpha' });
    expect(await propose({ title: 'ALPHA' })).toMatchObject({ ok: false, code: 'duplicate', error: PROPOSE_TEXT.duplicate });
    await proposed({ title: 'Beta' });
    await proposed({ title: 'Gamma' });
    expect(await propose({ title: 'Delta' })).toMatchObject({ ok: false, code: 'open_cap', error: PROPOSE_TEXT.open_cap });
  });
  it('ok: the exact text, one card in #setting, its channel and message stored; the run taint is stored', async () => {
    const r = await svc.propose(hq, { tainted: true, task: null }, input({ title: 'Tainted one' }));
    expect(r).toMatchObject({ ok: true, cardOk: true });
    if (!r.ok) return;
    expect(r.text).toBe(`Project proposal #${r.id} was sent to the Bot Admins. Nothing starts until it is approved. Adopt: 0 listed, 0 not eligible.`);
    const p = (await repo.get(r.id))!;
    expect(p).toMatchObject({ status: 'proposed', tainted: true, proposer: 'head:hq', channelId: CONFIG_CHANNEL_ID });
    expect(p.messageId).toMatch(/^[0-9]{17,20}$/);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ type: 'approval', origin: 'governance', title: 'Project proposal', projectCardId: p.token });
    expect(posts[0]!.body).toContain('The proposing run read outside content.');
  });
  it('the card carries the autopilot text VERBATIM and escapes model text (goal, title, adopt titles); no secret reaches it', async () => {
    const root = await tasks.create({ title: 'old **bold** @everyone', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'chat', status: 'todo' });
    const r = await propose({ title: 'T **x** <@123>', goal: 'g @everyone `code` [l](http://x)', adopt: [root.id.slice(0, 8), 'deadbeef', 'zz'.repeat(4)].slice(0, 2) });
    expect(r).toMatchObject({ ok: true });
    const p = posts[0]!;
    expect(p.body).toContain(AUTOPILOT_CARD_TEXT);
    expect(p.body).toContain('Deadline:');
    expect(p.body).toContain('Budget: 100 local model calls, 5.00 USD, 500 auto approvals');
    expect(p.body).toContain('Proposed by: the CEO');
    expect(p.body).not.toContain('@everyone');
    expect(p.body).not.toContain('<@123>');
    expect(p.body).toContain('T \\*\\*x\\*\\*');
    expect(p.body).toContain(`- ${root.id.slice(0, 8)} old \\*\\*bold\\*\\* @​everyone`);
    expect(p.body).toContain('- deadbeef not adopted: not_found');
    const goal = p.fields!.map((f) => f.value).join('');
    expect(goal).toContain('@​everyone');
    expect(goal).not.toContain('@everyone');
    expect(p.fields![0]!.name).toBe('Goal (written by the CEO)');
    for (const f of p.fields!) expect(f.value.length).toBeLessThanOrEqual(1024);
    expect(JSON.stringify(p)).not.toContain(SECRET);
  });
  it('a long goal with escapes is split over fields of at most 1024 characters, nothing cut', async () => {
    await propose({ goal: '*'.repeat(1000) });
    const f = posts[0]!.fields!;
    expect(f.length).toBeGreaterThan(1);
    expect(f.map((x) => x.value).join('')).toBe('\\*'.repeat(1000));
    for (const x of f) expect(x.value.length).toBeLessThanOrEqual(1024);
  });
  it('a failed card post keeps the row, tells the CEO and logs the error name only', async () => {
    failPost = true;
    const r = await propose({ goal: 'MARKER-PLANTED goal' });
    expect(r).toMatchObject({ ok: true, cardOk: false });
    if (!r.ok) return;
    expect(r.text).toContain('The card could not be posted; a Bot Admin can see it in /project list.');
    expect((await repo.get(r.id))!.messageId).toBeNull();
    expect(JSON.stringify(logLines)).not.toContain('planted');
    expect(JSON.stringify(logLines)).not.toContain('MARKER-PLANTED');
    expect(logLines).toContainEqual({ errName: 'TypeError' });
  });
  it('/project start: proposer user:<id>, never tainted, adopt string split; bad adopt is refused', async () => {
    const root = await tasks.create({ title: 'old', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'chat', status: 'todo' });
    const r = await svc.start({ userId: ADMIN, title: 'From admin', goal: 'g', deadline: plusDays(10), usd: 2, calls: 50, adopt: `${root.id.slice(0, 8)}, nonsense!` });
    expect(r).toMatchObject({ ok: false, code: 'invalid' });
    const ok = await svc.start({ userId: ADMIN, title: 'From admin', goal: 'g', deadline: plusDays(10), usd: 2, calls: 50, adopt: `${root.id.slice(0, 8)}  ${root.id.slice(0, 8)}` });
    expect(ok).toMatchObject({ ok: true });
    if (!ok.ok) return;
    expect(await repo.get(ok.id)).toMatchObject({ proposer: `user:${ADMIN}`, tainted: false, adoptIds: [root.id] });
    expect(posts[0]!.body).toContain(`Proposed by: <@${ADMIN}>`);
    expect(posts[0]!.fields![0]!.name).toBe('Goal (written by a Bot Admin)');
    expect(await svc.start({ userId: ADMIN, title: 'x', goal: 'g', deadline: plusDays(10), usd: Number.NaN, calls: 5 })).toMatchObject({ ok: false, code: 'invalid' });
  });
});

describe('projcard: approve (SA-1 3.2)', () => {
  it('approve creates the root once, emits task.created once, closes the card with the adoption report, and rejects a second click', async () => {
    const old = await tasks.create({ title: 'old', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'chat', status: 'todo' });
    const p = await proposed({ adopt: [old.id.slice(0, 8), 'abcdef12'] });
    const d = await svc.decideCard(click(p, 'approve'));
    expect(d).toMatchObject({ ok: true, result: 'approved', adopted: 1, skipped: [] });
    if (!d.ok || d.result !== 'approved') return;
    expect(d.root).toMatchObject({ status: 'todo', deptId: 'hq', parentId: null, depth: 0 });
    expect(events.filter((e) => e.name === 'task.created')).toHaveLength(1);
    expect((events.find((e) => e.name === 'task.created')!.p as { task: { id: string } }).task.id).toBe(d.root.id);
    expect(closes).toEqual([{ channelId: CONFIG_CHANNEL_ID, messageId: p.messageId, note: `Approved by <@${ADMIN}>. Root task ${d.root.id.slice(0, 8)}. Adopted 1, skipped none.` }]);
    expect((await tasks.get(old.id))!).toMatchObject({ rootId: d.root.id, parentId: d.root.id, depth: 1 });
    expect(await audits('project.decide')).toEqual([`#${p.id} approved root ${d.root.id.slice(0, 8)} adopted 1 skipped 0`]);
    // second click
    expect(await svc.decideCard(click(p, 'approve'))).toEqual({ ok: false, code: 'not_pending', text: DECIDE_TEXT.not_pending });
    expect(events.filter((e) => e.name === 'task.created')).toHaveLength(1);
  });
  it('a skipped adopt id is listed on the card with its code', async () => {
    const old = await tasks.create({ title: 'old', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'chat', status: 'todo' });
    const p = await proposed({ adopt: [old.id.slice(0, 8)] });
    await db.pool.query("UPDATE tasks SET status = 'doing' WHERE id = $1", [old.id]); // became ineligible between the proposal and the click
    const d = await svc.decideCard(click(p, 'approve'));
    expect(d).toMatchObject({ ok: true, adopted: 0, skipped: [`${old.id.slice(0, 8)} running`] });
    expect(closes[0]!.note).toContain(`Adopted 0, skipped ${old.id.slice(0, 8)} running.`);
  });
  it('two concurrent approves: exactly one wins, one task.created', async () => {
    const p = await proposed();
    const rs = await Promise.all([svc.decideCard(click(p, 'approve')), svc.decideCard(click(p, 'approve', ADMIN2))]);
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.find((r) => !r.ok)).toMatchObject({ code: 'not_pending' });
    expect(events.filter((e) => e.name === 'task.created')).toHaveLength(1);
  });
  it('wrong card: another message, another channel, a token of a card that was never posted, a bad token', async () => {
    const p = await proposed();
    const wrong = { ok: false, code: 'wrong_card', text: DECIDE_TEXT.wrong_card };
    expect(await svc.decideCard(click({ ...p, messageId: '800000000000999999' }, 'approve'))).toEqual(wrong);
    expect(await svc.decideCard(click({ ...p, channelId: '1570000000000000555' }, 'approve'))).toEqual(wrong);
    expect(await svc.decideCard(click({ ...p, messageId: null }, 'approve'))).toEqual(wrong);
    expect(await svc.decideCard(click({ ...p, token: 'ab'.repeat(16) }, 'approve'))).toEqual(wrong);
    expect(await svc.decideCard(click({ ...p, token: 'nope' }, 'approve'))).toEqual(wrong);
    expect((await repo.get(p.id))!.status).toBe('proposed');
  });
  it('a card whose stored channel is not #setting is refused even when the click matches it', async () => {
    const p = await proposed();
    await db.pool.query("UPDATE projects SET channel_id = '1570000000000000555' WHERE id = $1", [p.id]);
    expect(await svc.decideCard(click({ ...p, channelId: '1570000000000000555' }, 'approve'))).toMatchObject({ ok: false, code: 'wrong_card' });
  });
  it('halted and off refuse approve and leave the row proposed; reject still works under halt', async () => {
    const p = await proposed();
    halted = true;
    expect(await svc.decideCard(click(p, 'approve'))).toEqual({ ok: false, code: 'halted', text: DECIDE_TEXT.halted });
    halted = false;
    cfg.values.set('autopilot.enabled', false);
    expect(await svc.decideCard(click(p, 'approve'))).toEqual({ ok: false, code: 'off', text: DECIDE_TEXT.off });
    expect((await repo.get(p.id))!.status).toBe('proposed');
    expect((await db.pool.query('SELECT count(*)::int AS n FROM tasks')).rows[0].n).toBe(0);
    halted = true;
    expect(await svc.decideCard(click(p, 'reject'))).toMatchObject({ ok: true, result: 'rejected' });
  });
  it('an expired proposal is cancelled by the system, its card closed, and nothing starts', async () => {
    const p = await proposed();
    await db.pool.query("UPDATE projects SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE id = $1", [p.id]);
    for (const action of ['approve', 'reject'] as const) {
      if (action === 'reject') await db.pool.query("UPDATE projects SET status = 'proposed', closed_by = NULL, closed_at = NULL WHERE id = $1", [p.id]);
      closes = [];
      expect(await svc.decideCard(click(p, action))).toEqual({ ok: false, code: 'expired', text: DECIDE_TEXT.expired });
      expect(await repo.get(p.id)).toMatchObject({ status: 'cancelled', closedBy: 'system' });
      expect(closes).toEqual([{ channelId: CONFIG_CHANNEL_ID, messageId: p.messageId, note: 'Expired after 7 days without a decision.' }]);
    }
    expect((await db.pool.query('SELECT count(*)::int AS n FROM tasks')).rows[0].n).toBe(0);
  });
  it('the minute tick expires proposals that ran out (and closes their cards) and leaves live ones alone', async () => {
    const old = await proposed();
    const live = await proposed();
    await db.pool.query("UPDATE projects SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE id = $1", [old.id]);
    await svc.tick();
    expect((await repo.get(old.id))!.status).toBe('cancelled');
    expect((await repo.get(live.id))!.status).toBe('proposed');
    expect(closes).toHaveLength(1);
    await svc.tick();
    expect(closes).toHaveLength(1);
  });
});

describe('projcard: reject', () => {
  it('cancels, closes the card, tells the CEO once; a second reject is not_pending', async () => {
    const p = await proposed();
    expect(await svc.decideCard(click(p, 'reject'))).toMatchObject({ ok: true, result: 'rejected' });
    expect(await repo.get(p.id)).toMatchObject({ status: 'cancelled', closedBy: ADMIN });
    expect(notices).toEqual([{ dept: 'hq', text: `Project proposal #${p.id} was rejected. Do not start it.` }]);
    expect(closes[0]!.note).toBe(`Rejected by <@${ADMIN}>. Nothing started.`);
    expect(await svc.decideCard(click(p, 'reject'))).toMatchObject({ ok: false, code: 'not_pending' });
    expect(notices).toHaveLength(1);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM tasks')).rows[0].n).toBe(0);
  });
  it('a proposal made by a Bot Admin notifies nobody when rejected', async () => {
    const r = await svc.start({ userId: ADMIN, title: 'mine', goal: 'g', deadline: plusDays(5), usd: 1, calls: 10 });
    if (!r.ok) throw new Error('start');
    await svc.decideCard(click((await repo.get(r.id))!, 'reject'));
    expect(notices).toEqual([]);
  });
});

describe('budget notice, raise and close (SA-1 3.5)', () => {
  it('exhausted() posts exactly one card even under concurrency; the card text is fixed; the channel and message are stored', async () => {
    const { p, root } = await started({ title: 'Budget **one**' });
    await seedBudget(root.id, 40);
    const rs = await Promise.all([svc.exhausted(p.id), svc.exhausted(p.id), svc.exhausted(p.id)]);
    expect(rs.filter(Boolean)).toHaveLength(1);
    expect(posts).toHaveLength(1);
    const e = (await repo.get(p.id))!;
    expect(posts[0]).toMatchObject({ type: 'approval', origin: 'governance', title: 'Project budget used up', projectBudgetId: e.budgetToken });
    expect(posts[0]!.body).toBe(`Project #${p.id} Budget \\*\\*one\\*\\* used its budget: 40/100 local calls, 0.00/5.00 USD, 0/500 auto approvals. Autopilot is stopped for this project; tasks that hit the budget are blocked. Raise adds 100 calls, 5.00 USD, 500 approvals.`);
    expect(e).toMatchObject({ budgetChannelId: CONFIG_CHANNEL_ID });
    expect(e.budgetMessageId).toMatch(/^[0-9]{17,20}$/);
    expect(await svc.exhausted(p.id)).toBe(false);
  });
  it('a failed budget post is logged (error name only) and the notice is still owed once, not twice', async () => {
    const { p } = await started();
    failPost = true;
    expect(await svc.exhausted(p.id)).toBe(true);
    expect(logLines).toContainEqual({ errName: 'TypeError' });
    expect(JSON.stringify(logLines)).not.toContain('planted');
    failPost = false;
    expect(await svc.exhausted(p.id)).toBe(false);
    expect(posts).toHaveLength(0);
  });
  it('budgetHit blocks the task for the budget, emits task.changed and sends the one notice (twice: still one)', async () => {
    const { p, root } = await started();
    const k = await kid(root.id);
    await svc.budgetHit(k);
    await svc.budgetHit((await tasks.get(root.id))!);
    expect(await tasks.get(k.id)).toMatchObject({ status: 'blocked', blockedReason: 'budget' });
    expect(await tasks.get(root.id)).toMatchObject({ status: 'blocked', blockedReason: 'budget' });
    expect(events.filter((e) => e.name === 'task.changed')).toHaveLength(2);
    expect(posts.filter((x) => x.title === 'Project budget used up')).toHaveLength(1);
    expect((await repo.get(p.id))!.exhaustedAt).not.toBeNull();
  });
  it('raise (button) unblocks only budget-blocked tasks of the root, emits changed+ready, closes the card; a second click is refused', async () => {
    const { p, root } = await started();
    const a = await kid(root.id, 'blocked');
    const b = await kid(root.id, 'blocked');
    await db.pool.query("UPDATE tasks SET blocked_reason = 'budget' WHERE id = $1", [a.id]);
    await db.pool.query("UPDATE tasks SET blocked_reason = 'owner' WHERE id = $1", [b.id]);
    const other = await tasks.create({ title: 'elsewhere', deptId: 'hq', owner: hq, requester: hq, origin: 'chat', status: 'blocked' });
    await db.pool.query("UPDATE tasks SET blocked_reason = 'budget' WHERE id = $1", [other.id]);
    await svc.exhausted(p.id);
    const e = (await repo.get(p.id))!;
    const c = { token: e.budgetToken!, action: 'raise' as const, userId: ADMIN, channelId: e.budgetChannelId, messageId: e.budgetMessageId };
    events = [];
    const r = await svc.decideBudget(c);
    expect(r).toMatchObject({ ok: true, result: 'raised', unblocked: 1 });
    expect(await tasks.get(a.id)).toMatchObject({ status: 'todo', blockedReason: null });
    expect(await tasks.get(b.id)).toMatchObject({ status: 'blocked' });
    expect(await tasks.get(other.id)).toMatchObject({ status: 'blocked' });
    expect(events.map((x) => x.name)).toEqual(['task.changed', 'task.ready']);
    expect(await repo.get(p.id)).toMatchObject({ maxLocalCalls: 200, exhaustedAt: null });
    expect(closes.at(-1)!.note).toContain(`Raised by <@${ADMIN}>`);
    expect(await svc.decideBudget(c)).toMatchObject({ ok: false });
  });
  it('raise refuses: wrong card, not exhausted, halted, and a CHECK overflow says raise_max with nothing changed', async () => {
    const { p } = await started();
    await svc.exhausted(p.id);
    const e = (await repo.get(p.id))!;
    const c = { token: e.budgetToken!, action: 'raise' as const, userId: ADMIN, channelId: e.budgetChannelId, messageId: e.budgetMessageId };
    expect(await svc.decideBudget({ ...c, messageId: '800000000000999999' })).toEqual({ ok: false, code: 'wrong_card', text: DECIDE_TEXT.wrong_card });
    expect(await svc.decideBudget({ ...c, token: 'cd'.repeat(16) })).toMatchObject({ ok: false, code: 'wrong_card' });
    halted = true;
    expect(await svc.decideBudget(c)).toEqual({ ok: false, code: 'halted', text: DECIDE_TEXT.halted });
    halted = false;
    await db.pool.query('UPDATE projects SET max_approvals = 999999, base_approvals = 5000 WHERE id = $1', [p.id]);
    expect(await svc.decideBudget(c)).toEqual({ ok: false, code: 'raise_max', text: DECIDE_TEXT.raise_max });
    expect((await repo.get(p.id))!.exhaustedAt).not.toBeNull();
    const fresh = await started();
    expect(await svc.raise(fresh.p.id, ADMIN)).toEqual({ ok: false, code: 'not_exhausted', text: DECIDE_TEXT.not_exhausted });
    expect(await svc.raise(999999, ADMIN)).toEqual({ ok: false, code: 'not_found', text: DECIDE_TEXT.not_found });
  });
  it('close (button) ends the project, marks a lone root done, closes the card; /project raise works without a button', async () => {
    const { p, root } = await started();
    await svc.exhausted(p.id);
    const e = (await repo.get(p.id))!;
    events = [];
    const r = await svc.decideBudget({ token: e.budgetToken!, action: 'close', userId: ADMIN, channelId: e.budgetChannelId, messageId: e.budgetMessageId });
    expect(r).toMatchObject({ ok: true, result: 'closed' });
    expect(await repo.get(p.id)).toMatchObject({ status: 'done', closedBy: ADMIN });
    expect(await tasks.get(root.id)).toMatchObject({ status: 'done' });
    expect(events).toContainEqual({ name: 'task.changed', p: expect.objectContaining({ from: 'todo', to: 'done' }) });
    expect(closes.at(-1)!.note).toBe(`Closed by <@${ADMIN}>.`);
    const second = await started();
    await svc.exhausted(second.p.id);
    const text = await svc.raise(second.p.id, ADMIN);
    expect(text).toMatchObject({ ok: true });
    expect(text.text).toContain(`Project #${second.p.id} raised: 200 calls, 10.00 USD, 1000 approvals in total. 0 blocked tasks restarted.`);
  });
});

describe('lifecycle commands (SA-1 3.6, AP-C9)', () => {
  it('pause and resume with their texts; repeating is refused; unknown and inactive ids', async () => {
    const { p } = await started();
    expect(await svc.pause(p.id, ADMIN)).toEqual({ ok: true, text: `Project #${p.id} paused.` });
    expect(await svc.pause(p.id, ADMIN)).toEqual({ ok: false, code: 'unchanged_paused', text: DECIDE_TEXT.unchanged_paused });
    expect(await svc.resume(p.id, ADMIN)).toEqual({ ok: true, text: `Project #${p.id} resumed.` });
    expect(await svc.resume(p.id, ADMIN)).toMatchObject({ ok: false, code: 'unchanged_running' });
    expect(await svc.pause(424242, ADMIN)).toMatchObject({ ok: false, code: 'not_found' });
    expect(await audits('project.pause')).toHaveLength(1);
    expect(await audits('project.resume')).toHaveLength(1);
    await svc.close(p.id, ADMIN);
    expect(await svc.pause(p.id, ADMIN)).toMatchObject({ ok: false, code: 'not_active' });
  });
  it('close marks a lone root done and emits task.changed; with open children the tree is left alone', async () => {
    const a = await started();
    expect(await svc.close(a.p.id, ADMIN)).toEqual({ ok: true, text: `Project #${a.p.id} closed. Its root task was marked done.` });
    expect(events.some((e) => e.name === 'task.changed')).toBe(true);
    const b = await started();
    const k = await kid(b.root.id);
    expect(await svc.close(b.p.id, ADMIN)).toEqual({ ok: true, text: `Project #${b.p.id} closed.` });
    expect(await tasks.get(b.root.id)).toMatchObject({ status: 'todo' });
    expect(await tasks.get(k.id)).toMatchObject({ status: 'todo' });
    expect(await svc.close(b.p.id, ADMIN)).toMatchObject({ ok: false, code: 'not_active' });
  });
  it('extend: new deadline within the range, the date errors, halt, unknown project', async () => {
    const { p } = await started();
    const to = plusDays(90);
    expect(await svc.extend(p.id, to, ADMIN)).toEqual({ ok: true, text: `Project #${p.id} deadline is now ${to}.` });
    expect(await audits('project.extend')).toEqual([`#${p.id} ok ${to}`]);
    expect(await svc.extend(p.id, plusDays(-3), ADMIN)).toMatchObject({ ok: false, text: PROPOSE_TEXT.deadline });
    expect(await svc.extend(p.id, 'tomorrow', ADMIN)).toMatchObject({ ok: false, text: PROPOSE_TEXT.deadline });
    expect(await svc.extend(p.id, plusDays(500), ADMIN)).toMatchObject({ ok: false, text: PROPOSE_TEXT.deadline });
    expect(await svc.extend(31337, to, ADMIN)).toMatchObject({ ok: false, code: 'not_found' });
    halted = true;
    expect(await svc.extend(p.id, plusDays(100), ADMIN)).toEqual({ ok: false, code: 'halted', text: DECIDE_TEXT.halted });
  });
  it('deadline notice: none before the deadline, exactly one after (also under concurrency), again after an extend that passes; names /project extend', async () => {
    const { p } = await started();
    expect(await svc.deadlineNotices()).toBe(0);
    await db.pool.query("UPDATE projects SET deadline = '2020-01-01' WHERE id = $1", [p.id]);
    const ns = await Promise.all([svc.deadlineNotices(), svc.deadlineNotices()]);
    expect(ns[0]! + ns[1]!).toBe(1);
    await svc.tick();
    await svc.deadlineNotices();
    const dead = posts.filter((x) => x.title === 'Project deadline passed');
    expect(dead).toHaveLength(1);
    expect(dead[0]).toMatchObject({ type: 'alert', origin: 'governance' });
    expect(dead[0]!.body).toContain(`/project extend id:${p.id}`);
    expect(dead[0]!.body).toContain('2020-01-01');
    expect(await svc.deadlineNotices()).toBe(0);
    // an extend (to a future date) clears the mark; a later pass is announced again
    await svc.extend(p.id, plusDays(2), ADMIN);
    await db.pool.query("UPDATE projects SET deadline = '2020-01-02' WHERE id = $1", [p.id]);
    expect(await svc.deadlineNotices()).toBe(1);
    expect(posts.filter((x) => x.title === 'Project deadline passed')).toHaveLength(2);
  });
  it('no deadline notice while halted or off, and a closed project is never announced', async () => {
    const { p } = await started();
    await db.pool.query("UPDATE projects SET deadline = '2020-01-01' WHERE id = $1", [p.id]);
    halted = true;
    expect(await svc.deadlineNotices()).toBe(0);
    halted = false;
    cfg.values.set('autopilot.enabled', false);
    expect(await svc.deadlineNotices()).toBe(0);
    cfg.values.set('autopilot.enabled', true);
    await svc.close(p.id, ADMIN);
    expect(await svc.deadlineNotices()).toBe(0);
    expect(posts).toHaveLength(0);
  });
  it('list returns the rows with usage and the past-deadline flag', async () => {
    const { p, root } = await started();
    await seedBudget(root.id, 7);
    await db.pool.query("UPDATE projects SET deadline = '2020-01-01' WHERE id = $1", [p.id]);
    const rows = await svc.list(25);
    expect(rows[0]).toMatchObject({ id: p.id, status: 'active', pastDeadline: true, rootTaskId: root.id });
    expect(Number(rows[0]!.calls)).toBe(7);
  });
});

describe('root-end sync (SA-1 3.6)', () => {
  const attach = () => {
    const bus = new EventBus<AppEvents>({ error: (o) => void logLines.push(o) });
    const tracked: Promise<void>[] = [];
    const off = svc.attach(bus, (_w, fn) => { const pr = fn(); tracked.push(pr); return pr; });
    return { bus, tracked, off };
  };
  it('a root that ends done or cancelled ends its active project (closed_by system, audit project.end); a child ending does nothing', async () => {
    const { p, root } = await started();
    const k = await kid(root.id);
    const h = attach();
    await h.bus.emit('task.changed', { task: k, from: 'todo', to: 'done' });
    await Promise.all(h.tracked);
    expect((await repo.get(p.id))!.status).toBe('active');
    await h.bus.emit('task.changed', { task: root, from: 'todo', to: 'doing' });
    expect((await repo.get(p.id))!.status).toBe('active');
    await h.bus.emit('task.changed', { task: root, from: 'doing', to: 'cancelled' });
    await Promise.all(h.tracked);
    expect(await repo.get(p.id)).toMatchObject({ status: 'cancelled', closedBy: 'system' });
    expect(await audits('project.end')).toEqual([`#${p.id} cancelled`]);
    const two = await started();
    await h.bus.emit('task.changed', { task: two.root, from: 'review', to: 'done' });
    await Promise.all(h.tracked);
    expect((await repo.get(two.p.id))!.status).toBe('done');
    h.off();
  });
  it('a sync failure is logged by error name only and never throws', async () => {
    const { root } = await started();
    const bus = new EventBus<AppEvents>({ error: (o) => void logLines.push(o) });
    const broken = new ProjectService({ repo: { rootEnded: async () => { throw new RangeError('MARKER-PLANTED'); } }, log: { error: (o: unknown) => void logLines.push(o) } } as never);
    const tracked: Promise<void>[] = [];
    broken.attach(bus, (_w, fn) => { const pr = fn(); tracked.push(pr); return pr; });
    await bus.emit('task.changed', { task: root, from: 'todo', to: 'done' });
    await Promise.all(tracked);
    expect(logLines).toContainEqual({ errName: 'RangeError' });
    expect(JSON.stringify(logLines)).not.toContain('MARKER-PLANTED');
  });
});

describe('no model text out (AP-C14)', () => {
  it('a planted marker in title and goal appears only in the escaped card fields, never in refusal texts or log lines', async () => {
    const r = await propose({ title: 'MARKERT title', goal: 'MARKERG goal' });
    expect(r.ok).toBe(true);
    const refused = await propose({ title: 'MARKERT title' });
    expect(JSON.stringify(refused)).not.toContain('MARKER');
    const bad = await propose({ deadline: plusDays(-1), title: 'MARKERX' });
    expect(JSON.stringify(bad)).not.toContain('MARKER');
    expect(JSON.stringify(logLines)).not.toContain('MARKER');
    const p = (await repo.list(5))[0]!;
    const d = await svc.decideCard(click(p, 'approve'));
    expect(JSON.stringify(d.ok && d.result === 'approved' ? d.skipped : d)).not.toContain('MARKER');
    expect(closes.map((c) => c.note).join('')).not.toContain('MARKER');
    expect(JSON.stringify(logLines)).not.toContain('MARKER');
  });
});

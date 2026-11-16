import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import type { Task } from '../../db/repos/tasks.js';
import { insertTaskGrant } from '../../db/repos/task-grants.js';
import { insertGrant } from '../../db/repos/web-grants.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { handleInteraction } from '../../discord/index.js';
import { cmd, interaction } from '../../discord/commands/test-helpers.js';
import { ActorProvider, CTO, SA, TestPort, boot, resetDb, respond, taskIdOf, turn } from './helpers.js';

/**
 * TASKADMIN-1 through the real app and PostgreSQL: /task list, cancel, retry and done as a Bot Admin presses them (TA-C1..TA-C24).
 * The commands are driven with the same handleInteraction the gateway calls; the task rows are made directly (no run starts until a test says so).
 */
let db: TestDb;
let app: App | null = null;
beforeAll(async () => { db = await freshDb(); });
afterEach(async () => {
  await app?.stop();
  app = null;
  await resetDb(db.pool);
  await db.pool.query('TRUNCATE web_grants, approval_batches, task_grants RESTART IDENTITY CASCADE');
});
afterAll(async () => { await db.close(); });

const ADMIN = '123456789012345678';
type Booted = Awaited<ReturnType<typeof start>>;
async function start(script: ConstructorParameters<typeof ActorProvider>[0] = {}, o: { offDays?: number[] } = {}) {
  const provider = new ActorProvider(script);
  const port = new TestPort();
  const t = await boot(db.pool, { provider, port, ...(o.offDays ? { offDays: o.offDays } : {}) });
  app = t.app;
  return { app: t.app, provider, port, s: t.app.services, deps: t.app.services.commands };
}
const mkTask = (t: Booted, over: Partial<Parameters<Booted['s']['tasks']['create']>[0]> = {}) =>
  t.s.tasks.create({ title: 'a task', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat', ...over });
const slash = async (t: Booted, sub: string, strings: Record<string, string> = {}, bools: Record<string, boolean> = {}, userId = ADMIN) => {
  const i = cmd('task', sub, { strings, bools, userId });
  const r = await handleInteraction(i, t.deps);
  return { r: r!, i, text: r!.content ?? '' };
};
const nonceOf = (r: { components?: unknown[] }, kind: string): string => {
  const row = (r.components as { components: { custom_id: string }[] }[])[0]!;
  return row.components.find((c) => c.custom_id.startsWith(`taskadm:${kind}:`))!.custom_id;
};
const press = async (t: Booted, customId: string, userId = ADMIN) => {
  const r = await handleInteraction(interaction({ kind: 'button', customId, userId }), t.deps);
  await t.s.scheduler.idle();
  return r!;
};
const audits = async (like: string) => (await db.pool.query<{ action: string; outcome: string; tool: string | null; task_id: string | null; actor: string }>('SELECT action, outcome, tool, task_id, actor FROM audit_log WHERE action LIKE $1 ORDER BY id', [like])).rows;
const status = async (id: string) => (await t0().tasks.get(id))!.status;
let cur: Booted | null = null;
const t0 = () => cur!.s;

describe('wiring', () => {
  it('the app passes ONE TaskRuns to the agent loops, the commands and the services (TA-C10), and registers /task', async () => {
    const t = await start();
    cur = t;
    const sched = t.s.scheduler as unknown as { d: { agent: { taskRuns: unknown }; pendingApprovals: unknown } };
    expect(t.s.taskRuns).toBeDefined();
    expect(sched.d.agent.taskRuns).toBe(t.s.taskRuns);
    expect(t.deps.taskAdmin!.taskRuns).toBe(t.s.taskRuns);
    expect(typeof sched.d.pendingApprovals).toBe('function');
  });
});

describe('/task cancel through the app', () => {
  it('confirm, then click: the tree is cancelled, the loops are aborted first, approvals expire, the web grant is revoked, and every effect is audited with ids and codes only', async () => {
    const t = await start();
    cur = t;
    const root = await mkTask(t, { status: 'doing', title: `secret title sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789` });
    const child = await mkTask(t, { parentId: root.id, owner: SA, requester: CTO, origin: 'delegated', status: 'doing' });
    const grand = await mkTask(t, { parentId: child.id, owner: SA, requester: SA, origin: 'delegated' });
    const a = await t.s.approvals.request({ taskId: grand.id, kind: 'tool', tool: { name: 'write_file', input: { n: 1 } }, reason: 'r', estCostUsd: 0, requestedBy: SA });
    const ap = await t.s.approvals.request({ taskId: child.id, reason: 'big', estCostUsd: 5, requestedBy: SA });
    const wg = await insertGrant(db.pool, { rootId: root.id, approvalId: a.id, grantedBy: ADMIN, requestedBy: 'head:software', maxFetches: 5, maxHosts: 2, maxUrlChars: 1000, hours: 4 });
    const tg = await insertTaskGrant(db.pool, { rootId: root.id, approvalId: a.id, grantedBy: ADMIN, requestedBy: 'head:software', maxCalls: 10, hours: 4 });
    const ac = new AbortController();
    t.s.taskRuns.track(child.id, ac); // a model call of the child is streaming

    // without cascade the open children refuse it, with a fixed text and a refused audit row
    const refused = await slash(t, 'cancel', { task: root.id.slice(0, 8) });
    expect(refused.text).toBe('That task has 2 open subtasks. Add cascade:children to cancel them too.');
    expect(await audits('task.cancel')).toEqual([expect.objectContaining({ outcome: 'refused:E_OPEN_CHILDREN', task_id: root.id, actor: `user:${ADMIN}` })]);
    expect(await status(root.id)).toBe('doing');

    const confirm = await slash(t, 'cancel', { task: root.id.slice(0, 8), cascade: 'children', reason: 'cleanup sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' });
    expect(confirm.text).toContain('Cancel 3 tasks?');
    expect(confirm.text).toContain('Pending approvals that will expire: 2');
    expect(confirm.text).toContain('This is the root');
    expect(confirm.text).toContain('Running now: yes');
    expect(confirm.text).not.toContain('sk-ant');
    expect(await status(root.id)).toBe('doing'); // nothing changes before the click

    // another admin cannot use my button; it is consumed by the refused lookup
    const id = nonceOf(confirm.r, 'cancel');
    expect((await press(t, id, '999999999999999999')).content).toContain('The task changed or the confirmation expired');
    expect(await status(root.id)).toBe('doing');
    const again = await slash(t, 'cancel', { task: root.id.slice(0, 8), cascade: 'children', reason: 'cleanup sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' });
    const out = await press(t, nonceOf(again.r, 'cancel'));
    expect(out.content).toMatch(/^Cancelled 3 tasks: /);
    for (const x of [root, child, grand]) expect(await status(x.id)).toBe('cancelled');
    expect(ac.signal.aborted).toBe(true);
    expect((await db.pool.query("SELECT status FROM approvals ORDER BY id")).rows.map((r) => r.status)).toEqual(['expired', 'expired']);
    expect((await db.pool.query('SELECT revoke_reason, revoked_by FROM web_grants WHERE id = $1', [wg.id])).rows[0]).toEqual({ revoke_reason: 'admin', revoked_by: ADMIN });
    // TG-C18 (existing listener): the root ending revokes the task grant with root_ended
    await new Promise((r) => setTimeout(r, 50));
    expect((await db.pool.query('SELECT revoke_reason FROM task_grants WHERE id = $1', [tg.id])).rows[0]).toEqual({ revoke_reason: 'root_ended' });
    // reuse of the used button is stale
    expect((await press(t, nonceOf(again.r, 'cancel'))).content).toContain('The task changed or the confirmation expired');

    const rows = await audits('%');
    const by = (a: string) => rows.filter((r) => r.action === a);
    expect(by('task.cancel')).toContainEqual(expect.objectContaining({ outcome: expect.stringMatching(/^ok reason=cleanup \[REDACTED\]/), tool: 'cascade:3' }));
    expect(by('task.cancel.cascade').map((r) => r.outcome)).toEqual([`ok #${root.id.slice(0, 8)}`, `ok #${root.id.slice(0, 8)}`]);
    expect(by('approval.expire').map((r) => r.outcome).sort()).toEqual([`task_cancelled #${a.id}`, `task_cancelled #${ap.id}`].sort());
    expect(by('web_grant.revoke')).toEqual([expect.objectContaining({ outcome: `admin #${wg.id}`, task_id: root.id })]);
    expect(by('task.cancel.abort')).toEqual([expect.objectContaining({ outcome: 'runs 1' })]);
    expect(JSON.stringify(rows)).not.toMatch(/sk-ant|secret title/); // never a title or a secret
  });

  it('the admin reason reaches the "Subtask cancelled" post (masked, escaped), and neither the direct log line nor the head conversation memory (TA-C12)', async () => {
    const t = await start();
    cur = t;
    const parent = await mkTask(t, { status: 'doing', title: 'Parent' });
    await t.s.tasks.update(parent.id, { threadId: 'th-p' });
    const child = await mkTask(t, { parentId: parent.id, owner: SA, requester: CTO, origin: 'delegated', status: 'doing' });
    const c = await slash(t, 'cancel', { task: child.id.slice(0, 8), reason: 'stale sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 @everyone' });
    await press(t, nonceOf(c.r, 'cancel'));
    await t.s.scheduler.idle();
    const post = t.port.posts.find((p) => p.payload.title === 'Subtask cancelled')!;
    expect(post.payload.body).toContain('was cancelled by a Bot Admin.');
    expect(post.payload.body).toContain('Reason: stale \\[REDACTED\\]');
    expect(post.payload.body).not.toMatch(/sk-ant|@everyone/);
    expect(JSON.stringify(t.port.directs)).not.toContain('stale');
  });

  it('a child created between the confirm and the click makes the click stale and changes nothing; the dismiss button only consumes the nonce', async () => {
    const t = await start();
    cur = t;
    const root = await mkTask(t, { status: 'doing' });
    await mkTask(t, { parentId: root.id });
    const c1 = await slash(t, 'cancel', { task: root.id.slice(0, 8), cascade: 'children' });
    await mkTask(t, { parentId: root.id });
    const r = await press(t, nonceOf(c1.r, 'cancel'));
    expect(r.content).toContain('The task changed or the confirmation expired');
    expect(await status(root.id)).toBe('doing');
    expect(await audits('task.cancel')).toEqual([expect.objectContaining({ outcome: 'stale' })]);
    const c2 = await slash(t, 'cancel', { task: root.id.slice(0, 8), cascade: 'children' });
    const dismissId = (c2.r.components as unknown as { components: { custom_id: string }[] }[])[0]!.components.find((c) => c.custom_id.startsWith('taskadm:dismiss:'))!.custom_id;
    expect((await press(t, dismissId)).content).toBe('Dismissed. Nothing was changed.');
    expect((await press(t, nonceOf(c2.r, 'cancel'))).content).toContain('The task changed or the confirmation expired'); // the dismiss consumed the nonce
    expect(await status(root.id)).toBe('doing');
  });

  it('cancel works while halted and wakes nothing; an ended task and an ambiguous prefix are refused', async () => {
    const t = await start();
    cur = t;
    const x = await mkTask(t, { status: 'doing' });
    await t.s.halt.halt('test');
    const c = await slash(t, 'cancel', { task: x.id });
    const out = await press(t, nonceOf(c.r, 'cancel'));
    expect(out.content).toMatch(/^Cancelled 1 task: /);
    expect(await status(x.id)).toBe('cancelled');
    expect((await slash(t, 'cancel', { task: x.id })).text).toBe('That task is already done or cancelled.');
    expect((await slash(t, 'cancel', { task: '------' })).text).toBe('No task matches that id.');
  });

  it('cancelling a task its owner blocked (reason owner, with a note) succeeds under the backstop CHECK', async () => {
    const t = await start();
    cur = t;
    const x = await mkTask(t, { status: 'doing' });
    await t.s.tasks.update(x.id, { status: 'blocked', blockedReason: 'owner', blockedNote: 'need the vendor key' });
    const c = await slash(t, 'cancel', { task: x.id.slice(0, 8) });
    expect((await press(t, nonceOf(c.r, 'cancel'))).content).toMatch(/^Cancelled 1 task/);
    expect((await db.pool.query('SELECT status, blocked_note FROM tasks WHERE id = $1', [x.id])).rows[0]).toEqual({ status: 'cancelled', blocked_note: null });
  });
});

describe('/task list through the app', () => {
  it('shows blocked:owner with the stored note, the counts and masked titles', async () => {
    const t = await start();
    cur = t;
    const a = await mkTask(t, { status: 'doing', title: 'plain' });
    await t.s.tasks.update(a.id, { status: 'blocked', blockedReason: 'owner', blockedNote: 'need the vendor key' });
    await mkTask(t, { status: 'review', title: 'in review' });
    const l = await slash(t, 'list');
    expect(l.text.split('\n')[0]).toContain('review 1 · blocked 1');
    expect(l.text).toMatch(/blocked:owner[^\n]*need the vendor key/);
    expect((await slash(t, 'list', { status: 'blocked' })).text).not.toContain('in review');
    expect(await audits('task.%')).toEqual([]); // read-only
  });
});

describe('/task retry through the app', () => {
  const block = async (t: Booted, reason: 'turns' | 'budget' | 'approval' | 'error' | 'halt' | 'owner' | null, over: Partial<Task> = {}, parentId?: string) => {
    const x = await mkTask(t, { status: 'doing', ...(parentId ? { parentId } : {}) });
    await t.s.tasks.update(x.id, { status: 'blocked', ...(reason ? { blockedReason: reason } : {}), ...(reason === 'owner' ? { blockedNote: 'need the key' } : {}), ...(over.turnsUsed !== undefined ? { turnsUsed: over.turnsUsed } : {}) });
    return x;
  };

  it('refuses in order: halted, not blocked, tree ended, turns without reset; each refusal is audited', async () => {
    const t = await start({ 'heads/software': [turn(respond('chat', 'ok')), turn(respond('chat', 'ok'))] });
    cur = t;
    const todo = await mkTask(t);
    expect((await slash(t, 'retry', { task: todo.id.slice(0, 8) })).text).toBe('Only a blocked task can be retried (it is todo).');
    const parent = await mkTask(t, { status: 'doing' });
    const kid = await block(t, 'error', {}, parent.id);
    await t.s.tasks.update(parent.id, { status: 'cancelled' });
    expect((await slash(t, 'retry', { task: kid.id.slice(0, 8) })).text).toBe('Its parent or root task has ended.');
    const turns = await block(t, 'turns', { turnsUsed: 1000 });
    expect((await slash(t, 'retry', { task: turns.id.slice(0, 8) })).text).toBe('This task used all its turns (1000/20). Add reset_turns:true.');
    await t.s.halt.halt('test');
    expect((await slash(t, 'retry', { task: turns.id.slice(0, 8) })).text).toBe('The company is halted. Use /resume first.');
    expect(await status(turns.id)).toBe('blocked');
    expect((await audits('task.retry')).map((r) => r.outcome)).toEqual(['refused:E_NOT_BLOCKED', 'refused:E_TREE_ENDED', 'refused:E_TURNS', 'refused:E_HALTED']);
  });

  it('reset_turns moves a turn-limited task to todo with turns 0 and the owner runs it; audited as ok reset_turns with the previous reason', async () => {
    const t = await start({ 'heads/software': [turn(respond('chat', 'back at it'))] });
    cur = t;
    const x = await block(t, 'turns', { turnsUsed: 1000 });
    const r = await slash(t, 'retry', { task: x.id.slice(0, 8) }, { reset_turns: true });
    expect(r.text).toContain('is back in todo with its turns reset');
    await t.s.scheduler.idle();
    expect(t.provider.callsOf('heads/software').length).toBe(1); // the run started
    expect((await t.s.tasks.get(x.id))!.turnsUsed).toBe(1);
    expect(await audits('task.retry')).toEqual([expect.objectContaining({ outcome: 'ok reset_turns', tool: 'turns', task_id: x.id })]);
  });

  it('a NULL reason (a legacy row) and owner are the same: audited as owner, and the owner reason leaves no note behind', async () => {
    const t = await start({ 'heads/software': [turn(respond('chat', 'a')), turn(respond('chat', 'b'))] });
    cur = t;
    const a = await block(t, null);
    const b = await block(t, 'owner');
    await slash(t, 'retry', { task: a.id.slice(0, 8) });
    await slash(t, 'retry', { task: b.id.slice(0, 8) });
    await t.s.scheduler.idle();
    expect((await audits('task.retry')).map((r) => r.tool)).toEqual(['owner', 'owner']);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM tasks WHERE blocked_note IS NOT NULL')).rows[0]!.n).toBe(0);
  });

  it('after a human rejected the cap, a retried budget/approval task blocks again at once with no provider call (TA-C17)', async () => {
    const t = await start({ 'heads/software': [] });
    cur = t;
    await t.s.cfg.set('budget.taskUsd', 0.000001, 'test'); // any model call exceeds the tree cap
    const root = await mkTask(t, { status: 'doing' });
    const a = await mkTask(t, { parentId: root.id, status: 'doing' });
    const b = await mkTask(t, { parentId: root.id, status: 'doing' });
    const cap = (await t.s.approvals.onTreeCapHit({ rootId: root.id, taskId: a.id, est: 5, requestedBy: CTO }))!;
    await t.s.approvals.onTreeCapHit({ rootId: root.id, taskId: b.id, est: 5, requestedBy: CTO }); // joins
    await t.s.approvals.decide(cap.id, 'rejected', { id: ADMIN, isAdmin: true });
    expect(await t.s.tasks.get(b.id)).toMatchObject({ status: 'blocked', blockedReason: 'approval' });
    const r = await slash(t, 'retry', { task: b.id.slice(0, 8) });
    expect(r.text).toContain('it will block again unless the cap was raised or a new cap approval is granted');
    await t.s.scheduler.idle();
    expect(await t.s.tasks.get(b.id)).toMatchObject({ status: 'blocked', blockedReason: 'budget' });
    expect(t.provider.calls).toHaveLength(0);
  });
});

describe('/task done through the app', () => {
  const parentWithThread = async (t: Booted) => {
    const parent = await mkTask(t, { status: 'doing', title: 'Parent' });
    await t.s.tasks.update(parent.id, { threadId: 'th-p' });
    return parent;
  };

  it('a delegated child in review: confirm names the roll-up, the click moves it to done with the fixed summary and starts exactly ONE parent roll-up; the audit says ok', async () => {
    const t = await start({ 'heads/software': [turn(respond('chat', 'rolled up'))] });
    cur = t;
    const parent = await parentWithThread(t);
    const child = await mkTask(t, { parentId: parent.id, owner: SA, requester: CTO, origin: 'delegated', status: 'review' });
    const c = await slash(t, 'done', { task: child.id.slice(0, 8) });
    expect(c.text).toContain('Accept this task as done?');
    expect(c.text).toContain('A roll-up run of the parent will start');
    expect(await status(child.id)).toBe('review');
    const r = await press(t, nonceOf(c.r, 'done'));
    expect(r.content).toBe(`Accepted: ${child.id.slice(0, 8)} is done.`);
    await t.s.scheduler.idle();
    expect(await status(child.id)).toBe('done');
    expect(t.provider.callsOf('heads/software')).toHaveLength(1);
    expect(t.port.posts.find((p) => p.payload.title === 'Subtask done')!.payload.body).toContain('Accepted by a Bot Admin.');
    expect(await audits('task.done')).toEqual([expect.objectContaining({ outcome: 'ok', task_id: child.id })]);
    // the button of another subcommand and a reused one both fail
    expect((await press(t, nonceOf(c.r, 'done'))).content).toContain('The task changed or the confirmation expired');
  });

  it('on an off day the parent roll-up of a delegated child accepted by an admin is held, not run (TA-C21)', async () => {
    const t = await start({ 'heads/software': [turn(respond('chat', 'never'))] }, { offDays: [0, 1, 2, 3, 4, 5, 6] });
    cur = t;
    const parent = await parentWithThread(t);
    const child = await mkTask(t, { parentId: parent.id, owner: SA, requester: CTO, origin: 'delegated', status: 'review' });
    const c = await slash(t, 'done', { task: child.id.slice(0, 8) });
    await press(t, nonceOf(c.r, 'done'));
    await t.s.scheduler.idle();
    expect(await status(child.id)).toBe('done');
    expect(t.provider.callsOf('heads/software')).toHaveLength(0);
  });

  it('a human-requested root: no roll-up, and its web grant is revoked with reason admin (TA-C22)', async () => {
    const t = await start({ 'heads/software': [] });
    cur = t;
    const root = await mkTask(t, { status: 'review' });
    const a = await t.s.approvals.request({ taskId: root.id, kind: 'tool', tool: { name: 'fetch_page', input: { url: 'https://x.test/' } }, reason: 'r', estCostUsd: 0, requestedBy: CTO });
    await db.pool.query("UPDATE approvals SET status = 'approved' WHERE id = $1", [a.id]);
    await db.pool.query("UPDATE tasks SET status = 'review' WHERE id = $1", [root.id]);
    const wg = await insertGrant(db.pool, { rootId: root.id, approvalId: a.id, grantedBy: ADMIN, requestedBy: 'head:software', maxFetches: 5, maxHosts: 2, maxUrlChars: 1000, hours: 4 });
    const c = await slash(t, 'done', { task: root.id.slice(0, 8) });
    expect(c.text).toContain('No roll-up run starts.');
    await press(t, nonceOf(c.r, 'done'));
    expect(await status(root.id)).toBe('done');
    expect(t.provider.calls).toHaveLength(0);
    expect((await db.pool.query('SELECT revoke_reason FROM web_grants WHERE id = $1', [wg.id])).rows[0]).toEqual({ revoke_reason: 'admin' });
    expect(await audits('web_grant.revoke')).toEqual([expect.objectContaining({ outcome: `admin #${wg.id}` })]);
  });

  it('refuses in the spec order with fixed texts: halted, not review, open children, pending approval, running', async () => {
    const t = await start();
    cur = t;
    const x = await mkTask(t, { status: 'doing' });
    expect((await slash(t, 'done', { task: x.id.slice(0, 8) })).text).toBe('Only a task in review can be accepted (it is doing).');
    await t.s.tasks.update(x.id, { status: 'review' });
    const kid = await mkTask(t, { parentId: x.id });
    expect((await slash(t, 'done', { task: x.id.slice(0, 8) })).text).toBe('That task has 1 open subtask. Finish or cancel them first.');
    await t.s.tasks.update(kid.id, { status: 'done' });
    await t.s.approvals.request({ taskId: x.id, kind: 'tool', tool: { name: 'write_file', input: {} }, reason: 'r', estCostUsd: 0, requestedBy: CTO });
    await t.s.tasks.update(x.id, { status: 'review' }); // the request moved it to awaiting_approval
    expect((await slash(t, 'done', { task: x.id.slice(0, 8) })).text).toBe('That task has pending approvals. Decide them first.');
    await db.pool.query("UPDATE approvals SET status = 'rejected'");
    const ac = new AbortController();
    t.s.taskRuns.track(x.id, ac);
    expect((await slash(t, 'done', { task: x.id.slice(0, 8) })).text).toBe('That task is running right now. Try again when it has stopped.');
    await t.s.halt.halt('test');
    expect((await slash(t, 'done', { task: x.id.slice(0, 8) })).text).toBe('The company is halted. Use /resume first.');
    expect((await audits('task.done')).map((r) => r.outcome)).toEqual(['refused:E_NOT_REVIEW', 'refused:E_OPEN_CHILDREN', 'refused:E_PENDING', 'refused:E_RUNNING', 'refused:E_HALTED']);
  });
});

describe('the blocked reason end to end (TA-C13..C15)', () => {
  it('update_task blocked without a reason is refused; with one it persists reason owner, shows in /task list and in the parent notice, and the card extra reaches the log', async () => {
    const t = await start({
      'members/system-analyst': [
        (req) => turn({ name: 'update_task', input: { taskId: taskIdOf(req), status: 'blocked' } }),
        (req) => turn({ name: 'update_task', input: { taskId: taskIdOf(req), status: 'blocked', summary: 'need the vendor key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' } }),
        turn(respond('chat', 'waiting')),
      ],
    });
    cur = t;
    const parent = await mkTask(t, { status: 'doing', title: 'Parent' });
    await t.s.tasks.update(parent.id, { threadId: 'th-p' });
    const child = await mkTask(t, { parentId: parent.id, owner: SA, requester: CTO, origin: 'delegated' });
    await t.deps.taskAdmin!.bus.emit('task.ready', { taskId: child.id });
    await t.s.scheduler.idle();
    const row = (await db.pool.query<{ status: string; blocked_reason: string; blocked_note: string }>('SELECT status, blocked_reason, blocked_note FROM tasks WHERE id = $1', [child.id])).rows[0]!;
    expect(row).toMatchObject({ status: 'blocked', blocked_reason: 'owner' });
    expect(row.blocked_note).toContain('need the vendor key');
    expect(row.blocked_note).not.toMatch(/sk-ant/);
    const notice = t.port.posts.find((p) => p.payload.title === 'Subtask blocked')!;
    expect(notice.payload.body).toContain('is blocked (owner): need the vendor key');
    expect(notice.payload.body).not.toMatch(/sk-ant/);
    const l = await slash(t, 'list', { status: 'blocked' });
    expect(l.text).toMatch(/blocked:owner[^\n]*need the vendor key/);
    expect(t.port.tasks.some((x) => x.id === child.id)).toBe(true);
    // the first call (no summary) was a tool error the model saw
    const second = t.provider.callsOf('members/system-analyst')[1]!;
    expect(JSON.stringify(second.messages.at(-1))).toContain('blocked needs a short reason in summary');
  });
});


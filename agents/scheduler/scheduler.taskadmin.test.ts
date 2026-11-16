import { describe, expect, it, vi } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import type { Task } from '../../db/repos/tasks.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeDiscordPort } from '../../tests/fakes/discordPort.js';
import type { AgentDeps, AgentOutcome, AgentTrigger } from '../loop/loop.js';
import { Scheduler } from './scheduler.js';
import { CTO, MemTasks, newBus, noApprovedTools, quiet, seededOrg } from '../test-helpers.js';

// TASKADMIN-1 at the scheduler: the cancel notices (TA-C12), the blocked reason on cards and posts (TA-C15), /task done (TA-C19..C21).
const SA: ActorRef = { kind: 'persona', personaId: 'system-analyst' };
const SECRET = 'sk-live-TOPSECRET-1234567890';
const chat = (body: string): AgentOutcome => ({ payload: { type: 'chat', body }, costUsd: 0, turns: 1 });

async function mk(o: { halted?: () => boolean; pending?: (id: string) => Promise<number> } = {}) {
  const cfg = new FakeConfig();
  const tasks = new MemTasks() as MemTasks & { findByThread(id: string): Promise<Task | null> };
  tasks.findByThread = async (id) => [...tasks.rows.values()].find((t) => t.threadId === id) ?? null;
  const port = new FakeDiscordPort();
  const bus = newBus();
  const runs: AgentTrigger[] = [];
  const run = vi.fn(async (t: AgentTrigger) => { runs.push(t); return chat('ok'); });
  const s = new Scheduler({
    agent: {} as AgentDeps, approvedTools: noApprovedTools, run, port, org: await seededOrg(), tasks, limits: new Limits(cfg, tasks),
    halt: { isHalted: o.halted ?? (() => false) }, cfg, bus, log: quiet, now: () => 1_000_000, secrets: [SECRET],
    ...(o.pending ? { pendingApprovals: o.pending } : {}),
  });
  s.attach();
  return { s, port, tasks, bus, runs, run };
}
const pair = async (t: Awaited<ReturnType<typeof mk>>, childStatus: Task['status'] = 'cancelled', parentOver: Partial<Task> = {}) => {
  const parent = await t.tasks.create({ title: 'Parent', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'th-p', status: 'doing' });
  if (Object.keys(parentOver).length) await t.tasks.update(parent.id, parentOver);
  const child = await t.tasks.create({ title: 'Child', deptId: 'software', owner: SA, requester: CTO, origin: 'delegated', parentId: parent.id, status: childStatus, threadId: 'th-c' });
  return { parent: (await t.tasks.get(parent.id))!, child: (await t.tasks.get(child.id))! };
};

describe('admin cancel notices (TA-C12)', () => {
  it('the parent post says "cancelled by a Bot Admin" and carries the masked, defanged reason; no other path sees the reason', async () => {
    const t = await mk();
    const { parent, child } = await pair(t);
    // a head conversation parent keeps every ended child's report for its final summary (noteReport): the reason must not be in it
    t.tasks.rows.get(parent.id)!.conversation = true;
    await t.bus.emit('task.changed', { task: child, from: 'doing', to: 'cancelled', admin: { cascadeIds: [child.id], reason: `stale since ${SECRET} @everyone <@123456789012345678> **x**` } });
    await t.s.idle();
    const post = t.port.posts.find((p) => p.target.threadId === 'th-p')!;
    expect(post.payload.title).toBe('Subtask cancelled');
    expect(post.payload.body).toContain('was cancelled by a Bot Admin.');
    expect(post.payload.body).toContain('Reason: stale since \\[REDACTED\\]'); // masked, then markdown-escaped
    expect(post.payload.body).not.toContain(SECRET);
    expect(post.payload.body).not.toContain('@everyone'); // defanged with a zero-width space
    expect(post.payload.body).not.toContain('<@123');
    expect((post.payload as { noHandles?: boolean }).noHandles).toBe(true);
    // not in the direct log line, not in the roll-up memory
    expect(JSON.stringify(t.port.directs)).not.toContain('stale since');
    expect(JSON.stringify(t.port.directs)).toContain('was cancelled by a Bot Admin.');
    const kept = (t.s as unknown as { reports: Map<string, { text: string }[]> }).reports.get(parent.id) ?? [];
    expect(kept.map((r) => r.text).join('\n')).toContain('was cancelled by a Bot Admin.');
    expect(kept.map((r) => r.text).join('\n')).not.toContain('stale since');
    expect(t.run).not.toHaveBeenCalled();
  });

  it('without the admin field the text is today\'s "was cancelled."', async () => {
    const t = await mk();
    const { child } = await pair(t);
    await t.bus.emit('task.changed', { task: child, from: 'doing', to: 'cancelled' });
    await t.s.idle();
    expect(t.port.posts.find((p) => p.target.threadId === 'th-p')!.payload.body).toBe('"Child" (system-analyst) was cancelled.');
  });

  it('a parent that is itself in the cascade gets no notice (no flood), but the task is still mirrored', async () => {
    const t = await mk();
    const { parent, child } = await pair(t);
    await t.bus.emit('task.changed', { task: child, from: 'doing', to: 'cancelled', admin: { cascadeIds: [parent.id, child.id] } });
    await t.s.idle();
    expect(t.port.posts.filter((p) => p.target.threadId === 'th-p')).toEqual([]);
    expect(t.port.tasks).toHaveLength(1);
  });
});

describe('the blocked reason on cards and posts (TA-C15)', () => {
  const blockedEvent = async (t: Awaited<ReturnType<typeof mk>>, child: Task, summary: string) => {
    await t.tasks.update(child.id, { status: 'blocked', blockedReason: 'owner', blockedNote: summary });
    await t.bus.emit('task.changed', { task: (await t.tasks.get(child.id))!, from: 'doing', to: 'blocked', summary });
    await t.s.idle();
  };

  it('"Subtask blocked" shows the reason, the #tasks log gets the "Blocked because" extra, and a thread card edit carries the field', async () => {
    const t = await mk();
    const { child } = await pair(t, 'doing');
    t.port.cardIds.set(child.id, 'card-1');
    await blockedEvent(t, child, 'need the vendor key');
    const post = t.port.posts.find((p) => p.target.threadId === 'th-p')!;
    expect(post.payload.title).toBe('Subtask blocked');
    expect(post.payload.body).toContain('is blocked (owner): need the vendor key');
    expect(t.port.taskLogExtras).toEqual([{ taskId: child.id, blockedBecause: 'need the vendor key' }]);
    const edit = t.port.cardEdits.find((e) => e.taskId === child.id)!;
    expect(JSON.stringify((edit.payload as { fields?: unknown }).fields)).toContain('Blocked because');
    expect(JSON.stringify((edit.payload as { fields?: unknown }).fields)).toContain('need the vendor key');
  });

  it('a reason with a secret is masked before it is cut, one line, at most 300 characters; other reasons add no field', async () => {
    const t = await mk();
    const { child } = await pair(t, 'doing');
    t.port.cardIds.set(child.id, 'card-1');
    await blockedEvent(t, child, `${'a'.repeat(280)} ${SECRET.slice(0, 12)}${SECRET.slice(12)} tail\nsecond line`);
    const body = t.port.posts.find((p) => p.target.threadId === 'th-p')!.payload.body;
    expect(body).not.toContain('sk-live');
    expect(body).not.toContain('\nsecond');
    const extra = t.port.taskLogExtras[0]!.blockedBecause!;
    expect(extra.length).toBeLessThanOrEqual(300);
    expect(extra).not.toContain('sk-live');
    // an approval block has no summary: no field
    const t2 = await mk();
    const p2 = await pair(t2, 'doing');
    t2.port.cardIds.set(p2.child.id, 'card-2');
    await t2.tasks.update(p2.child.id, { status: 'blocked', blockedReason: 'approval' });
    await t2.bus.emit('task.changed', { task: (await t2.tasks.get(p2.child.id))!, from: 'awaiting_approval', to: 'blocked' });
    await t2.s.idle();
    expect(t2.port.taskLogExtras).toEqual([]);
    expect(JSON.stringify(t2.port.cardEdits[0]!.payload)).not.toContain('Blocked because');
  });
});

describe('Scheduler.adminAccept (TA-C19..C21)', () => {
  const accept = async (t: Awaited<ReturnType<typeof mk>>, id: string) => t.s.adminAccept(id, 'admin1', (await t.tasks.acceptDigest(id))!);

  it('moves a review task to done with the fixed summary and the normal "Subtask done" path (exactly one parent roll-up for a delegated child)', async () => {
    const t = await mk();
    const { child } = await pair(t, 'review');
    const seen: string[] = [];
    t.bus.on('task.changed', (e) => void seen.push(`${e.from}>${e.to}:${e.summary ?? ''}`));
    const r = await accept(t, child.id);
    expect(r).toMatchObject({ ok: true });
    await t.s.idle();
    expect(seen).toEqual(['review>done:Accepted by a Bot Admin.']);
    expect((await t.tasks.get(child.id))!.status).toBe('done');
    const post = t.port.posts.find((p) => p.target.threadId === 'th-p')!;
    expect(post.payload.title).toBe('Subtask done');
    expect(post.payload.body).toContain('Accepted by a Bot Admin.');
    expect(t.run).toHaveBeenCalledTimes(1); // the roll-up of the delegating parent
  });

  it('a human-requested task starts no roll-up', async () => {
    const t = await mk();
    const root = await t.tasks.create({ title: 'Root', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'th-r', status: 'review' });
    expect((await accept(t, root.id)).ok).toBe(true);
    await t.s.idle();
    expect(t.run).not.toHaveBeenCalled();
    expect((await t.tasks.get(root.id))!.status).toBe('done');
  });

  it('refuses in order: halted, not review, open children, pending approval, running (lock busy), stale', async () => {
    const t = await mk({ pending: async (id) => (id === 'P' ? 1 : 0) });
    const { parent, child } = await pair(t, 'review', { status: 'review' });
    const d = (await t.tasks.acceptDigest(parent.id))!;
    expect(await t.s.adminAccept(parent.id, 'a', d)).toEqual({ ok: false, error: 'open_children' }); // the review child below is open
    expect(await t.s.adminAccept(child.id, 'a', 'deadbeef0000')).toEqual({ ok: false, error: 'stale' });
    await t.tasks.update(child.id, { status: 'doing' });
    expect(await t.s.adminAccept(child.id, 'a', 'x')).toEqual({ ok: false, error: 'not_review' });
    const halted = await mk({ halted: () => true });
    const h = await pair(halted, 'review');
    expect(await halted.s.adminAccept(h.child.id, 'a', 'x')).toEqual({ ok: false, error: 'halted' });
    // pending approval
    const t3 = await mk({ pending: async () => 1 });
    const p3 = await pair(t3, 'review');
    expect(await t3.s.adminAccept(p3.child.id, 'a', (await t3.tasks.acceptDigest(p3.child.id))!)).toEqual({ ok: false, error: 'pending' });
    // running: the task's lock is held
    const t4 = await mk();
    const p4 = await pair(t4, 'review');
    let release!: () => void;
    const held = (t4.s as unknown as { locks: { run(k: string, f: () => Promise<void>): Promise<void> } }).locks.run(p4.child.id, () => new Promise<void>((r) => { release = r; }));
    expect(await t4.s.adminAccept(p4.child.id, 'a', 'x')).toEqual({ ok: false, error: 'running' });
    release();
    await held;
  });

  it('a task that changed after the confirm is stale and unchanged', async () => {
    const t = await mk();
    const { child } = await pair(t, 'review');
    const d = (await t.tasks.acceptDigest(child.id))!;
    await t.tasks.update(child.id, { costUsd: 1 }); // any write moves updated_at
    expect(await t.s.adminAccept(child.id, 'a', d)).toEqual({ ok: false, error: 'stale' });
    expect((await t.tasks.get(child.id))!.status).toBe('review');
  });
});

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { DepartmentRepo, TaskRepo } from './index.js';
import { canonicalActor, QuestionRepo } from './questions.js';

let db: TestDb;
let tasks: TaskRepo;
let repo: QuestionRepo;
const hq: ActorRef = { kind: 'head', dept: 'hq' };
const sw: ActorRef = { kind: 'head', dept: 'software' };
const CAPS = { perRoot: 6, perDay: 40 };
const MSG = '1565667791938387969';

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'), 'up');
  const d = new DepartmentRepo(db.pool);
  for (const id of ['hq', 'software']) await d.upsert({ id, name: id, categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
  tasks = new TaskRepo(db.pool);
  repo = new QuestionRepo(db.pool);
});
beforeEach(async () => {
  await db.pool.query('DELETE FROM task_questions');
  await db.pool.query('DELETE FROM tasks');
});
afterAll(async () => { await db.close(); });

const root = () => tasks.create({ title: 'r', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
async function pair() {
  const r = await root();
  const c = await tasks.create({ title: 'c', deptId: 'software', owner: sw, requester: hq, origin: 'delegated', parentId: r.id });
  return { r, c };
}
const input = (c: { id: string; rootId: string; parentId: string | null }, over: Record<string, unknown> = {}) => ({
  taskId: c.id, rootId: c.rootId, parentId: c.parentId, asker: sw, requester: hq as ActorRef, question: 'which env?', questionTainted: false, ...over,
});

describe('questions repo (AB11)', () => {
  it('canonical actor form has exactly the allowed keys', () => {
    expect(canonicalActor({ kind: 'head', dept: 'hq' })).toEqual({ kind: 'head', dept: 'hq' });
    expect(canonicalActor({ kind: 'persona', personaId: 'p' })).toEqual({ kind: 'persona', personaId: 'p' });
    expect(canonicalActor({ kind: 'human', userId: '9' })).toEqual({ kind: 'human', userId: '9' });
    expect(canonicalActor({ kind: 'head', dept: 'hq', extra: 1 } as unknown as ActorRef)).toEqual({ kind: 'head', dept: 'hq' });
  });

  it('create: pending, seq 1 then 2, third refused (cap_task), one open at a time', async () => {
    const { c } = await pair();
    const a = await repo.create(input(c), CAPS);
    expect(a).toMatchObject({ ok: true, row: { seq: 1, status: 'pending', questionTainted: false } });
    expect(await repo.create(input(c), CAPS)).toEqual({ ok: false, why: 'open' });
    await repo.close((a as { row: { id: number } }).row.id, 'moot');
    expect(await repo.create(input(c), CAPS)).toMatchObject({ ok: true, row: { seq: 2 } });
    const open = await repo.openFor(c.id);
    await repo.close(open!.id, 'moot');
    expect(await repo.create(input(c), CAPS)).toEqual({ ok: false, why: 'cap_task' });
  });

  it('per-root and per-day caps hold, also under concurrent creates', async () => {
    const r = await root();
    const kids = await Promise.all([1, 2, 3, 4].map((n) => tasks.create({ title: `c${n}`, deptId: 'software', owner: sw, requester: hq, origin: 'delegated', parentId: r.id })));
    const res = await Promise.all(kids.map((k) => repo.create(input(k), { perRoot: 2, perDay: 40 })));
    expect(res.filter((x) => x.ok)).toHaveLength(2);
    expect(res.filter((x) => !x.ok).every((x) => !x.ok && x.why === 'cap_root')).toBe(true);
    const r2 = await root();
    const k2 = await Promise.all([1, 2, 3].map((n) => tasks.create({ title: `d${n}`, deptId: 'software', owner: sw, requester: hq, origin: 'delegated', parentId: r2.id })));
    const day = await Promise.all(k2.map((k) => repo.create(input(k), { perRoot: 6, perDay: 3 })));
    expect(day.filter((x) => x.ok)).toHaveLength(1); // 2 already exist today
    expect(day.filter((x) => !x.ok).every((x) => !x.ok && x.why === 'cap_day')).toBe(true);
  });

  it('a human requester row is asked at once with an expiry', async () => {
    const r = await root();
    const x = await repo.create({ taskId: r.id, rootId: r.rootId, parentId: null, asker: hq, requester: { kind: 'human', userId: '1' }, question: 'q', questionTainted: true, askedForHours: 4 }, CAPS);
    expect(x).toMatchObject({ ok: true, row: { status: 'asked', parentId: null } });
    const row = (x as { row: { askedAt: Date; expiresAt: Date } }).row;
    expect(row.expiresAt.getTime() - row.askedAt.getTime()).toBeGreaterThan(3.9 * 3600_000);
  });

  it('every transition is conditional', async () => {
    const { c } = await pair();
    const id = ((await repo.create(input(c), CAPS)) as { row: { id: number } }).row.id;
    expect(await repo.answer(id, hq, 'a', false)).toBeNull(); // pending: not answerable
    expect((await repo.markAsked(id, 4))?.status).toBe('asked');
    expect(await repo.markAsked(id, 4)).toBeNull(); // the claim is once
    expect(await repo.answer(id, { kind: 'head', dept: 'software' }, 'a', false)).toBeNull(); // not the requester
    expect(await repo.answer(id, { kind: 'human', userId: '1' }, 'a', false)).toBeNull();
    expect(await repo.answer(id, hq, 'the answer', true)).toMatchObject({ status: 'answered', answer: 'the answer', answerTainted: true });
    expect(await repo.answer(id, hq, 'again', false)).toBeNull();
    expect(await repo.close(id, 'moot')).toBeNull(); // closed rows do not move
    expect(await repo.close(id, 'expired')).toBeNull();
    expect(await repo.markResumed(id)).toBe(true);
    expect(await repo.markResumed(id)).toBe(false);
  });

  it('answer stores the taint it is given and never NULL', async () => {
    const { c } = await pair();
    const id = ((await repo.create(input(c), CAPS)) as { row: { id: number } }).row.id;
    await repo.markAsked(id, 1);
    const a = await repo.answer(id, hq, 'x', false);
    expect(a?.answerTainted).toBe(false);
  });

  it('revertAnswer passes the CHECKs, clears answer/taint/closed_at and keeps resumed_at; only before an answer message id exists', async () => {
    const { c } = await pair();
    const id = ((await repo.create(input(c), CAPS)) as { row: { id: number } }).row.id;
    await repo.markAsked(id, 4);
    await repo.answer(id, hq, 'a', false);
    expect(await repo.revertAnswer(id)).toBe(true);
    expect(await repo.get(id)).toMatchObject({ status: 'asked', answer: null, answerTainted: null, closedAt: null });
    await repo.answer(id, hq, 'a2', false);
    expect(await repo.setAnswerMessage(id, MSG)).toBe(true);
    expect(await repo.revertAnswer(id)).toBe(false); // the line was posted: not reverted
    expect(await repo.setAnswerMessage(id, 'not-a-snowflake')).toBe(false);
  });

  it('answerHuman: only the human requester, claims resumed_at with the answer, message id optional', async () => {
    const r = await root();
    const id = ((await repo.create({ taskId: r.id, rootId: r.rootId, parentId: null, asker: hq, requester: { kind: 'human', userId: '1' }, question: 'q', questionTainted: true, askedForHours: 4 }, CAPS)) as { row: { id: number } }).row.id;
    expect(await repo.answerHuman(id, '2', 'no', false, MSG)).toBeNull();
    const a = await repo.answerHuman(id, '1', 'yes', true, MSG);
    expect(a).toMatchObject({ status: 'answered', answer: 'yes', answerTainted: true, answerMessageId: MSG });
    expect(a?.resumedAt).not.toBeNull();
    expect(await repo.markResumed(id)).toBe(false);
  });

  it('expiry, stale pending and stale unresumed selectors; close(noResume) claims the resume', async () => {
    const { c } = await pair();
    const id = ((await repo.create(input(c), CAPS)) as { row: { id: number } }).row.id;
    expect(await repo.stalePending(0)).toHaveLength(1);
    expect(await repo.stalePending(3600)).toHaveLength(0);
    await repo.markAsked(id, 1);
    expect(await repo.dueExpiry()).toHaveLength(0);
    await db.pool.query("UPDATE task_questions SET expires_at = now() - interval '1 minute'");
    expect((await repo.dueExpiry()).map((x) => x.id)).toEqual([id]);
    expect((await repo.close(id, 'expired'))?.status).toBe('expired');
    // Gate 2 G2AB-03: only rows whose child is `doing` are returned (an ended or parked child's row can never fill the LIMIT)
    expect(await repo.staleUnresumed(0)).toHaveLength(0);
    await tasks.update(c.id, { status: 'doing' });
    expect((await repo.staleUnresumed(0)).map((x) => x.id)).toEqual([id]);
    expect(await repo.markResumed(id)).toBe(true);
    expect(await repo.staleUnresumed(0)).toHaveLength(0);
    const { c: c2 } = await pair();
    const id2 = ((await repo.create(input(c2), CAPS)) as { row: { id: number } }).row.id;
    expect((await repo.close(id2, 'moot', { noResume: true }))?.resumedAt).not.toBeNull();
  });

  it('openUnderParent lists the open rows of a parent', async () => {
    const { r, c } = await pair();
    await repo.create(input(c), CAPS);
    expect((await repo.openUnderParent(r.id)).map((x) => x.taskId)).toEqual([c.id]);
  });

  it('bootClose (AB2 b): open rows become moot and claimed; closed unresumed rows are claimed', async () => {
    const { c } = await pair();
    const { c: c2 } = await pair();
    const { c: c3 } = await pair();
    const a = ((await repo.create(input(c), CAPS)) as { row: { id: number } }).row.id; // pending
    const b = ((await repo.create(input(c2), CAPS)) as { row: { id: number } }).row.id; // asked
    await repo.markAsked(b, 4);
    const d = ((await repo.create(input(c3), CAPS)) as { row: { id: number } }).row.id; // answered, unresumed
    await repo.markAsked(d, 4);
    await repo.answer(d, hq, 'x', false);
    expect(await repo.bootClose()).toEqual({ closed: 2, claimed: 1 });
    for (const id of [a, b]) expect(await repo.get(id)).toMatchObject({ status: 'moot' });
    for (const id of [a, b, d]) expect((await repo.get(id))?.resumedAt).not.toBeNull();
    expect(await repo.openFor(c.id)).toBeNull();
  });

  it('the table CHECKs: shapes, lengths, snowflakes, answer/status pairing', async () => {
    const { c } = await pair();
    const base = ['task_id', 'root_id', 'asker', 'requester', 'question'];
    const ins = (cols: string, vals: string) => db.pool.query(`INSERT INTO task_questions (${cols}) VALUES (${vals})`);
    const ok = `'${c.id}','${c.rootId}','{"kind":"head","dept":"hq"}','{"kind":"head","dept":"hq"}'`;
    await expect(ins(`${base.join(',')},seq`, `${ok},'',1`)).rejects.toThrow(/check/i);
    await expect(ins(`${base.join(',')},seq`, `${ok},'${'x'.repeat(501)}',1`)).rejects.toThrow(/check/i);
    await expect(ins(`${base.join(',')},seq`, `'${c.id}','${c.rootId}','[]','{"kind":"head","dept":"hq"}','q',1`)).rejects.toThrow(/check/i);
    await expect(ins(`${base.join(',')},seq`, `'${c.id}','${c.rootId}','{"kind":"head","dept":"hq"}','{"kind":"robot"}','q',1`)).rejects.toThrow(/check/i);
    await expect(ins(`${base.join(',')},seq`, `${ok},'q',3`)).rejects.toThrow(/check/i);
    await expect(ins(`${base.join(',')},seq,question_message_id`, `${ok},'q',1,'abc'`)).rejects.toThrow(/check/i);
    await expect(ins(`${base.join(',')},seq,status`, `${ok},'q',1,'answered'`)).rejects.toThrow(/check/i);
    await expect(ins(`${base.join(',')},seq,status`, `${ok},'q',1,'asked'`)).rejects.toThrow(/check/i);
  });

  it('deleting a task cascades its questions', async () => {
    const { c } = await pair();
    await repo.create(input(c), CAPS);
    await db.pool.query('DELETE FROM tasks WHERE id = $1', [c.id]);
    expect((await db.pool.query('SELECT 1 FROM task_questions')).rowCount).toBe(0);
  });
});

describe('migration 033 up/down/up (AB11)', () => {
  it('down drops the table and its indexes cleanly and up restores it', async () => {
    const own = await freshDb();
    try {
      const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
      await migrate(own.pool, dir, 'up');
      const has = async () => (await own.pool.query("SELECT 1 FROM information_schema.tables WHERE table_name = 'task_questions' AND table_schema = current_schema()")).rowCount === 1;
      expect(await has()).toBe(true);
      expect(await migrate(own.pool, dir, 'down')).toContain('033_task_questions'); // newer migrations are rolled back first
      expect(await has()).toBe(false);
      expect((await own.pool.query("SELECT 1 FROM pg_indexes WHERE indexname LIKE 'task_questions%' AND schemaname = current_schema()")).rowCount).toBe(0);
      expect(await migrate(own.pool, dir, 'up')).toContain('033_task_questions');
      expect(await has()).toBe(true);
    } finally {
      await own.close();
    }
  });
});

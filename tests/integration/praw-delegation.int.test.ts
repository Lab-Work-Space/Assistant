import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import type { ActorRef } from '../../company/types.js';
import { seed } from '../../company/index.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo } from '../../db/repos/index.js';
import { TaskRepo } from '../../db/repos/tasks.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { PROMPTS_DIR, loadPrompts } from '../../prompts/index.js';
import {
  ActorProvider, AI_WARROOM, CEO, HQ_WORK, MARKETING_WORK, SOFTWARE_WORK, TestPort, boot, humanMsg, mentionOf, migrateUp, resetDb, respond, taskIdOf, turn,
} from './helpers.js';

const PRAW: ActorRef = { kind: 'head', dept: 'praw' };
const MKT: ActorRef = { kind: 'head', dept: 'marketing' };
const PRAW_WORK = '1565999999999999001';

let db: TestDb;
let app: App | null = null;
beforeAll(async () => {
  db = await freshDb();
});
afterEach(async () => {
  await app?.stop();
  app = null;
  await resetDb(db.pool);
});
afterAll(async () => {
  await db.close();
});

/** Seeds the company, points praw at the fake provider and optionally gives her a work channel (R1). */
async function prepare(workChannel: string | null): Promise<void> {
  await migrateUp(db.pool);
  await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, loadPrompts(PROMPTS_DIR));
  await db.pool.query("UPDATE departments SET provider = 'claude', model = 'claude-sonnet-5-5', work_channel_id = $1 WHERE id = 'praw'", [workChannel]);
}
const done = (summary: string, report: ReturnType<typeof respond>) => (req: Parameters<typeof taskIdOf>[0]) =>
  turn({ name: 'update_task', input: { taskId: taskIdOf(req), status: 'done', summary } }, report);
const create = (dept: string, title = 'Launch plan') =>
  turn({ name: 'create_task', input: { title, description: 'Do the work and report back.', assignee: { kind: 'head', dept }, estCostUsd: 0.1 } });
const textOf = (r: { messages: { content: unknown }[] }) => JSON.stringify(r.messages);

describe('praw conversation and delegation', () => {
  it('AC2 › "ฝากทีม Marketing…" → child owned by marketing (requester praw) in marketing\'s work channel; done report in Praw\'s thread by Praw; roll-up answers the human', async () => {
    await prepare(null);
    const provider = new ActorProvider({
      'heads/praw': [create('marketing'), turn(respond('chat', 'ส่งต่อให้ทีม Marketing แล้วค่ะ')), turn(respond('report', 'ทีม Marketing ทำเสร็จแล้วค่ะ'))],
      'heads/marketing': [done('Plan ready.', respond('report', 'Plan ready.'))],
    });
    const t = await boot(db.pool, { provider });
    app = t.app;
    await t.app.services.scheduler.onMessage(humanMsg(`${mentionOf('praw')} ฝากทีม Marketing วางแผนเปิดตัวหน่อย`, { mentionedHeads: ['praw'] }));
    await t.app.services.scheduler.idle();

    const rows = (await db.pool.query('SELECT id, parent_id, depth, dept_id, owner, requester, status, origin, channel_id, thread_id, source_user_id FROM tasks ORDER BY depth')).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ depth: 0, dept_id: 'praw', owner: PRAW, requester: { kind: 'human', userId: '42' }, status: 'done', origin: 'chat', channel_id: SOFTWARE_WORK, source_user_id: '42' });
    expect(rows[1]).toMatchObject({ depth: 1, parent_id: rows[0].id, dept_id: 'marketing', owner: MKT, requester: PRAW, status: 'done', origin: 'delegated' });
    // F5: a top-level message to Praw makes no thread of its own: the conversation lives in the channel (thread id = channel id) and the answers reply to the message
    expect(t.port.threads.map((x) => [x.dept, x.channelId])).toEqual([['marketing', AI_WARROOM]]);
    expect(rows[0].thread_id).toBe(SOFTWARE_WORK);
    const inChannel = t.port.posts.filter((p) => p.target.channelId === SOFTWARE_WORK && !p.target.threadId && p.actor.kind === 'head' && p.actor.dept === 'praw');
    expect(inChannel.map((p) => p.payload.body)).toEqual(['ส่งต่อให้ทีม Marketing แล้วค่ะ', 'ทีม Marketing ทำเสร็จแล้วค่ะ']);
    expect(inChannel.at(-1)).toMatchObject({ payload: { type: 'report' } }); // (the test message id is not a snowflake, so no reply reference is stored)
    expect(provider.remaining()).toEqual({ 'heads/praw': 0, 'heads/marketing': 0 });
  });

  it('AC3 › CEO create_task dept praw → Praw owner runs in her work-channel thread and reports to hq\'s requester thread', async () => {
    await prepare(PRAW_WORK);
    const provider = new ActorProvider({
      'heads/hq': [create('praw', 'Ask Praw'), turn(respond('chat', 'Asked Praw.')), done('Praw finished.', respond('report', 'Final: Praw finished.'))],
      'heads/praw': [done('Done by Praw.', respond('report', 'Praw here: done.'))],
    });
    const t = await boot(db.pool, { provider });
    app = t.app;
    await t.app.services.scheduler.onMessage(humanMsg(`${mentionOf('hq')} please ask Praw`, { channelId: HQ_WORK, mentionedHeads: ['hq'] }));
    await t.app.services.scheduler.idle();

    const rows = (await db.pool.query('SELECT id, depth, dept_id, owner, requester, status, thread_id FROM tasks ORDER BY depth')).rows;
    expect(rows.map((r) => [r.dept_id, r.status])).toEqual([['hq', 'done'], ['praw', 'done']]);
    expect(rows[1]).toMatchObject({ owner: PRAW, requester: CEO });
    expect(t.port.threads.map((x) => [x.dept, x.channelId])).toEqual([['hq', HQ_WORK], ['praw', AI_WARROOM]]);
    const prawPost = t.port.posts.find((p) => p.actor.kind === 'head' && p.actor.dept === 'praw' && p.payload.type === 'report');
    expect(prawPost!.target).toEqual({ channelId: AI_WARROOM, threadId: rows[1].thread_id });
    expect(t.port.posts.find((p) => p.payload.title === 'Subtask done')).toMatchObject({ actor: CEO, target: { channelId: HQ_WORK, threadId: rows[0].thread_id } });
    expect(t.port.posts.filter((p) => p.target.threadId === rows[0].thread_id).at(-1)).toMatchObject({ actor: CEO, payload: { body: 'Final: Praw finished.' } });
  });

  it('AC3 › no praw work channel → create_task refused cleanly (R1)', async () => {
    await prepare(null);
    const provider = new ActorProvider({ 'heads/hq': [create('praw', 'Ask Praw'), turn(respond('chat', 'Cannot.'))] });
    const t = await boot(db.pool, { provider });
    app = t.app;
    await t.app.services.scheduler.onMessage(humanMsg(`${mentionOf('hq')} ask Praw`, { channelId: HQ_WORK, mentionedHeads: ['hq'] }));
    await t.app.services.scheduler.idle();
    expect((await db.pool.query("SELECT 1 FROM tasks WHERE dept_id = 'praw'")).rowCount).toBe(0);
    expect(textOf(provider.callsOf('heads/hq')[1]!)).toContain('praw has no work channel');
  });

  it('depth/children/budget/approval rules unchanged for praw chains (depth 3 stops)', async () => {
    await prepare(null);
    const provider = new ActorProvider({
      'heads/praw': [create('marketing'), turn(respond('chat', 'ok')), turn(respond('report', 'all done'))],
      'heads/marketing': [create('sales'), turn(respond('chat', 'ok')), done('m', respond('report', 'm done'))],
      'heads/sales': [create('hr'), turn(respond('chat', 'ok')), done('s', respond('report', 's done'))],
      'heads/hr': [create('finance'), done('h', respond('report', 'h done'))],
    });
    const t = await boot(db.pool, { provider });
    app = t.app;
    await t.app.services.scheduler.onMessage(humanMsg(`${mentionOf('praw')} chain it`, { mentionedHeads: ['praw'] }));
    await t.app.services.scheduler.idle();
    const rows = (await db.pool.query('SELECT depth, dept_id, status FROM tasks ORDER BY depth')).rows;
    expect(rows.map((r) => [r.depth, r.dept_id])).toEqual([[0, 'praw'], [1, 'marketing'], [2, 'sales'], [3, 'hr']]);
    expect(textOf(provider.callsOf('heads/hr')[1]!)).toContain('depth limit');
    expect(rows.map((r) => r.status)).toEqual(['done', 'done', 'done', 'done']);
  });

  it('recovery does not re-run a review conversation task', async () => {
    await prepare(null);
    const tasks = new TaskRepo(db.pool);
    const conv = await tasks.create({
      title: 'Wait', deptId: 'praw', owner: PRAW, requester: { kind: 'human', userId: '42' }, origin: 'chat', status: 'review', threadId: 'th-conv', channelId: SOFTWARE_WORK,
    });
    // an open child keeps it legitimately in review (a review task with nothing open is closed by the sweep, never re-run)
    await tasks.create({ title: 'Waiting child', deptId: 'marketing', owner: MKT, requester: PRAW, origin: 'delegated', parentId: conv.id, status: 'blocked' });
    const crashed = await tasks.create({
      title: 'Crashed', deptId: 'praw', owner: PRAW, requester: { kind: 'human', userId: '42' }, origin: 'chat', status: 'doing', threadId: 'th-crash', channelId: SOFTWARE_WORK,
    });
    const provider = new ActorProvider({ 'heads/praw': [turn(respond('chat', 'resumed'))] });
    const t = await boot(db.pool, { provider, port: new TestPort() });
    app = t.app;
    await t.app.services.scheduler.idle();
    expect((await tasks.get(conv.id))!.status).toBe('review');
    expect(provider.callsOf('heads/praw')).toHaveLength(1); // only the interrupted (doing -> todo) one runs
    expect((await tasks.get(crashed.id))!.threadId).toBe('th-crash');
  });
});

describe('stuck conversation tasks', () => {
  it('boot sweep closes a review conversation task with nothing open, without running anyone', async () => {
    await prepare(null);
    const tasks = new TaskRepo(db.pool);
    const conv = await tasks.create({ title: 'Stuck', deptId: 'praw', owner: PRAW, requester: { kind: 'human', userId: '42' }, origin: 'chat', status: 'review', threadId: 'th-s', channelId: SOFTWARE_WORK });
    const provider = new ActorProvider({ 'heads/praw': [] });
    app = (await boot(db.pool, { provider })).app;
    await app.services.scheduler.idle();
    expect((await tasks.get(conv.id))!.status).toBe('done');
    expect(provider.calls).toHaveLength(0);
  });
});

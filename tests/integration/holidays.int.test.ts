import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../../app.js';
import { seed } from '../../company/index.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo } from '../../db/repos/index.js';
import { JobRepo } from '../../db/repos/jobs.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { PROMPTS_DIR, loadPrompts } from '../../prompts/index.js';
import { ActorProvider, AI_WARROOM, CEO, CTO, HQ_WORK, SOFTWARE_WORK, boot, humanMsg, mentionOf, migrateUp, resetDb, respond, taskIdOf, turn } from './helpers.js';

// 09:00 Asia/Bangkok = 02:00Z. 2026-11-07 is a Saturday, 2026-11-08 a Sunday, 2026-11-09 a Monday.
const SAT_0900 = Date.parse('2026-11-07T02:00:00Z');
const SUN_1000 = Date.parse('2026-11-08T03:00:00Z');
const MON_0900 = Date.parse('2026-11-09T02:00:00Z');
const PRAW_WORK = '1565999999999999001';

let db: TestDb;
let app: App | null = null;
beforeAll(async () => { db = await freshDb(); });
afterEach(async () => { await app?.stop(); app = null; await resetDb(db.pool); await db.pool.query('TRUNCATE scheduled_jobs RESTART IDENTITY'); });
afterAll(async () => { await db.close(); });

const done = (summary: string, report: ReturnType<typeof respond>) => (req: Parameters<typeof taskIdOf>[0]) =>
  turn({ name: 'update_task', input: { taskId: taskIdOf(req), status: 'done', summary } }, report);

describe('off days (Saturday and Sunday by default)', () => {
  it('a scheduled job occurrence on an off day is skipped with an audit row; the next workday occurrence fires and runs', async () => {
    await migrateUp(db.pool);
    await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, loadPrompts(PROMPTS_DIR));
    await db.pool.query("UPDATE departments SET provider = 'claude', model = 'claude-sonnet-5-5', work_channel_id = $1 WHERE id = 'praw'", [PRAW_WORK]);
    const jobs = new JobRepo(db.pool);
    await jobs.add({ guildId: 'g', channelId: PRAW_WORK, userId: '42', prompt: 'Morning news', origin: 'schedule', kind: 'daily', hhmm: '09:00', tz: 'Asia/Bangkok', nextRunAt: new Date(SAT_0900) }, 'unlimited');
    let now = SAT_0900 + 30_000;
    const provider = new ActorProvider({ 'heads/praw': [turn(respond('report', 'Here is the news.'))] });
    const t = await boot(db.pool, { provider, now: () => now, offDays: [0, 6] });
    app = t.app;
    const fire = async () => { await t.app.services.jobRunner.tick(); await t.app.services.jobRunner.tick(); await t.app.services.scheduler.idle(); };

    await fire();
    expect((await db.pool.query('SELECT count(*)::int AS n FROM tasks')).rows[0].n).toBe(0);
    expect((await db.pool.query("SELECT tool, outcome FROM audit_log WHERE action = 'schedule.skip'")).rows).toEqual([{ tool: '1', outcome: 'off day' }]);
    expect((await jobs.get(1))!.nextRunAt.toISOString()).toBe('2026-11-08T02:00:00.000Z');

    now = MON_0900 + 30_000; // the Sunday occurrence is skipped late, then Monday's fires
    await fire();
    await fire();
    expect((await db.pool.query("SELECT count(*)::int AS n FROM audit_log WHERE action = 'schedule.skip' AND outcome = 'off day'")).rows[0].n).toBe(2);
    const tasks = (await db.pool.query('SELECT origin, status FROM tasks')).rows;
    expect(tasks).toEqual([{ origin: 'schedule', status: 'done' }]);
    expect(t.port.posts.some((p) => p.payload.body === 'Here is the news.')).toBe(true);
    expect((await jobs.get(1))!.nextRunAt.toISOString()).toBe('2026-11-10T02:00:00.000Z');
  });

  it('a human is answered on an off day; the delegated child waits (the model is told) and starts once the day turns', async () => {
    let now = SUN_1000;
    const provider = new ActorProvider({
      'heads/hq': [
        turn({ name: 'create_task', input: { title: 'Build the MVP', description: 'Plan the MVP.', assignee: { kind: 'head', dept: 'software' }, estCostUsd: 0.1 } }),
        turn(respond('chat', 'Delegated; the CTO starts on Monday.')),
        done('MVP planned.', respond('report', 'Final: MVP planned.')),
      ],
      'heads/software': [
        (req) => turn({ name: 'update_task', input: { taskId: taskIdOf(req), status: 'done', summary: 'Plan ready.' } }, respond('report', 'Plan ready.')),
      ],
    });
    const t = await boot(db.pool, { provider, now: () => now, offDays: [0, 6] });
    app = t.app;
    const { scheduler } = t.app.services;

    await scheduler.onMessage(humanMsg('<@100> Launch an MVP', { channelId: HQ_WORK, mentionedHeads: ['hq'] }));
    await scheduler.idle();
    expect(t.port.posts.some((p) => p.actor.kind === 'head' && p.actor.dept === 'hq' && p.payload.body === 'Delegated; the CTO starts on Monday.')).toBe(true);
    const toolResult = JSON.stringify(provider.callsOf('heads/hq')[1]!.messages);
    expect(toolResult).toContain('It will start on the next workday (today is a weekly off day).');
    let rows = (await db.pool.query('SELECT owner, origin, status FROM tasks ORDER BY depth')).rows;
    expect(rows).toEqual([{ owner: CEO, origin: 'slash', status: 'doing' }, { owner: CTO, origin: 'delegated', status: 'todo' }]);
    expect(provider.callsOf('heads/software')).toHaveLength(0);

    expect(t.app.services.healthUrl()).not.toBeNull();
    const health = await (await fetch(`${t.app.services.healthUrl()}/healthz`)).json();
    expect(health).toMatchObject({ offDay: true, offDayReason: 'weekday' });

    // a tick on the same off day releases nothing
    await t.app.services.offDayTick();
    await scheduler.idle();
    expect(provider.callsOf('heads/software')).toHaveLength(0);

    now = MON_0900;
    await t.app.services.offDayTick();
    await scheduler.idle();
    rows = (await db.pool.query('SELECT owner, status FROM tasks ORDER BY depth')).rows;
    expect(rows).toEqual([{ owner: CEO, status: 'done' }, { owner: CTO, status: 'done' }]);
    expect(provider.callsOf('heads/software')).toHaveLength(1);
    expect(t.port.posts.filter((p) => p.target.channelId === AI_WARROOM && p.payload.body === 'Plan ready.')).toHaveLength(1);
  });

  it('a calendar change applies at once: work held by a holiday added by mistake starts when it is removed', async () => {
    const provider = new ActorProvider({
      'heads/software': [(req) => turn({ name: 'update_task', input: { taskId: taskIdOf(req), status: 'done', summary: 'ok' } }, respond('report', 'Done.'))],
    });
    const t = await boot(db.pool, { provider, now: () => MON_0900, offDays: [0, 6] });
    app = t.app;
    const { cfg, scheduler, tasks } = t.app.services;
    await cfg.set('schedule.holidays', [{ date: '2026-11-09', name: 'Oops' }], 'test');
    const task = await tasks.create({ title: 'Later', deptId: 'software', owner: CTO, requester: CEO, origin: 'delegated' });
    await scheduler.onTaskCreated(task);
    await scheduler.idle();
    expect(provider.callsOf('heads/software')).toHaveLength(0);
    await cfg.set('schedule.holidays', [], 'test'); // no offDayTick: the config watch re-checks the day
    await vi.waitFor(async () => expect((await tasks.get(task.id))!.status).toBe('done'));
    expect(provider.callsOf('heads/software')).toHaveLength(1);
  });

  it('a restart on an off day keeps a Praw conversation in review; after a halt and the day turn, /resume rolls it up once', async () => {
    const PRAW = { kind: 'head', dept: 'praw' } as const;
    const provider = new ActorProvider({ 'heads/praw': [turn(respond('chat', 'Your plan is ready.'))] });
    let now = SUN_1000;
    const first = await boot(db.pool, { provider, now: () => now, offDays: [0, 6] });
    const { tasks } = first.app.services;
    const root = await tasks.create({ title: 'Chat', deptId: 'praw', owner: PRAW, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'th-c', channelId: PRAW_WORK, status: 'review' });
    const child = await tasks.create({ title: 'Plan', deptId: 'software', owner: CTO, requester: PRAW, origin: 'delegated', parentId: root.id, status: 'done' });
    await first.app.services.scheduler.onTaskChanged({ task: child, from: 'doing', to: 'done', summary: 'ok' });
    await first.app.services.scheduler.idle();
    await first.app.stop(); // restart: the held roll-up is gone
    await db.pool.query("UPDATE departments SET provider = 'claude', model = 'claude-sonnet-5-5' WHERE id = 'praw'"); // the fake provider answers as claude

    const t = await boot(db.pool, { provider, now: () => now, offDays: [0, 6] });
    app = t.app;
    expect((await tasks.get(root.id))!.status).toBe('review'); // boot recovery on the off day leaves it
    await t.app.services.halt.halt('test');
    now = MON_0900;
    await t.app.services.offDayTick();
    await t.app.services.scheduler.idle();
    expect(provider.callsOf('heads/praw')).toHaveLength(0);
    await t.app.services.halt.resume('test');
    await vi.waitFor(async () => expect((await tasks.get(root.id))!.status).toBe('done'));
    expect(provider.callsOf('heads/praw')).toHaveLength(1);
    expect(t.port.posts.some((p) => p.payload.body === 'Your plan is ready.')).toBe(true);
  });

  it('a human chat with a department head is answered on an off day', async () => {
    const provider = new ActorProvider({ 'heads/software': [turn(respond('chat', 'Hello, it is Sunday but I am here.'))] });
    const t = await boot(db.pool, { provider, now: () => SUN_1000, offDays: [0, 6] });
    app = t.app;
    await t.app.services.scheduler.onMessage(humanMsg(`${mentionOf('software')} are you there?`, { mentionedHeads: ['software'] }));
    await t.app.services.scheduler.idle();
    expect(t.port.posts.at(-1)).toMatchObject({ actor: CTO, payload: { body: 'Hello, it is Sunday but I am here.' } });
  });
});

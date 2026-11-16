import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../../db/migrate.js';
import { ClickUpSeenRepo } from '../../../db/repos/praw.js';
import { freshDb, type TestDb } from '../../../db/test-helpers.js';
import { NOW, rig, task } from './test-helpers.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');
const MIN = 60_000;
let db: TestDb, seen: ClickUpSeenRepo;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, dir, 'up'); seen = new ClickUpSeenRepo(db.pool); });
beforeEach(async () => { await db.pool.query('TRUNCATE clickup_seen'); });
afterAll(async () => { await db.close(); });

const alice = { id: 1, username: 'alice' };
const bodies = (r: ReturnType<typeof rig>) => r.port.posts.map((p) => p.payload.body);

describe('poller', () => {
  it('poller › new task notifies once; second tick same state silent', async () => {
    const r = rig({ tasks: [task({ id: 'old1', name: 'Existing' })] });
    const p = r.mk(seen);
    await p.tick(); // first run: silent baseline, existing tasks not announced
    expect(r.port.posts).toHaveLength(0);
    r.state.tasks = [task({ id: 'old1', name: 'Existing' }), task({ id: 'new1', name: 'Fresh task', assignees: [alice] })];
    r.advance(2 * MIN);
    await p.tick();
    expect(r.port.posts).toHaveLength(1);
    expect(bodies(r)[0]).toMatch(/new task/);
    expect(bodies(r)[0]).toContain('Fresh task');
    expect(bodies(r)[0]).toContain('https://app.clickup.com/t/new1');
    expect(r.port.posts[0]!.target).toEqual({ channelId: '1569000000000000001' });
    r.advance(2 * MIN);
    await p.tick();
    expect(r.port.posts).toHaveLength(1);
  });

  it('poller › status change and new comment notify once each', async () => {
    const r = rig({ tasks: [task({ id: 't1', assignees: [alice] })] });
    const p = r.mk(seen);
    await p.tick();
    r.advance(2 * MIN);
    r.state.tasks = [task({ id: 't1', assignees: [alice], status: { status: 'In Progress' }, date_updated: String(r.now()) })];
    r.state.comments = { t1: [
      { id: 'c-old', comment_text: 'before the baseline', date: String(NOW - 5 * MIN) },
      { id: 'c1', comment_text: 'looks good', user: { username: 'bob' }, date: String(NOW + MIN) },
    ] };
    await p.tick();
    expect(bodies(r)).toHaveLength(2);
    expect(bodies(r).some((b) => /status in progress/i.test(b))).toBe(true);
    expect(bodies(r).some((b) => /looks good/.test(b) && /bob/.test(b))).toBe(true);
    expect(bodies(r).join()).not.toContain('before the baseline');
    r.advance(2 * MIN);
    await p.tick();
    expect(r.port.posts).toHaveLength(2);
  });

  it('poller › restart (new poller instance, same DB) does not re-notify', async () => {
    const r = rig({ tasks: [task({ id: 't1' })] });
    await r.mk(seen).tick();
    r.state.tasks = [task({ id: 't1' }), task({ id: 't2', name: 'Two' })];
    r.advance(2 * MIN);
    await r.mk(seen).tick();
    expect(r.port.posts).toHaveLength(1);
    r.advance(2 * MIN);
    await r.mk(new ClickUpSeenRepo(db.pool)).tick(); // a new instance over the same table
    expect(r.port.posts).toHaveLength(1);
  });

  it('poller › caps comment inspection per tick and records it; unread tasks are read on the next tick', async () => {
    const r = rig({ tasks: [] });
    const p = r.mk(seen);
    await p.tick(); // baseline of an empty list
    r.state.tasks = Array.from({ length: 25 }, (_, i) => task({ id: `t${i}`, date_updated: String(NOW + MIN + i) }));
    await db.pool.query("INSERT INTO clickup_seen SELECT 't'||g, k, f, now() FROM generate_series(0,24) g, (VALUES ('created','1'),('status_changed','to do')) v(k,f)");
    r.advance(2 * MIN);
    await p.tick();
    expect(r.client.listComments).toHaveBeenCalledTimes(20);
    expect(r.audits.some((a) => a.action === 'clickup.poll.capped')).toBe(true);
    await p.tick();
    expect(r.client.listComments.mock.calls.length).toBeGreaterThan(20);
  });

  it('poller › a failed post is retried, not lost; prune drops old rows but keeps live-task state', async () => {
    const r = rig({ tasks: [] });
    const p = r.mk(seen);
    await p.tick();
    r.state.tasks = [task({ id: 'n1', name: 'N' })];
    r.port.failPost = new Error('boom');
    r.advance(2 * MIN);
    await p.tick();
    r.port.failPost = null;
    r.advance(2 * MIN);
    await p.tick();
    expect(r.port.posts).toHaveLength(1);
    await db.pool.query("INSERT INTO clickup_seen VALUES ('gone','created','1', now() - interval '40 days'), ('n1','comment','c9', now() - interval '40 days'), ('live','created','1', now() - interval '40 days')");
    expect(await seen.prune(new Date(Date.now() - 30 * 86_400_000), ['live'])).toBe(2);
    expect(await db.pool.query("SELECT 1 FROM clickup_seen WHERE task_id='live'")).toMatchObject({ rowCount: 1 });
    expect(await seen.baselineAt()).not.toBeNull();
  });

  it('poller › last tick persists in the DB and survives a new instance', async () => {
    const r = rig({ tasks: [task({ id: 't1' })] });
    await r.mk(seen).tick();
    r.advance(5 * MIN);
    await r.mk(seen).tick();
    expect(await new ClickUpSeenRepo(db.pool).lastTick()).toBe(r.now() - 60_000);
    await seen.saveTick(123);
    expect(await seen.lastTick()).toBe(123);
    expect(await seen.prune(new Date(Date.now() + MIN), [])).toBeGreaterThanOrEqual(0);
    expect(await seen.lastTick()).toBe(123); // prune keeps the tick and baseline rows
  });
});

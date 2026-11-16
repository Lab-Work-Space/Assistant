import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { DevJobRepo } from './devjobs.js';

let db: TestDb;
let repo: DevJobRepo;
const U1 = '1'.repeat(18);
const U2 = '2'.repeat(18);
beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'), 'up');
  repo = new DevJobRepo(db.pool);
});
afterAll(() => db.close());

describe('DevJobRepo', () => {
  it('creates, transitions only from the allowed state, and records facts', async () => {
    const j = await repo.create({ repo: 'Lab-Work-Space/Assistant', kind: 'assistant', requesterId: U1, channelId: null, request: 'add /poll' });
    expect(j).toMatchObject({ status: 'queued', tainted: true, spendUsd: 0 });
    expect(await repo.transition(j.id, ['coding'], 'testing')).toBe(false);
    expect(await repo.transition(j.id, ['queued'], 'planning')).toBe(true);
    expect(await repo.transition(j.id, ['planning'], 'ready', { baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), bundleSha256: 'c'.repeat(64), facts: { a: 1 }, report: 'log' })).toBe(true);
    expect(await repo.get(j.id)).toMatchObject({ status: 'ready', headSha: 'b'.repeat(40), facts: { a: 1 }, report: 'log' });
    expect((await repo.get(j.id))!.finishedAt).not.toBeNull();
  });
  it('claimNext honours the running cap and takes the oldest', async () => {
    await db.pool.query('DELETE FROM dev_jobs');
    const a = await repo.create({ repo: 'o/r', kind: 'assistant', requesterId: U1, channelId: null, request: 'a' });
    const b = await repo.create({ repo: 'o/r', kind: 'assistant', requesterId: U1, channelId: null, request: 'b' });
    expect((await repo.claimNext(1))?.id).toBe(a.id);
    expect(await repo.claimNext(1)).toBeNull();
    expect(await repo.runningCount()).toBe(1);
    await repo.transition(a.id, ['planning'], 'failed', { outcome: 'x' });
    expect((await repo.claimNext(1))?.id).toBe(b.id);
  });
  it('counts failed and refused jobs per day and per requester; spend adds up', async () => {
    await db.pool.query('DELETE FROM dev_jobs');
    await repo.create({ repo: 'o/r', kind: 'assistant', requesterId: U1, channelId: null, request: 'a', status: 'refused', outcome: 'no' });
    const j = await repo.create({ repo: 'o/r', kind: 'assistant', requesterId: U2, channelId: null, request: 'b' });
    const since = new Date(Date.now() - 3600_000);
    expect(await repo.countSince(since)).toBe(2);
    expect(await repo.countSince(since, U1)).toBe(1);
    expect(await repo.addSpend(j.id, 0.25)).toBeCloseTo(0.25);
    expect(await repo.addSpend(j.id, 0.5)).toBeCloseTo(0.75);
    expect(await repo.spendSince(since)).toBeCloseTo(0.75);
  });
  it('stores a bundle, caps its size in the database, fails running jobs after a crash, purges old ones', async () => {
    const j = await repo.create({ repo: 'o/r', kind: 'assistant', requesterId: U1, channelId: null, request: 'c' });
    await repo.putBundle(j.id, 'd'.repeat(64), Buffer.from('bundle'));
    expect(await repo.getBundle(j.id)).toMatchObject({ sha256: 'd'.repeat(64), size: 6 });
    await expect(db.pool.query(`UPDATE dev_job_bundles SET size = 20971521`)).rejects.toThrow();
    await repo.transition(j.id, ['queued'], 'coding');
    expect(await repo.failRunning('restart')).toBeGreaterThanOrEqual(1);
    expect((await repo.get(j.id))!.status).toBe('failed');
    await db.pool.query(`UPDATE dev_jobs SET created_at = now() - interval '40 days' WHERE id = $1`, [j.id]);
    expect(await repo.purge(30)).toBe(1);
    expect(await repo.getBundle(j.id)).toBeNull();
  });
  it('rejects a malformed job id or repo', async () => {
    await expect(db.pool.query(`INSERT INTO dev_jobs (id, repo, kind, requester_id, request) VALUES ('bad', 'o/r', 'assistant', '${U1}', 'x')`)).rejects.toThrow();
    await expect(db.pool.query(`INSERT INTO dev_jobs (id, repo, kind, requester_id, request) VALUES ('J-0123456789abcdef', '../x', 'assistant', '${U1}', 'x')`)).rejects.toThrow();
  });
});

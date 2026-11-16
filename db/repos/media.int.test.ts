import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { MediaJobRepo, MediaUsageRepo } from './media.js';

let db: TestDb;
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, dir, 'up'); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { await db.pool.query('DELETE FROM media_usage'); await db.pool.query('DELETE FROM media_jobs'); });

describe('RF30 durable daily counters under row lock', () => {
  const caps = { company: 20, person: 5 };
  it('per-person cap 1 video: 10 concurrent takes by one person let exactly one through', async () => {
    const u = new MediaUsageRepo(db.pool);
    const r = await Promise.all(Array.from({ length: 10 }, () => u.take('video', 'u:1', 1, { company: 2, person: 1 })));
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    expect(r.filter((x) => !x.ok && x.scope === 'person')).toHaveLength(9);
  });
  it('company cap 2 videos: 6 concurrent takes by 6 people let exactly two through; the rest are refused by the company scope', async () => {
    const u = new MediaUsageRepo(db.pool);
    const r = await Promise.all(Array.from({ length: 6 }, (_, i) => u.take('video', `u:${i}`, 1, { company: 2, person: 1 })));
    expect(r.filter((x) => x.ok)).toHaveLength(2);
    expect(r.filter((x) => !x.ok && x.scope === 'company')).toHaveLength(4);
  });
  it('counts images, not calls: 2+2 fits 5, a further 2 does not; a refused take adds nothing', async () => {
    const u = new MediaUsageRepo(db.pool);
    expect(await u.take('image', 'u:1', 2, caps)).toEqual({ ok: true });
    expect(await u.take('image', 'u:1', 2, caps)).toEqual({ ok: true });
    expect(await u.take('image', 'u:1', 2, caps)).toEqual({ ok: false, scope: 'person' });
    expect(await u.take('image', 'u:1', 1, caps)).toEqual({ ok: true });
    expect((await db.pool.query("SELECT used FROM media_usage WHERE scope='company' AND kind='image'")).rows[0].used).toBe(5);
  });
  it('giveBack returns the slots; days are separate; kinds are separate; a new repo instance still sees the count (durable)', async () => {
    let now = new Date('2026-11-05T10:00:00Z');
    const u = new MediaUsageRepo(db.pool, () => now);
    await u.take('video', 'u:1', 1, { company: 2, person: 1 });
    expect((await u.take('video', 'u:1', 1, { company: 2, person: 1 })).ok).toBe(false);
    expect((await new MediaUsageRepo(db.pool, () => now).take('video', 'u:1', 1, { company: 2, person: 1 })).ok).toBe(false); // "after a restart"
    expect((await u.take('image', 'u:1', 1, caps)).ok).toBe(true);
    await u.giveBack('video', 'u:1', 1);
    expect((await u.take('video', 'u:1', 1, { company: 2, person: 1 })).ok).toBe(true);
    now = new Date('2026-11-06T00:00:01Z');
    expect((await u.take('video', 'u:1', 1, { company: 2, person: 1 })).ok).toBe(true);
  });
});

describe('RF33 job rows', () => {
  const job = { opName: 'operations/a', requesterId: 'u1', actor: { kind: 'head', dept: 'marketing' } as const, channelId: 'c', threadId: null, taskId: null, reservedUsd: 4, seconds: 8, tainted: true };
  it('the post claim is a conditional update: one winner among concurrent callers; finish works only from the stated state', async () => {
    const repo = new MediaJobRepo(db.pool);
    const id = await repo.add(job);
    const wins = await Promise.all(Array.from({ length: 8 }, () => repo.claimPost(id)));
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect(await repo.finish(id, 'posted')).toBe(false); // it is in posting now, not running
    expect(await repo.finish(id, 'posted', 'posting')).toBe(true);
    expect(await repo.finish(id, 'failed', 'posting')).toBe(false);
    expect(await repo.open()).toHaveLength(0);
    const got = await repo.get(id);
    expect(got).toMatchObject({ opName: 'operations/a', tainted: true, reservedUsd: 4, status: 'posted', actor: { kind: 'head', dept: 'marketing' } });
  });
});

describe('migration 024 data: tools.byDept grants', () => {
  it('adds image/video grants only to marketing, rnd and praw (video: marketing, praw), idempotently, leaving others alone', async () => {
    const mig = (await import('node:fs')).readFileSync(join(dir, '024_media.up.sql'), 'utf8').split('-- Data only:')[1]!.replace(/^[^\n]*\n/, '');
    await db.pool.query("DELETE FROM config WHERE key='tools.byDept'");
    await db.pool.query(`INSERT INTO config (key, value) VALUES ('tools.byDept', $1::jsonb)`, [JSON.stringify({ marketing: ['web_search'], rnd: ['web_search'], praw: ['web_search'], finance: ['web_search'] })]);
    await db.pool.query(mig);
    await db.pool.query(mig);
    const v = (await db.pool.query("SELECT value FROM config WHERE key='tools.byDept'")).rows[0].value as Record<string, string[]>;
    expect(v.marketing!.sort()).toEqual(['image_generate', 'video_generate', 'web_search']);
    expect(v.praw!.sort()).toEqual(['image_generate', 'video_generate', 'web_search']);
    expect(v.rnd!.sort()).toEqual(['image_generate', 'web_search']);
    expect(v.finance).toEqual(['web_search']);
  });
  it('G2RF5-06: the down migration removes the two media tool names and keeps the rest', async () => {
    const down = (await import('node:fs')).readFileSync(join(dir, '024_media.down.sql'), 'utf8').split('\n').filter((l) => !/^DROP TABLE/.test(l)).join('\n');
    await db.pool.query("DELETE FROM config WHERE key='tools.byDept'");
    await db.pool.query(`INSERT INTO config (key, value) VALUES ('tools.byDept', $1::jsonb)`, [JSON.stringify({ marketing: ['web_search', 'image_generate', 'video_generate'], finance: ['web_search'] })]);
    await db.pool.query(down);
    expect((await db.pool.query("SELECT value FROM config WHERE key='tools.byDept'")).rows[0].value).toEqual({ marketing: ['web_search'], finance: ['web_search'] });
  });
});

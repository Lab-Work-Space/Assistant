import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { DashboardRepo, PanelStateRepo } from './dashboard.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
let db: TestDb;
let repo: DashboardRepo;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, dir, 'up'); repo = new DashboardRepo(db.pool); });
beforeEach(async () => { await db.pool.query('TRUNCATE dash_login_tokens, dash_sessions, panel_state'); });
afterAll(async () => { await db.close(); });

describe('DashboardRepo (S41, S43)', () => {
  it('two parallel consumes of one link give one winner; the second finds it used', async () => {
    await repo.issueLink('u1', 'h1');
    const r = await Promise.all([repo.consumeLink('h1'), repo.consumeLink('h1')]);
    expect(r.filter((x) => x === 'u1')).toHaveLength(1);
    expect(r.filter((x) => x === null)).toHaveLength(1);
  });

  it('an expired link and an unknown hash are refused', async () => {
    await repo.issueLink('u1', 'h1');
    await db.pool.query(`UPDATE dash_login_tokens SET expires_at = now() - interval '1 second'`);
    expect(await repo.consumeLink('h1')).toBeNull();
    expect(await repo.consumeLink('nope')).toBeNull();
  });

  it('a new link invalidates the admin earlier unused links, and 3 per 10 minutes is the cap', async () => {
    expect(await repo.issueLink('u1', 'a')).toEqual({ ok: true });
    expect(await repo.issueLink('u1', 'b')).toEqual({ ok: true });
    expect(await repo.consumeLink('a')).toBeNull();
    expect(await repo.issueLink('u1', 'c')).toEqual({ ok: true });
    expect(await repo.issueLink('u1', 'd')).toEqual({ ok: false, reason: 'rate' });
    expect(await repo.issueLink('u2', 'e')).toEqual({ ok: true }); // per admin
    expect(await repo.consumeLink('c')).toBe('u1');
  });

  it('sessions: idle 8 h and absolute 24 h expiry are enforced in SQL; revoke and revokeUser delete the rows', async () => {
    await repo.createSession('s1', 'u1');
    expect((await repo.touchSession('s1'))?.userId).toBe('u1');
    await db.pool.query(`UPDATE dash_sessions SET last_seen = now() - interval '9 hours'`);
    expect(await repo.touchSession('s1')).toBeNull();
    await repo.createSession('s2', 'u1');
    await db.pool.query(`UPDATE dash_sessions SET created_at = now() - interval '25 hours' WHERE sid_hash = 's2'`);
    expect(await repo.touchSession('s2')).toBeNull();
    await repo.createSession('s3', 'u1');
    await repo.createSession('s4', 'u2');
    expect(await repo.revokeUser('u1')).toBe(3);
    expect(await repo.touchSession('s3')).toBeNull();
    expect((await repo.touchSession('s4'))?.userId).toBe('u2');
    await repo.revokeSession('s4');
    expect(await repo.touchSession('s4')).toBeNull();
  });

  it('purge returns the number of expired sessions it deleted', async () => {
    await repo.createSession('a', 'u1');
    await repo.createSession('b', 'u1');
    await db.pool.query(`UPDATE dash_sessions SET last_seen = now() - interval '9 hours' WHERE sid_hash = 'a'`);
    expect(await repo.purge()).toBe(1);
    expect(await repo.purge()).toBe(0);
  });

  it('panel_state keeps exactly one message id', async () => {
    const p = new PanelStateRepo(db.pool);
    expect(await p.get()).toBeNull();
    await p.set('c', 'm1');
    await p.set('c', 'm2');
    expect((await p.get())?.messageId).toBe('m2');
  });
});

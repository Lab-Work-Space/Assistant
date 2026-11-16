import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { AdminCardRepo } from './adminCards.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
let db: TestDb;
let repo: AdminCardRepo;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, dir, 'up'); repo = new AdminCardRepo(db.pool); });
beforeEach(async () => { await db.pool.query('TRUNCATE admin_cards RESTART IDENTITY'); });
afterAll(async () => { await db.close(); });

const mk = async (proposerId = 'u1', msg = 'm1') => {
  const { card, superseded } = await repo.create({ proposerId, kind: 'config', payload: { changes: [] }, snapshot: {}, tainted: false, channelId: 'c' });
  await repo.setMessage(card.id, msg);
  return { card, superseded };
};

describe('AdminCardRepo (C6)', () => {
  it('ids are opaque 128-bit hex and unique', async () => {
    const a = (await mk()).card.id;
    const b = (await mk('u2', 'm2')).card.id;
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('two parallel confirms yield exactly one winner', async () => {
    const { card } = await mk();
    const r = await Promise.all([repo.consume(card.id, 'confirmed', 'u1', 'm1'), repo.consume(card.id, 'confirmed', 'u1', 'm1')]);
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    expect(r.find((x) => !x.ok)).toEqual({ ok: false, reason: 'not_pending' });
  });

  it('a confirm after expiry is refused, also after a "restart" (a fresh repo over the same rows)', async () => {
    const { card } = await mk();
    await db.pool.query(`UPDATE admin_cards SET expires_at = now() - interval '1 second' WHERE id = $1`, [card.id]);
    expect(await new AdminCardRepo(db.pool).consume(card.id, 'confirmed', 'u1', 'm1')).toEqual({ ok: false, reason: 'expired' });
    expect((await repo.expireOverdue()).map((c) => c.id)).toEqual([card.id]);
    expect(await repo.expireOverdue()).toEqual([]);
    expect((await repo.get(card.id))!.status).toBe('expired');
  });

  it('another user, another message and a superseded card are refused', async () => {
    const first = (await mk('u1', 'm1')).card;
    expect(await repo.consume(first.id, 'confirmed', 'u2', 'm1')).toEqual({ ok: false, reason: 'not_proposer' });
    expect(await repo.consume(first.id, 'confirmed', 'u1', 'other')).toEqual({ ok: false, reason: 'wrong_message' });
    const second = await mk('u1', 'm2');
    expect(second.superseded.map((c) => c.id)).toEqual([first.id]);
    expect(await repo.consume(first.id, 'confirmed', 'u1', 'm1')).toEqual({ ok: false, reason: 'superseded' });
    expect((await repo.consume(second.card.id, 'confirmed', 'u1', 'm2')).ok).toBe(true);
  });

  it('only the newest pending card of a proposer is confirmable even if an older one was never superseded explicitly', async () => {
    const a = (await mk('u1', 'm1')).card;
    await db.pool.query(`UPDATE admin_cards SET status = 'pending' WHERE id = $1`, [a.id]);
    await mk('u1', 'm2');
    await db.pool.query(`UPDATE admin_cards SET status = 'pending' WHERE id = $1`, [a.id]); // forced back: the newer one still blocks it
    expect(await repo.consume(a.id, 'confirmed', 'u1', 'm1')).toEqual({ ok: false, reason: 'superseded' });
  });

  it('a card without a posted message cannot be consumed', async () => {
    const { card } = await repo.create({ proposerId: 'u1', kind: 'perm', payload: {}, snapshot: {}, tainted: true, channelId: 'c' });
    expect((await repo.consume(card.id, 'cancelled', 'u1', null)).ok).toBe(false);
  });

  it('unknown id', async () => {
    expect(await repo.consume('0'.repeat(32), 'confirmed', 'u1', 'm')).toEqual({ ok: false, reason: 'not_found' });
  });
});

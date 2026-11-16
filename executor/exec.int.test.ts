import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AdminCardRepo } from '../db/repos/adminCards.js';
import { ExecRepo } from '../db/repos/exec.js';
import { AuditRepo } from '../db/repos/ledger.js';
import { migrate } from '../db/migrate.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { createAudit } from '../governance/audit.js';
import { fakeServerWorld, fakeServerWriter, NOW, S, serverConsts, serverData } from '../discord/server/server-fixture.js';
import { C, U, fakeWriter } from '../discord/test-helpers.js';
import { createRateGate, RATE, TIER_RATE } from './rate.js';
import { ExecutorService } from './service.js';
import { NO_TIERS, readTierConfig } from './tiers.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
let db: TestDb;
let cards: AdminCardRepo;
let exec: ExecRepo;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, dir, 'up'); cards = new AdminCardRepo(db.pool); exec = new ExecRepo(db.pool); });
beforeEach(async () => { await db.pool.query('TRUNCATE admin_cards, audit_log, exec_state, exec_outbox, welcome_seen, server_archives RESTART IDENTITY'); });
afterAll(async () => { await db.close(); });

async function confirmed(o: { proposer?: string; decider?: string; kind?: 'perm' | 'server' | 'config'; payload?: unknown; via?: 'praw' | 'panel' | 'dashboard'; ageSec?: number } = {}) {
  const proposer = o.proposer ?? U.admin;
  const { card } = await cards.create({ proposerId: proposer, kind: o.kind ?? 'server', payload: o.payload ?? { ops: [{ kind: 'welcome.resume' }], named: [] }, snapshot: { snaps: [{}] }, tainted: false, channelId: C.setting, via: o.via ?? 'praw' });
  await cards.setMessage(card.id, 'm1');
  const got = await cards.consume(card.id, 'confirmed', o.decider ?? proposer, 'm1');
  if (!got.ok) throw new Error(got.reason);
  if (o.ageSec) await db.pool.query(`UPDATE admin_cards SET decided_at = now() - $2 * interval '1 second' WHERE id = $1`, [card.id, o.ageSec]);
  return card;
}
const audit = (actor: string, action: string, outcome = 'ok x') => db.pool.query('INSERT INTO audit_log (actor, action, outcome) VALUES ($1,$2,$3)', [actor, action, outcome]);

describe('claimForExecution (S2, S46)', () => {
  it('a confirmed card is claimed exactly once, even by two parallel applies', async () => {
    const c = await confirmed();
    const r = await Promise.all([cards.claimForExecution(c.id), cards.claimForExecution(c.id), cards.claimForExecution(c.id)]);
    expect(r.filter(Boolean)).toHaveLength(1);
    expect(r.find(Boolean)).toMatchObject({ id: c.id, kind: 'server', decidedBy: U.admin, via: 'praw' });
    expect(await cards.claimForExecution(c.id)).toBeNull();
  });
  it('pending, cancelled, config-kind, foreign-decided and stale (> 2 minutes) cards are never claimed', async () => {
    const { card: pending } = await cards.create({ proposerId: 'u9', kind: 'server', payload: {}, snapshot: {}, tainted: false, channelId: 'c' });
    expect(await cards.claimForExecution(pending.id)).toBeNull();
    expect(await cards.claimForExecution((await confirmed({ kind: 'config', proposer: 'u2' })).id)).toBeNull();
    const stale = await confirmed({ proposer: 'u3', ageSec: 130 });
    expect(await cards.claimForExecution(stale.id)).toBeNull();
    const other = await confirmed({ proposer: 'u4' });
    await db.pool.query(`UPDATE admin_cards SET decided_by = 'someone-else' WHERE id = $1`, [other.id]);
    expect(await cards.claimForExecution(other.id)).toBeNull();
    expect(await cards.claimForExecution('f'.repeat(32))).toBeNull();
  });
});

describe('the executor against a real database (S1, S30)', () => {
  const build = (data = serverData()) => {
    const writer = fakeServerWriter();
    const svc = new ExecutorService({
      world: fakeServerWorld(data), permWriter: fakeWriter(), serverWriter: writer, cards, exec, rate: createRateGate(db.pool), consts: () => serverConsts(),
      recheck: async () => [], disabled: () => null, welcomeRoleIds: async () => [], tiers: async () => NO_TIERS, audit: createAudit(new AuditRepo(db.pool)), log: { error() {} }, now: () => NOW,
    });
    return { svc, writer };
  };

  it('a forged confirmed row that breaks a hard limit is refused at apply and audited; the card is spent', async () => {
    const forged = await confirmed({ payload: { ops: [{ kind: 'channel.delete', channel: C.setting }], named: [] } });
    const x = build();
    expect(await x.svc.apply(forged.id)).toMatchObject({ kind: 'refused' });
    expect(x.writer.calls).toEqual([]);
    expect((await db.pool.query(`SELECT outcome FROM audit_log WHERE action = 'admin.exec'`)).rows[0]!.outcome).toContain('refused card:');
    expect(await x.svc.apply(forged.id)).toMatchObject({ kind: 'refused', why: expect.stringContaining('not a confirmed, unused card') });
  });

  it('two parallel applies of one valid card run it once', async () => {
    const x0 = build();
    const p = await x0.svc.propose('server', [{ kind: 'channel.edit', channel: S.plain, topic: 'once' }], { userId: U.admin, namedIds: [] });
    if (!p.ok) throw new Error(p.error);
    const c = await confirmed({ payload: p.payload });
    await db.pool.query('UPDATE admin_cards SET snapshot = $2::jsonb WHERE id = $1', [c.id, JSON.stringify(p.snapshot)]);
    const x = build();
    const r = await Promise.all([x.svc.apply(c.id), x.svc.apply(c.id)]);
    expect(r.filter((v) => v.kind === 'done')).toHaveLength(1);
    expect(x.writer.calls).toHaveLength(1);
    expect((await db.pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'server.channel.edit'`)).rows[0]!.n).toBe(1);
  });

  it('S30: the eleventh destructive op in an hour is refused, also with a brand-new gate (a restart)', async () => {
    for (let i = 0; i < 10; i++) await audit(`user:${U.admin} via praw`, 'server.member.ban');
    const fresh = createRateGate(db.pool);
    expect(await fresh.check(U.admin, 1, 1)).toMatch(/destructive operations/);
    expect(await fresh.check(U.admin, 1, 0)).toBeNull(); // a harmless op still fits
    const x = build();
    const r = await x.svc.propose('server', [{ kind: 'member.ban', member: U.alice }], { userId: U.admin, namedIds: [U.alice] });
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('destructive') });
  });

  it('S30: 20 per admin and 40 globally per 10 minutes; failures, refusals and old rows do not count', async () => {
    for (let i = 0; i < 19; i++) await audit(`user:${U.admin} via praw`, 'server.channel.edit');
    await audit(`user:${U.admin} via praw`, 'server.channel.edit', 'failed Discord error 50013');
    await audit(`user:${U.admin} via praw`, 'admin.exec', 'refused card:x');
    const gate = createRateGate(db.pool);
    expect(await gate.check(U.admin, 1, 0)).toBeNull();
    expect(await gate.check(U.admin, 2, 0)).toMatch(/per admin per 10 minutes/);
    await db.pool.query(`UPDATE audit_log SET ts = now() - interval '11 minutes' WHERE id <= 5`);
    expect(await gate.check(U.admin, 5, 0)).toBeNull();
    for (let i = 0; i < 30; i++) await audit(`user:${U.alice} via panel`, 'perm.role.assign');
    expect(await gate.check(U.bob, 1, 0)).toMatch(/in 10 minutes in total|per admin/);
    expect(RATE).toEqual({ perAdmin10m: 20, global10m: 40, destructiveHour: 10 });
  });
});

describe('delegated tiers: rate limits per tier bucket (T19)', () => {
  it('10 Moderator bulk deletes in an hour do not block a Bot Admin ban; the Moderator bucket (5 per hour) and per-user caps (10 / 20) hold', async () => {
    for (let i = 0; i < 10; i++) await audit(`user:mod${i % 5} via praw tier:moderator`, 'server.msg.bulk');
    const gate = createRateGate(db.pool);
    expect(await gate.check(U.admin, 1, 1, 'bot_admin')).toBeNull();
    expect(await gate.check(U.admin, 1, 1)).toBeNull(); // the default is the Bot Admin bucket
    expect(await gate.check(U.alice, 1, 1, 'moderator')).toMatch(/at most 5 destructive operations .* a moderator/);
    expect(await gate.check(U.bob, 1, 1, 'moderator')).toMatch(/destructive/); // the bucket is shared by every Moderator
    expect(await gate.check(U.bob, 1, 1, 'manager')).toBeNull(); // a Manager has its own bucket
    expect(TIER_RATE.moderator).toEqual({ perUser10m: 10, destructiveHour: 5 });
    expect(TIER_RATE.manager).toEqual({ perUser10m: 20, destructiveHour: 10 });
    expect(await gate.check('mod0', 9, 0, 'moderator')).toMatch(/per moderator per 10 minutes/); // 2 applied by this user + 9 > 10
  });
  it('a Moderator cannot inflate the Bot Admin bucket or hide in it with text in the outcome: only the anchored actor suffix decides the bucket', async () => {
    await audit(`user:${U.alice} via praw tier:moderator`, 'server.msg.bulk', 'ok card:x tier:bot_admin reason "tier:bot_admin"');
    for (let i = 0; i < 9; i++) await audit(`user:${U.admin} via praw tier:bot_admin`, 'server.member.ban');
    const gate = createRateGate(db.pool);
    expect(await gate.check(U.admin, 1, 1, 'bot_admin')).toBeNull(); // 9 + 1 = 10: the Moderator row is not in this bucket
    expect(await gate.check(U.admin, 1, 2, 'bot_admin')).toMatch(/destructive/);
  });
  it('the global ceiling of 40 per 10 minutes still holds across the tiers', async () => {
    for (let i = 0; i < 20; i++) await audit(`user:${U.alice} via praw tier:manager`, 'server.channel.edit');
    for (let i = 0; i < 20; i++) await audit(`user:${U.bob} via praw tier:manager`, 'server.channel.edit');
    expect(await createRateGate(db.pool).check(U.admin, 1, 0, 'bot_admin')).toMatch(/in total/);
  });
  it('readTierConfig reads the executor\'s own config rows; a missing or invalid value is null (that tier is off)', async () => {
    await db.pool.query('DELETE FROM config');
    expect(await readTierConfig(db.pool)).toEqual(NO_TIERS);
    await db.pool.query(`INSERT INTO config (key, value, updated_by) VALUES ('roles.managerId', '"700000000000000060"', 't'), ('roles.moderatorId', '"not-an-id"', 't'), ('roles.modRoomId', '"700000000000000070"', 't')`);
    expect(await readTierConfig(db.pool)).toEqual({ managerId: '700000000000000060', moderatorId: null, modRoomId: '700000000000000070' });
  });
});

describe('ExecRepo (S11, S13, S16, S33)', () => {
  it('firstWelcome: one welcome per user per 24 h, atomically', async () => {
    const r = await Promise.all([exec.firstWelcome('u1'), exec.firstWelcome('u1')]);
    expect(r.filter(Boolean)).toHaveLength(1);
    expect(await exec.firstWelcome('u1')).toBe(false);
    await db.pool.query(`UPDATE welcome_seen SET at = now() - interval '25 hours'`);
    expect(await exec.firstWelcome('u1')).toBe(true);
  });
  it('state survives a "restart" (a new repo over the same rows) and is cleared only explicitly', async () => {
    await exec.setState('welcome.paused', { since: 'x' });
    expect(await new ExecRepo(db.pool).getState('welcome.paused')).toEqual({ since: 'x' });
    expect(await exec.clearState('welcome.paused')).toBe(true);
    expect(await exec.getState('welcome.paused')).toBeNull();
  });
  it('outbox: rows come out in order and are marked done by one caller only', async () => {
    await exec.push('alert', { text: 'a' });
    await exec.push('summary', { text: 'b' });
    const rows = await exec.pending();
    expect(rows.map((r) => r.kind)).toEqual(['alert', 'summary']);
    expect((await Promise.all([exec.markDone(rows[0]!.id), exec.markDone(rows[0]!.id)])).filter(Boolean)).toHaveLength(1);
    expect((await exec.pending()).map((r) => r.kind)).toEqual(['summary']);
  });
  it('archive record: written by the executor, readable by the world', async () => {
    await exec.recordArchive('c1', U.admin);
    expect((await db.pool.query('SELECT archived_by FROM server_archives WHERE channel_id = $1', ['c1'])).rows[0]).toEqual({ archived_by: U.admin });
  });
  it('S33: the purge removes only expired member-id rows (welcome, member, message, role audit rows older than 90 days)', async () => {
    const old = (action: string) => db.pool.query(`INSERT INTO audit_log (ts, actor, action, outcome) VALUES (now() - interval '91 days', 'a', $1, 'ok')`, [action]);
    for (const a of ['welcome.role', 'server.member.ban', 'server.msg.bulk', 'perm.role.assign', 'server.channel.edit', 'config.set', 'admin.propose']) await old(a);
    // G2SM-08: refusal rows quote member ids; successes of admin.card/admin.propose are not member rows and stay
    await db.pool.query(`INSERT INTO audit_log (ts, actor, action, outcome) VALUES (now() - interval '91 days', 'a', 'admin.exec', 'refused card:x target 1'), (now() - interval '91 days', 'a', 'admin.card', 'refused card:x ...'), (now() - interval '91 days', 'a', 'admin.card', 'applied card:x'), (now() - interval '91 days', 'a', 'admin.propose', 'refused: x'), (now() - interval '10 days', 'a', 'admin.exec', 'refused card:y')`);
    await audit('a', 'welcome.role'); // recent: kept
    const r = await exec.purge();
    expect(r.audit).toBe(7);
    const left = (await db.pool.query<{ action: string }>('SELECT action FROM audit_log ORDER BY id')).rows.map((x) => x.action);
    expect(left).toEqual(['server.channel.edit', 'config.set', 'admin.propose', 'admin.card', 'admin.exec', 'welcome.role']);
  });
});

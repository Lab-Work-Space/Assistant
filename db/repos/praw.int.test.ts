import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { CapError } from './praw.js';
import { ReminderRepo } from './reminders.js';
import { JobRepo, nextDaily } from './jobs.js';
import { WatchRepo } from './watches.js';
import { LessonRepo } from './lessons.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
let db: TestDb;
let reminders: ReminderRepo, jobs: JobRepo, watches: WatchRepo, lessons: LessonRepo;
beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, dir, 'up');
  reminders = new ReminderRepo(db.pool); jobs = new JobRepo(db.pool); watches = new WatchRepo(db.pool); lessons = new LessonRepo(db.pool);
});
beforeEach(async () => { await db.pool.query('TRUNCATE reminders, scheduled_jobs, watches, lessons RESTART IDENTITY'); });
afterAll(async () => { await db.close(); });

const loc = { guildId: 'g', channelId: 'c' };
const past = new Date(Date.now() - 60_000);
const mkReminder = (userId = 'u1', over: Record<string, unknown> = {}) => ({ ...loc, userId, text: 'r', remindAt: past, ...over });
const mkJob = (userId = 'u1', over: Record<string, unknown> = {}) => ({ ...loc, userId, prompt: 'p', origin: 'schedule' as const, kind: 'interval' as const, intervalMinutes: 15, nextRunAt: past, ...over });
const mkWatch = (userId = 'u1', over: Record<string, unknown> = {}) => ({ ...loc, userId, kind: 'url' as const, target: 'https://example.com', intervalMinutes: 15, ...over });
const tables = ['reminders', 'scheduled_jobs', 'watches', 'lessons'];

describe('praw.int', () => {
  it('migration up/down', async () => {
    const names = async () => (await db.pool.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ANY($1) ORDER BY 1", [tables])).rows.map((r) => r.table_name);
    expect(await names()).toEqual(['lessons', 'reminders', 'scheduled_jobs', 'watches']);
    expect(await migrate(db.pool, dir, 'down')).toContain('008_praw_m2');
    expect(await names()).toEqual([]);
    expect(await migrate(db.pool, dir, 'up')).toContain('008_praw_m2');
    expect(await names()).toHaveLength(4);
  });
});

describe('reminders', () => {
  it('claimDue returns a row once even with two concurrent callers', async () => {
    await reminders.add(mkReminder(), 'unlimited');
    const rs = await Promise.all([reminders.claimDue(new Date(), 10), reminders.claimDue(new Date(), 10), reminders.claimDue(new Date(), 10)]);
    expect(rs.flat()).toHaveLength(1);
    expect(await reminders.claimDue(new Date(), 10)).toEqual([]);
  });
  it('recurring claim advances remind_at past now; concurrent callers still get one', async () => {
    const r = await reminders.add(mkReminder('u1', { everyMinutes: 10, remindAt: new Date(Date.now() - 35 * 60_000) }), 'unlimited');
    const rs = await Promise.all([reminders.claimDue(new Date(), 10), reminders.claimDue(new Date(), 10)]);
    expect(rs.flat()).toHaveLength(1);
    const after = (await reminders.list('u1'))[0]!;
    expect(after.id).toBe(r!.id);
    expect(after.remindAt.getTime()).toBeGreaterThan(Date.now());
    expect(after.remindAt.getTime()).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
    expect(await reminders.claimDue(new Date(), 10)).toEqual([]);
  });
  it('future, cancelled and fired rows are not claimed; limit respected', async () => {
    await reminders.add(mkReminder('u1', { remindAt: new Date(Date.now() + 3_600_000) }), 'unlimited');
    const c = await reminders.add(mkReminder('u1'), 'unlimited');
    await reminders.cancel(c!.id, 'u1');
    await reminders.add(mkReminder('u2'), 'unlimited'); await reminders.add(mkReminder('u2'), 'unlimited');
    expect(await reminders.claimDue(new Date(), 1)).toHaveLength(1);
    expect(await reminders.claimDue(new Date(), 10)).toHaveLength(1);
  });
  it('markFired stamps fired_at', async () => {
    await reminders.add(mkReminder(), 'unlimited');
    const [c] = await reminders.claimDue(new Date(), 1);
    await reminders.markFired(c!.id);
    const row = (await db.pool.query('SELECT fired_at FROM reminders WHERE id=$1', [c!.id])).rows[0];
    expect(row.fired_at).not.toBeNull();
  });
  it('cancel only by owner; list/cancel scoped to userId (P14)', async () => {
    const r = (await reminders.add(mkReminder('u1'), 'unlimited'))!;
    expect(await reminders.cancel(r.id, 'u2')).toBe(false);
    expect(await reminders.list('u2')).toEqual([]);
    expect(await reminders.list('u1')).toHaveLength(1);
    expect(await reminders.cancel(r.id, 'u1')).toBe(true);
    expect(await reminders.list('u1')).toEqual([]);
    expect(await reminders.claimDue(new Date(), 5)).toEqual([]);
  });
  it('21st reminder refused (per-user cap 20); company cap refused; other user unaffected', async () => {
    const caps = { perUser: 20, total: 500 };
    for (let i = 0; i < 20; i++) await reminders.add(mkReminder('u1'), caps);
    await expect(reminders.add(mkReminder('u1'), caps)).rejects.toMatchObject({ name: 'CapError', scope: 'user' });
    await expect(reminders.add(mkReminder('u1'), caps)).rejects.toBeInstanceOf(CapError);
    expect(await reminders.add(mkReminder('u2'), caps)).not.toBeNull();
    await expect(reminders.add(mkReminder('u3'), { perUser: 20, total: 21 })).rejects.toMatchObject({ scope: 'total' });
  });
  it('concurrent adds cannot both pass the boundary', async () => {
    const rs = await Promise.allSettled(Array.from({ length: 8 }, () => reminders.add(mkReminder('u1'), { perUser: 3, total: 500 })));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(3);
    expect((await reminders.list('u1')).length).toBe(3);
  });
  it('legacy_id unique: second insert of same legacy id is a no-op', async () => {
    expect(await reminders.add(mkReminder('u1', { legacyId: 7 }), 'unlimited')).not.toBeNull();
    expect(await reminders.add(mkReminder('u1', { legacyId: 7 }), 'unlimited')).toBeNull();
    expect(await reminders.list('u1')).toHaveLength(1);
  });
  it('rejects every_minutes < 1 and bad notify_via by CHECK', async () => {
    await expect(reminders.add(mkReminder('u1', { everyMinutes: 0 }), 'unlimited')).rejects.toThrow(/check/i);
    await expect(reminders.add(mkReminder('u1', { notifyVia: 'sms' }), 'unlimited')).rejects.toThrow(/check/i);
  });
});

describe('reminder advance notice (R9)', () => {
  const soon = (min: number) => new Date(Date.now() + min * 60_000);
  it('fires once per occurrence, even with concurrent claimers', async () => {
    await reminders.add(mkReminder('u1', { remindAt: soon(5), advanceMinutes: 10 }), 'unlimited');
    await reminders.add(mkReminder('u1', { remindAt: soon(60), advanceMinutes: 10 }), 'unlimited');
    await reminders.add(mkReminder('u1', { remindAt: soon(5) }), 'unlimited');
    const rs = await Promise.all([reminders.claimAdvanceDue(new Date(), 10), reminders.claimAdvanceDue(new Date(), 10)]);
    expect(rs.flat()).toHaveLength(1);
    expect(await reminders.claimAdvanceDue(new Date(), 10)).toEqual([]);
  });
  it('recurring gets a new advance per occurrence', async () => {
    const r = (await reminders.add(mkReminder('u1', { remindAt: soon(5), everyMinutes: 60, advanceMinutes: 10 }), 'unlimited'))!;
    expect(await reminders.claimAdvanceDue(new Date(), 10)).toHaveLength(1);
    await reminders.claimDue(soon(6), 10); // main fire moves remind_at to the next slot
    expect(await reminders.claimAdvanceDue(soon(6), 10)).toEqual([]); // next occurrence still > 10 min away
    expect(await reminders.claimAdvanceDue(soon(56), 10)).toHaveLength(1);
    expect(r.id).toBeGreaterThan(0);
  });
  it('cancelled and fired rows get no advance', async () => {
    const c = (await reminders.add(mkReminder('u1', { remindAt: soon(5), advanceMinutes: 10 }), 'unlimited'))!;
    await reminders.cancel(c.id, 'u1');
    expect(await reminders.claimAdvanceDue(new Date(), 10)).toEqual([]);
  });
});

describe('scheduled jobs', () => {
  it('claimDue advances next_run_at atomically; one winner among concurrent callers', async () => {
    await jobs.add(mkJob(), 'unlimited');
    const rs = await Promise.all([jobs.claimDue(new Date(), 5), jobs.claimDue(new Date(), 5), jobs.claimDue(new Date(), 5)]);
    expect(rs.flat()).toHaveLength(1);
    const [j] = await jobs.list('u1');
    expect(j!.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(await jobs.claimDue(new Date(), 5)).toEqual([]);
  });
  it('once job needs no hhmm; daily needs tz (CHECK)', async () => {
    await expect(jobs.add(mkJob('u1', { kind: 'daily', intervalMinutes: null, hhmm: '09:00' }), 'unlimited')).rejects.toThrow(/check/i);
    expect(await jobs.add(mkJob('u1', { kind: 'daily', intervalMinutes: null, hhmm: '09:00', tz: 'UTC' }), 'unlimited')).not.toBeNull();
  });
  it('once job is deactivated when claimed', async () => {
    await jobs.add(mkJob('u1', { kind: 'once', intervalMinutes: null }), 'unlimited');
    expect(await jobs.claimDue(new Date(), 5)).toHaveLength(1);
    expect((await jobs.list('u1'))).toEqual([]);
    expect(await jobs.claimDue(new Date(), 5)).toEqual([]);
  });
  it('daily job reschedules to the next local hh:mm', async () => {
    const after = new Date('2026-11-01T10:00:00Z');
    expect(nextDaily('09:00', 'UTC', after).toISOString()).toBe('2026-11-02T09:00:00.000Z');
    expect(nextDaily('11:30', 'Asia/Bangkok', after).toISOString()).toBe('2026-11-02T04:30:00.000Z');
    expect(nextDaily('20:00', 'Asia/Bangkok', after).toISOString()).toBe('2026-11-01T13:00:00.000Z');
  });
  it('interval < 15 rejected by CHECK; bad origin rejected', async () => {
    await expect(jobs.add(mkJob('u1', { intervalMinutes: 14 }), 'unlimited')).rejects.toThrow(/check/i);
    await expect(jobs.add(mkJob('u1', { origin: 'chat' }), 'unlimited')).rejects.toThrow(/check/i);
  });
  it('remove scoped to owner; list scoped', async () => {
    const j = (await jobs.add(mkJob('u1'), 'unlimited'))!;
    expect(await jobs.remove(j.id, 'u2')).toBe(false);
    expect(await jobs.list('u2')).toEqual([]);
    expect(await jobs.remove(j.id, 'u1')).toBe(true);
  });
  it('6th refused (per-user 5); company cap refused; legacy no-op', async () => {
    const caps = { perUser: 5, total: 50 };
    for (let i = 0; i < 5; i++) await jobs.add(mkJob('u1'), caps);
    await expect(jobs.add(mkJob('u1'), caps)).rejects.toMatchObject({ scope: 'user' });
    await expect(jobs.add(mkJob('u2'), { perUser: 5, total: 5 })).rejects.toMatchObject({ scope: 'total' });
    expect(await jobs.add(mkJob('u3', { legacyId: 1 }), 'unlimited')).not.toBeNull();
    expect(await jobs.add(mkJob('u3', { legacyId: 1 }), 'unlimited')).toBeNull();
  });
  it('concurrent adds cannot both pass the boundary', async () => {
    const rs = await Promise.allSettled(Array.from({ length: 8 }, () => jobs.add(mkJob('u1'), { perUser: 2, total: 50 })));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
  });
});

describe('watches', () => {
  it('interval <15 rejected by CHECK', async () => {
    await expect(watches.add(mkWatch('u1', { intervalMinutes: 14 }), 'unlimited')).rejects.toThrow(/check/i);
  });
  it('snapshot >6000 rejected', async () => {
    const w = (await watches.add(mkWatch(), 'unlimited'))!;
    await expect(watches.saveSnapshot(w.id, { snapshot: 'x'.repeat(6001) })).rejects.toThrow(/check/i);
    await watches.saveSnapshot(w.id, { snapshot: 'x'.repeat(6000), hrefs: ['a'] });
    const row = (await db.pool.query('SELECT has_baseline, last_hrefs, fail_count FROM watches')).rows[0];
    expect(row).toEqual({ has_baseline: true, last_hrefs: ['a'], fail_count: 0 });
  });
  it('claimDue advances next_check_at once among concurrent callers; disabled skipped', async () => {
    await watches.add(mkWatch('u1', { nextCheckAt: past }), 'unlimited');
    const off = (await watches.add(mkWatch('u1', { nextCheckAt: past }), 'unlimited'))!;
    await watches.remove(off.id, 'u1');
    const rs = await Promise.all([watches.claimDue(new Date(), 5), watches.claimDue(new Date(), 5)]);
    expect(rs.flat()).toHaveLength(1);
    expect(await watches.claimDue(new Date(), 5)).toEqual([]);
  });
  it('saveSnapshot keeps columns it is not given; recordFailure and saveSnapshot ignore a disabled watch', async () => {
    const w = (await watches.add(mkWatch('u1'), 'unlimited'))!;
    await watches.saveSnapshot(w.id, { hrefs: ['a', 'b'] });
    await watches.recordFailure(w.id, 3);
    expect(await watches.saveSnapshot(w.id, {})).toBe(true);
    expect(await watches.get(w.id)).toMatchObject({ lastHrefs: ['a', 'b'], lastSnapshot: null, failCount: 0, hasBaseline: true });
    await watches.removeAny(w.id);
    expect(await watches.recordFailure(w.id, 3)).toBeNull();
    expect(await watches.saveSnapshot(w.id, { snapshot: 'z' })).toBe(false);
  });
  it('get, removeAny and postpone', async () => {
    const w = (await watches.add(mkWatch('u1'), 'unlimited'))!;
    expect(await watches.get(w.id)).toMatchObject({ id: w.id, enabled: true });
    expect(await watches.get(999)).toBeNull();
    const later = new Date(Date.now() + 3_600_000);
    await watches.postpone(w.id, later);
    expect((await watches.get(w.id))!.nextCheckAt).toEqual(later);
    expect(await watches.removeAny(w.id)).toBe(true);
    expect(await watches.removeAny(w.id)).toBe(false);
    await watches.postpone(w.id, past);
    expect((await watches.get(w.id))!.nextCheckAt).toEqual(later); // a disabled watch is left alone
  });
  it('recordFailure counts and disables at the limit', async () => {
    const w = (await watches.add(mkWatch(), 'unlimited'))!;
    expect(await watches.recordFailure(w.id, 3)).toEqual({ failCount: 1, enabled: true });
    await watches.recordFailure(w.id, 3);
    expect(await watches.recordFailure(w.id, 3)).toEqual({ failCount: 3, enabled: false });
  });
  it('remove/list scoped; 6th refused; company cap; legacy no-op; concurrent boundary', async () => {
    const w = (await watches.add(mkWatch('u1'), 'unlimited'))!;
    expect(await watches.remove(w.id, 'u2')).toBe(false);
    expect(await watches.list('u2')).toEqual([]);
    const caps = { perUser: 5, total: 50 };
    for (let i = 0; i < 4; i++) await watches.add(mkWatch('u1'), caps);
    await expect(watches.add(mkWatch('u1'), caps)).rejects.toMatchObject({ scope: 'user' });
    await expect(watches.add(mkWatch('u9'), { perUser: 5, total: 5 })).rejects.toMatchObject({ scope: 'total' });
    expect(await watches.add(mkWatch('u4', { legacyId: 3 }), 'unlimited')).not.toBeNull();
    expect(await watches.add(mkWatch('u4', { legacyId: 3 }), 'unlimited')).toBeNull();
    const rs = await Promise.allSettled(Array.from({ length: 6 }, () => watches.add(mkWatch('u5'), { perUser: 2, total: 50 })));
    expect(rs.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
  });
});

describe('lessons', () => {
  it('activeTexts caps total chars, newest first and excludes inactive', async () => {
    await lessons.add({ text: 'aaaa', source: 'manual', authorId: '1', origin: 'slash' });
    const b = (await lessons.add({ text: 'bbbb', source: 'manual', authorId: '1', origin: 'slash' }))!;
    await lessons.add({ text: 'cccc', source: 'auto', authorId: null, origin: 'chat' });
    await lessons.add({ text: 'dddd', source: 'manual', authorId: '1', origin: 'slash' });
    await db.pool.query('UPDATE lessons SET active = false WHERE id = $1', [b.id]);
    expect(await lessons.activeTexts(100)).toEqual(['dddd', 'cccc', 'aaaa']);
    expect(await lessons.activeTexts(8)).toEqual(['dddd', 'cccc']);
    expect(await lessons.activeTexts(3)).toEqual([]);
  });
  it('length >500 and bad origin/source rejected by CHECK', async () => {
    await expect(lessons.add({ text: 'x'.repeat(501), source: 'manual', authorId: '1', origin: 'slash' })).rejects.toThrow(/check/i);
    await expect(lessons.add({ text: 'x', source: 'manual', authorId: '1', origin: 'bogus' as never })).rejects.toThrow(/check/i);
    await expect(lessons.add({ text: 'x', source: 'other' as never, authorId: '1', origin: 'slash' })).rejects.toThrow(/check/i);
  });
  it('remove with scope only deletes matching rows (P13); no scope = admin', async () => {
    const own = (await lessons.add({ text: 'a', source: 'auto', authorId: null, origin: 'chat' }))!;
    const man = (await lessons.add({ text: 'b', source: 'manual', authorId: '9', origin: 'slash' }))!;
    expect(await lessons.remove(man.id, { source: 'auto' })).toBe(false);
    expect(await lessons.remove(man.id, { authorId: '8' })).toBe(false);
    expect(await lessons.remove(own.id, { source: 'auto', origin: 'chat' })).toBe(true);
    expect(await lessons.remove(man.id)).toBe(true);
  });
  it('origin import starts inactive too', async () => {
    expect((await lessons.add({ text: 'x', source: 'manual', authorId: null, origin: 'import' }))!.active).toBe(false);
  });
  it('imported rows start inactive; legacy_id second insert is a no-op; list and remove', async () => {
    const l = (await lessons.add({ text: 'old', source: 'import', authorId: null, origin: 'import', legacyId: 5 }))!;
    expect(l.active).toBe(false);
    expect(await lessons.add({ text: 'old', source: 'import', authorId: null, origin: 'import', legacyId: 5 })).toBeNull();
    expect(await lessons.activeTexts(100)).toEqual([]);
    expect(await lessons.list({ includeInactive: true })).toHaveLength(1);
    expect(await lessons.list()).toEqual([]);
    expect(await lessons.remove(l.id)).toBe(true);
    expect(await lessons.remove(l.id)).toBe(false);
  });
});

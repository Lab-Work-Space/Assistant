import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../../db/migrate.js';
import { ReminderRepo } from '../../../db/repos/reminders.js';
import { freshDb, type TestDb } from '../../../db/test-helpers.js';
import { FakeConfig } from '../../../governance/test-helpers.js';
import { FakeDiscordPort } from '../../../tests/fakes/discordPort.js';
import type { AuditEntry } from '../../../governance/index.js';
import type { PluginDeps } from '../deps.js';
import { webRig } from '../web/test-helpers.js';
import { remindersGroup } from './index.js';
import { ReminderWorker } from './worker.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');
const DENIED = '1565715069969502310';
const MIN = 60_000;
let db: TestDb, repo: ReminderRepo;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, dir, 'up'); repo = new ReminderRepo(db.pool); });
beforeEach(async () => { await db.pool.query('TRUNCATE reminders RESTART IDENTITY'); });
afterAll(async () => { await db.close(); });

function world(over: { enabled?: () => boolean; canRun?: () => boolean } = {}) {
  let now = Date.parse('2026-11-01T10:00:00Z');
  const port = new FakeDiscordPort();
  const audits: AuditEntry[] = [];
  const log = { warn: vi.fn(), error: vi.fn() };
  const mk = (r: ConstructorParameters<typeof ReminderWorker>[0]['repo'] = repo) => new ReminderWorker({ repo: r, port, clock: () => now, log, markRetryMs: 1, audit: async (e) => void audits.push(e), ...over });
  const add = (o: Record<string, unknown> = {}) => repo.add({ guildId: 'g', channelId: 'c1', userId: 'u1', text: 'drink water', remindAt: new Date(now + 2 * MIN), ...o }, 'unlimited');
  return { port, audits, log, mk, add, advance: (ms: number) => void (now += ms), now: () => now };
}

describe('worker', () => {
  it('reminder due in 2 min fires once in the right channel with a user mention (AC6, fake clock)', async () => {
    const w = world();
    await w.add();
    const worker = w.mk();
    await worker.tick();
    expect(w.port.posts).toHaveLength(0);
    w.advance(2 * MIN);
    await worker.tick();
    await worker.tick();
    expect(w.port.posts).toHaveLength(1);
    expect(w.port.posts[0]).toMatchObject({ target: { channelId: 'c1' }, opts: { mentionUserIds: ['u1'] }, actor: { kind: 'head', dept: 'praw' } });
    expect(w.port.posts[0]!.payload.body).toContain('drink water');
    expect(await repo.list('u1')).toEqual([]);
  });

  it('I5 (D9): while halted the worker claims nothing; the due reminder fires once after /resume', async () => {
    let halted = true;
    const w = world({ canRun: () => !halted });
    await w.add();
    const worker = w.mk();
    w.advance(3 * MIN);
    await worker.tick();
    expect(w.port.posts).toHaveLength(0);
    expect((await db.pool.query('SELECT claimed_at FROM reminders')).rows).toEqual([{ claimed_at: null }]); // not claimed
    halted = false;
    await worker.tick();
    await worker.tick();
    expect(w.port.posts).toHaveLength(1);
    expect(w.port.posts[0]!.payload.body).toContain('drink water');
  });

  it('recurring fires again after every_minutes', async () => {
    const w = world();
    await w.add({ everyMinutes: 10 });
    const worker = w.mk();
    w.advance(2 * MIN); await worker.tick();
    expect(w.port.posts).toHaveLength(1);
    w.advance(5 * MIN); await worker.tick();
    expect(w.port.posts).toHaveLength(1);
    w.advance(5 * MIN); await worker.tick();
    expect(w.port.posts).toHaveLength(2);
    expect(await repo.list('u1')).toHaveLength(1);
  });

  it('two ticks / two workers fire once (claim)', async () => {
    const w = world();
    await w.add();
    w.advance(3 * MIN);
    await Promise.all([w.mk().tick(), w.mk().tick(), w.mk().tick()]);
    expect(w.port.posts).toHaveLength(1);
  });

  it('restart after claim but before post does not double fire; unposted claim older than 5 min is retried once', async () => {
    const w = world();
    const r = (await w.add())!;
    w.advance(3 * MIN);
    // simulated crash: claimed, never posted
    expect(await repo.claimDue(new Date(w.now()), 10)).toHaveLength(1);
    w.advance(MIN);
    await w.mk().tick(); // a restarted worker 1 min later: still within the 5 min grace
    expect(w.port.posts).toHaveLength(0);
    w.advance(5 * MIN);
    await w.mk().tick();
    expect(w.port.posts).toHaveLength(1);
    expect(w.port.posts[0]!.payload.body).toContain('drink water');
    // fired now: nothing more
    w.advance(30 * MIN);
    await w.mk().tick();
    expect(w.port.posts).toHaveLength(1);
    // a retry that fails again is not retried a second time
    const w2 = world();
    await w2.add();
    w2.advance(3 * MIN);
    w2.port.failPost = new Error('discord 500');
    await w2.mk().tick();
    w2.advance(6 * MIN);
    await w2.mk().tick();
    w2.advance(60 * MIN);
    w2.port.failPost = null;
    await w2.mk().tick();
    expect(w2.port.posts).toHaveLength(0);
    expect(r.id).toBeGreaterThan(0);
  });

  it('markFired throws once after a successful post: no second delivery after 5 min (R11)', async () => {
    const w = world();
    await w.add();
    w.advance(3 * MIN);
    let fails = 1;
    const flaky = Object.assign(Object.create(repo), {
      markFired: async (id: number, next?: Date) => { if (fails-- > 0) throw new Error('db blip'); return repo.markFired(id, next); },
    }) as ReminderRepo;
    await w.mk(flaky).tick();
    expect(w.port.posts).toHaveLength(1);
    w.advance(10 * MIN);
    await w.mk().tick();
    expect(w.port.posts).toHaveLength(1);
    // markFired failing every time: this process still never re-sends
    const x = world();
    await x.add();
    x.advance(3 * MIN);
    const dead = Object.assign(Object.create(repo), { markFired: async () => { throw new Error('db down'); } }) as ReminderRepo;
    const worker = x.mk(dead);
    await worker.tick();
    x.advance(10 * MIN);
    await worker.tick();
    expect(x.port.posts).toHaveLength(1);
  });

  it('advance at or beyond the lead time is dropped; late advance reports the real minutes', async () => {
    const w = world();
    const t = (await import('./index.js')).planReminder({ text: 'x', when: { inMinutes: 5 }, advanceMinutes: 10 }, w.now());
    expect(t).toMatchObject({ advanceMinutes: null });
    await w.add({ remindAt: new Date(w.now() + 30 * MIN), advanceMinutes: 10 });
    w.advance(25 * MIN); // the tick was late: 5 minutes left
    await w.mk().tick();
    expect(w.port.posts[0]!.payload.body).toMatch(/in 5 minutes/);
  });

  it('missed reminders fire on boot', async () => {
    const w = world();
    await w.add({ text: 'one', remindAt: new Date(w.now() - 3 * 60 * MIN) });
    await w.add({ text: 'two', remindAt: new Date(w.now() - MIN) });
    const worker = w.mk();
    worker.start();
    await vi.waitFor(() => expect(w.port.posts).toHaveLength(2));
    await worker.stop();
  });

  it('stop clears the timer and waits for the in-flight pass', async () => {
    vi.useFakeTimers();
    try {
      const calls = vi.fn(async () => []);
      const stub = { claimDue: calls, claimAdvanceDue: async () => [], reclaimStale: async () => [], markFired: async () => undefined, get: async () => null };
      const worker = new ReminderWorker({ repo: stub, port: new FakeDiscordPort(), clock: Date.now, log: { warn: vi.fn(), error: vi.fn() }, intervalMs: 1000 });
      worker.start();
      await vi.advanceTimersByTimeAsync(3500);
      const before = calls.mock.calls.length;
      expect(before).toBeGreaterThanOrEqual(3);
      await worker.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls.mock.calls.length).toBe(before);
    } finally { vi.useRealTimers(); }
  });

  it('advance notice fires advance_minutes earlier, then the reminder', async () => {
    const w = world();
    await w.add({ remindAt: new Date(w.now() + 30 * MIN), advanceMinutes: 10 });
    const worker = w.mk();
    w.advance(19 * MIN); await worker.tick();
    expect(w.port.posts).toHaveLength(0);
    w.advance(MIN); await worker.tick();
    await worker.tick();
    expect(w.port.posts).toHaveLength(1);
    expect(w.port.posts[0]!.payload.body).toMatch(/in 10 minutes/);
    w.advance(10 * MIN); await worker.tick();
    expect(w.port.posts).toHaveLength(2);
    expect(w.port.posts[1]!.payload.body).not.toMatch(/in 10 minutes/);
  });

  it('notify_via dm sends a DM with no mentions; closed DM falls back to the channel', async () => {
    const w = world();
    await w.add({ notifyVia: 'dm' });
    w.advance(3 * MIN);
    await w.mk().tick();
    expect(w.port.dms).toMatchObject([{ userId: 'u1' }]);
    expect(w.port.posts).toHaveLength(0);
    const w2 = world();
    w2.port.dmResult = false;
    await w2.add({ notifyVia: 'dm' });
    w2.advance(3 * MIN);
    await w2.mk().tick();
    expect(w2.port.posts).toHaveLength(1);
    expect(w2.port.posts[0]!.opts).toEqual({ mentionUserIds: ['u1'] });
    expect(w2.port.posts[0]!.payload.body).toContain('(DM closed, sent here instead)');
    const w4 = world();
    w4.port.dmResult = 'partial';
    await w4.add({ notifyVia: 'dm' });
    w4.advance(3 * MIN);
    await w4.mk().tick();
    expect(w4.port.posts).toHaveLength(0);
    const w3 = world();
    w3.port.dmResult = 'throw';
    await w3.add({ notifyVia: 'dm' });
    w3.advance(3 * MIN);
    await w3.mk().tick();
    expect(w3.port.posts).toHaveLength(1);
  });
});

describe('reminders.int', () => {
  it('fire in now-denied channel skipped (P14)', async () => {
    const w = world();
    await w.add({ channelId: DENIED });
    w.advance(3 * MIN);
    await w.mk().tick();
    expect(w.port.posts).toHaveLength(0);
    expect(w.port.dms).toHaveLength(0);
    expect(w.audits.filter((a) => a.action === 'reminder.skip')).toHaveLength(1);
    w.advance(30 * MIN);
    await w.mk().tick();
    expect(w.audits.filter((a) => a.action === 'reminder.skip')).toHaveLength(1);
  });

  it('creator no longer a member / praw disabled / cancelled: skipped with one audit row', async () => {
    const w = world();
    w.port.view.set('u1|c1', false);
    await w.add();
    w.advance(3 * MIN); await w.mk().tick();
    expect(w.port.posts).toHaveLength(0);
    expect(w.audits.map((a) => [a.action, a.outcome])).toEqual([['reminder.skip', expect.stringMatching(/member/)]]);
    const off = world({ enabled: () => false });
    await off.add({ userId: 'u2' });
    off.advance(3 * MIN); await off.mk().tick();
    expect(off.port.posts).toHaveLength(0);
    expect(off.audits).toHaveLength(1);
    const c = world();
    const r = (await c.add({ userId: 'u3' }))!;
    await repo.cancel(r.id, 'u3');
    c.advance(3 * MIN); await c.mk().tick();
    expect(c.port.posts).toHaveLength(0);
  });

  it('reminder text with @everyone does not ping', async () => {
    const w = world();
    await w.add({ text: '@everyone <@&123> @here wake up' });
    w.advance(3 * MIN);
    await w.mk().tick();
    expect(w.port.posts).toHaveLength(1);
    expect(w.port.posts[0]!.opts).toEqual({ mentionUserIds: ['u1'] });
    expect(w.port.posts[0]!.payload.body).toContain('@everyone');
  });

  describe('tools against the real repo (P14)', () => {
    const rig = async (userId: string) => {
      const deps = { env: { guildId: 'g' }, cfg: new FakeConfig({ 'limits.remindersPerUser': 20 }), log: { warn: vi.fn() }, clock: () => Date.now(), reminders: repo } as unknown as PluginDeps;
      const g = remindersGroup(deps);
      if ('disabled' in g) throw new Error('disabled');
      return webRig(g.tools, { direct: true, origin: 'chat', source: { channelId: 'c1', threadId: null, messageId: null, userId, attachments: [] } });
    };

    it('cancel another user\'s reminder refused', async () => {
      const mine = await rig('u1');
      const theirs = await rig('u2');
      await mine.reg.run('add_reminder', { text: 'secret', when: { inMinutes: 30 } }, mine.c);
      const [r] = await repo.list('u1');
      const res = await theirs.reg.run('cancel_reminder', { id: r!.id }, theirs.c);
      expect(res.isError).toBe(true);
      expect((await repo.list('u1'))).toHaveLength(1);
      expect((await theirs.reg.run('list_reminders', {}, theirs.c)).content).not.toContain('secret');
      expect((await mine.reg.run('cancel_reminder', { id: r!.id }, mine.c)).isError).toBeFalsy();
      expect(await repo.list('u1')).toHaveLength(0);
    });

    it('21st reminder refused', async () => {
      const t = await rig('u1');
      for (let n = 0; n < 20; n++) expect((await t.reg.run('add_reminder', { text: `r${n}`, when: { inMinutes: 30 + n } }, t.c)).isError).toBeFalsy();
      const res = await t.reg.run('add_reminder', { text: 'one too many', when: { inMinutes: 99 } }, t.c);
      expect(res.isError).toBe(true);
      expect(await repo.list('u1')).toHaveLength(20);
    });
  });
});

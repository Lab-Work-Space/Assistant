import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../../../db/repos/tasks.js';
import { migrate } from '../../../db/migrate.js';
import { JobRepo } from '../../../db/repos/jobs.js';
import { freshDb, type TestDb } from '../../../db/test-helpers.js';
import type { AuditEntry } from '../../../governance/index.js';
import { FakeDiscordPort } from '../../../tests/fakes/discordPort.js';
import { JobRunner } from './runner.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');
const DENIED = '1565715069969502310';
const MIN = 60_000;
const PRAW = { kind: 'head', dept: 'praw' };
let db: TestDb, repo: JobRepo;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, dir, 'up'); repo = new JobRepo(db.pool); });
beforeEach(async () => { await db.pool.query('TRUNCATE scheduled_jobs RESTART IDENTITY'); });
afterAll(async () => { await db.close(); });

function world(over: { capacity?: () => Promise<number>; canRun?: () => boolean; submit?: (t: unknown) => Promise<Task | null>; enabled?: () => boolean } = {}) {
  let now = Date.parse('2026-11-01T10:00:00Z');
  const port = new FakeDiscordPort();
  const audits: AuditEntry[] = [];
  const submitted: Record<string, unknown>[] = [];
  const submit = over.submit ?? (async (t: unknown) => { submitted.push(t as Record<string, unknown>); return { id: `t${submitted.length}` } as Task; });
  const log = { warn: vi.fn(), error: vi.fn() };
  const mk = () => new JobRunner({ repo, port, submit: submit as never, canRun: over.canRun ?? (() => true), ...(over.capacity ? { capacity: over.capacity } : {}), clock: () => now, log, audit: async (e) => void audits.push(e), ...(over.enabled ? { enabled: over.enabled } : {}) });
  const add = (o: Record<string, unknown> = {}) => repo.add({ guildId: 'g', channelId: 'c1', userId: 'u1', prompt: 'summarize the news', origin: 'schedule', kind: 'interval', intervalMinutes: 30, nextRunAt: new Date(now - MIN), ...o } as never, 'unlimited');
  return { port, audits, submitted, log, mk, add, advance: (ms: number) => void (now += ms) };
}

describe('runner', () => {
  it('runner › due job creates one root task with origin schedule (import for imported jobs) and runs as praw, requester praw not the creator', async () => {
    const w = world();
    await w.add();
    await w.add({ origin: 'import', prompt: 'old job', legacyId: 9 });
    await w.mk().tick();
    expect(w.submitted).toHaveLength(2);
    expect(w.submitted[0]).toMatchObject({ deptId: 'praw', owner: PRAW, requester: PRAW, origin: 'schedule', channelId: 'c1', sourceUserId: 'u1', status: 'todo', description: 'summarize the news' });
    expect(w.submitted[1]).toMatchObject({ origin: 'import', requester: PRAW, sourceUserId: 'u1' });
    expect((await repo.list('u1')).every((j) => j.nextRunAt.getTime() > Date.parse('2026-11-01T10:00:00Z'))).toBe(true);
  });

  it('runner › claim prevents double run across ticks', async () => {
    const w = world();
    await w.add();
    const a = w.mk(), b = w.mk();
    await Promise.all([a.tick(), b.tick(), a.tick()]);
    await a.tick();
    expect(w.submitted).toHaveLength(1);
    w.advance(31 * MIN);
    await b.tick();
    expect(w.submitted).toHaveLength(2);
  });

  it('runner › halted → no run, job stays due', async () => {
    let ok = false;
    const w = world({ canRun: () => ok });
    const j = (await w.add())!;
    const r = w.mk();
    await r.tick();
    expect(w.submitted).toHaveLength(0);
    expect((await repo.list('u1'))[0]!.nextRunAt).toEqual(j.nextRunAt);
    ok = true;
    await r.tick();
    expect(w.submitted).toHaveLength(1);
  });

  it('runner › a refused submit (open-task cap) un-claims the job so it is retried', async () => {
    let refuse = true;
    const calls: unknown[] = [];
    const w = world({ submit: async (t) => { calls.push(t); return refuse ? null : ({ id: 't' } as Task); } });
    const j = (await w.add())!;
    await w.mk().tick();
    expect((await repo.list('u1'))[0]!.nextRunAt).toEqual(j.nextRunAt);
    refuse = false;
    await w.mk().tick();
    expect(calls).toHaveLength(2);
  });

  it('runner › fire in now-denied channel or by a creator who left the guild is skipped', async () => {
    const w = world();
    await w.add({ channelId: DENIED });
    await w.add({ channelId: 'c2', userId: 'gone' });
    w.port.view.set('gone|c2', false);
    await w.add({ channelId: 'c3', userId: 'u3' });
    await w.mk().tick();
    expect(w.submitted.map((s) => s.channelId)).toEqual(['c3']);
    expect(w.audits.filter((a) => a.action === 'schedule.skip').map((a) => a.outcome)).toEqual(expect.arrayContaining(['channel is denied', 'creator is not a member who can see the channel']));
  });

  it('runner › a once job fires once and is gone; disabled praw fires nothing', async () => {
    const w = world();
    await w.add({ kind: 'once', intervalMinutes: null, nextRunAt: new Date(Date.parse('2026-11-01T09:00:00Z')) });
    const r = w.mk();
    await r.tick(); await r.tick();
    expect(w.submitted).toHaveLength(1);
    expect(await repo.list('u1')).toEqual([]);
    const off = world({ enabled: () => false });
    await off.add();
    await off.mk().tick();
    expect(off.submitted).toHaveLength(0);
    expect(off.audits.at(-1)).toMatchObject({ action: 'schedule.skip', outcome: 'praw disabled' });
  });

  it('runner › a burst claims only the free capacity; the rest stay due for later ticks', async () => {
    let free = 2;
    const w = world({ capacity: async () => free });
    for (let i = 0; i < 6; i++) await w.add({ prompt: `job ${i}` });
    const r = w.mk();
    await r.tick();
    expect(w.submitted).toHaveLength(2);
    free = 0;
    await r.tick();
    expect(w.submitted).toHaveLength(2);
    free = 10;
    await r.tick();
    expect(w.submitted.map((s) => s.description)).toEqual(['job 0', 'job 1', 'job 2', 'job 3', 'job 4', 'job 5']);
  });

  it('runner › a one-off whose start throws is put back once, then dropped with an audit note', async () => {
    let calls = 0;
    const w = world({ submit: async () => { calls++; throw new Error('db down'); } });
    await w.add({ kind: 'once', intervalMinutes: null });
    const r = w.mk();
    await r.tick();
    expect(await repo.list('u1')).toHaveLength(1);
    await r.tick();
    expect(calls).toBe(2);
    expect(await repo.list('u1')).toEqual([]);
    expect(w.audits.map((a) => a.outcome)).toEqual(['start failed; will retry once', 'start failed']);
  });

  it('runner › the task description is the mention-stripped prompt (goalTask)', async () => {
    const w = world();
    await w.add({ prompt: `<@123> ${'x'.repeat(1900)}` });
    await w.mk().tick();
    expect((w.submitted[0]!.description as string).length).toBe(1900);
    expect(w.submitted[0]!.description).not.toContain('<@');
  });

  it('stop awaits an in-flight tick', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const w = world({ submit: async () => { await gate; return { id: 't' } as Task; } });
    await w.add();
    const r = w.mk();
    const tick = r.tick();
    let stopped = false;
    const stop = r.stop().then(() => (stopped = true));
    await new Promise((x) => setTimeout(x, 20));
    expect(stopped).toBe(false);
    release();
    await Promise.all([tick, stop]);
    expect(stopped).toBe(true);
  });
});

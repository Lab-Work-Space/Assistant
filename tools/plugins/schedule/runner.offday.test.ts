import { describe, expect, it, vi } from 'vitest';
import { createCalendar } from '../../../company/calendar.js';
import type { ScheduledJob } from '../../../db/repos/jobs.js';
import type { AuditEntry } from '../../../governance/index.js';
import { FakeConfig } from '../../../governance/test-helpers.js';
import { JobRunner } from './runner.js';

// 09:00 Asia/Bangkok = 02:00Z. 2026-11-07 is a Saturday, 2026-11-09 a Monday.
const SAT_0900 = new Date('2026-11-07T02:00:00Z');
const SUN_0900 = new Date('2026-11-08T02:00:00Z');
const MON_0900 = new Date('2026-11-09T02:00:00Z');

const job = (over: Partial<ScheduledJob> = {}): ScheduledJob => ({
  id: 1, guildId: 'g', channelId: 'c1', userId: 'u1', prompt: 'news', origin: 'schedule', kind: 'daily', hhmm: '09:00', tz: 'Asia/Bangkok',
  intervalMinutes: null, nextRunAt: SAT_0900, lastClaim: null, active: true, legacyId: null, createdAt: new Date(0), ...over,
});

function rig(j: ScheduledJob, now: number) {
  const cal = createCalendar(new FakeConfig());
  const audits: AuditEntry[] = [];
  const repo = { claimDue: vi.fn(async () => [j]), get: vi.fn(async () => j), reschedule: vi.fn(async () => true) };
  const submit = vi.fn(async () => ({ id: 't1' }) as never);
  const r = new JobRunner({
    repo, port: { canMemberView: async () => true }, submit, canRun: () => true, clock: () => now, log: { warn: vi.fn(), error: vi.fn() },
    audit: async (e) => void audits.push(e), offDay: (at) => cal.isOffDay(at).off,
  });
  return { r, repo, submit, audits };
}

describe('runner on off days', () => {
  it('an occurrence on an off day is skipped with one audit row and no task; the claim already advanced it', async () => {
    const t = rig(job(), SAT_0900.getTime() + 30_000);
    await t.r.tick();
    expect(t.submit).not.toHaveBeenCalled();
    expect(t.audits).toEqual([{ actor: 'system:schedule', action: 'schedule.skip', tool: '1', outcome: 'off day' }]);
    expect(t.repo.reschedule).not.toHaveBeenCalled(); // the next occurrence (Sunday) is still ahead
  });

  it('a skipped occurrence seen late (bot down over the weekend) moves the job to the first due workday occurrence (the off-day one is not caught up)', async () => {
    const t = rig(job({ nextRunAt: SUN_0900 }), MON_0900.getTime() + 3_600_000);
    await t.r.tick();
    expect(t.submit).not.toHaveBeenCalled();
    expect(t.repo.reschedule).toHaveBeenCalledWith(1, MON_0900);
  });

  it('a workday occurrence fires even when the tick runs on an off day (the task then waits in the scheduler)', async () => {
    const t = rig(job({ nextRunAt: new Date('2026-11-06T02:00:00Z') }), SAT_0900.getTime());
    await t.r.tick();
    expect(t.submit).toHaveBeenCalledTimes(1);
    expect(t.audits).toEqual([]);
  });

  it('a one-off on an off day is skipped and not caught up later', async () => {
    const t = rig(job({ kind: 'once', hhmm: null }), SAT_0900.getTime() + 30_000);
    await t.r.tick();
    expect(t.submit).not.toHaveBeenCalled();
    expect(t.audits.map((a) => a.outcome)).toEqual(['off day']);
    expect(t.repo.reschedule).not.toHaveBeenCalled();
  });

  it('an interval job seen late skips to its first workday occurrence', async () => {
    const t = rig(job({ kind: 'interval', hhmm: null, tz: null, intervalMinutes: 720, nextRunAt: SAT_0900 }), MON_0900.getTime());
    await t.r.tick();
    // Sat 09:00 BKK + 12 h steps: Sat 21:00, Sun 09:00, Sun 21:00, Mon 09:00 (the first workday one, due now).
    expect(t.repo.reschedule).toHaveBeenCalledWith(1, MON_0900);
  });
});

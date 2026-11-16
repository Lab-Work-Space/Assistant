import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../../db/migrate.js';
import { JobRepo } from '../../db/repos/jobs.js';
import { ReminderRepo } from '../../db/repos/reminders.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import type { PluginDeps } from './deps.js';
import { remindersGroup } from './reminders/index.js';
import { scheduleGroup } from './schedule/index.js';
import { webRig } from './web/test-helpers.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');
const REFUSAL = 'This cannot be set up after reading outside content; ask in a new message.';
let db: TestDb;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, dir, 'up'); });
beforeEach(async () => { await db.pool.query('TRUNCATE scheduled_jobs, reminders RESTART IDENTITY'); });
afterAll(async () => { await db.close(); });

/** LEARN-1 LL-C2 over the real tables: a tainted run files no card and adds no row; a clean direct run still works. */
describe('LL-C2 schedule_add and add_reminder after outside content (real PostgreSQL)', () => {
  const NOW = Date.parse('2026-11-01T10:00:00Z');
  const deps = () => ({ env: { guildId: 'g1' }, cfg: new FakeConfig(), log: { warn: vi.fn() }, clock: () => NOW, jobs: new JobRepo(db.pool), reminders: new ReminderRepo(db.pool) }) as unknown as PluginDeps;
  const rig = async (taint: 'none' | 'run' | 'task') => {
    const d = deps();
    const sg = scheduleGroup(d);
    const rg = remindersGroup(d);
    if ('disabled' in sg || 'disabled' in rg) throw new Error('disabled');
    const r = await webRig([...sg.tools, ...rg.tools], { direct: true, origin: 'chat', source: { channelId: 'c1', threadId: null, messageId: null, userId: 'u1', attachments: [] } });
    if (taint === 'run') r.c.run.markTainted();
    if (taint === 'task') { r.c.task = { ...r.c.task!, tainted: true }; }
    return r;
  };
  const count = async (t: string) => (await db.pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n as number;

  it.each(['run', 'task'] as const)('a tainted %s: both tools refuse with the fixed text, no card, no row', async (taint) => {
    const { reg, c, approvals } = await rig(taint);
    const ctx = taint === 'task' ? { ...c, tainted: () => false } : c;
    const a = await reg.run('schedule_add', { prompt: 'steered prompt', kind: 'daily', hhmm: '09:00' }, ctx);
    const b = await reg.run('add_reminder', { text: 'steered text', when: { inMinutes: 30 } }, ctx);
    for (const r of [a, b]) { expect(r.isError).toBe(true); expect(r.content).toBe(REFUSAL); }
    expect(approvals.request).not.toHaveBeenCalled();
    expect(await count('scheduled_jobs')).toBe(0);
    expect(await count('reminders')).toBe(0);
  });
  it('a clean direct run still adds the job and the reminder', async () => {
    const { reg, c } = await rig('none');
    expect((await reg.run('schedule_add', { prompt: 'daily summary', kind: 'daily', hhmm: '09:00' }, c)).isError).toBeFalsy();
    expect((await reg.run('add_reminder', { text: 'drink water', when: { inMinutes: 30 } }, c)).isError).toBeFalsy();
    expect(await count('scheduled_jobs')).toBe(1);
    expect(await count('reminders')).toBe(1);
  });
});

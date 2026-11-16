import { describe, expect, it, vi } from 'vitest';
import { CapError } from '../../../db/repos/praw.js';
import { FakeConfig } from '../../../governance/test-helpers.js';
import { toGeminiSchema } from '../../../providers/gemini/convert.js';
import type { PluginDeps } from '../deps.js';
import { webRig } from '../web/test-helpers.js';
import { scheduleGroup } from './index.js';

const NOW = Date.parse('2026-11-01T10:00:00Z');
function setup(origin: 'chat' | 'schedule' | 'delegated' = 'chat', userId: string | null = 'u1') {
  const added: { j: Record<string, unknown>; caps: unknown }[] = [];
  let n = 0;
  const jobs = {
    add: vi.fn(async (j: Record<string, unknown>, caps: unknown) => {
      if (added.filter((a) => a.j.userId === j.userId).length >= 5) throw new CapError('user', 5);
      added.push({ j, caps });
      return { id: ++n, ...j };
    }),
    list: vi.fn(async (u: string) => (u === 'u1' ? [{ id: 1, prompt: 'p', kind: 'daily', hhmm: '09:00', nextRunAt: new Date(NOW), intervalMinutes: null }] : [])),
    remove: vi.fn(async (id: number, u: string) => u === 'u1' && id === 1),
  };
  const deps = { env: { guildId: 'g1' }, cfg: new FakeConfig(), log: { warn: vi.fn() }, clock: () => NOW, jobs } as unknown as PluginDeps;
  const g = scheduleGroup(deps);
  if ('disabled' in g) throw new Error('disabled');
  return { g, jobs, added, rig: () => webRig(g.tools, { direct: true, origin, source: { channelId: 'c1', threadId: null, messageId: null, userId, attachments: [] } }) };
}

describe('schedule tools', () => {
  it('declares kinds and converts for Gemini', () => {
    const t = setup();
    expect(Object.fromEntries(t.g.tools.map((x) => [x.name, x.kind]))).toEqual({ schedule_add: 'write', schedule_list: 'read', schedule_remove: 'write' });
    for (const x of t.g.tools) expect(() => toGeminiSchema(x.inputSchema as never)).not.toThrow();
  });

  it('tool › add takes user, channel and caps from the trigger and config', async () => {
    const t = setup('chat', 'real');
    const { reg, c } = await t.rig();
    const r = await reg.run('schedule_add', { prompt: 'summarize', kind: 'daily', hhmm: '09:00', userId: 'attacker' }, c);
    expect(r.isError).toBeFalsy();
    expect(t.added[0]!.j).toMatchObject({ guildId: 'g1', channelId: 'c1', userId: 'real', prompt: 'summarize', origin: 'schedule', kind: 'daily', hhmm: '09:00', tz: 'Asia/Bangkok' });
    expect(t.added[0]!.caps).toEqual({ perUser: 5, total: 50 });
  });

  it('tool › 6th schedule refused', async () => {
    const t = setup();
    const { reg, c } = await t.rig();
    for (let i = 0; i < 5; i++) expect((await reg.run('schedule_add', { prompt: `p${i}`, kind: 'interval', intervalMinutes: 30 }, c)).isError).toBeFalsy();
    const r = await reg.run('schedule_add', { prompt: 'sixth', kind: 'interval', intervalMinutes: 30 }, c);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/limit/);
  });

  it('runner › interval <15 min refused (tool)', async () => {
    const t = setup();
    const { reg, c } = await t.rig();
    expect((await reg.run('schedule_add', { prompt: 'x', kind: 'interval', intervalMinutes: 14 }, c)).isError).toBe(true);
    expect((await reg.run('schedule_add', { prompt: 'x', kind: 'once', at: 'soon' }, c)).isError).toBe(true);
    expect(t.jobs.add).not.toHaveBeenCalled();
  });

  it('tool › list/remove only the caller own jobs; schedule-origin runs cannot manage jobs', async () => {
    const t = setup('chat', 'u2');
    const a = await t.rig();
    expect((await a.reg.run('schedule_list', {}, a.c)).content).toMatch(/No scheduled/);
    expect((await a.reg.run('schedule_remove', { id: 1 }, a.c)).isError).toBe(true);
    expect(t.jobs.list).toHaveBeenCalledWith('u2');
    expect(t.jobs.remove).toHaveBeenCalledWith(1, 'u2');
    const mine = setup('chat', 'u1');
    const b = await mine.rig();
    expect((await b.reg.run('schedule_list', {}, b.c)).content).toContain('#1');
    expect((await b.reg.run('schedule_remove', { id: 1 }, b.c)).isError).toBeFalsy();
    const sch = setup('schedule', 'u1');
    const s = await sch.rig();
    expect((await s.reg.run('schedule_add', { prompt: 'x', kind: 'interval', intervalMinutes: 30 }, s.c)).isError).toBe(true);
    expect(sch.jobs.add).not.toHaveBeenCalled();
  });

  // LEARN-1 LL-C2: a tainted run cannot set up a job (no card, no row); a clean direct run still can
  it('LL-C2 › schedule_add refuses in a precheck after outside content: no card, no row', async () => {
    const t = setup('chat', 'u1');
    for (const how of ['run', 'task'] as const) {
      const { reg, c, approvals } = await t.rig();
      if (how === 'run') c.run.markTainted();
      else c.task = { ...c.task!, tainted: true };
      const ctx = how === 'run' ? c : { ...c, tainted: () => false };
      const r = await reg.run('schedule_add', { prompt: 'x', kind: 'daily', hhmm: '09:00' }, ctx);
      expect(r.isError, how).toBe(true);
      expect(r.content).toBe('This cannot be set up after reading outside content; ask in a new message.');
      expect(approvals.request).not.toHaveBeenCalled();
    }
    expect(t.jobs.add).not.toHaveBeenCalled();
    const clean = await t.rig();
    expect((await clean.reg.run('schedule_add', { prompt: 'x', kind: 'daily', hhmm: '09:00' }, clean.c)).isError).toBeFalsy();
    expect(t.jobs.add).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { PrawRateLimit } from '../../agents/call/rate.js';
import { CapError } from '../../db/repos/praw.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { ADMIN_ROLE, GUILD, cmd, text } from '../commands/test-helpers.js';
import { handlePrawInteraction, prawCommandDeps, PRAW_COMMANDS } from './index.js';

const NOW = Date.parse('2026-11-01T10:00:00Z');
function mk() {
  const cfg = new FakeConfig();
  const rows = [{ id: 5, userId: 'u1', prompt: 'daily digest', kind: 'daily', hhmm: '09:00', intervalMinutes: null, nextRunAt: new Date(NOW + 3_600_000) }];
  const schedules = {
    add: vi.fn(async (j: Record<string, unknown>, _caps?: unknown) => ({ id: 6, ...j })),
    list: vi.fn(async (u: string) => rows.filter((r) => r.userId === u)),
    remove: vi.fn(async (id: number, u: string) => rows.some((r) => r.id === id && r.userId === u)),
    removeAny: vi.fn(async (id: number) => rows.some((r) => r.id === id)),
  };
  const audits: unknown[] = [];
  const deps = prawCommandDeps({
    guildId: GUILD, adminRoleId: ADMIN_ROLE, org: { dept: () => null }, cfg, rate: new PrawRateLimit(cfg, () => NOW), ask: vi.fn() as never,
    audit: async (e) => void audits.push(e), log: { error: () => undefined }, reminders: {} as never, schedules: schedules as never, clock: () => NOW,
  });
  return { deps, schedules, audits };
}
const sched = (sub: string, o: Parameters<typeof cmd>[2] = {}) => cmd('schedule', sub, { channelId: '555', roles: [], ...o });

describe('/schedule', () => {
  it('is registered with add/list/remove', () => {
    const r = PRAW_COMMANDS.find((c) => c.name === 'schedule') as { options?: { name: string }[] } | undefined;
    expect(r?.options?.map((o) => o.name)).toEqual(['add', 'list', 'remove']);
  });

  it('/schedule › add|list|remove', async () => {
    const t = mk();
    const add = sched('add', { strings: { prompt: 'daily digest', daily: '09:00' } });
    const r1 = await handlePrawInteraction(add, t.deps);
    expect(add.deferred).toEqual({ ephemeral: true });
    expect(r1?.ephemeral).toBe(true);
    expect(t.schedules.add.mock.calls[0]![0]).toMatchObject({ guildId: GUILD, channelId: '555', userId: 'u1', prompt: 'daily digest', origin: 'schedule', kind: 'daily', hhmm: '09:00', tz: 'Asia/Bangkok' });
    expect(t.schedules.add.mock.calls[0]![1]).toEqual({ perUser: 5, total: 50 });
    const every = await handlePrawInteraction(sched('add', { strings: { prompt: 'p' }, numbers: { every: 30 } }), t.deps);
    expect(text(every)).toMatch(/#6/);
    const list = await handlePrawInteraction(sched('list'), t.deps);
    expect(list?.ephemeral).toBe(true);
    expect(text(list)).toContain('daily digest');
    expect(text(await handlePrawInteraction(sched('remove', { numbers: { id: 5 } }), t.deps))).toMatch(/removed/i);
    expect(t.schedules.remove).toHaveBeenCalledWith(5, 'u1');
    expect(text(await handlePrawInteraction(sched('remove', { numbers: { id: 5 }, userId: 'u2' }), t.deps))).toMatch(/No schedule/);
    expect(t.schedules.removeAny).not.toHaveBeenCalled();
    // a Bot Admin may remove any, audited
    expect(text(await handlePrawInteraction(sched('remove', { numbers: { id: 5 }, userId: 'admin', roles: [ADMIN_ROLE] }), t.deps))).toMatch(/removed/i);
    expect(t.audits).toContainEqual(expect.objectContaining({ action: 'schedule.remove_any', tool: '5' }));
  });

  it('/schedule › add refuses zero or several time options, interval <15, and reports the cap', async () => {
    const t = mk();
    for (const o of [{ strings: { prompt: 'p' } } as Parameters<typeof cmd>[2], { strings: { prompt: 'p', daily: '09:00' }, numbers: { every: 30 } }, { strings: { prompt: 'p' }, numbers: { every: 14 } }, { strings: { prompt: 'p', daily: '9am' } }])
      expect(text(await handlePrawInteraction(sched('add', o), t.deps)), JSON.stringify(o)).toMatch(/Could not|Give exactly/);
    expect(t.schedules.add).not.toHaveBeenCalled();
    t.schedules.add.mockRejectedValueOnce(new CapError('user', 5));
    expect(text(await handlePrawInteraction(sched('add', { strings: { prompt: 'p', daily: '09:00' } }), t.deps))).toMatch(/limit/);
  });
});

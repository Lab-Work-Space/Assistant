import { describe, expect, it, vi } from 'vitest';
import { PrawRateLimit } from '../../agents/call/rate.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { ADMIN_ROLE, GUILD, cmd, text } from '../commands/test-helpers.js';
import { handlePrawInteraction, prawCommandDeps, PRAW_COMMANDS } from './index.js';

const NOW = Date.parse('2026-11-01T10:00:00Z');
function mk(limit = 20) {
  const cfg = new FakeConfig({ 'limits.prawPerUser10Min': limit });
  const rows = [{ id: 5, userId: 'u1', text: 'water', remindAt: new Date(NOW + 600_000), everyMinutes: null, notifyVia: 'channel' }];
  const reminders = {
    add: vi.fn(async (r: Record<string, unknown>, _caps?: unknown) => ({ id: 6, ...r })),
    list: vi.fn(async (u: string) => rows.filter((r) => r.userId === u)),
    cancel: vi.fn(async (id: number, u: string) => rows.some((r) => r.id === id && r.userId === u)),
    cancelAny: vi.fn(async (id: number) => rows.some((r) => r.id === id)),
  };
  const audits: unknown[] = [];
  const deps = prawCommandDeps({
    guildId: GUILD, adminRoleId: ADMIN_ROLE, org: { dept: () => null }, cfg, rate: new PrawRateLimit(cfg, () => NOW),
    ask: vi.fn() as never, audit: async (e) => void audits.push(e), log: { error: () => undefined }, reminders: reminders as never, schedules: {} as never, clock: () => NOW,
  });
  return { deps, reminders, audits };
}
const remind = (sub: string, o: Parameters<typeof cmd>[2] = {}) => cmd('remind', sub, { channelId: '555', roles: [], ...o });

describe('/remind', () => {
  it('is registered with add/list/cancel', () => {
    const r = PRAW_COMMANDS.find((c) => c.name === 'remind') as { options?: { name: string }[] } | undefined;
    expect(r?.options?.map((o) => o.name)).toEqual(['add', 'list', 'cancel']);
  });

  it('/remind › add/list/cancel respond ephemeral and are rate limited', async () => {
    const t = mk(4);
    const add = remind('add', { strings: { text: 'water' }, numbers: { minutes: 10 } });
    const r1 = await handlePrawInteraction(add, t.deps);
    expect(add.deferred).toEqual({ ephemeral: true });
    expect(r1?.ephemeral).toBe(true);
    expect(t.reminders.add).toHaveBeenCalledTimes(1);
    expect(t.reminders.add.mock.calls[0]![0]).toMatchObject({ guildId: GUILD, channelId: '555', userId: 'u1', text: 'water', remindAt: new Date(NOW + 600_000) });
    expect(t.reminders.add.mock.calls[0]![1]).toEqual({ perUser: 20, total: 500 });

    const list = remind('list');
    const r2 = await handlePrawInteraction(list, t.deps);
    expect(list.deferred).toEqual({ ephemeral: true });
    expect(r2?.ephemeral).toBe(true);
    expect(text(r2)).toContain('water');
    expect(text(r2)).toContain('5');

    const cancel = remind('cancel', { numbers: { id: 5 } });
    const r3 = await handlePrawInteraction(cancel, t.deps);
    expect(r3?.ephemeral).toBe(true);
    expect(t.reminders.cancel).toHaveBeenCalledWith(5, 'u1');

    const r4 = await handlePrawInteraction(remind('list'), t.deps); // 4th slot
    expect(r4?.ephemeral).toBe(true);
    const limited = remind('list');
    const r5 = await handlePrawInteraction(limited, t.deps);
    expect(r5?.ephemeral).toBe(true);
    expect(limited.deferred).toBeNull();
    expect(limited.replies).toHaveLength(1);
  });

  it('bad input is refused ephemeral without calling the repo; non-owner cancel says not found; admin may cancel any', async () => {
    const t = mk();
    const past = remind('add', { strings: { text: 'x' }, numbers: { minutes: 0 } });
    expect((await handlePrawInteraction(past, t.deps))?.ephemeral).toBe(true);
    expect(t.reminders.add).not.toHaveBeenCalled();
    const other = remind('cancel', { numbers: { id: 5 }, userId: 'u2' });
    expect(text(await handlePrawInteraction(other, t.deps))).toMatch(/no reminder/i);
    expect(t.reminders.cancelAny).not.toHaveBeenCalled();
    const admin = remind('cancel', { numbers: { id: 5 }, userId: 'u2', roles: [ADMIN_ROLE] });
    expect(text(await handlePrawInteraction(admin, t.deps))).toMatch(/cancelled/i);
    expect(t.reminders.cancelAny).toHaveBeenCalledWith(5);
    expect(t.audits).toContainEqual(expect.objectContaining({ action: 'remind.cancel_any', actor: 'user:u2' }));
  });
});

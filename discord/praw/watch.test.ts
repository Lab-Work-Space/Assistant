import { describe, expect, it, vi } from 'vitest';
import { PrawRateLimit } from '../../agents/call/rate.js';
import { CapError } from '../../db/repos/praw.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { watchNet } from '../../tools/plugins/watch/test-helpers.js';
import { ADMIN_ROLE, GUILD, cmd, text } from '../commands/test-helpers.js';
import { handlePrawInteraction, prawCommandDeps, PRAW_COMMANDS } from './index.js';

const NOW = Date.parse('2026-11-01T10:00:00Z');
function mk() {
  const cfg = new FakeConfig();
  const rows = [{ id: 5, userId: 'u1', kind: 'url', target: 'https://example.com/a', intervalMinutes: 30 }];
  const watches = {
    add: vi.fn(async (w: Record<string, unknown>, _caps?: unknown) => ({ id: 6, ...w })),
    list: vi.fn(async (u: string) => rows.filter((r) => r.userId === u)),
    remove: vi.fn(async (id: number, u: string) => rows.some((r) => r.id === id && r.userId === u)),
    removeAny: vi.fn(async (id: number) => rows.some((r) => r.id === id)),
  };
  const audits: unknown[] = [];
  const net = watchNet();
  const deps = prawCommandDeps({
    guildId: GUILD, adminRoleId: ADMIN_ROLE, org: { dept: () => null }, cfg, rate: new PrawRateLimit(cfg, () => NOW), ask: vi.fn() as never,
    audit: async (e) => void audits.push(e), log: { error: () => undefined }, reminders: {} as never, schedules: {} as never, clock: () => NOW,
    watches: watches as never, watchNet: net,
  });
  return { deps, watches, audits, net };
}
const watch = (sub: string, o: Parameters<typeof cmd>[2] = {}) => cmd('watch', sub, { channelId: '555', roles: [], ...o });

describe('/watch', () => {
  it('is registered with add/list/remove', () => {
    const r = PRAW_COMMANDS.find((c) => c.name === 'watch') as { options?: { name: string }[] } | undefined;
    expect(r?.options?.map((o) => o.name)).toEqual(['add', 'list', 'remove']);
  });

  it('/watch › add|list|remove', async () => {
    const t = mk();
    const add = watch('add', { strings: { kind: 'url', target: 'https://example.com/a#x' }, numbers: { every: 30 } });
    const r1 = await handlePrawInteraction(add, t.deps);
    expect(add.deferred).toEqual({ ephemeral: true });
    expect(r1?.ephemeral).toBe(true);
    expect(text(r1)).toMatch(/#6/);
    expect(t.watches.add.mock.calls[0]![0]).toMatchObject({ guildId: GUILD, channelId: '555', userId: 'u1', kind: 'url', target: 'https://example.com/a', intervalMinutes: 30 });
    expect(t.watches.add.mock.calls[0]![1]).toEqual({ perUser: 5, total: 50 });
    const list = await handlePrawInteraction(watch('list'), t.deps);
    expect(list?.ephemeral).toBe(true);
    expect(text(list)).toContain('https://example.com/a');
    expect(text(await handlePrawInteraction(watch('remove', { numbers: { id: 5 } }), t.deps))).toMatch(/removed/i);
    expect(t.watches.remove).toHaveBeenCalledWith(5, 'u1');
    expect(text(await handlePrawInteraction(watch('remove', { numbers: { id: 5 }, userId: 'u2' }), t.deps))).toMatch(/No watch/);
    expect(t.watches.removeAny).not.toHaveBeenCalled();
    expect(text(await handlePrawInteraction(watch('remove', { numbers: { id: 5 }, userId: 'admin', roles: [ADMIN_ROLE] }), t.deps))).toMatch(/removed/i);
    expect(t.audits).toContainEqual(expect.objectContaining({ action: 'watch.remove_any', tool: '5' }));
  });

  it('/watch › add refuses private urls, interval <15, bad kind; reports the cap', async () => {
    const t = mk();
    for (const o of [
      { strings: { kind: 'url', target: 'http://127.0.0.1/' }, numbers: { every: 30 } },
      { strings: { kind: 'url', target: 'https://evil.example/' }, numbers: { every: 30 } },
      { strings: { kind: 'url', target: 'https://example.com/' }, numbers: { every: 14 } },
      { strings: { kind: 'bogus', target: 'x' }, numbers: { every: 30 } },
      { strings: { kind: 'topic', target: '   ' }, numbers: { every: 30 } },
    ])
      expect(text(await handlePrawInteraction(watch('add', o), t.deps)), JSON.stringify(o)).toMatch(/Could not|Tell me/);
    expect(t.watches.add).not.toHaveBeenCalled();
    t.watches.add.mockRejectedValueOnce(new CapError('user', 5));
    expect(text(await handlePrawInteraction(watch('add', { strings: { kind: 'topic', target: 'chips' }, numbers: { every: 60 } }), t.deps))).toMatch(/limit/);
  });
});

import { describe, expect, it } from 'vitest';
import { SettingsRegistry } from './settings.js';

const U = '900000000000000021';
const reg = () => {
  const calls: { who: unknown; kind: string; raw: unknown }[] = [];
  const r = new SettingsRegistry();
  r.bindConsole({
    proposeConfig: async () => ({ ok: true, text: 'c' }), proposeOp: async () => ({ ok: true, text: 'o' }), proposePerm: async () => ({ ok: true, text: 'p' }),
    proposeServer: async (who: unknown, raw: unknown) => (calls.push({ who, kind: 'server', raw }), { ok: true, text: 's', cardId: 'x'.repeat(32) }),
  } as never);
  return { r, calls };
};
const build = (r: SettingsRegistry, id: string, v: Record<string, string>) => r.build(id, v);

describe('server actions replace the stubs (panel and dashboard)', () => {
  it('all seven ids build real ops; every modal has at most 5 fields', () => {
    const { r } = reg();
    for (const id of ['welcome_set', 'automod_rule', 'server_settings', 'server_event', 'mod_timeout', 'mod_kick', 'mod_ban']) {
      const a = r.action(id)!;
      expect(a.fields.length, id).toBeGreaterThan(0);
      expect(a.fields.length, id).toBeLessThanOrEqual(5);
    }
  });
  it('a typed user id is a NAMED target (S18, S37d): kick, ban and timeout reach the console with namedIds', async () => {
    const { r, calls } = reg();
    for (const [id, v] of [['mod_kick', { member: U, reason: 'rude' }], ['mod_ban', { member: U, days: '1' }], ['mod_timeout', { member: U, minutes: '10' }]] as const) {
      const b = build(r, id, v);
      if (!b.ok) throw new Error(b.error);
      expect(await r.propose({ userId: '900000000000000001', tainted: false, via: 'panel' }, b)).toMatchObject({ ok: true });
    }
    expect(calls.map((c) => (c.who as { namedIds: string[]; via: string }).namedIds)).toEqual([[U], [U], [U]]);
    expect((calls[1]!.raw as { deleteDays: number }[])[0]!.deleteDays).toBe(1);
  });
  it('bad input is refused by code with a readable reason and never becomes a card', () => {
    const { r } = reg();
    expect(build(r, 'mod_kick', { member: 'alice' })).toMatchObject({ ok: false });
    expect(build(r, 'mod_ban', { member: U, days: '5' })).toMatchObject({ ok: true }); // the schema allows 7; the executor limit (1 day) refuses at propose
    expect(build(r, 'mod_timeout', { member: U, minutes: '99999' })).toMatchObject({ ok: false });
    expect(build(r, 'automod_rule', { name: 'x', keywords: 'a,b', actions: 'delete-everything' })).toMatchObject({ ok: false });
    expect(build(r, 'server_event', { name: 'e', type: 'party', where: 'x', start: 'now' })).toMatchObject({ ok: false });
    expect(build(r, 'welcome_set', { raid: 'many' })).toMatchObject({ ok: false });
    expect(build(r, 'welcome_set', { roleIds: 'staff' })).toMatchObject({ ok: false });
    // range and template rules are enforced by the planner at propose and apply (tested in console.server.int.test.ts), not by the form
  });
  it('welcome_set goes the admin_op way; automod, server settings and events go the server way', () => {
    const { r } = reg();
    expect(build(r, 'welcome_set', { enabled: 'yes', message: 'Welcome {user}!', channelId: '700000000000000001' })).toMatchObject({ ok: true, kind: 'admin_op', raw: { op: 'welcome_set', enabled: true } });
    expect(build(r, 'automod_rule', { name: 'links', keywords: 'free nitro, steam gift', actions: 'block, alert, timeout=600' })).toMatchObject({ ok: true, kind: 'server' });
    expect(build(r, 'server_settings', { name: 'Lab Two', description: '-' })).toMatchObject({ ok: true, kind: 'server', raw: [{ kind: 'guild.edit', name: 'Lab Two', description: null }] });
    expect(build(r, 'server_event', { name: 'Demo', type: 'external', where: 'https://example.org/x', start: '2026-12-01T18:00:00Z', end: '2026-12-01T19:00:00Z' })).toMatchObject({ ok: true, kind: 'server' });
  });
  it('the server family reports its executor readiness as the capability', async () => {
    const r = new SettingsRegistry();
    r.bindConsole({ proposeConfig: async () => ({ ok: true, text: '' }), proposeOp: async () => ({ ok: true, text: '' }), proposePerm: async () => ({ ok: true, text: '' }), proposeServer: async () => ({ ok: true, text: '' }) } as never, undefined, async () => 'the executor (LW Admin) is not running');
    expect((await r.capabilities()).server).toBe('the executor (LW Admin) is not running');
  });
});

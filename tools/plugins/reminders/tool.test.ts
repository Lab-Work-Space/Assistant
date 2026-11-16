import { describe, expect, it, vi } from 'vitest';
import { FakeConfig } from '../../../governance/test-helpers.js';
import { toGeminiSchema } from '../../../providers/gemini/convert.js';
import { ToolRegistry } from '../../registry.js';
import { registerGroups } from '../index.js';
import type { PluginDeps } from '../deps.js';
import { webRig } from '../web/test-helpers.js';
import { remindersGroup } from './index.js';

const NOW = Date.parse('2026-11-01T10:00:00Z');
const GUILD = 'g1';
function setup(origin: 'chat' | 'slash' | 'voice' | 'schedule' | 'delegated' = 'chat', userId: string | null = 'u1') {
  const added: { r: Record<string, unknown>; caps: unknown }[] = [];
  const reminders = {
    add: vi.fn(async (r: Record<string, unknown>, caps: unknown) => { added.push({ r, caps }); return { id: 7, ...r }; }),
    list: vi.fn(async () => []), cancel: vi.fn(async () => true),
  };
  const deps = { env: { guildId: GUILD }, cfg: new FakeConfig(), log: { warn: vi.fn() }, clock: () => NOW, reminders } as unknown as PluginDeps;
  const g = remindersGroup(deps);
  if ('disabled' in g) throw new Error('disabled');
  return { g, reminders, added, deps, rig: () => webRig(g.tools, { direct: true, origin, source: { channelId: 'c1', threadId: null, messageId: null, userId, attachments: [] } }) };
}

describe('reminder tools', () => {
  it('when: offset-less ISO uses schedule.timezone; offset and Z honored', async () => {
    const t = setup();
    const { reg, c } = await t.rig();
    for (const when of ['2026-11-02T09:00', '2026-11-02T09:00+07:00', '2026-11-02T02:00:00Z']) {
      expect((await reg.run('add_reminder', { text: 'x', when }, c)).isError, when).toBeFalsy();
    }
    expect(t.added.map((a) => (a.r.remindAt as Date).toISOString())).toEqual(['2026-11-02T02:00:00.000Z', '2026-11-02T02:00:00.000Z', '2026-11-02T02:00:00.000Z']);
    const other = setup();
    (other.deps.cfg as unknown as FakeConfig).values.set('schedule.timezone', 'UTC');
    const r2 = await other.rig();
    await r2.reg.run('add_reminder', { text: 'x', when: '2026-11-02T09:00' }, r2.c);
    expect((other.added[0]!.r.remindAt as Date).toISOString()).toBe('2026-11-02T09:00:00.000Z');
  });

  it('tool › add rejects past time, over 1 year, every<1', async () => {
    const t = setup();
    const { reg, c } = await t.rig();
    const bad = [
      { text: 'x', when: '2026-11-01T09:00:00Z' },
      { text: 'x', when: { inMinutes: 366 * 24 * 60 } },
      { text: 'x', when: '2027-12-01T00:00:00Z' },
      { text: 'x', when: { inMinutes: 10 }, everyMinutes: 0 },
      { text: 'x', when: { inMinutes: 0 } },
      { text: 'x', when: 'not a date' },
      { text: 'x', when: 'tomorrow at 9' },
      { text: 'x', when: '2026-11-02' },
      { text: 'x', when: 'Nov 2 2026 09:00' },
      { text: 'x', when: { inMinutes: 10 }, everyMinutes: 525_601 },
    ];
    for (const input of bad) expect((await reg.run('add_reminder', input, c)).isError, JSON.stringify(input)).toBe(true);
    expect(t.reminders.add).not.toHaveBeenCalled();
    const ok = await reg.run('add_reminder', { text: 'x', when: { inMinutes: 10 }, everyMinutes: 5 }, c);
    expect(ok.isError).toBeFalsy();
  });

  it('userId and caps come from the trigger and config, never from tool input', async () => {
    const t = setup('chat', 'real-user');
    const { reg, c } = await t.rig();
    await reg.run('add_reminder', { text: 'hi', when: { inMinutes: 2 }, userId: 'attacker', user_id: 'attacker' }, c);
    expect(t.added[0]!.r).toMatchObject({ guildId: GUILD, channelId: 'c1', userId: 'real-user', text: 'hi', remindAt: new Date(NOW + 120_000) });
    expect(t.added[0]!.caps).toEqual({ perUser: 20, total: 500 });
    await reg.run('list_reminders', {}, c);
    expect(t.reminders.list).toHaveBeenCalledWith('real-user');
    await reg.run('cancel_reminder', { id: 3 }, c);
    expect(t.reminders.cancel).toHaveBeenCalledWith(3, 'real-user');
  });

  it('tool › add_reminder from a schedule/delegated origin refused', async () => {
    for (const origin of ['schedule', 'delegated', 'watch', 'reminder', 'poll', 'import'] as const) {
      const t = setup(origin as never);
      const { reg, c } = await t.rig();
      const res = await reg.run('add_reminder', { text: 'x', when: { inMinutes: 5 } }, c);
      expect(res.isError, origin).toBe(true);
      expect(t.reminders.add).not.toHaveBeenCalled();
    }
    const none = setup('chat', null);
    const { reg, c } = await none.rig();
    expect((await reg.run('add_reminder', { text: 'x', when: { inMinutes: 5 } }, c)).isError).toBe(true);
  });

  it('cap error is a tool error; kinds are read/write; schemas convert for Gemini', async () => {
    const t = setup();
    const { CapError } = await import('../../../db/repos/praw.js');
    t.reminders.add.mockRejectedValueOnce(new CapError('user', 20));
    const { reg, c } = await t.rig();
    const res = await reg.run('add_reminder', { text: 'x', when: { inMinutes: 5 } }, c);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/limit/i);
    expect(t.g.tools.map((x) => [x.name, x.kind])).toEqual([['add_reminder', 'write'], ['list_reminders', 'read'], ['cancel_reminder', 'write']]);
    const full = new ToolRegistry({ halt: { isHalted: () => false } });
    registerGroups(full, [remindersGroup], t.deps);
    for (const s of full.specsFor(full.names())) expect((toGeminiSchema(s.inputSchema) as { type?: string }).type, s.name).toBe('OBJECT');
  });

  it('group is disabled without a repo', () => {
    expect(remindersGroup({ cfg: new FakeConfig() } as unknown as PluginDeps)).toMatchObject({ id: 'reminders', disabled: expect.any(String) });
  });

  // LEARN-1 LL-C2
  it('LL-C2 › add_reminder refuses in a precheck after outside content: no card, no row', async () => {
    const t = setup();
    for (const how of ['run', 'task'] as const) {
      const { reg, c, approvals } = await t.rig();
      if (how === 'run') c.run.markTainted();
      else c.task = { ...c.task!, tainted: true };
      const ctx = how === 'run' ? c : { ...c, tainted: () => false };
      const r = await reg.run('add_reminder', { text: 'x', when: { inMinutes: 10 } }, ctx);
      expect(r.isError, how).toBe(true);
      expect(r.content).toBe('This cannot be set up after reading outside content; ask in a new message.');
      expect(approvals.request).not.toHaveBeenCalled();
    }
    expect(t.reminders.add).not.toHaveBeenCalled();
    const clean = await t.rig();
    expect((await clean.reg.run('add_reminder', { text: 'x', when: { inMinutes: 10 } }, clean.c)).isError).toBeFalsy();
  });
});

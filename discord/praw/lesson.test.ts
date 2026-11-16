import { describe, expect, it, vi } from 'vitest';
import { PrawRateLimit } from '../../agents/call/rate.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { memLessons } from '../../tools/plugins/lessons/test-helpers.js';
import { ADMIN_ROLE, GUILD, cmd, text } from '../commands/test-helpers.js';
import { handlePrawInteraction, prawCommandDeps, PRAW_COMMANDS } from './index.js';

const NOW = Date.parse('2026-11-01T10:00:00Z');
function mk(seed: Parameters<typeof memLessons>[0] = []) {
  const cfg = new FakeConfig();
  const lessons = memLessons(seed);
  const audits: Record<string, unknown>[] = [];
  const deps = prawCommandDeps({
    guildId: GUILD, adminRoleId: ADMIN_ROLE, org: { dept: () => null }, cfg, rate: new PrawRateLimit(cfg, () => NOW), ask: vi.fn() as never,
    audit: async (e) => void audits.push(e as never), log: { error: () => undefined }, reminders: {} as never, schedules: {} as never, clock: () => NOW,
    lessons: lessons as never,
  });
  return { deps, lessons, audits };
}
const lesson = (sub: string, o: Parameters<typeof cmd>[2] = {}) => cmd('lesson', sub, { channelId: '555', ...o });
const MEMBER = { roles: [] as string[] };
const ADMIN = { roles: [ADMIN_ROLE] };

describe('/lesson', () => {
  it('is registered with add/list/remove/enable/disable', () => {
    const r = PRAW_COMMANDS.find((c) => c.name === 'lesson') as { options?: { name: string }[] } | undefined;
    expect(r?.options?.map((o) => o.name)).toEqual(['add', 'list', 'remove', 'enable', 'disable']);
  });

  it('commands › /lesson add by non-admin refused; remove by non-admin refused', async () => {
    const t = mk([{ text: 'keep me', source: 'manual' }]);
    const add = lesson('add', { ...MEMBER, strings: { text: 'be nice' } });
    const r1 = await handlePrawInteraction(add, t.deps);
    expect(r1?.ephemeral).toBe(true);
    expect(text(r1)).toMatch(/Bot Admin/);
    const r2 = await handlePrawInteraction(lesson('remove', { ...MEMBER, numbers: { id: 1 } }), t.deps);
    expect(text(r2)).toMatch(/Bot Admin/);
    for (const sub of ['enable', 'disable']) expect(text(await handlePrawInteraction(lesson(sub, { ...MEMBER, numbers: { id: 1 } }), t.deps))).toMatch(/Bot Admin/);
    expect(t.lessons.add).not.toHaveBeenCalled();
    expect(t.lessons.remove).not.toHaveBeenCalled();
    expect(t.lessons.setActive).not.toHaveBeenCalled();
    expect(t.lessons.rows).toHaveLength(1);
  });

  it('/lesson › admin add stores source manual; list open to members; admin remove', async () => {
    const t = mk();
    const add = lesson('add', { ...ADMIN, strings: { text: 'Answer in Thai when asked in Thai.' } });
    const r = await handlePrawInteraction(add, t.deps);
    expect(add.deferred).toEqual({ ephemeral: true });
    expect(text(r)).toMatch(/#1/);
    expect(t.lessons.add.mock.calls[0]![0]).toEqual({ text: 'Answer in Thai when asked in Thai.', source: 'manual', authorId: 'u1', origin: 'slash' });
    expect(t.audits).toContainEqual(expect.objectContaining({ action: 'lesson.add', actor: 'user:u1', outcome: 'ok' }));
    const list = await handlePrawInteraction(lesson('list', { ...MEMBER, userId: 'u2' }), t.deps);
    expect(list?.ephemeral).toBe(true);
    expect(text(list)).toContain('Answer in Thai');
    expect(text(await handlePrawInteraction(lesson('remove', { ...ADMIN, numbers: { id: 1 } }), t.deps))).toMatch(/removed/i);
    expect(t.lessons.remove).toHaveBeenCalledWith(1); // no scope: the admin path
    expect(t.audits).toContainEqual(expect.objectContaining({ action: 'lesson.remove', tool: '1', outcome: 'ok' }));
    expect(text(await handlePrawInteraction(lesson('remove', { ...ADMIN, numbers: { id: 1 } }), t.deps))).toMatch(/No lesson/);
  });

  it('add refuses text over the per-lesson cap and redacts secrets', async () => {
    const t = mk();
    expect(text(await handlePrawInteraction(lesson('add', { ...ADMIN, strings: { text: 'x'.repeat(501) } }), t.deps))).toMatch(/500/);
    await handlePrawInteraction(lesson('add', { ...ADMIN, strings: { text: 'token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' } }), t.deps);
    expect(t.lessons.add.mock.calls[0]![0].text).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('PF14 › imported lessons start inactive; only a Bot Admin enables them (audited); members do not see them', async () => {
    const t = mk([{ text: 'imported lesson', source: 'import', origin: 'import', active: false }]);
    expect(text(await handlePrawInteraction(lesson('list', MEMBER), t.deps))).not.toContain('imported lesson');
    expect(text(await handlePrawInteraction(lesson('list', ADMIN), t.deps))).toContain('imported lesson');
    expect(text(await handlePrawInteraction(lesson('enable', { ...ADMIN, numbers: { id: 1 } }), t.deps))).toMatch(/enabled/i);
    expect(t.lessons.rows[0]!.active).toBe(true);
    expect(t.audits).toContainEqual(expect.objectContaining({ action: 'lesson.enable', tool: '1', outcome: 'ok' }));
    await handlePrawInteraction(lesson('disable', { ...ADMIN, numbers: { id: 1 } }), t.deps);
    expect(t.lessons.rows[0]!.active).toBe(false);
    expect(text(await handlePrawInteraction(lesson('enable', { ...ADMIN, numbers: { id: 99 } }), t.deps))).toMatch(/No lesson/);
  });
});

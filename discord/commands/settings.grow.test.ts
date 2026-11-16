import { describe, expect, it } from 'vitest';
import { handleInteraction } from './index.js';
import { cmd, makeDeps, text } from './test-helpers.js';

const set = (key: string, value: string, roles?: string[]) => cmd('settings', 'set', { strings: { key, value }, ...(roles ? { roles } : {}) });

describe('GROW-1: /settings and the grow.retro keys', () => {
  it('weekday and hour are psql only and write nothing', async () => {
    const t = await makeDeps();
    for (const k of ['grow.retro.weekday', 'grow.retro.hour']) expect(text(await handleInteraction(set(k, '3'), t.deps)), k).toContain('the owner sets it in the database');
    expect(t.sets).toHaveLength(0);
  });
  it('the switch: junk and no-op refused; off is stored without a risk notice; on is a risk', async () => {
    const notes: string[] = [];
    const t = await makeDeps({ settings: { notice: async (s) => void notes.push(s), channels: async () => [] } });
    expect(t.deps.cfg.get('grow.retro.enabled')).toBe(true);
    expect(text(await handleInteraction(set('grow.retro.enabled', 'maybe'), t.deps))).toContain('true or false');
    expect(text(await handleInteraction(set('grow.retro.enabled', 'true'), t.deps))).toContain('No change');
    await handleInteraction(set('grow.retro.enabled', 'false'), t.deps);
    expect(t.deps.cfg.get('grow.retro.enabled')).toBe(false);
    expect(t.audits.at(-1)).toMatchObject({ action: 'config.set', tool: 'grow.retro.enabled', outcome: 'ok' });
    expect(notes).toHaveLength(0);
    await handleInteraction(set('grow.retro.enabled', 'true'), t.deps);
    expect(notes.join('\n')).toContain('grow.retro.enabled');
  });
  it('a non-Bot-Admin cannot flip it', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(set('grow.retro.enabled', 'false', []), t.deps))).toContain('Only Bot Admins');
    expect(t.deps.cfg.get('grow.retro.enabled')).toBe(true);
  });
  it('GROW-1: skills.ai.enabled — switch only, junk and no-op refused, on is a risk, off is not, non-admin refused', async () => {
    const notes: string[] = [];
    const t = await makeDeps({ settings: { notice: async (s) => void notes.push(s), channels: async () => [] } });
    expect(t.deps.cfg.get('skills.ai.enabled')).toBe(false);
    expect(text(await handleInteraction(set('skills.ai.enabled', 'maybe'), t.deps))).toContain('true or false');
    expect(text(await handleInteraction(set('skills.ai.enabled', 'false'), t.deps))).toContain('No change');
    expect(text(await handleInteraction(set('skills.ai.enabled', 'true', []), t.deps))).toContain('Only Bot Admins');
    expect(t.deps.cfg.get('skills.ai.enabled')).toBe(false);
    await handleInteraction(set('skills.ai.enabled', 'true'), t.deps);
    expect(t.deps.cfg.get('skills.ai.enabled')).toBe(true);
    expect(t.audits.at(-1)).toMatchObject({ action: 'config.set', tool: 'skills.ai.enabled', outcome: 'ok' });
    expect(notes.join('\n')).toContain('skills.ai.enabled');
    notes.length = 0;
    await handleInteraction(set('skills.ai.enabled', 'off'), t.deps);
    expect(t.deps.cfg.get('skills.ai.enabled')).toBe(false);
    expect(notes).toHaveLength(0);
    for (const k of ['skills.ai.maxPerDeptWeek', 'skills.ai.maxPerWeek']) expect(text(await handleInteraction(set(k, '3'), t.deps)), k).toContain('the owner sets it in the database');
  });
});

import { describe, expect, it } from 'vitest';
import { handleInteraction } from './index.js';
import { cmd, makeDeps, text } from './test-helpers.js';

const set = (key: string, value: string, roles?: string[]) => cmd('settings', 'set', { strings: { key, value }, ...(roles ? { roles } : {}) });

describe('AI-APPROVE-1: /settings and the approval.ai keys (AA-C17)', () => {
  it('the caps use the database wording and write nothing', async () => {
    const t = await makeDeps();
    for (const k of ['approval.ai.maxPerTree', 'approval.ai.maxPerDay']) {
      expect(text(await handleInteraction(set(k, '3'), t.deps)), k).toContain('the owner sets the AI approval caps in the database');
    }
    expect(t.sets).toHaveLength(0);
  });
  it('the switch defaults to false; on is stored, audited and notified as a risk; junk and no-op are refused', async () => {
    const notes: string[] = [];
    const t = await makeDeps({ settings: { notice: async (s) => void notes.push(s), channels: async () => [] } });
    expect(t.deps.cfg.get('approval.ai.enabled')).toBe(false);
    expect(text(await handleInteraction(set('approval.ai.enabled', 'maybe'), t.deps))).toContain('true or false');
    expect(text(await handleInteraction(set('approval.ai.enabled', 'false'), t.deps))).toContain('No change');
    await handleInteraction(set('approval.ai.enabled', 'true'), t.deps);
    expect(t.deps.cfg.get('approval.ai.enabled')).toBe(true);
    expect(t.sets.at(-1)).toMatchObject({ key: 'approval.ai.enabled', value: true, by: 'user:u1' });
    expect(t.audits.at(-1)).toMatchObject({ action: 'config.set', tool: 'approval.ai.enabled', outcome: 'ok' });
    expect(notes.join('\n')).toContain('approval.ai.enabled');
    notes.length = 0;
    await handleInteraction(set('approval.ai.enabled', 'false'), t.deps);
    expect(t.deps.cfg.get('approval.ai.enabled')).toBe(false);
    expect(notes).toHaveLength(0); // turning it off is no risk
  });
  it('a non-Bot-Admin cannot flip it', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(set('approval.ai.enabled', 'true', []), t.deps))).toContain('Only Bot Admins');
    expect(t.deps.cfg.get('approval.ai.enabled')).toBe(false);
  });
});

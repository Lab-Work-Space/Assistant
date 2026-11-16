import { describe, expect, it } from 'vitest';
import { handleInteraction } from './index.js';
import { cmd, makeDeps, text } from './test-helpers.js';

const set = (key: string, value: string, roles?: string[]) => cmd('settings', 'set', { strings: { key, value }, ...(roles ? { roles } : {}) });

describe('HEAL-1: /settings and the heal keys', () => {
  it('the caps and the quiet settings are not set with /settings: database wording, nothing written', async () => {
    const t = await makeDeps();
    for (const k of ['heal.maxRetries', 'heal.maxWakesPerTask', 'heal.maxWakesPerDeciderDay', 'warroom.stallQuietMinutes', 'warroom.quietLiftsPerDay', 'warroom.personLiftsPerDay']) {
      expect(text(await handleInteraction(set(k, '3'), t.deps)), k).toContain('the owner sets the heal caps in the database');
    }
    expect(t.sets).toHaveLength(0);
  });
  it('heal.enabled false is accepted, stored and audited; on again is accepted; junk and no-op are refused', async () => {
    const t = await makeDeps();
    await handleInteraction(set('heal.enabled', 'false'), t.deps);
    expect(t.deps.cfg.get('heal.enabled')).toBe(false);
    expect(t.sets.at(-1)).toMatchObject({ key: 'heal.enabled', value: false, by: 'user:u1' });
    expect(t.audits.at(-1)).toMatchObject({ actor: 'user:u1', action: 'config.set', tool: 'heal.enabled', outcome: 'ok' });
    expect(text(await handleInteraction(set('heal.enabled', 'maybe'), t.deps))).toContain('true or false');
    expect(text(await handleInteraction(set('heal.enabled', 'false'), t.deps))).toContain('No change');
    await handleInteraction(set('heal.enabled', 'true'), t.deps);
    expect(t.deps.cfg.get('heal.enabled')).toBe(true);
  });
  it('a non-Bot-Admin cannot flip it', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(set('heal.enabled', 'false', []), t.deps))).toContain('Only Bot Admins');
    expect(t.deps.cfg.get('heal.enabled')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { handleInteraction } from './index.js';
import { cmd, makeDeps, text } from './test-helpers.js';

const set = (key: string, value: string, roles?: string[]) => cmd('settings', 'set', { strings: { key, value }, ...(roles ? { roles } : {}) });

describe('R7 PLUGIN-FORGE: /settings and forge.enabled (spec 5.10, FG-AC17)', () => {
  it('has a /settings path: on is stored, audited and posts the risk notice; junk and a no-op are refused', async () => {
    const t = await makeDeps();
    const notices: string[] = [];
    t.deps.settings = { notice: async (s: string) => void notices.push(s), channels: async () => [] };
    expect(t.deps.cfg.get('forge.enabled')).toBe(false);
    expect(text(await handleInteraction(set('forge.enabled', 'maybe'), t.deps))).toContain('true or false');
    expect(text(await handleInteraction(set('forge.enabled', 'false'), t.deps))).toContain('No change');
    await handleInteraction(set('forge.enabled', 'true'), t.deps);
    expect(t.deps.cfg.get('forge.enabled')).toBe(true);
    expect(t.sets.at(-1)).toMatchObject({ key: 'forge.enabled', value: true, by: 'user:u1' });
    expect(t.audits.at(-1)).toMatchObject({ actor: 'user:u1', action: 'config.set', tool: 'forge.enabled', outcome: 'ok' });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('forge.enabled');
    await handleInteraction(set('forge.enabled', 'off'), t.deps);
    expect(t.deps.cfg.get('forge.enabled')).toBe(false);
    expect(notices).toHaveLength(1);
  });
  it('a non-Bot-Admin cannot flip it', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(set('forge.enabled', 'true', []), t.deps))).toContain('Only Bot Admins');
    expect(t.deps.cfg.get('forge.enabled')).toBe(false);
  });
});

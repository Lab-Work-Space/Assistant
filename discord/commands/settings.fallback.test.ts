import { describe, expect, it } from 'vitest';
import { handleInteraction } from './index.js';
import { cmd, makeDeps, text } from './test-helpers.js';

const set = (key: string, value: string, roles?: string[]) => cmd('settings', 'set', { strings: { key, value }, ...(roles ? { roles } : {}) });

describe('R8 PROV-FALLBACK: /settings and provider.fallback.enabled (a clone of ws.enabled and forge.enabled)', () => {
  it('on is stored, audited and posts the risk notice; junk and a no-op are refused; off is direct with no notice', async () => {
    const t = await makeDeps();
    const notices: string[] = [];
    t.deps.settings = { notice: async (s: string) => void notices.push(s), channels: async () => [] };
    expect(t.deps.cfg.get('provider.fallback.enabled')).toBe(false);
    expect(text(await handleInteraction(set('provider.fallback.enabled', 'maybe'), t.deps))).toContain('true or false');
    expect(text(await handleInteraction(set('provider.fallback.enabled', 'false'), t.deps))).toContain('No change');
    await handleInteraction(set('provider.fallback.enabled', 'true'), t.deps);
    expect(t.deps.cfg.get('provider.fallback.enabled')).toBe(true);
    expect(t.sets.at(-1)).toMatchObject({ key: 'provider.fallback.enabled', value: true, by: 'user:u1' });
    expect(t.audits.at(-1)).toMatchObject({ actor: 'user:u1', action: 'config.set', tool: 'provider.fallback.enabled', outcome: 'ok' });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('provider.fallback.enabled');
    await handleInteraction(set('provider.fallback.enabled', 'off'), t.deps);
    expect(t.deps.cfg.get('provider.fallback.enabled')).toBe(false);
    expect(notices).toHaveLength(1);
  });
  it('a non-Bot-Admin cannot flip it', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(set('provider.fallback.enabled', 'true', []), t.deps))).toContain('Only Bot Admins');
    expect(t.deps.cfg.get('provider.fallback.enabled')).toBe(false);
  });
});

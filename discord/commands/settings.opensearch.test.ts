import { describe, expect, it } from 'vitest';
import { handleInteraction } from './index.js';
import { cmd, makeDeps, text } from './test-helpers.js';

const set = (key: string, value: string, roles?: string[]) => cmd('settings', 'set', { strings: { key, value }, ...(roles ? { roles } : {}) });

describe('SEARCH-1: /settings web.search.openSources', () => {
  it('default is on; false is accepted, stored, audited; on again is a risk plan; junk and no-op are refused', async () => {
    const t = await makeDeps();
    expect(t.deps.cfg.get('web.search.openSources')).toBe(true);
    await handleInteraction(set('web.search.openSources', 'false'), t.deps);
    expect(t.deps.cfg.get('web.search.openSources')).toBe(false);
    expect(t.sets.at(-1)).toMatchObject({ key: 'web.search.openSources', value: false, by: 'user:u1' });
    expect(t.audits.at(-1)).toMatchObject({ actor: 'user:u1', action: 'config.set', tool: 'web.search.openSources', outcome: 'ok' });
    expect(text(await handleInteraction(set('web.search.openSources', 'maybe'), t.deps))).toContain('true or false');
    expect(text(await handleInteraction(set('web.search.openSources', 'false'), t.deps))).toContain('No change');
    await handleInteraction(set('web.search.openSources', 'true'), t.deps);
    expect(t.deps.cfg.get('web.search.openSources')).toBe(true);
  });
  it('a non-Bot-Admin cannot flip it', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(set('web.search.openSources', 'false', []), t.deps))).toContain('Only Bot Admins');
    expect(t.deps.cfg.get('web.search.openSources')).toBe(true);
  });
});

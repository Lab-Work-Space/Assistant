import { describe, expect, it } from 'vitest';
import { handleInteraction } from './index.js';
import { cmd, makeDeps, text } from './test-helpers.js';

const quota = { snapshot: { status: 'allowed' as const, rateLimitType: 'seven_day' as const, windows: { seven_day: { utilization: 0.5, resetsAt: 1794614400, status: 'allowed' as const } } }, observedAt: new Date('2026-10-31T11:00:00Z') };

// R8 PROV-FALLBACK, BE2: the "Backup:" line of /usage range:quota (fixed format, numbers and enums only).
describe('R8 /usage range:quota backup line', () => {
  it('appends the line the app supplies; nothing changes without it', async () => {
    const with_ = await makeDeps({ quota: { latest: () => quota } });
    with_.deps.fallback = { line: async () => 'Backup: off · route: subscription · Claude API today $0.00 / company cap $50.00' };
    const r = text(await handleInteraction(cmd('usage', null, { strings: { range: 'quota' } }), with_.deps));
    expect(r).toContain('Backup: off · route: subscription · Claude API today $0.00 / company cap $50.00');
    const without = await makeDeps({ quota: { latest: () => quota } });
    expect(text(await handleInteraction(cmd('usage', null, { strings: { range: 'quota' } }), without.deps))).not.toContain('Backup');
  });
  it('a null line (no key, or no local provider) and a throwing line add nothing and never fail the answer', async () => {
    for (const line of [async () => null, async () => { throw new Error('db'); }]) {
      const t = await makeDeps({ quota: { latest: () => quota } });
      t.deps.fallback = { line };
      const r = text(await handleInteraction(cmd('usage', null, { strings: { range: 'quota' } }), t.deps));
      expect(r).not.toContain('Backup');
      expect(r).toContain('Weekly');
    }
  });
});

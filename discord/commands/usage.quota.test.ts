import { describe, expect, it } from 'vitest';
import { COMMANDS, handleInteraction } from './index.js';
import { cmd, makeDeps, text } from './test-helpers.js';

const quota = { snapshot: { status: 'allowed' as const, rateLimitType: 'seven_day' as const, windows: { seven_day: { utilization: 0.91, resetsAt: 1794614400, status: 'allowed_warning' as const } } }, observedAt: new Date('2026-10-31T11:00:00Z') };

describe('USAGE-1 /usage', () => {
  it('has a quota range choice', () => {
    const u = COMMANDS.find((c) => c.name === 'usage');
    expect(JSON.stringify(u)).toContain('"value":"quota"');
  });
  it('range:quota shows the windows, or no data yet', async () => {
    const t = await makeDeps({ quota: { latest: () => quota } });
    const r = text(await handleInteraction(cmd('usage', null, { strings: { range: 'quota' } }), t.deps));
    expect(r).toContain('Claude subscription (shared by the bots)');
    expect(r).toContain('Weekly: 91.0% (allowed_warning), resets <t:1794614400:R>');
    expect(r).toContain('Asia/Bangkok');
    const n = await makeDeps({ quota: { latest: () => null } });
    expect(text(await handleInteraction(cmd('usage', null, { strings: { range: 'quota' } }), n.deps))).toContain('No data yet.');
  });
  it('today and week carry the quota block first and the per-actor calls and tokens', async () => {
    let since: Date | undefined;
    const t = await makeDeps({
      quota: { latest: () => quota },
      llmUsage: { byActor: async (s) => { since = s; return [{ actor: 'head:hq', calls: 1234, tokensIn: 5000, tokensOut: 700, costUsd: 0 }, { actor: 'persona:system-analyst', calls: 2, tokensIn: 10, tokensOut: 5, costUsd: 0.5 }]; } },
    });
    const today = text(await handleInteraction(cmd('usage', null, { strings: { range: 'today' } }), t.deps));
    expect(today.indexOf('Claude subscription')).toBeLessThan(today.indexOf('$1.5000 spent'));
    expect(today).toContain('head:hq: 1,234 calls, 5,000 in / 700 out tokens, $0.0000');
    expect(today).toContain('persona:system-analyst: 2 calls, 10 in / 5 out tokens, $0.5000');
    expect(since?.toISOString()).toBe('2026-10-31T00:00:00.000Z');
    await handleInteraction(cmd('usage', null, { strings: { range: 'week' } }), t.deps);
    expect(since?.toISOString()).toBe('2026-10-25T00:00:00.000Z');
  });
  it('a failing audit query still answers', async () => {
    const t = await makeDeps({ llmUsage: { byActor: async () => { throw new Error('db'); } } });
    expect(text(await handleInteraction(cmd('usage', null), t.deps))).toContain('$1.5000 spent');
  });
  it('OPS-HOLD: range:quota says "Held" while a window is rejected (reset still ahead), and not otherwise', async () => {
    const rejected = { snapshot: { status: 'rejected' as const, rateLimitType: 'seven_day' as const, windows: { seven_day: { utilization: 1, resetsAt: 1794614400, status: 'rejected' as const } } }, observedAt: new Date('2026-10-31T11:00:00Z') };
    const t = await makeDeps({ quota: { latest: () => rejected } });
    const r = text(await handleInteraction(cmd('usage', null, { strings: { range: 'quota' } }), t.deps));
    expect(r).toContain('Held: Claude-backed bots wait until <t:1794614460:R>');
    const ok = await makeDeps({ quota: { latest: () => quota } });
    expect(text(await handleInteraction(cmd('usage', null, { strings: { range: 'quota' } }), ok.deps))).not.toContain('Held');
  });
});

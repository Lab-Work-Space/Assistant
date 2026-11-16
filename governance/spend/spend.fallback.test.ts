import { describe, expect, it } from 'vitest';
import { FakeConfig } from '../test-helpers.js';
import { summaryRenderer, type SpendRepo, type TrendRow } from './spend.js';

// R8 PROV-FALLBACK, BE2: the weekly summary carries the metered Claude API line only when the backup switch is on and the API was used.
const row = (day: string, provider: string, usd: number, calls: number): TrendRow => ({ day, deptId: 'software', provider, tool: 'agent', usd, calls });
const repoOf = (trend: TrendRow[]): SpendRepo => ({
  trend: async (from: string, to: string) => trend.filter((r) => r.day >= from && r.day <= to),
  topRoots: async () => [],
  deptMtd: async () => new Map(),
}) as unknown as SpendRepo;
const NOW = Date.parse('2026-11-17T03:00:00Z'); // Tuesday of ISO week 47; the previous week is 2026-11-09 .. 2026-11-15
const overrides = { effectiveCap: async () => Infinity };
const render = async (cfg: FakeConfig, trend: TrendRow[]) => (await summaryRenderer(repoOf(trend), overrides, cfg as never, () => NOW)({ period: '2026-W47' })).body;

describe('R8 weekly summary line', () => {
  const trend = [row('2026-11-10', 'claude', 3.2, 10), row('2026-11-12', 'claude', 9.1456, 30), row('2026-11-12', 'claude-code-local', 0, 200), row('2026-11-02', 'claude', 99, 99)];

  it('switch on with API calls last week: one fixed line with the totals of that week only', async () => {
    const body = await render(new FakeConfig({ 'provider.fallback.enabled': true }), trend);
    expect(body).toContain('Claude API (metered) last week: $12.35, 40 calls');
  });
  it('switch off, or no API calls last week: the summary is unchanged', async () => {
    expect(await render(new FakeConfig(), trend)).not.toContain('Claude API');
    expect(await render(new FakeConfig({ 'provider.fallback.enabled': true }), [row('2026-11-12', 'claude-code-local', 0, 5)])).not.toContain('Claude API');
  });
});

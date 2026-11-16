import { describe, expect, it } from 'vitest';
import { PRAW_DEFAULT_MODEL } from '../company/seed.js';
import { CONFIG_DEFAULTS } from '../config/defaults.js';
import { newBus } from '../agents/test-helpers.js';
import { FakeConfig } from './test-helpers.js';
import { Budget } from './budget.js';

const mk = (pricing: Record<string, { inPerMTok: number; outPerMTok: number; cacheReadPerMTok?: number }>) =>
  new Budget(null as never, new FakeConfig({ pricing }) as never, newBus());

describe('budget costOf (P11, PF16)', () => {
  it('counts cached and thinking tokens; audio/image billed at input price', () => {
    const b = mk({ g: { inPerMTok: 1, outPerMTok: 10, cacheReadPerMTok: 0.1 } });
    // T3 folds thinking into outputTokens, and audio/image prompt tokens into inputTokens (billed at the input price).
    const cost = b.costOf('g', { inputTokens: 1_000_000, outputTokens: 500_000 + 250_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 0 });
    expect(cost).toBeCloseTo(1 + 7.5 + 0.2, 9);
  });

  it('cached tokens fall back to the input price when no cached price is set', () => {
    expect(mk({ g: { inPerMTok: 2, outPerMTok: 4 } }).costOf('g', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 })).toBeCloseTo(2, 9);
  });

  it('the default pricing prices the praw model including cached tokens', () => {
    const p = CONFIG_DEFAULTS.pricing[PRAW_DEFAULT_MODEL];
    expect(p).toMatchObject({ inPerMTok: expect.any(Number), outPerMTok: expect.any(Number), cacheReadPerMTok: expect.any(Number) });
    expect(p!.cacheReadPerMTok!).toBeLessThan(p!.inPerMTok);
  });
});

import { describe, expect, it } from 'vitest';
import { FakeConfig } from '../../governance/test-helpers.js';
import { VisionCap } from './vision.js';

const DAY = 24 * 60 * 60 * 1000;

describe('VisionCap (P15)', () => {
  it('counts per user per UTC day; peek never consumes; the next day starts clean', () => {
    const cfg = new FakeConfig({ 'limits.visionPerUserDay': 2 });
    let now = Date.UTC(2026, 10, 1, 12);
    const v = new VisionCap(cfg, () => now);
    expect(v.peek('a')).toBe(true);
    expect(v.take('a')).toBe(true);
    expect(v.take('a')).toBe(true);
    expect(v.peek('a')).toBe(false);
    expect(v.take('a')).toBe(false);
    expect(v.take('b')).toBe(true); // per user
    now += DAY;
    expect(v.peek('a')).toBe(true);
    expect(v.take('a')).toBe(true);
  });

  it('reads the limit live (raising it frees the user)', async () => {
    const cfg = new FakeConfig({ 'limits.visionPerUserDay': 1 });
    const v = new VisionCap(cfg, () => 0);
    v.take('a');
    expect(v.peek('a')).toBe(false);
    await cfg.set('limits.visionPerUserDay', 3, 'test');
    expect(v.peek('a')).toBe(true);
  });
});

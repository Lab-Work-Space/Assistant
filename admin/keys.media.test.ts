import { describe, expect, it } from 'vitest';
import { ConfigSchema } from '../config/schema.js';
import { ADMIN_CONFIG_KEYS, configRisk, requiresCard } from './keys.js';

const PRICES = ['media.image.inPerMTok', 'media.image.textOutPerMTok', 'media.image.imageOutPerMTok', 'media.video.inPerMTok', 'media.video.textOutPerMTok', 'media.video.videoOutPerMTok'] as const;

describe('RFMD P5 RF28/M2: media keys', () => {
  it('a lowered price and a raised cap are high risk; a raised price or a lowered cap is not', () => {
    for (const k of PRICES) {
      expect(configRisk(k, 30, 20), k).toBe(true);
      expect(configRisk(k, 30, 40), k).toBe(false);
    }
    for (const k of ['media.imagesPerDay', 'media.videosPerDay', 'media.imagesPerPersonPerDay', 'media.videosPerPersonPerDay'] as const) {
      expect(configRisk(k, 5, 6), k).toBe(true);
      expect(configRisk(k, 5, 4), k).toBe(false);
    }
  });
  it('every media price and cap change goes through a card, never a direct /settings write', () => {
    for (const k of [...PRICES, 'media.imagesPerDay', 'media.videosPerDay', 'media.imagesPerPersonPerDay', 'media.videosPerPersonPerDay'] as const) {
      expect(requiresCard(k, 1, 2), k).toBe(true);
      expect(ADMIN_CONFIG_KEYS).toContain(k); // reachable through config_propose, which is a Bot Admin card
    }
  });
  it('M2: each price has a floor at 50 % of list; below it, zero, negative and NaN are invalid; the list price is valid', () => {
    const floors: Record<string, number> = { 'media.image.inPerMTok': 0.75, 'media.image.textOutPerMTok': 3.75, 'media.image.imageOutPerMTok': 15, 'media.video.inPerMTok': 0.75, 'media.video.textOutPerMTok': 4.5, 'media.video.videoOutPerMTok': 6 };
    for (const k of PRICES) {
      expect(ConfigSchema[k].safeParse(floors[k]).success, k).toBe(true);
      expect(ConfigSchema[k].safeParse(floors[k]! - 0.01).success, k).toBe(false);
      for (const bad of [0, -1, Number.NaN, Infinity]) expect(ConfigSchema[k].safeParse(bad).success, `${k} ${bad}`).toBe(false);
    }
  });
  it('M2: the removed per-unit keys are gone from the schema', () => {
    expect(Object.keys(ConfigSchema)).not.toContain('media.imageUsd');
    expect(Object.keys(ConfigSchema)).not.toContain('media.videoUsdPerSecond');
  });
  it('duties.byDept changes stay high risk (RF36)', () => {
    expect(configRisk('duties.byDept', { sales: ['sales'] }, { sales: ['sales', 'finance'] })).toBe(true);
  });
});

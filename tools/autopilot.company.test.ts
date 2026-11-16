import { describe, expect, it } from 'vitest';
import { AUTOPILOT_REFUSAL, AUTOPILOT_REFUSAL_COMPANY } from './autopilot.js';

describe('AUTOPILOT_REFUSAL_COMPANY (AUTO-2 5.5)', () => {
  it('has every project code, frozen, with the company prefix and no interpolation', () => {
    expect(Object.keys(AUTOPILOT_REFUSAL_COMPANY).sort()).toEqual(Object.keys(AUTOPILOT_REFUSAL).sort());
    expect(Object.isFrozen(AUTOPILOT_REFUSAL_COMPANY)).toBe(true);
    for (const [k, v] of Object.entries(AUTOPILOT_REFUSAL_COMPANY)) {
      expect(v, k).toMatch(/^Refused under company autopilot: /);
      expect(v, k).not.toContain('${');
      expect(v, k).toContain('No card was sent.');
    }
  });
});

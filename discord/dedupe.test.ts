import { describe, expect, it } from 'vitest';
import { Dedupe } from './dedupe.js';

describe('Dedupe', () => {
  it('processes a message id once across clients', () => {
    const d = new Dedupe();
    // the same guild message reaches every one of the 9 clients
    const results = Array.from({ length: 9 }, () => d.seen('1000'));
    expect(results.filter((r) => !r)).toHaveLength(1);
    expect(results[0]).toBe(false);
    expect(d.seen('1001')).toBe(false);
  });

  it('evicts after 5000', () => {
    const d = new Dedupe();
    for (let i = 0; i < 5000; i++) d.seen(`id-${i}`);
    expect(d.seen('id-0')).toBe(true); // still remembered (and refreshed)
    d.seen('id-5000'); // evicts the least recently seen: id-1
    expect(d.seen('id-1')).toBe(false);
    expect(d.seen('id-0')).toBe(true);
  });
});

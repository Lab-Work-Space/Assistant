import { describe, expect, it } from 'vitest';
import { diffSummary, escapeText } from './diff.js';

describe('diff', () => {
  it('diff › unchanged → null; added/removed lines summarised; capped', () => {
    expect(diffSummary('a\nb\nc', 'a\nb\nc')).toBeNull();
    expect(diffSummary('a\n\n  b  ', 'a\nb')).toBeNull(); // whitespace-only differences are not changes
    expect(diffSummary('a\nb\nc', 'a\nc\nd')).toBe('+ d\n- b');
    const big = diffSummary('', Array.from({ length: 200 }, (_, i) => `line number ${i}`).join('\n'), 300)!;
    expect(big.length).toBeLessThanOrEqual(300);
    expect(big).toMatch(/… and \d+ more$/);
    const many = diffSummary('', Array.from({ length: 100 }, (_, i) => `l${i}`).join('\n'))!;
    expect(many.split('\n')).toHaveLength(21);
    expect(many).toMatch(/… and 80 more$/);
    expect(diffSummary('', 'x'.repeat(5000))!.length).toBeLessThanOrEqual(1200);
  });

  it('escapeText neutralises markdown, mentions and control characters', () => {
    const e = escapeText('**bold** @everyone <@123> [x](http://e.com) `code` ‮\u0007hi');
    expect(e).not.toMatch(/(?<!\\)[*`[<]/);
    expect(e).not.toContain('@everyone');
    expect(e).not.toMatch(/[‮\u0007]/);
  });
});

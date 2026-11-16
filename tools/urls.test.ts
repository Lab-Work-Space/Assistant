import { describe, expect, it } from 'vitest';
import { extractUrls } from './urls.js';

describe('extractUrls', () => {
  it('finds http(s) urls, trims punctuation, drops fragments, ignores junk', () => {
    expect(extractUrls('go to https://a.test/p?q=1, then <https://b.test> or "http://c.test/x". ftp://no.test javascript:alert(1)')).toEqual([
      'https://a.test/p?q=1', 'https://b.test/', 'http://c.test/x',
    ]);
  });
});

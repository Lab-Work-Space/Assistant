import { describe, expect, it } from 'vitest';
import { DENIED_CHANNEL_IDS, isDenied } from './denylist.js';

describe('denylist', () => {
  it('blocks 1565715069969502310', () => {
    expect(isDenied('1565715069969502310', null)).toBe(true);
    expect(isDenied('1565649677280485457', null)).toBe(true);
  });
  it('blocks thread whose parent is denied', () => {
    expect(isDenied('thread-1', '1565715069969502310')).toBe(true);
  });
  it('allows normal channel', () => {
    expect(isDenied('1565652605290414160', null)).toBe(false);
    expect(isDenied('thread-1', '1565652605290414160')).toBe(false);
  });
  it('exposes the single shared denied-id list', () => {
    expect(DENIED_CHANNEL_IDS).toContain('1565715069969502310');
  });
});

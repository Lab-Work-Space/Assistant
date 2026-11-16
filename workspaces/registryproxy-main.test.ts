import { describe, expect, it } from 'vitest';
import { HOURLY_MAX_BYTES, HOUR_MS, hourlyHandler } from './registryproxy-main.js';

describe('hourlyHandler (SA-1 C2)', () => {
  it('builds a fresh handler (fresh byte counter) at each UTC hour with a 1 GiB cap, and not within an hour', () => {
    let t = 10 * HOUR_MS + 5;
    const made: number[] = [];
    let calls = 0;
    const h = hourlyHandler((max) => { made.push(max); const id = made.length; return () => void (calls = id); }, () => t);
    h({} as never, {} as never);
    t += HOUR_MS - 10;
    h({} as never, {} as never);
    expect(made).toEqual([HOURLY_MAX_BYTES]);
    t += 10;
    h({} as never, {} as never);
    expect(made).toEqual([HOURLY_MAX_BYTES, HOURLY_MAX_BYTES]);
    expect(calls).toBe(2);
    expect(HOURLY_MAX_BYTES).toBe(1024 ** 3);
  });
  it('importing the module does not start a server', () => {
    expect(typeof hourlyHandler).toBe('function');
  });
});

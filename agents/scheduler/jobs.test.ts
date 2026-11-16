import { describe, expect, it } from 'vitest';
import { KeyedLock } from './jobs.js';

describe('KeyedLock.busy (TASKADMIN-1, TA-C19)', () => {
  it('is true while a job of that key is queued or running and false again after it, without waiting', async () => {
    const l = new KeyedLock();
    expect(l.busy('a')).toBe(false);
    let release!: () => void;
    const hold = new Promise<void>((r) => { release = r; });
    const first = l.run('a', () => hold);
    const second = l.run('a', async () => undefined); // queued behind the first
    expect(l.busy('a')).toBe(true);
    expect(l.busy('b')).toBe(false);
    release();
    await Promise.all([first, second]);
    await new Promise((r) => setImmediate(r));
    expect(l.busy('a')).toBe(false);
  });

  it('a failing job releases the key too', async () => {
    const l = new KeyedLock();
    await expect(l.run('a', async () => { throw new Error('x'); })).rejects.toThrow('x');
    await new Promise((r) => setImmediate(r));
    expect(l.busy('a')).toBe(false);
  });
});

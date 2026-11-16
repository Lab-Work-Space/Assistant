import { describe, expect, it } from 'vitest';
import { SlugLock } from './lock.js';

const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};

describe('SlugLock (SA-1 5.2, WS-C10)', () => {
  it('a run excludes file operations and other runs of that slug, but not other slugs', async () => {
    const l = new SlugLock();
    const rel = l.tryRun('a')!;
    expect(rel).toBeTypeOf('function');
    expect(l.tryRun('a')).toBeNull();
    expect(await l.op('a', 'write', async () => 1)).toEqual({ busy: true });
    expect(await l.op('a', 'read', async () => 1)).toEqual({ busy: true });
    expect(l.tryRun('b')).not.toBeNull();
    rel();
    expect(await l.op('a', 'read', async () => 7)).toEqual({ busy: false, value: 7 });
    expect(l.tryRun('a')).not.toBeNull();
  });
  it('a run is refused while an operation is active, and an operation does not wait for a run', async () => {
    const l = new SlugLock();
    const g = gate();
    const op = l.op('a', 'read', () => g.p);
    expect(l.tryRun('a')).toBeNull();
    g.open();
    await op;
    expect(l.tryRun('a')).not.toBeNull();
  });
  it('writes of one slug are serialised; reads overlap', async () => {
    const l = new SlugLock();
    const order: string[] = [];
    const g1 = gate();
    const w1 = l.op('a', 'write', async () => { order.push('w1 start'); await g1.p; order.push('w1 end'); });
    const w2 = l.op('a', 'write', async () => { order.push('w2 start'); });
    await new Promise((r) => setTimeout(r, 0));
    const r = l.op('a', 'read', async () => { order.push('read'); });
    await r;
    expect(order).toEqual(['w1 start', 'read']);
    g1.open();
    await Promise.all([w1, w2]);
    expect(order).toEqual(['w1 start', 'read', 'w1 end', 'w2 start']);
  });
  it('a failing write does not block the next one and releases the count', async () => {
    const l = new SlugLock();
    await expect(l.op('a', 'write', async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(await l.op('a', 'write', async () => 2)).toEqual({ busy: false, value: 2 });
    expect(l.tryRun('a')).not.toBeNull();
  });
  it('a stuck slug keeps its lock; its release is a no-op', async () => {
    const l = new SlugLock();
    const rel = l.tryRun('a')!;
    l.markStuck('a');
    rel();
    expect(l.tryRun('a')).toBeNull();
    expect(await l.op('a', 'read', async () => 1)).toEqual({ busy: true });
  });
});

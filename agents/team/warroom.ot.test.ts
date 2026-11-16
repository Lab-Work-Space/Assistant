import { describe, expect, it, vi } from 'vitest';
import { WarroomGuard } from './warroom.js';

const guard = (heldMax = 10) => new WarroomGuard(() => ({ turnsPerThreadPerHour: 100, turnsPerHour: 100, stallTurns: 100, heldMax }), () => 1_000_000);

describe('OT-1 OT-C5: held starts carry the tree they belong to', () => {
  it('releaseHeldFor returns only the entries tagged with that root and leaves the others (and untagged ones) held', () => {
    const g = guard();
    const [a1, a2, b1, none] = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
    expect(g.hold('t-a1', a1, 'A')).toBe(true);
    expect(g.hold('t-a2', a2, 'A')).toBe(true);
    expect(g.hold('t-b1', b1, 'B')).toBe(true);
    expect(g.hold('t-none', none)).toBe(true);
    const out = g.releaseHeldFor('A');
    expect(out.map((x) => x.key).sort()).toEqual(['t-a1', 't-a2']);
    out.forEach((x) => x.start());
    expect(a1).toHaveBeenCalledOnce();
    expect(a2).toHaveBeenCalledOnce();
    expect(b1).not.toHaveBeenCalled();
    expect(g.heldCount()).toBe(2); // B and the untagged one
    expect(g.heldCountFor('B')).toBe(1);
    expect(g.heldCountFor('A')).toBe(0);
  });

  it('untagged entries are never released by releaseHeldFor, only by releaseHeld (the day turning)', () => {
    const g = guard();
    const none = vi.fn();
    g.hold('t', none);
    expect(g.releaseHeldFor('A')).toEqual([]);
    expect(g.releaseHeldFor('')).toEqual([]);
    expect(g.heldCount()).toBe(1);
    g.releaseHeld().forEach((s) => s());
    expect(none).toHaveBeenCalledOnce();
  });

  it('a re-hold on the same thread overwrites the start AND the tag together: the newer start never inherits the older tree', () => {
    const g = guard();
    const older = vi.fn();
    const newer = vi.fn();
    g.hold('thread', older, 'A');
    g.hold('thread', newer); // a newer start with no task
    expect(g.releaseHeldFor('A')).toEqual([]);
    expect(g.heldCountFor('A')).toBe(0);
    g.hold('thread', older, 'A');
    g.hold('thread', newer, 'B'); // a newer start from another tree
    expect(g.releaseHeldFor('A')).toEqual([]);
    const b = g.releaseHeldFor('B');
    expect(b).toHaveLength(1);
    b[0]!.start();
    expect(newer).toHaveBeenCalledOnce();
    expect(older).not.toHaveBeenCalled();
  });

  it('the held limit still applies to tagged entries, and releaseHeld (the day turning) returns tagged ones too', () => {
    const g = guard(1);
    expect(g.hold('t1', vi.fn(), 'A')).toBe(true);
    expect(g.hold('t2', vi.fn(), 'A')).toBe(false);
    expect(g.hold('t1', vi.fn(), 'B')).toBe(true); // an overwrite is not a new thread
    expect(g.releaseHeld()).toHaveLength(1);
    expect(g.heldCount()).toBe(0);
  });
});

describe('Gate 2 G2OT-02: holdIfAbsent', () => {
  it('re-holds only when the thread has no newer entry; a full hold reports full', () => {
    const g = guard(1);
    const old = vi.fn();
    const newer = vi.fn();
    expect(g.holdIfAbsent('t', old, 'A')).toBe('held');
    expect(g.holdIfAbsent('t', newer, 'B')).toBe('present');
    expect(g.releaseHeldFor('A').map((x) => x.key)).toEqual(['t']);
    g.hold('t', newer, 'B');
    expect(g.holdIfAbsent('t', old, 'A')).toBe('present'); // the newer start stays
    expect(g.heldCountFor('B')).toBe(1);
    expect(g.holdIfAbsent('u', old, 'A')).toBe('full');
  });
});

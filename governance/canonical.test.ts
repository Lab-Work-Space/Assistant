import { describe, expect, it } from 'vitest';
import { canonicalJson, inputDigest } from './canonical.js';

describe('canonicalJson', () => {
  it('orders keys deterministically at every depth', () => {
    const a = { b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } };
    const b = { a: { c: null, d: [3, { x: 2, y: 1 }] }, b: 1 };
    expect(canonicalJson(a)).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
  it('keeps array order, drops undefined object keys, nulls undefined array items', () => {
    expect(canonicalJson([2, 1])).toBe('[2,1]');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined])).toBe('[null]');
  });
  it('escapes strings like JSON and parses back to the same value', () => {
    const v = { s: 'a"b\n \u0000', n: -0.5, t: true };
    expect(JSON.parse(canonicalJson(v))).toEqual(v);
  });
  it('refuses values JSON cannot carry', () => {
    expect(() => canonicalJson({ n: Number.NaN })).toThrow();
    expect(() => canonicalJson({ n: Infinity })).toThrow();
    expect(() => canonicalJson({ n: 1n })).toThrow();
    expect(() => canonicalJson({ f: () => 1 })).toThrow();
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(() => canonicalJson(cyc)).toThrow();
  });
  it('contract (c): refuses non-plain objects (Date, Map, Set, class instances); null-prototype objects are fine', () => {
    expect(() => canonicalJson({ d: new Date(0) })).toThrow(/plain/);
    expect(() => canonicalJson({ m: new Map([[1, 2]]) })).toThrow(/plain/);
    expect(() => canonicalJson([new Set([1])])).toThrow(/plain/);
    class Box { v = 1; }
    expect(() => canonicalJson(new Box())).toThrow(/plain/);
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { b: 1, a: 2 });
    expect(canonicalJson(bare)).toBe('{"a":2,"b":1}');
  });
  it('digest is a stable sha256 hex of the canonical string', () => {
    expect(inputDigest('{"a":1}')).toBe('015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862');
    expect(inputDigest(canonicalJson({ b: 1, a: 2 }))).toBe(inputDigest(canonicalJson({ a: 2, b: 1 })));
  });
});

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpError } from './errors.js';
import { convertSchema } from './schema.js';

const code = (f: () => unknown): string | undefined => { try { f(); } catch (e) { return e instanceof McpError ? e.code : 'other'; } return undefined; };
const obj = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'object', properties, ...extra });
const conv = (s: unknown) => convertSchema(s).schema;
const json = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input' }) as { properties?: Record<string, Record<string, unknown>>; required?: string[]; additionalProperties?: unknown };

describe('MCP-AC04: the input schema subset (spec 5.3)', () => {
  it('converts every allowed construct to a strict zod object; undeclared keys are refused; required decides optional', () => {
    const s = conv(obj({
      q: { type: 'string', description: 'the query', minLength: 1, maxLength: 50 }, n: { type: 'number', minimum: 0, maximum: 10 }, i: { type: 'integer' }, b: { type: 'boolean', default: true, title: 'T', format: 'x' },
      e: { type: 'string', enum: ['a', 'b'] }, l: { type: 'array', items: { type: 'string' }, maxItems: 3 }, o: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    }, { required: ['q'], additionalProperties: false, $schema: 'http://json-schema.org/draft-07/schema#', title: 'root', description: 'root desc' }));
    expect(s.safeParse({ q: 'x' }).success).toBe(true);
    expect(s.safeParse({ q: 'x', n: 5, i: 2, b: false, e: 'a', l: ['x'], o: 'z' }).success).toBe(true);
    for (const bad of [{}, { q: '' }, { q: 'x', n: 11 }, { q: 'x', i: 1.5 }, { q: 'x', e: 'c' }, { q: 'x', l: ['a', 'b', 'c', 'd'] }, { q: 'x', extra: 1 }, { q: 'x', o: null }, { q: 1 }, { q: 'x'.repeat(51) }]) expect(s.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    const j = json(s);
    expect(j.required).toEqual(['q']);
    expect(j.additionalProperties).toBe(false);
  });
  it('no properties at all is an empty strict object', () => {
    expect(conv({ type: 'object' }).safeParse({}).success).toBe(true);
    expect(conv({ type: 'object' }).safeParse({ a: 1 }).success).toBe(false);
  });
  it('forced caps: a string is at most 4000 and an array at most 32 even when the server declares more or nothing', () => {
    const s = conv(obj({ a: { type: 'string', maxLength: 99999 }, b: { type: 'string' }, l: { type: 'array', items: { type: 'integer' } }, m: { type: 'array', items: { type: 'integer' }, maxItems: 1000 } }));
    expect(s.safeParse({ a: 'x'.repeat(4000), b: 'x'.repeat(4000) }).success).toBe(true);
    expect(s.safeParse({ a: 'x'.repeat(4001) }).success).toBe(false);
    expect(s.safeParse({ b: 'x'.repeat(4001) }).success).toBe(false);
    expect(s.safeParse({ l: Array(32).fill(1), m: Array(32).fill(1) }).success).toBe(true);
    expect(s.safeParse({ l: Array(33).fill(1) }).success).toBe(false);
    expect(s.safeParse({ m: Array(33).fill(1) }).success).toBe(false);
  });
  it('one refusal per banned construct (E_SCHEMA)', () => {
    const banned: unknown[] = [
      null, 'x', [], { type: 'string' }, { type: 'object', properties: [] }, { type: 'object', properties: null }, { type: 'object', $ref: '#/x' }, { type: 'object', oneOf: [] }, { type: 'object', allOf: [] }, { type: 'object', patternProperties: {} },
      { type: 'object', additionalProperties: { type: 'string' } }, { type: 'object', required: 'a' }, { type: 'object', required: [1] }, { type: 'object', $defs: {} },
      obj({ a: { $ref: '#/$defs/x' } }), obj({ a: { oneOf: [{ type: 'string' }] } }), obj({ a: { allOf: [{ type: 'string' }] } }), obj({ a: { type: 'object' } }), obj({ a: { type: ['string', 'null'] } }), obj({ a: { type: 'null' } }),
      obj({ a: { type: 'string', pattern: '^a' } }), obj({ a: { type: 'string', enum: [1, 2] } }), obj({ a: { type: 'number', enum: [1] } }), obj({ a: { type: 'array' } }), obj({ a: { type: 'array', items: { type: 'array', items: { type: 'string' } } } }),
      obj({ a: { type: 'array', items: { type: 'object' } } }), obj({ a: { type: 'array', items: { $ref: 'x' } } }), obj({ a: { type: 'string', items: { type: 'string' } } }), obj({ a: { type: 'string', maxItems: 1 } }), obj({ a: { type: 'string', minimum: 1 } }), obj({ a: { type: 'number', minLength: 1 } }),
      obj({ a: { anyOf: [{ type: 'string' }] } }), obj({ a: { anyOf: [{ type: 'string' }, { type: 'number' }] } }), obj({ a: { anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }] } }), obj({ a: { anyOf: [{ type: 'string' }, { type: 'null' }], type: 'string' } }),
      obj({ a: { type: 'string', enum: Array.from({ length: 33 }, (_, i) => `v${i}`) } }), obj({ a: { type: 'string', enum: [] } }), obj({ a: { type: 'string', minLength: 10, maxLength: 5 } }), obj({ a: { type: 'number', minimum: 5, maximum: 1 } }), obj({ a: { type: 'string', maxLength: -1 } }),
      obj({ a: { type: 'number', minimum: Number.POSITIVE_INFINITY } }), obj({ a: { type: 'number', maximum: Number.NaN } }), obj({ a: { type: 'number', minimum: '1' } }), obj({ a: 'string' }), obj({ a: null }), obj({ a: [] }),
      obj({ '1bad': { type: 'string' } }), obj({ 'a-b': { type: 'string' } }), obj({ 'a b': { type: 'string' } }), obj({ [`a${'b'.repeat(40)}`]: { type: 'string' } }), obj({ a: { type: 'string', unknownKey: 1 } }),
      obj(Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`p${i}`, { type: 'string' }]))), { type: 'object', unknownRootKey: 1 },
      obj({ a: { type: 'string' } }, { required: ['b'] }), obj({ a: { type: 'string' } }, { required: ['toString'] }), obj({ a: { type: 'string' } }, { required: ['__proto__'] }),
    ];
    for (const b of banned) expect(code(() => conv(b)), JSON.stringify(b)).toBe('E_SCHEMA');
    expect(code(() => conv(JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}')))).toBe('E_SCHEMA');
    expect(code(() => conv(JSON.parse('{"type":"object","__proto__":{"x":1}}')))).toBe('E_SCHEMA');
    expect(code(() => conv(JSON.parse('{"type":"object","properties":{"a":{"type":"number","maximum":1e999}}}')))).toBe('E_SCHEMA');
  });
  it('MC-C12: strictObject refuses undeclared toString, constructor and an own __proto__, and accepts a declared constructor', () => {
    const s = conv(obj({ a: { type: 'string' } }));
    expect(s.safeParse({ a: 'x', toString: 'y' }).success).toBe(false);
    expect(s.safeParse({ a: 'x', constructor: 'y' }).success).toBe(false);
    expect(s.safeParse(JSON.parse('{"a":"x","__proto__":{"x":1}}')).success).toBe(false);
    expect(s.safeParse(JSON.parse('{"a":"x","__proto__":"y"}')).success).toBe(false);
    const c = conv(obj({ constructor: { type: 'string' }, toString: { type: 'string' } }, { required: ['constructor', 'toString'] }));
    expect(c.safeParse({ constructor: 'v', toString: 't' }).success).toBe(true);
    expect(c.safeParse({ constructor: 'v' }).success).toBe(false);
    expect(c.safeParse({}).success).toBe(false);
    expect(c.safeParse({ constructor: 1, toString: 't' }).success).toBe(false);
    // an optional property named like an Object.prototype member could never be omitted (zod would read the inherited function): refused at add
    expect(code(() => conv(obj({ toString: { type: 'string' } })))).toBe('E_SCHEMA');
    expect(code(() => conv(obj({ valueOf: { type: 'string' } }, { required: ['valueOf'] })))).toBeUndefined();
  });
  it('descriptions: folded, cut to 120, screened; the JSON schema holds only that screened text (and the enum values)', () => {
    const long = `${'word '.repeat(60)}end`;
    const j = json(conv(obj({ a: { type: 'string', description: `  two\n\n  lines\tof   text ` }, b: { type: 'string', description: long }, c: { type: 'string', enum: ['x', 'y'], description: 'pick' } })));
    expect(j.properties!['a']!['description']).toBe('two lines of text');
    expect((j.properties!['b']!['description'] as string).length).toBeLessThanOrEqual(120);
    expect(j.properties!['c']).toMatchObject({ enum: ['x', 'y'], description: 'pick' });
    expect(JSON.stringify(j)).not.toContain('default');
  });
  it('a refused description, enum value or property description is E_SCREEN with the index of nothing but the code (MC-C5: raw checks run before fold and cut)', () => {
    const bad = ['a​b', '﻿start', 'line two', 'tag\u{E0041}x', 'vs️x', 'ctl\u0007x', 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123', 'a­b', 'x‮y'];
    for (const d of bad) {
      expect(code(() => conv(obj({ a: { type: 'string', description: d } }))), JSON.stringify(d)).toBe('E_SCREEN');
      expect(code(() => conv(obj({ a: { type: 'string', enum: [d] } }))), `enum ${JSON.stringify(d)}`).toBe('E_SCREEN');
    }
    for (const v of ['', ' pad', 'a\nb', 'x'.repeat(65)]) expect(code(() => conv(obj({ a: { type: 'string', enum: [v] } }))), JSON.stringify(v)).toMatch(/E_SCREEN|E_SCHEMA/);
  });
  it('MC-C6: an enum may hold at most 512 characters in total', () => {
    const values = (n: number) => Array.from({ length: n }, (_, i) => `v${String(i).padStart(7, '0')}`.padEnd(32, 'x')); // 32 chars each
    expect(code(() => conv(obj({ a: { type: 'string', enum: values(16) } })))).toBeUndefined(); // 512
    expect(code(() => conv(obj({ a: { type: 'string', enum: values(17) } })))).toBe('E_SCHEMA');
  });
  it('the zod error text is never part of an McpError', () => {
    try { conv(obj({ a: { type: 'string', enum: [1] } })); } catch (e) { expect((e as Error).message).toBe('E_SCHEMA'); }
  });
});

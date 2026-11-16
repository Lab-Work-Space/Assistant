import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ProposeInput } from '../knowledge/service.js';
import { ToolRegistry } from './registry.js';
import { flattenTopLevelUnion } from './schema.js';
import type { ToolPlugin } from './types.js';

// API400-1: the Claude API refuses oneOf/anyOf/allOf at the top of a tool's input_schema (and wants type: object), which zod emits for a discriminated union.
const U = z.discriminatedUnion('op', [
  z.object({ op: z.literal('a'), id: z.number(), note: z.string().optional() }).strict(),
  z.object({ op: z.literal('b'), id: z.number(), flag: z.boolean() }).strict(),
]);

describe('flattenTopLevelUnion', () => {
  it('turns a top-level union into one object schema (type, merged properties, common required, discriminator enum)', () => {
    const out = flattenTopLevelUnion(z.toJSONSchema(U, { io: 'input' }) as Record<string, unknown>) as any;
    expect(out.type).toBe('object');
    for (const k of ['oneOf', 'anyOf', 'allOf']) expect(out[k]).toBeUndefined();
    expect(Object.keys(out.properties).sort()).toEqual(['flag', 'id', 'note', 'op']);
    expect(out.properties.op.enum).toEqual(['a', 'b']);
    expect([...out.required].sort()).toEqual(['id', 'op']);
  });

  it('a property named __proto__ is kept as data and pollutes nothing (F-2)', () => {
    const schema = JSON.parse('{"oneOf":[{"type":"object","properties":{"op":{"const":"a"},"__proto__":{"type":"string"}}},{"type":"object","properties":{"op":{"const":"b"},"__proto__":{"type":"number"}}}]}');
    const out = flattenTopLevelUnion(schema) as any;
    expect(Object.keys(out.properties).sort()).toEqual(['__proto__', 'op']);
    expect(Object.getPrototypeOf(out.properties)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(out.properties, '__proto__')?.value.anyOf).toHaveLength(2);
    expect(({} as any).anyOf).toBeUndefined();
    expect(JSON.parse(JSON.stringify(out)).properties['__proto__']).toBeDefined();
  });

  it('the discriminator enum takes its type from the const values (F-2)', () => {
    const mk = (a: unknown, b: unknown) => ({ oneOf: [{ type: 'object', properties: { k: { const: a } } }, { type: 'object', properties: { k: { const: b } } }] });
    expect((flattenTopLevelUnion(mk(1, 2)) as any).properties.k).toEqual({ type: 'number', enum: [1, 2] });
    expect((flattenTopLevelUnion(mk(true, false)) as any).properties.k).toEqual({ type: 'boolean', enum: [true, false] });
    expect((flattenTopLevelUnion(mk('a', 2)) as any).properties.k).toEqual({ enum: ['a', 2] });
  });

  it('leaves a plain object schema untouched', () => {
    const s = z.toJSONSchema(z.object({ n: z.number() }), { io: 'input' }) as Record<string, unknown>;
    expect(flattenTopLevelUnion(s)).toEqual(s);
  });

  it('specsFor hands the provider a flat schema for knowledge_propose', () => {
    const reg = new ToolRegistry({ halt: { isHalted: () => false } });
    const tool = { name: 'knowledge_propose', description: 'd', inputSchema: ProposeInput, requiresApproval: () => false, run: async () => ({ content: '' }) } as unknown as ToolPlugin<never>;
    reg.register(tool);
    const s = reg.specsFor(['knowledge_propose'])[0]!.inputSchema as any;
    expect(s.type).toBe('object');
    expect(s.oneOf).toBeUndefined();
    expect(s.properties.op.enum).toContain('kb_create');
  });
});

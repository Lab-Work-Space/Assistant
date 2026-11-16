import { z } from 'zod';
import { McpError } from './errors.js';
import { screenExact, screenLine } from './screen.js';

/**
 * R6 MCP-1 (spec 5.3, MC-C5, MC-C6, MC-C12): the own JSON-Schema-to-zod converter. zod's `z.fromJSONSchema` is not used because it accepts $ref and combinators.
 * Only a closed subset is converted; anything else is E_SCHEMA. Every key set is checked with `Object.keys` on own properties, so an own `__proto__` is just an
 * unknown key. The output is a strict object: an undeclared key (`toString`, `constructor`, an own `__proto__`) is refused by the schema itself. Descriptions and enum
 * values are screened (hidden characters and secret-like text refused, MC-C5) and what remains is capped, so `z.toJSONSchema` of the result holds only screened text.
 */
export type ToolInput = z.ZodType<Record<string, unknown>>;
export type Converted = { schema: ToolInput };

const PROP_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const ROOT_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties', '$schema', 'title', 'description']);
const PRIM_KEYS = new Set(['type', 'description', 'enum', 'minimum', 'maximum', 'minLength', 'maxLength', 'default', 'title', 'format']);
const PROP_KEYS = new Set([...PRIM_KEYS, 'items', 'maxItems']);
const ANYOF_KEYS = new Set(['anyOf', 'description', 'default', 'title']);
const PRIMS = new Set(['string', 'number', 'integer', 'boolean']);
export const STRING_CAP = 4000;
export const ARRAY_CAP = 32;
const ENUM_VALUES = 32;
const ENUM_VALUE_CHARS = 64;
export const ENUM_TOTAL_CHARS = 512;
const MAX_PROPS = 16;
const DESC_MAX = 120;

const bad = (): never => { throw new McpError('E_SCHEMA'); };
const screen = (): never => { throw new McpError('E_SCREEN'); };
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const only = (o: Record<string, unknown>, allowed: ReadonlySet<string>): void => { for (const k of Object.keys(o)) if (!allowed.has(k)) bad(); };
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : bad());
const int = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : bad());

function describeOf(o: Record<string, unknown>, secrets: readonly string[]): string | null {
  if (!('description' in o)) return null;
  if (typeof o['description'] !== 'string') return bad();
  const t = screenLine(o['description'], DESC_MAX, secrets);
  if (t === null) return screen();
  return t === '' ? null : t;
}

function primitive(o: Record<string, unknown>, allowed: ReadonlySet<string>, secrets: readonly string[]): z.ZodType {
  only(o, allowed);
  const type = o['type'];
  if (typeof type !== 'string' || !PRIMS.has(type)) return bad();
  if ('enum' in o) {
    if (type !== 'string' || !Array.isArray(o['enum'])) return bad();
    const vals = o['enum'] as unknown[];
    if (vals.length < 1 || vals.length > ENUM_VALUES) return bad();
    let total = 0;
    for (const v of vals) {
      if (typeof v !== 'string') return bad();
      total += v.length;
      if (v === '' || Array.from(v).length > ENUM_VALUE_CHARS) return bad();
      if (!screenExact(v, ENUM_VALUE_CHARS, secrets)) return screen();
    }
    if (total > ENUM_TOTAL_CHARS) return bad();
    for (const k of ['minimum', 'maximum', 'minLength', 'maxLength']) if (k in o) return bad();
    return z.enum(vals as [string, ...string[]]);
  }
  if (type === 'string') {
    if ('minimum' in o || 'maximum' in o) return bad();
    const min = 'minLength' in o ? int(o['minLength']) : 0;
    const max = Math.min('maxLength' in o ? int(o['maxLength']) : STRING_CAP, STRING_CAP);
    if (min > max) return bad();
    let s = z.string().max(max);
    if (min > 0) s = s.min(min);
    return s;
  }
  if ('minLength' in o || 'maxLength' in o) return bad();
  if (type === 'boolean') {
    if ('minimum' in o || 'maximum' in o) return bad();
    return z.boolean();
  }
  const lo = 'minimum' in o ? num(o['minimum']) : null;
  const hi = 'maximum' in o ? num(o['maximum']) : null;
  if (lo !== null && hi !== null && lo > hi) return bad();
  let n = type === 'integer' ? z.number().int() : z.number();
  if (lo !== null) n = n.min(lo);
  if (hi !== null) n = n.max(hi);
  return n;
}

function property(p: unknown, secrets: readonly string[]): { field: z.ZodType; optional: boolean; description: string | null } {
  if (!isPlain(p)) return bad();
  if ('anyOf' in p) {
    only(p, ANYOF_KEYS);
    const a = p['anyOf'];
    if (!Array.isArray(a) || a.length !== 2) return bad();
    const nulls = a.filter((x) => isPlain(x) && Object.keys(x).length === 1 && x['type'] === 'null');
    const rest = a.filter((x) => !(isPlain(x) && Object.keys(x).length === 1 && x['type'] === 'null'));
    if (nulls.length !== 1 || rest.length !== 1 || !isPlain(rest[0])) return bad();
    return { field: primitive(rest[0], PRIM_KEYS, secrets), optional: true, description: describeOf(p, secrets) ?? describeOf(rest[0], secrets) };
  }
  only(p, PROP_KEYS);
  if (p['type'] === 'array') {
    for (const k of ['enum', 'minimum', 'maximum', 'minLength', 'maxLength']) if (k in p) return bad();
    if (!isPlain(p['items'])) return bad();
    if (p['items']['type'] === 'array') return bad();
    const item = primitive(p['items'], PRIM_KEYS, secrets);
    const max = Math.min('maxItems' in p ? int(p['maxItems']) : ARRAY_CAP, ARRAY_CAP);
    return { field: z.array(item).max(max), optional: false, description: describeOf(p, secrets) };
  }
  if ('items' in p || 'maxItems' in p) return bad();
  return { field: primitive(p, PROP_KEYS, secrets), optional: false, description: describeOf(p, secrets) };
}

/** Throws McpError E_SCHEMA or E_SCREEN (the caller adds the tool index). */
export function convertSchema(input: unknown, secrets: readonly string[] = []): Converted {
  if (!isPlain(input)) return bad();
  only(input, ROOT_KEYS);
  if (input['type'] !== 'object') return bad();
  if ('additionalProperties' in input && typeof input['additionalProperties'] !== 'boolean') return bad();
  for (const k of ['title', 'description', '$schema']) if (k in input && typeof input[k] !== 'string') return bad();
  const props = 'properties' in input ? input['properties'] : {};
  if (!isPlain(props)) return bad();
  const names = Object.keys(props);
  if (names.length > MAX_PROPS) return bad();
  const required = new Set<string>();
  if ('required' in input) {
    if (!Array.isArray(input['required'])) return bad();
    for (const r of input['required']) {
      if (typeof r !== 'string' || !Object.hasOwn(props, r)) return bad();
      required.add(r);
    }
  }
  const shape: Record<string, z.ZodType> = Object.create(null) as Record<string, z.ZodType>;
  for (const name of names) {
    if (!PROP_NAME.test(name)) return bad();
    // zod reads `input[name]` for every declared key, so an absent optional `toString` would read Object.prototype.toString: such a name is allowed only when it is required
    if (name in Object.prototype && !required.has(name)) return bad();
    const { field, optional, description } = property(props[name], secrets);
    let f = field;
    if (description !== null) f = f.describe(description);
    if (optional || !required.has(name)) f = f.optional();
    if (description !== null) f = f.describe(description);
    shape[name] = f;
  }
  return { schema: z.strictObject(shape) as unknown as ToolInput };
}

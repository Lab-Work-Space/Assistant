type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * API400-1: the Claude API wants `type: "object"` at the top of a tool's input_schema and refuses oneOf/anyOf/allOf there, which is what zod emits
 * for a discriminated union (knowledge_propose). The branches are merged into one object schema: all properties, the required keys every branch
 * has, a property that differs between branches becomes an anyOf (the discriminator becomes one enum). Only the model's view changes: the zod
 * schema still validates every call.
 */
export function flattenTopLevelUnion(schema: Json): Json {
  const branches = (['oneOf', 'anyOf'] as const).map((k) => schema[k]).find((v) => Array.isArray(v)) as unknown[] | undefined;
  if (!branches || !branches.length || !branches.every((b) => isObj(b) && isObj(b.properties))) return schema;
  const { oneOf: _o, anyOf: _a, ...rest } = schema;
  const objs = branches as Json[];
  const props = new Map<string, Json[]>(); // a Map and a null-prototype object: a property named __proto__ is data, never the prototype
  for (const b of objs) for (const [k, v] of Object.entries(b.properties as Json)) props.set(k, [...(props.get(k) ?? []), v as Json]);
  const properties: Json = Object.create(null) as Json;
  for (const [k, vs] of props) {
    const uniq = vs.filter((v, i) => vs.findIndex((w) => same(w, v)) === i);
    if (uniq.length === 1) properties[k] = uniq[0]!;
    else if (uniq.every((v) => 'const' in v && Object.keys(v).every((x) => x === 'const' || x === 'type'))) {
      const vals = uniq.map((v) => v.const);
      const types = [...new Set(vals.map((v) => (v === null ? 'null' : typeof v)))];
      properties[k] = { ...(types.length === 1 ? { type: types[0] } : {}), enum: vals };
    }
    else properties[k] = { anyOf: uniq };
  }
  const req = objs.map((b) => (Array.isArray(b.required) ? (b.required as string[]) : []));
  const required = (req[0] ?? []).filter((k) => req.every((r) => r.includes(k)));
  return { ...rest, type: 'object', properties: { ...properties }, ...(required.length ? { required } : {}) };
}

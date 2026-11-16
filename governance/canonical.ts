import { createHash } from 'node:crypto';

const MAX_DEPTH = 32;

/**
 * Deterministic JSON (R4): object keys sorted by UTF-16 code unit at every depth, no whitespace, strings escaped by
 * JSON.stringify. Values JSON cannot carry (NaN, Infinity, bigint, functions, cycles, non-plain objects such as Date/Map/Set/class instances) throw, so a digest is never taken
 * over something that would not survive storage.
 */
export function canonicalJson(v: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) throw new Error('input too deeply nested (or cyclic)');
  if (v === null) return 'null';
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return JSON.stringify(v);
    case 'number':
      if (!Number.isFinite(v)) throw new Error('non-finite number cannot be canonicalised');
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x, depth + 1))).join(',')}]`;
      // Only plain data: a Date, Map, Set or class instance would serialise lossily (or as {}), so it never gets a digest.
      const proto = Object.getPrototypeOf(v) as unknown;
      if (proto !== Object.prototype && proto !== null) throw new Error('only plain objects can be canonicalised');
      const o = v as Record<string, unknown>;
      const parts = Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k], depth + 1)}`);
      return `{${parts.join(',')}}`;
    }
    default:
      throw new Error(`${typeof v} cannot be canonicalised`);
  }
}

/** sha256 (hex) of a canonical JSON string. */
export const inputDigest = (canonical: string): string => createHash('sha256').update(canonical, 'utf8').digest('hex');

/**
 * B5: the digest of an approval batch: the first 12 hex of sha256 over the ascending `"<id>:<input_sha256>"` list joined by `,`.
 * It binds the member set AND each member's input hash. The caller passes the members in SQL `ORDER BY id` order (never re-sorted here).
 */
export function itemsDigest(items: readonly { id: number; inputSha256: string }[]): string {
  return createHash('sha256').update(items.map((i) => `${i.id}:${i.inputSha256}`).join(',')).digest('hex').slice(0, 12);
}

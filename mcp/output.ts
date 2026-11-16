import { redactText } from '../core/logger.js';
import { ANSI, C0 } from '../workspaces/runner.js';
import { McpError } from './errors.js';
import { stripHidden } from './screen.js';

export const OUTPUT_CHARS = 8000;
const MAX_ITEMS = 64;
const HEAD_BYTES = 64 * 1024;
const KNOWN_TYPES = new Set(['image', 'audio', 'resource', 'resource_link']);

/** `s.slice(0, n)` that never ends in half a surrogate pair. */
const headOf = (s: string, n: number): string => {
  if (s.length <= n) return s;
  const h = s.slice(0, n);
  return /[\uD800-\uDBFF]$/.test(h) ? h.slice(0, -1) : h;
};

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * What the model sees of a `tools/call` result (spec 5.7 as amended by MC-C4). The text items are joined with a newline; a non-text item becomes a fixed marker
 * whose type comes from a closed set (a server-chosen type string never reaches the prompt). `structuredContent` is ignored. Then, in this order:
 *  1. the head is cut to 8000 + longestSecret - 1 characters (and 64 KiB of bytes), so no regex ever sees more than that;
 *  2. ANSI and C0 are stripped, then the hidden characters (global strip, MC-C5), then the text is redacted (the strip comes first, so a secret split by a hidden
 *     character is still masked);
 *  3. the first 8000 characters are kept, plus `[cut: n more characters]`.
 * A non-string `text`, a non-array `content`, a non-object item and a non-string type are E_PROTOCOL; more than 64 items is E_TOO_BIG.
 */
export function processResult(result: Record<string, unknown>, secrets: readonly string[]): { text: string; isError: boolean } {
  const c = result['content'];
  if (c !== undefined && !Array.isArray(c)) throw new McpError('E_PROTOCOL');
  const items = (c ?? []) as unknown[];
  if (items.length > MAX_ITEMS) throw new McpError('E_TOO_BIG');
  const parts: string[] = [];
  for (const it of items) {
    if (!isPlain(it) || typeof it['type'] !== 'string') throw new McpError('E_PROTOCOL');
    if (it['type'] === 'text') {
      if (typeof it['text'] !== 'string') throw new McpError('E_PROTOCOL');
      parts.push(it['text']);
    } else parts.push(`[${KNOWN_TYPES.has(it['type']) ? it['type'] : 'other'} content omitted]`);
  }
  const lits = secrets.filter((s) => s.length > 0);
  const longest = lits.reduce((m, s) => Math.max(m, s.length), 0);
  const joined = parts.join('\n');
  const headLen = OUTPUT_CHARS + Math.max(0, longest - 1);
  let head = headOf(joined, headLen);
  let dropped = joined.length - head.length;
  if (Buffer.byteLength(head, 'utf8') > HEAD_BYTES) {
    const b = Buffer.from(head, 'utf8').subarray(0, HEAD_BYTES).toString('utf8').replace(/�$/, '');
    dropped += head.length - b.length;
    head = b;
  }
  const clean = redactText(stripHidden(head.replace(ANSI, '').replace(C0, '')), lits);
  let out = clean;
  let more = dropped;
  if (clean.length > OUTPUT_CHARS) {
    out = headOf(clean, OUTPUT_CHARS);
    more += clean.length - out.length;
  }
  if (more > 0) out += `\n[cut: ${more} more characters]`;
  return { text: out, isError: result['isError'] === true };
}

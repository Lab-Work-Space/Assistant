import { HIDDEN } from '../discord/embeds/approval.js';
import { INVISIBLE, screenText } from '../knowledge/screen.js';

/**
 * MC-C5: every MCP screen refuses on BOTH `INVISIBLE` (knowledge/screen.ts) and the `HIDDEN` class (discord/embeds/approval.ts: format, private-use, the tag
 * block and the variation selectors). `HIDDEN` is exported with the `g` flag, whose `lastIndex` carries between `.test()` calls, so the tests use non-global
 * copies and the strips use global ones. The refusal runs on the RAW string, before any fold, trim, NFC or cut: `\s` and `trim()` match U+FEFF, U+2028 and
 * U+2029, so folding first would launder them.
 */
const HIDDEN_ONE = new RegExp(HIDDEN.source, 'u');
const HIDDEN_ALL = new RegExp(HIDDEN.source, 'gu');
const INVISIBLE_ALL = new RegExp(INVISIBLE.source, 'gu');

export const hasHidden = (s: string): boolean => INVISIBLE.test(s) || HIDDEN_ONE.test(s);
export const stripHidden = (s: string): string => s.replace(INVISIBLE_ALL, '').replace(HIDDEN_ALL, '');
/** Lone surrogates and NUL: jsonb refuses both. */
export const hasUnstorable = (s: string): boolean => s.includes('\u0000') || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

export const cutPoints = (s: string, n: number): string => {
  const cps = Array.from(s);
  return cps.length > n ? cps.slice(0, n).join('') : s;
};

/**
 * Descriptions (tool: 300, property: 120): refuse hidden on the raw string, fold whitespace, cut to `max` code points, then screenText (secret-like, one line).
 * null: refused. An empty text is `''` (nothing to show), not a refusal.
 */
export function screenLine(raw: string, max: number, secrets: readonly string[] = []): string | null {
  if (hasHidden(raw)) return null;
  const folded = raw.replace(/\s+/g, ' ').trim();
  if (folded === '') return '';
  const r = screenText(cutPoints(folded, max), { max: max * 2, multiline: false, pii: false, secrets }); // screenText counts UTF-16 units; the cut above counted code points
  return r.ok ? r.text : null;
}

/** A value the model must send back exactly (an enum member): the screen may not change it. */
export function screenExact(raw: string, max: number, secrets: readonly string[] = []): boolean {
  if (hasHidden(raw) || Array.from(raw).length > max) return false;
  const r = screenText(raw, { max, multiline: false, pii: false, secrets });
  return r.ok && r.text === raw;
}

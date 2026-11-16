import { createHash } from 'node:crypto';
import { redactText } from '../core/logger.js';

export const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** Zero-width, bidi and other invisible format characters, and control characters other than newline and tab (K7, K13). */
export const INVISIBLE = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u2064\\u2066-\\u206f\\ufeff\\ufff9-\\ufffb]', 'u');

/** Text form used to spot a near-duplicate: compatibility-folded, lower case, punctuation and spacing removed. */
export function normalizeForDedup(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const luhn = (digits: string): boolean => {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
};

/** K13: email, national id, card and phone numbers are masked before anything is stored. */
export function maskPii(s: string): string {
  return s
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/(?<![\d-])\d-?\d{4}-?\d{5}-?\d{2}-?\d(?![\d-])/g, '[id]')
    .replace(/(?<![\w.])\d(?:[ -]?\d){12,18}(?![\w])/g, (m) => (luhn(m.replace(/\D/g, '')) ? '[card]' : m))
    .replace(/(?<![\w.])\+?\d[\d ()-]{7,}\d(?![\w])/g, (m) => {
      const n = m.replace(/\D/g, '').length;
      return n >= 9 && n <= 15 ? '[phone]' : m;
    });
}

export type Screened = { ok: true; text: string; masked: boolean } | { ok: false; reason: string };

/**
 * K13: the one gate in front of every store (notes, KB docs, lessons, prompts): secret-shaped text is refused (the G2A-05 redaction
 * identity: if the masker would change it, it is a secret), invisible and control characters are refused, PII is masked, size is capped.
 * `pii: false` is for prompt bodies, where masking would silently rewrite the text the admin is asked to confirm.
 */
export function screenText(text: string, o: { max: number; secrets?: readonly string[]; pii?: boolean; multiline?: boolean }): Screened {
  const t = text.normalize('NFC').trim();
  if (!t) return { ok: false, reason: 'empty text' };
  if (INVISIBLE.test(t)) return { ok: false, reason: 'invisible or control characters are not allowed' };
  if (o.multiline === false && /[\r\n]/.test(t)) return { ok: false, reason: 'a single line is required' };
  if (redactText(t, o.secrets ?? []) !== t) return { ok: false, reason: 'the text looks like it contains a secret' };
  const out = o.pii === false ? t : maskPii(t);
  if (out.length > o.max) return { ok: false, reason: `the text is longer than ${o.max} characters` };
  return { ok: true, text: out, masked: out !== t };
}

import { HIDDEN, visibleCode } from '../discord/embeds/approval.js';

/** Gate 1 S49: every interpolation is escaped unless it is already `SafeHtml`. Discord-sourced text never reaches the page raw. */
export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string { return this.value; }
}

const ENT: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

/** Escapes for text and quoted-attribute contexts; invisible, bidi and zero-width characters are written out visibly (S49). */
export function esc(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return s.replace(/[&<>"'`]/g, (c) => ENT[c]!).replace(HIDDEN, (c) => visibleCode(c));
}

export const raw = (s: string): SafeHtml => new SafeHtml(s);

function part(v: unknown): string {
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(part).join('');
  return esc(v);
}

export function html(strings: TemplateStringsArray, ...vals: unknown[]): SafeHtml {
  let out = strings[0]!;
  vals.forEach((v, i) => { out += part(v) + strings[i + 1]!; });
  return new SafeHtml(out);
}

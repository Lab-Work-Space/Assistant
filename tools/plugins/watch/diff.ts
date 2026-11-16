const LINE_MAX = 160;
const DEFAULT_MAX = 1200;
const MAX_LINES = 20;

const lines = (s: string): string[] => s.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

/** First `n` code points (never cuts a surrogate pair). */
export const clip = (s: string, n: number): string => (s.length <= n ? s : [...s].slice(0, n).join(''));

/** Every changed line ("+ added" first, then "- removed"), each capped; null when nothing changed. Whitespace-only differences are ignored. */
export function diffLines(prev: string, next: string): string[] | null {
  const before = lines(prev), after = lines(next);
  const had = new Set(before), has = new Set(after);
  const entries = [
    ...[...new Set(after.filter((l) => !had.has(l)))].map((l) => `+ ${clip(l, LINE_MAX)}`),
    ...[...new Set(before.filter((l) => !has.has(l)))].map((l) => `- ${clip(l, LINE_MAX)}`),
  ];
  return entries.length ? entries : null;
}

/** Joins whole entries while they fit `max` characters and `maxLines` lines; the rest becomes "… and N more" (always within `max`). */
export function fitLines(entries: string[], max: number, maxLines = MAX_LINES): string {
  const out: string[] = [];
  let used = 0;
  for (const e of entries) {
    const trailer = out.length + 1 < entries.length ? `… and ${entries.length - out.length - 1} more`.length + 1 : 0;
    if (out.length >= maxLines || used + e.length + 1 + trailer > max) break;
    out.push(e);
    used += e.length + 1;
  }
  if (out.length < entries.length) out.push(`… and ${entries.length - out.length} more`);
  return out.join('\n').slice(0, max);
}

/**
 * Line-set diff of two page snapshots: lines only in `next` are "+", lines only in `prev` are "-" (order of appearance,
 * duplicates folded). Null when nothing changed. Plain text, at most 20 lines and `max` characters (a trailer counts the omitted ones).
 * Built by code only (PF15); callers escape it before it reaches Discord.
 */
export function diffSummary(prev: string, next: string, max = DEFAULT_MAX): string | null {
  const e = diffLines(prev, next);
  return e === null ? null : fitLines(e, max);
}

/**
 * Makes untrusted page or search text safe to post: ASCII punctuation that Discord markdown or mentions use is
 * backslash-escaped, `@` is broken with a zero-width space, control characters are dropped. Escaping only; the caller caps length.
 */
export function escapeText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0009\u000b-\u001f\u007f​-‏‪-‮⁦-⁩]/g, '')
    .replace(/@/g, '@​')
    .replace(/[\\`*_~|>#[\](){}<:+\-.!=&]/g, '\\$&');
}

/** Index safe to cut at: never between a high and a low surrogate. */
function safeCut(s: string, at: number): number {
  const c = s.charCodeAt(at - 1);
  return c >= 0xd800 && c <= 0xdbff ? at - 1 : at;
}

/** Truncates to `max` UTF-16 units, ending in "…" when cut, without splitting a surrogate pair. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, safeCut(s, max - 1)) + '…';
}

/** Splits into chunks of at most `max` units, preferring newline then space boundaries. Chunks concatenate to the input. */
export function splitText(s: string, max: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = Math.max(window.lastIndexOf('\n'), 0);
    if (cut < max / 2) cut = Math.max(window.lastIndexOf(' '), cut);
    cut = cut >= max / 2 ? cut + 1 : safeCut(rest, max);
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest !== '') out.push(rest);
  return out;
}

const URL_RE = /https?:\/\/[^\s<>"'`\])}]+/gi;
const TRAILING = /[.,;:!?]+$/;

/** One canonical form for comparing urls (R17): http(s) only, fragment dropped. Null for anything else. */
export function urlKey(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

/** http(s) urls found in free text, trimmed of sentence punctuation, canonical, deduped. */
export function extractUrls(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.match(URL_RE) ?? []) {
    const k = urlKey(m.replace(TRAILING, ''));
    if (k) out.add(k);
  }
  return [...out];
}

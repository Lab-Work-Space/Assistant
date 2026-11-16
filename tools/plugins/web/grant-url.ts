import { isIP } from 'node:net';
import { redactText } from '../../../core/logger.js';
import { HIDDEN } from './webSearch.js';

/**
 * WEBGRANT-1 (D9): whether a fetch_page url may use the task web grant. Pure, synchronous, no network: it runs before any DNS lookup.
 * A failure never refuses the call; the per-URL approval card follows. Parsed once (W-C6): E1-E7 read the WHATWG-parsed parts, and the
 * length, credential-shape and hidden-character rules read BOTH the raw text and the parsed href. The host is exactly `u.hostname`.
 * The rules keep a url from carrying data out: https only, no userinfo or port, a plain DNS name, short words, no token shapes.
 */
export type GrantRule = 'E1' | 'E2' | 'E3' | 'E4' | 'E5' | 'E6' | 'E7' | 'E8' | 'E9';
export type GrantUrlResult = { ok: true; host: string; /** pathname + search length: what the grant's character budget counts. */ chars: number } | { ok: false; rule: GrantRule };

const SEP = /[-._~+,;=&/]/;
const fail = (rule: GrantRule): GrantUrlResult => ({ ok: false, rule });

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const STRIP = /[-._~+,;=]/g;
/** DEFECT-1: whole segment or query value with its separators removed, so a dashed id cannot hide as short groups. */
function runBad(whole: string): boolean {
  if (UUID.test(whole)) return true;
  const t = whole.replace(STRIP, '');
  return (t.length >= 16 && /^[0-9a-f]+$/i.test(t) && /[0-9]/.test(t)) || (t.match(/[0-9]/g)?.length ?? 0) >= 10;
}

function tokenBad(t: string): boolean {
  if (t.length >= 24) return true;
  if (t.length >= 16 && /^[0-9a-f]+$/i.test(t) && /[0-9]/.test(t)) return true;
  return (t.match(/[0-9]/g)?.length ?? 0) >= 10;
}

export function grantUrlCheck(raw: string): GrantUrlResult {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return fail('E1');
  }
  if (u.protocol !== 'https:') return fail('E1');
  if (u.username !== '' || u.password !== '') return fail('E2');
  if (u.port !== '') return fail('E3');
  const host = u.hostname;
  if (host === '' || host.startsWith('[') || host.includes(':') || isIP(host) !== 0 || !host.includes('.') || host.endsWith('.')
    || !/^[a-z0-9.-]+$/.test(host) || host.split('.').some((l) => l === '')) return fail('E4');
  const labels = host.split('.');
  if (host.length > 64 || labels.length > 5 || labels.some((l) => l.length > 24 || (l.match(/[0-9]/g)?.length ?? 0) > 3)) return fail('E5');
  const segments = u.pathname.split('/').filter((s) => s !== '');
  const params = [...u.searchParams.entries()];
  const pct = (u.pathname + u.search).match(/%[0-9a-fA-F]{2}/g)?.length ?? 0;
  if (raw.length > 256 || u.href.length > 256 || u.pathname.length > 160 || segments.length > 8 || u.search.length > 100 || params.length > 4
    || u.hash !== '' || raw.includes('#') || pct > 6) return fail('E6');
  const tokens = [...labels, ...segments, ...u.search.replace(/^\?/, '').split('&').flatMap((p) => p.split('='))].flatMap((s) => s.split(SEP));
  const values = u.search.replace(/^\?/, '').split('&').map((p) => p.slice(p.indexOf('=') + 1));
  if (tokens.some(tokenBad) || segments.some(runBad) || values.some(runBad)) return fail('E7');
  if (redactText(raw) !== raw || redactText(u.href) !== u.href) return fail('E8');
  if (HIDDEN.test(raw) || HIDDEN.test(u.href)) return fail('E9');
  return { ok: true, host, chars: u.pathname.length + u.search.length };
}

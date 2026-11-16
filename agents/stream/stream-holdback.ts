import { redactText } from '../../core/logger.js';

/**
 * STREAM-1 (Gate 1 S1/S2): which prefix of a half-written answer may be shown. The invariant: no edit reveals any character that the
 * full-text redaction (core/logger.ts TEXT_PATTERNS plus the literal secrets) masks once the text is complete, because every edit is
 * broadcast to the guild and logging bots keep copies.
 */
export const EDIT_INTERVAL_MS = 1500;
export const EDIT_MAX_INTERVAL_MS = 6000;
export const MIN_FIRST_CHARS = 40;
export const FIRST_WAIT_MS = 1200;
export const MIN_DELTA = 24;
export const PREVIEW_MAX = 1900;
export const HOLDBACK = 64;
export const STREAM_PER_CHANNEL = 1;
export const STREAM_MAX_ACTIVE = 4;
export const TYPING_REFRESH_MS = 8000;
/** Gate 1 S13: hard cap of writes (create + edits) per stream across all segments. */
export const EDIT_CAP = 120;
/** Gate 1 S14: typing never runs longer than this. */
export const TYPING_MAX_MS = 5 * 60_000;
/** The shown marker of an unfinished preview. */
export const ELLIPSIS = ' …';

const PEM_BEGIN = '-----BEGIN';
const PEM_END = /-----END [A-Z0-9 ]+-----/;
const TAB_LINE_START = (s: string): number => s.lastIndexOf('\n') + 1;
const COOKIE_TAIL = /(?:\b(?:Set-Cookie|Cookie):|\b(?:Bot|Basic))\s*$/i;
const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;

/** Start of the earliest literal prefix that the text ends with (>= 1 char), or -1. */
function literalTailStart(s: string, literals: readonly string[]): number {
  let best = -1;
  for (const lit of literals) {
    if (!lit) continue;
    const from = Math.max(0, s.length - (lit.length - 1));
    for (let i = from; i < s.length; i++) {
      if (s.charCodeAt(i) !== lit.charCodeAt(0)) continue;
      if (lit.startsWith(s.slice(i))) {
        if (best < 0 || i < best) best = i;
        break;
      }
    }
  }
  return best;
}

/**
 * The prefix length of `raw` that is safe to show (before redaction). Rules, applied to a fixpoint: (a) keep `holdback` chars back;
 * (b) cut before the trailing run of non-whitespace; (c) an open PEM block (also a partial header) is cut from its first dash;
 * (d) the last line holding a tab is held; (e) a trailing Cookie:/Set-Cookie:/Bot/Basic word is held; (f) a suffix (>= 1 char) of the
 * prefix that equals a prefix of a literal secret is cut; never inside a UTF-16 surrogate pair.
 */
export function safeLength(raw: string, literals: readonly string[] = [], holdback: number = HOLDBACK): number {
  let cut = Math.max(0, raw.length - holdback);
  for (let guard = 0; guard < 10_000; guard++) {
    const before = cut;
    // (b)
    while (cut > 0 && !/\s/.test(raw[cut - 1]!)) cut--;
    let head = raw.slice(0, cut);
    // (c)
    let p = head.indexOf(PEM_BEGIN);
    while (p >= 0) {
      if (!PEM_END.test(head.slice(p + PEM_BEGIN.length))) {
        cut = p;
        head = raw.slice(0, cut);
        break;
      }
      p = head.indexOf(PEM_BEGIN, p + PEM_BEGIN.length);
    }
    // a partial PEM header at the very end ("-----BEG") is a trailing non-whitespace run, held by (b)
    // (d)
    const ls = TAB_LINE_START(head);
    if (head.indexOf('\t', ls) >= 0) {
      cut = ls;
      head = raw.slice(0, cut);
    }
    // (e)
    const m = COOKIE_TAIL.exec(head);
    if (m) {
      cut = m.index;
      head = raw.slice(0, cut);
    }
    // (f)
    const lt = literalTailStart(head, literals);
    if (lt >= 0) {
      cut = lt;
      head = raw.slice(0, cut);
    }
    // surrogate pair
    if (cut > 0 && isHigh(raw.charCodeAt(cut - 1))) cut--;
    if (cut === before) break;
  }
  return cut;
}

/** What may be shown now: the safe prefix of `raw`, redacted with the live literal list, never longer than PREVIEW_MAX (cut after redaction, S2). */
export function committable(raw: string, secrets: readonly string[] = [], holdback: number = HOLDBACK): string {
  const redacted = redactText(raw.slice(0, safeLength(raw, secrets, holdback)), secrets);
  if (redacted.length <= PREVIEW_MAX) return redacted;
  let end = PREVIEW_MAX;
  if (isHigh(redacted.charCodeAt(end - 1))) end--;
  return redacted.slice(0, end);
}

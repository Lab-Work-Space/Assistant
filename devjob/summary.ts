import type { Facts } from './facts.js';

/**
 * The text a human reads before confirming (Gate 1 self-code X20): code-computed facts first, in a fixed order, then model text labelled as
 * unverified. The second-confirmation prompt is cut at 1800 characters by SecondConfirm, so the order is the priority and an overflow ends in an
 * explicit marker, never a silent cut.
 */
export const PROMPT_BUDGET = 1700;

/** Model-written text made safe to show: mentions broken, markdown neutralised, invisible and bidi characters shown as markers, length capped. */
export function defang(s: string, max = 300): string {
  const marker = (c: number) => `<U+${c.toString(16).toUpperCase().padStart(4, '0')}>`;
  const invisible = (c: number) => (c >= 0x202a && c <= 0x202e) || (c >= 0x2066 && c <= 0x2069) || (c >= 0x200b && c <= 0x200d) || c === 0x2060 || c === 0xfeff;
  const t = [...s].map((ch) => {
    const c = ch.codePointAt(0)!;
    if (invisible(c)) return marker(c);
    if (c < 0x20 && c !== 0x0a) return '?';
    if (ch === '@') return '@\u200b';
    if ('`*_~|>\\'.includes(ch)) return `\\${ch}`;
    return ch;
  }).join('').replace(/\bhttps?:\/\//gi, (m) => `${m.slice(0, -3)}\u200b:\u200b//`);
  return t.length > max ? `${t.slice(0, max)}...(cut)` : t;
}

export interface ModelText { summary?: string; review?: string }
export interface Evidence {
  repo: string;
  bundleSha256: string;
  jobId: string;
  /** G2SC-09: who asked (the card's proposer can be the owner). */
  requesterId?: string;
  /** Test counts and results from the X5 container: advisory. */
  tests?: { before: number; after: number; typecheck: boolean; build: boolean };
  verdicts?: { code: string; security: string };
  spendUsd?: number;
  ownerOnly: boolean;
  dashboardUrl?: string;
}

const short = (s: string): string => s.slice(0, 12);
const flagsOf = (f: Facts['files'][number]): string => [f.protected ? 'protected' : '', f.closure ? 'closure' : '', f.test ? 'test' : '', f.nonSelfModifiable ? 'NON-SELF-MODIFIABLE' : ''].filter(Boolean).join(',');

/** Lines in priority order; the caller joins them. */
export function summaryLines(f: Facts, e: Evidence, model: ModelText = {}): string[] {
  const out: string[] = [];
  out.push(`CODE CHANGE ${e.repo}: base ${short(f.base)} -> head ${short(f.head)}, ${f.commits} commit(s), bundle sha256 ${e.bundleSha256.slice(0, 16)}`);
  if (e.requesterId) out.push(`requested by <${e.requesterId}>, diff sha256 ${f.diffSha256.slice(0, 16)}`);
  else out.push(`diff sha256 ${f.diffSha256.slice(0, 16)}`);
  for (const r of f.refusals) out.push(`REFUSED: ${r}`);
  out.push(e.ownerOnly ? 'Protected paths: only the owner can confirm.' : 'No protected paths: a Bot Admin can confirm.');
  const prot = f.files.filter((x) => x.protected || x.closure || x.nonSelfModifiable);
  const rest = f.files.filter((x) => !prot.includes(x));
  const row = (x: Facts['files'][number]) => `${x.status} ${JSON.stringify(x.path).slice(1, -1)}${flagsOf(x) ? ` [${flagsOf(x)}]` : ''}`;
  out.push(...[...prot, ...rest].map(row));
  for (const d of f.deps) out.push(`new dependency ${d.name}@${d.version}${d.hasInstallScript ? ' (HAS INSTALL SCRIPT, not run)' : ''} published ${d.publishedAt?.slice(0, 10) ?? 'unknown'}`);
  if (f.deps.length) out.push(f.auditNote);
  if (e.tests) out.push(`tests ${e.tests.before} -> ${e.tests.after}; type check ${e.tests.typecheck ? 'ok' : 'FAILED'}; build ${e.tests.build ? 'ok' : 'FAILED'} (run by the code under test: evidence, never a gate)`);
  for (const l of f.flags) out.push(`flag: ${l}`);
  if (e.verdicts) out.push(`reviews: code ${e.verdicts.code}, security ${e.verdicts.security} (automated; never sufficient alone)`);
  if (e.spendUsd !== undefined) out.push(`spend: $${e.spendUsd.toFixed(2)}`);
  if (model.summary) out.push(`model-written, unverified: ${defang(model.summary)}`);
  if (model.review) out.push(`model-written review, unverified: ${defang(model.review)}`);
  out.push('The health window does not undo side effects (messages, database writes, outbound calls).');
  if (e.dashboardUrl) out.push(`Full diff: ${e.dashboardUrl}`);
  return out;
}

/** Fits the lines in `budget` characters; what does not fit becomes "+N more, see dashboard". The last two lines (side effects, link) always stay. */
export function fitSummary(lines: readonly string[], budget = PROMPT_BUDGET): string {
  const keep = lines.slice(-2);
  const body = lines.slice(0, -2);
  const tail = `\n${keep.join('\n')}`;
  const out: string[] = [];
  let used = tail.length + 40;
  for (let i = 0; i < body.length; i++) {
    const l = body[i]!.length > 240 ? `${body[i]!.slice(0, 240)}...` : body[i]!;
    if (used + l.length + 1 > budget) { out.push(`+${body.length - i} more, see dashboard`); break; }
    out.push(l);
    used += l.length + 1;
  }
  return out.join('\n') + tail;
}

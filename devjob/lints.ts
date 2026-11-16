/**
 * Deterministic lints (Gate 1 self-code X13) and the static test-integrity scan (X12). Pure, byte bounded and fail closed. They run before any
 * reviewer; no reviewer verdict overrides a refusal here.
 */
export const MAX_FILE_BYTES = 256 * 1024;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export interface LintInput {
  path: string;
  /** Content after the change (null for a deleted file). */
  head: string | null;
  /** Content before the change (null for an added file). */
  base: string | null;
  isTest: boolean;
}
export interface LintResult {
  refusals: string[];
  /** Shown on the card and force the security pass. */
  flags: string[];
}

// Trojan Source (CVE-2021-42574) and invisible characters.
const BIDI = /[‪-‮⁦-⁩]/;
const ZERO_WIDTH = /[​-‍⁠﻿]/;
const NON_ASCII = /[^\x00-\x7f]/; // eslint-disable-line no-control-regex

/** Lines present in `head` and not in `base` (a multiset difference: robust against reordering, needs no diff parser). */
export function addedLines(base: string | null, head: string): string[] {
  const have = new Map<string, number>();
  for (const l of (base ?? '').split('\n')) have.set(l, (have.get(l) ?? 0) + 1);
  const out: string[] = [];
  for (const l of head.split('\n')) {
    const n = have.get(l) ?? 0;
    if (n > 0) have.set(l, n - 1);
    else out.push(l);
  }
  return out;
}

const NEW_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"](?:node:)?(child_process|vm|worker_threads|net|http|https|http2|tls|dgram|dns|fs|fs\/promises|cluster|inspector|repl)['"]/;
const EVAL_LIKE = /\beval\s*\(|\bnew\s+Function\s*\(|(?<![\w.])Function\s*\(/;
const DYNAMIC = /\bimport\s*\(\s*[^'"\s)]|\brequire\s*\(\s*[^'"\s)]/;
const ENV_READ = /\bprocess\.env\b/;
const URL_LITERAL = /(?:https?|wss?):\/\/[a-z0-9.-]+/i;
const FETCH_SITE = /\b(?:fetch|safeFetch|request|got|axios)\s*\(/;
const BLOB = /[A-Za-z0-9+/=]{200,}|[0-9a-fA-F]{200,}/;

export function lintFile(f: LintInput): LintResult {
  const refusals: string[] = [];
  const flags: string[] = [];
  const at = JSON.stringify(f.path).slice(0, 100);
  if (f.head === null) return { refusals, flags };
  if (f.head.includes('\0')) refusals.push(`binary content: ${at}`);
  if (Buffer.byteLength(f.head, 'utf8') > MAX_FILE_BYTES) refusals.push(`file above the ${MAX_FILE_BYTES} byte cap: ${at}`);
  if (BIDI.test(f.head)) refusals.push(`bidirectional control character: ${at}`);
  if (ZERO_WIDTH.test(f.head)) refusals.push(`zero-width character: ${at}`);
  const allAdded = addedLines(f.base, f.head);
  // A line over 300 characters is flagged and never run through the other patterns: bounded work per line (fail closed on size, not on regex time).
  const added = allAdded.map((l) => (l.length > 300 ? '' : l));
  const code = /\.(?:[cm]?[jt]sx?|sh|json|ya?ml|sql)$/i.test(f.path);
  if (code) {
    if (added.some((l) => NON_ASCII.test(l))) flags.push(`non-ASCII in code: ${at}`);
    if (allAdded.some((l) => l.length > 300)) flags.push(`line over 300 characters (minified or generated?): ${at}`);
    if (allAdded.some((l) => l.length > 300) ? false : added.some((l) => BLOB.test(l))) flags.push(`base64 or hex run over 200 characters: ${at}`);
    if (added.some((l) => NEW_IMPORT.test(l))) flags.push(`new import of a process, network or file-system module: ${at}`);
    if (added.some((l) => EVAL_LIKE.test(l))) flags.push(`new eval or Function: ${at}`);
    if (added.some((l) => DYNAMIC.test(l))) flags.push(`new dynamic import or require: ${at}`);
    if (added.some((l) => ENV_READ.test(l))) flags.push(`new process.env read: ${at}`);
    if (added.some((l) => URL_LITERAL.test(l))) flags.push(`new URL or host literal: ${at}`);
    if (added.some((l) => FETCH_SITE.test(l))) flags.push(`new outbound call site: ${at}`);
    // Confusable identifiers: a non-ASCII letter inside an identifier-looking token.
    if (added.some((l) => /[A-Za-z_$][\w$]{0,60}[^\x00-\x7f]/.test(l))) flags.push(`possible confusable identifier: ${at}`);
  }
  if (f.isTest) {
    for (const l of added) {
      if (/\.(?:skip|only|todo|fails)\b|\b(?:skipIf|runIf)\b|\b(?:xit|xdescribe|xtest)\s*\(/.test(l)) {
        refusals.push(`test integrity: a skip, only, todo or conditional marker was added: ${at}`);
        break;
      }
    }
    if (added.some((l) => /^\s*(?:if\s*\(.*\)\s*)?return\s*;?\s*$/.test(l) && /^\s{0,4}\S/.test(l))) refusals.push(`test integrity: a top-level conditional return was added: ${at}`);
    if (f.base !== null) flags.push(`existing test file changed: ${at}`);
  }
  return { refusals, flags };
}

export function lintAll(files: readonly LintInput[]): LintResult {
  const r: LintResult = { refusals: [], flags: [] };
  let total = 0;
  for (const f of files) {
    const x = lintFile(f);
    r.refusals.push(...x.refusals);
    r.flags.push(...x.flags);
    total += f.head ? Buffer.byteLength(f.head, 'utf8') : 0;
  }
  if (total > MAX_TOTAL_BYTES) r.refusals.push(`the changed files add up to more than ${MAX_TOTAL_BYTES} bytes`);
  return r;
}

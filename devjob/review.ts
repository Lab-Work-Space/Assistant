import { z } from 'zod';

/** Reviewer output (Gate 1 self-code X15): a strict schema; anything else, including prose around the JSON, is REJECT. A reviewer can only block. */
const Finding = z.object({ severity: z.enum(['low', 'medium', 'high']), file: z.string().max(200), note: z.string().max(500) }).strict();
const Verdict = z.object({ verdict: z.enum(['APPROVE', 'CONDITIONAL', 'REJECT']), findings: z.array(Finding).max(30) }).strict();
export type ReviewVerdict = z.infer<typeof Verdict>;

export function parseReview(stdout: string): ReviewVerdict {
  const reject = (why: string): ReviewVerdict => ({ verdict: 'REJECT', findings: [{ severity: 'high', file: '-', note: why }] });
  const t = stdout.trim();
  if (t.length === 0 || t.length > 200_000) return reject('the reviewer gave no usable output');
  // The CLI's --output-format=json wraps the answer in {"result": "..."}; accept exactly that wrapper or the bare object.
  let v: unknown;
  try { v = JSON.parse(t); } catch { return reject('the reviewer output is not JSON'); }
  if (v && typeof v === 'object' && 'result' in v && typeof (v as { result: unknown }).result === 'string') {
    try { v = JSON.parse((v as { result: string }).result.trim()); } catch { return reject('the reviewer answer is not JSON'); }
  }
  const p = Verdict.safeParse(v);
  return p.success ? p.data : reject('the reviewer output does not match the schema');
}

/** The pair of passes combined: any REJECT blocks; CONDITIONAL is shown as model text; APPROVE alone never unlocks anything. */
export const blocks = (...vs: ReviewVerdict[]): boolean => vs.some((v) => v.verdict === 'REJECT');
export const label = (v: ReviewVerdict): string => v.verdict;

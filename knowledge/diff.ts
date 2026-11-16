/** Line diff for the cards and the size cap (K8c). Bodies are small (<= 20 000 chars); beyond the line cap everything counts as changed. */
export type DiffOp = { t: ' ' | '+' | '-'; line: string };
const LINE_CAP = 1500;

export function lineDiff(a: string, b: string): DiffOp[] {
  const x = a === '' ? [] : a.split('\n');
  const y = b === '' ? [] : b.split('\n');
  if (x.length > LINE_CAP || y.length > LINE_CAP) return [...x.map((line) => ({ t: '-' as const, line })), ...y.map((line) => ({ t: '+' as const, line }))];
  const n = x.length;
  const m = y.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ t: ' ', line: x[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ t: '-', line: x[i++]! });
    else out.push({ t: '+', line: y[j++]! });
  }
  while (i < n) out.push({ t: '-', line: x[i++]! });
  while (j < m) out.push({ t: '+', line: y[j++]! });
  return out;
}

/** Plain unified-style text: every line of both versions is present, changed lines are marked +/-. Shown as escaped text only. */
export function unifiedDiff(a: string, b: string): string {
  return lineDiff(a, b).map((o) => `${o.t}${o.line}`).join('\n');
}

/** Characters on added and removed lines. */
export function changedChars(a: string, b: string): number {
  return lineDiff(a, b).reduce((n, o) => n + (o.t === ' ' ? 0 : o.line.length + 1), 0);
}

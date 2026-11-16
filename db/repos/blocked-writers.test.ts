import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// TASKADMIN-1 (TA-C14): every SQL that WRITES blocked_reason also writes blocked_note (the migration 036 backstop CHECK would otherwise throw at run time).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'vendor', 'docs']);

function* sources(dir: string): Generator<string> {
  for (const f of readdirSync(dir)) {
    if (SKIP.has(f)) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) yield* sources(p);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) yield p;
  }
}

/** Offsets of assignments to blocked_reason (not comparisons: `AND blocked_reason = 'halt'`, `WHERE blocked_reason = ...`). */
export function reasonWrites(src: string): number[] {
  const out: number[] = [];
  for (const m of src.matchAll(/blocked_reason\s*=/g)) {
    const before = src.slice(Math.max(0, m.index! - 8), m.index!);
    if (/(AND|WHERE|OR)\s*$/i.test(before) || /[.(]\s*$/.test(before)) continue;
    out.push(m.index!);
  }
  return out;
}
export const missingNote = (src: string): number[] => reasonWrites(src).filter((i) => !src.slice(Math.max(0, i - 700), i + 700).includes('blocked_note'));

describe('blocked_note writers (TA-C14)', () => {
  it('no SQL in the repo writes blocked_reason without blocked_note', () => {
    const bad: string[] = [];
    let writers = 0;
    for (const f of sources(ROOT)) {
      const src = readFileSync(f, 'utf8');
      writers += reasonWrites(src).length;
      if (missingNote(src).length) bad.push(relative(ROOT, f));
    }
    expect(bad).toEqual([]);
    expect(writers).toBeGreaterThanOrEqual(3); // TaskRepo.update, TaskRepo.unblockHalted, approvals move(): the scan really sees them
  });

  it('the scan itself catches a writer that forgets the note', () => {
    expect(missingNote("UPDATE tasks SET status = 'todo', blocked_reason = NULL WHERE id = $1")).toHaveLength(1);
    expect(missingNote("UPDATE tasks SET status = 'todo', blocked_reason = NULL, blocked_note = NULL WHERE id = $1")).toHaveLength(0);
    expect(missingNote("SELECT 1 FROM tasks WHERE status = 'blocked' AND blocked_reason = 'halt'")).toHaveLength(0);
  });
});

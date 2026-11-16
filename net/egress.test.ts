import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', 'dist', '.git', '.superpowers', '.claude']);

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('egress', () => {
  it('only net/ and tests/ import net/fetch (tools use net/guard, which binds the real address predicate)', () => {
    const offenders = tsFiles(ROOT)
      .map((f) => relative(ROOT, f))
      .filter((f) => !f.startsWith(`net${sep}`) && !f.startsWith(`tests${sep}`))
      .filter((f) => /from\s+['"][^'"]*net\/fetch(\.js)?['"]|import\(\s*['"][^'"]*net\/fetch(\.js)?['"]/.test(readFileSync(join(ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });
});

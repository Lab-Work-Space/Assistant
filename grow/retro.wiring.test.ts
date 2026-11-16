import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'docs', 'vendor', 'data']);
function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (e.endsWith('.ts') && !e.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

describe('GW-C2: trigger.retro has exactly one writer', () => {
  it('only Scheduler.retroRun sets `retro: true` on an agent trigger; nothing else in production code builds it', () => {
    const hits: string[] = [];
    for (const f of sources(ROOT)) {
      readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
        if (/\bretro\s*:\s*true\b/.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('*')) hits.push(`${relative(ROOT, f)}:${i + 1}`);
      });
    }
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatch(/^agents\/scheduler\/scheduler\.ts:/);
  });
  it('the registry offer and the dispatch list come from the same `allowedFor` (no second filter on the offered list)', () => {
    const src = readFileSync(join(ROOT, 'agents/loop/loop.ts'), 'utf8');
    expect(src).toContain('deps.tools.specsFor(allowedFor(withProject(deps.org.toolsFor(actor))))');
    expect(src).not.toMatch(/specsFor\(allowedFor\([^)]*\)\)?\.filter/);
  });
});

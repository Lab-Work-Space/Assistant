import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'vendor', '.git', '.claude', 'releases', 'docs']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Blank out comments and string-free line comments so a mention in prose never counts. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

const files = walk(ROOT).map((p) => ({ rel: relative(ROOT, p), src: code(readFileSync(p, 'utf8')) }));

/**
 * G4 (R8, rule 6: an allowlist, not a denylist). Provider selection goes through `resolveEffective`. The registry's `resolve` and a direct
 * `get('claude')` / FALLBACK_PROVIDER are reachable only from the route module, the registry itself and the metered media service.
 */
const ALLOWED = new Set(['providers/route.ts', 'providers/registry.ts', 'agents/call/metered.ts']);

describe('R8 G4: one route function', () => {
  const hits = (re: RegExp): string[] => files.filter((f) => !ALLOWED.has(f.rel) && re.test(f.src)).map((f) => f.rel).sort();

  it('no providers.resolve( outside providers/route.ts and providers/registry.ts', () => {
    expect(hits(/providers\.resolve\(/)).toEqual([]);
  });
  it('no providers.get( outside the allowlist', () => {
    expect(hits(/providers\.get\(/)).toEqual([]);
  });
  it("no get('claude') and no FALLBACK_PROVIDER outside the allowlist", () => {
    expect(hits(/\.get\(\s*['"`]claude['"`]\s*\)/)).toEqual([]);
    expect(hits(/FALLBACK_PROVIDER/)).toEqual([]);
  });
  it('the scan really sees the use sites (a guard that finds nothing proves nothing)', () => {
    expect(files.some((f) => f.rel === 'providers/route.ts')).toBe(true);
    // the six use sites: loop, judge, helper call, and the scheduler's providerOk, isHeld and warroom lift
    for (const rel of ['agents/loop/loop.ts', 'governance/judge-call.ts', 'knowledge/small.ts']) expect(files.find((f) => f.rel === rel)?.src, rel).toMatch(/resolveEffective\(/);
    expect(files.find((f) => f.rel === 'agents/scheduler/scheduler.ts')!.src.match(/resolveEffective\(/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(code('// providers.resolve(x)\nconst a = 1; /* providers.resolve( */')).not.toContain('providers.resolve(');
  });
});

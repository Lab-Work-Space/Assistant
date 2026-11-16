import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * G2-MCP-02: the sandbox precondition (MC-C3 seccomp) applies on every path that spawns the MCP sandbox. This enumerates the production call sites of `withSandbox(` and of the spawner
 * (`.spawn(`), so a new one fails here until it is reviewed and its guard is named. Reviewed sites:
 *  - mcp/sandbox.ts: the definition (`d.spawn(argv)` inside withSandbox);
 *  - mcp/admin.ts `probe`: gated by `checkSeccomp` as its first statement, on every probe;
 *  - mcp/tool.ts: reachable only for a tool in the host, and the host is empty until `bootMcp` passed the seccomp check (app.ts `mcpHostGate.refresh` needs `mcpBooted`).
 */
const root = fileURLToPath(new URL('../', import.meta.url));
const SKIP = new Set(['node_modules', 'dist', '.git', 'vendor', 'data', 'docs']);
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(path.join(dir, e.name), out); }
    else if (e.name.endsWith('.ts') && !/\.test\.ts$/.test(e.name) && !e.name.endsWith('test-helpers.ts') && !e.name.endsWith('spawner-fixture.ts')) out.push(path.relative(root, path.join(dir, e.name)));
  }
  return out;
}
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('G2-MCP-02: the spawn call sites of the MCP sandbox are enumerated', () => {
  const files = walk(root);
  const sites = (re: RegExp): string[] => files.filter((f) => re.test(strip(readFileSync(path.join(root, f), 'utf8')))).sort();
  it('only sandbox.ts, admin.ts and tool.ts call withSandbox or the spawner', () => {
    expect(sites(/\bwithSandbox\s*[(<]/)).toEqual(['mcp/admin.ts', 'mcp/sandbox.ts', 'mcp/tool.ts']);
    expect(sites(/\b(?:d|sandbox|this\.d\.sandbox)\.spawn\s*\(/)).toEqual(['mcp/sandbox.ts']);
  });
  it('G2-MCP-R1: the spawner is not reachable under any other name: importers of sandbox.ts (any specifier form), references to its symbols, and spawner property uses are enumerated', () => {
    // 1. Every production file that imports mcp/sandbox, resolved from its own directory (static, dynamic, require, with or without .js, absolute or file: forms).
    const importers = files.filter((f) => {
      const src = strip(readFileSync(path.join(root, f), 'utf8'));
      const specs = [...src.matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"`]([^'"`]+)['"`]/g)].map((m) => m[1]!);
      return specs.some((sp) => {
        const clean = sp.replace(/^file:\/\//, '').replace(/\.(?:js|ts)$/, '');
        const abs = clean.startsWith('/') ? clean : path.resolve(root, path.dirname(f), clean);
        return abs === path.join(root, 'mcp/sandbox');
      });
    }).sort();
    expect(importers).toEqual(['app.ts', 'mcp/admin.ts', 'mcp/boot.ts', 'mcp/tool.ts']);
    // 2. Any mention of the sandbox symbols (a rename on import, a re-export or a type-only use still names them).
    expect(sites(/\b(?:withSandbox|SandboxDeps|realMcpSpawner|McpSpawner)\b/)).toEqual(['app.ts', 'mcp/admin.ts', 'mcp/rpc.ts', 'mcp/sandbox.ts', 'mcp/tool.ts']);
    // 3. The spawner as a property on any receiver, a destructured or shorthand `spawn`, or a bracket access, in the files that can hold a SandboxDeps value.
    const spawnUse = /\.\s*spawn\b|\[\s*['"`]spawn['"`]\s*\]|[{,]\s*spawn\s*[,}]|\bspawn\s*:/;
    expect(sites(spawnUse).filter((f) => f.startsWith('mcp/') || importers.includes(f) || f === 'app.ts')).toEqual(['app.ts', 'mcp/sandbox.ts']);
  });
  it('admin.ts spawns in exactly one place, and the shared seccomp check is the first thing that place does', () => {
    const src = strip(readFileSync(path.join(root, 'mcp/admin.ts'), 'utf8'));
    expect(src.match(/\bwithSandbox\s*\(/g)).toHaveLength(1);
    const probe = src.slice(src.indexOf('private async probe('));
    expect(probe.indexOf('checkSeccomp(this.d.docker)')).toBeGreaterThan(0);
    expect(probe.indexOf('checkSeccomp(this.d.docker)')).toBeLessThan(probe.indexOf('withSandbox('));
    expect(src.match(/this\.probe\(/g)!.length).toBe(3); // stageBody (add and stageRelease share it: one place, seccomp first), approve, test
  });
  it('the boot uses the same shared function (no second copy of the check)', () => {
    const boot = strip(readFileSync(path.join(root, 'mcp/boot.ts'), 'utf8'));
    expect(boot).toContain('checkSeccomp(d.docker)');
    expect(boot).not.toContain('SecurityOptions');
  });
  it('tool.ts is reached only through a booted host: the app gate refreshes only after a successful boot', () => {
    const app = strip(readFileSync(path.join(root, 'app.ts'), 'utf8'));
    expect(app).toContain('refresh: async (slug?: string) => { if (mcpBooted) await mcpHost.refresh(slug); }');
  });
});

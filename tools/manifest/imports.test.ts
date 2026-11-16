import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * PM-C8 (global rule 6): the allowlist import test for the manifest chain. The parser reads static `import`, `export ... from`, dynamic `import()` and
 * `require()`; a non-literal dynamic import or a createRequire is itself a violation. It is proven by bypass probes below.
 */
const root = fileURLToPath(new URL('../../', import.meta.url));

/** Source with comments removed (string and template contents are kept, so specifiers survive). */
export function stripComments(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; ) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; out += ' '; continue; }
    if (c === "'" || c === '"' || c === '`') {
      out += c; i++;
      while (i < src.length && src[i] !== c) { if (src[i] === '\\') { out += src[i]!; i++; } out += src[i] ?? ''; i++; }
      out += c; i++; continue;
    }
    out += c; i++;
  }
  return out;
}

/** Every module specifier the source pulls in, plus a marker for anything that can not be read statically. */
export function specifiers(src: string): string[] {
  const code = stripComments(src);
  const out: string[] = [];
  for (const m of code.matchAll(/\bimport\s+(?:type\s+)?(?:[\w*${},\s]+?\s+from\s+)?(['"])([^'"]+)\1/g)) out.push(m[2]!);
  for (const m of code.matchAll(/\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+(['"])([^'"]+)\1/g)) out.push(m[2]!);
  for (const m of code.matchAll(/\b(import|require)\s*\(\s*([^)]*)\)/g)) {
    const lit = /^(['"])([^'"]+)\1$/.exec(m[2]!.trim());
    out.push(lit ? lit[2]! : `<non-literal ${m[1]}>`);
  }
  if (/\bcreateRequire\b/.test(code)) out.push('<createRequire>');
  return out;
}

const abs = (fromFile: string, spec: string): string => (spec.startsWith('.') ? path.resolve(path.dirname(fromFile), spec).replace(/\.js$/, '.ts') : spec);
const file = (rel: string): string => path.join(root, rel);
export function violations(rel: string, allowed: readonly string[]): string[] {
  const p = file(rel);
  const ok = new Set(allowed.map((a) => (a.startsWith('node:') ? a : file(a))));
  return specifiers(readFileSync(p, 'utf8')).map((s) => abs(p, s)).filter((s) => !ok.has(s));
}

describe('the import checker itself (bypass probes)', () => {
  it('reads static imports, side-effect imports, multi-line imports and type imports', () => {
    expect(specifiers("import { a } from './x.js';\nimport b from '../y.js';\nimport './z.js';\nimport type { T } from './t.js';\nimport * as ns from './n.js';")).toEqual(['./x.js', '../y.js', './z.js', './t.js', './n.js']);
    expect(specifiers("import {\n  a,\n  b,\n} from './multi.js';")).toEqual(['./multi.js']);
  });
  it('probe 1: export ... from', () => {
    expect(specifiers("export { a } from './re.js';\nexport * from './all.js';\nexport * as q from './q.js';\nexport type { T } from './tt.js';")).toEqual(['./re.js', './all.js', './q.js', './tt.js']);
  });
  it('probe 2: dynamic import(), literal and computed', () => {
    expect(specifiers("const m = await import('./dyn.js');")).toEqual(['./dyn.js']);
    expect(specifiers("const m = await import(name);")).toEqual(['<non-literal import>']);
    expect(specifiers("await import('./' + 'x.js')")).toEqual(['<non-literal import>']);
  });
  it('probe 3: require() and createRequire', () => {
    expect(specifiers("const x = require('./cjs.js');")).toEqual(['./cjs.js']);
    expect(specifiers("const x = require(p);")).toEqual(['<non-literal require>']);
    expect(specifiers("import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);")).toEqual(['node:module', '<createRequire>']);
  });
  it('probe 4: comments hide nothing and add nothing', () => {
    expect(specifiers("// import { a } from './commented.js';\n/* import './block.js'; */\nimport { b } from './real.js';")).toEqual(['./real.js']);
    expect(specifiers("const u = 'https://x.test/a//b'; import('./after-url.js');")).toEqual(['./after-url.js']);
    expect(specifiers("const s = `${a}`; /* x */ require('./after-template.js')")).toEqual(['./after-template.js']);
  });
  it('a bypass attempt in a scratch string is reported as a violation of the allowlist', () => {
    const ok = new Set([file('tools/manifest/types.ts')]);
    const spec = specifiers("import { READ } from '../../manifest/types.js';\nconst x = await import('../../../governance/x.js');").map((s) => abs(file('tools/plugins/web/manifest.ts'), s)).filter((s) => !ok.has(s));
    expect(spec).toEqual([file('governance/x.ts')]);
  });
});

describe('the manifest chain imports only what the allowlist says', () => {
  const manifests = [...readdirSync(file('tools/plugins'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => `tools/plugins/${d.name}/manifest.ts`), 'tools/builtin/manifest.ts', 'admin/manifest.ts'];
  it('types.ts and floor.ts have no imports at all', () => {
    expect(specifiers(readFileSync(file('tools/manifest/types.ts'), 'utf8'))).toEqual([]);
    expect(specifiers(readFileSync(file('tools/manifest/floor.ts'), 'utf8'))).toEqual([]);
  });
  it('each manifest.ts imports only tools/manifest/types', () => {
    expect(manifests).toHaveLength(17);
    for (const m of manifests) expect(violations(m, ['tools/manifest/types.ts']), m).toEqual([]);
    for (const m of manifests) expect(specifiers(readFileSync(file(m), 'utf8')), m).toHaveLength(1);
  });
  it('catalog.ts imports only types, floor, external, the 17 manifests and node:crypto', () => {
    expect(violations('tools/manifest/catalog.ts', ['tools/manifest/types.ts', 'tools/manifest/floor.ts', 'tools/manifest/external.ts', 'node:crypto', ...manifests])).toEqual([]);
    expect(specifiers(readFileSync(file('tools/manifest/catalog.ts'), 'utf8'))).toHaveLength(2 + 1 + 17 + 1);
  });
  it('R6: external.ts (the class table for MCP names) is a leaf that imports only types.ts', () => {
    expect(violations('tools/manifest/external.ts', ['tools/manifest/types.ts'])).toEqual([]);
    expect(specifiers(readFileSync(file('tools/manifest/external.ts'), 'utf8'))).toEqual(['./types.js']);
  });
  it('tree-grant-tools.ts (the leaf the card renderer reads) imports nothing but the catalog chain', () => {
    expect(violations('tools/tree-grant-tools.ts', ['tools/manifest/catalog.ts'])).toEqual([]);
  });
});

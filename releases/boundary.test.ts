import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * RL-C1 (Gate 1, global rule 6): the release code has no path from an AI or tool run to `decide`, `claim` or `reject`.
 * This is an ALLOWLIST of the files that may import the release modules, and an allowlist of what the release modules may import.
 * The parser reads static `import`, `export ... from`, dynamic `import()` and `require()`; a non-literal one and `createRequire` are reported.
 * It lives under releases/ so a bot diff cannot weaken it (devjob/paths.ts protects the prefix). The parser is self-contained: importing another
 * test file would re-run its describe blocks.
 */
const root = fileURLToPath(new URL('../', import.meta.url));

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

export type Ref = { spec: string; typeOnly: boolean };

/** Every module reference, with whether it is certainly erased at run time (`import type`, `export type ... from`, or a qualified `import('x').Type` outside `await`). */
export function refs(src: string): Ref[] {
  return refsIn(stripComments(src));
}

/**
 * Gate 2 (G2-RL-01): stripComments cannot tell a regex literal from a comment, so `/[/*]/` or `/[//]/` would hide a real import after it. The checks
 * below therefore scan the stripped text AND the raw text; the raw pass can only add references (a commented import of a guarded module counts too).
 */
export function scanRefs(src: string): Ref[] {
  const seen = new Set<string>();
  return [...refs(src), ...refsIn(src)].filter((r) => { const k = `${r.typeOnly}|${r.spec}`; return seen.has(k) ? false : (seen.add(k), true); });
}

function refsIn(code: string): Ref[] {
  const out: Ref[] = [];
  for (const m of code.matchAll(/\bimport\s+(type\s+)?(?:[\w*${},\s]+?\s+from\s+)?(['"])([^'"]+)\2/g)) out.push({ spec: m[3]!, typeOnly: m[1] !== undefined });
  for (const m of code.matchAll(/\bexport\s+(type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+(['"])([^'"]+)\2/g)) out.push({ spec: m[3]!, typeOnly: m[1] !== undefined });
  for (const m of code.matchAll(/(\bawait\s+|\()?\b(import|require)\s*\(\s*([^)]*)\)(\s*\.\s*[A-Z]\w*)?/g)) {
    const lit = /^(['"])([^'"]+)\1$/.exec(m[3]!.trim());
    out.push(lit ? { spec: lit[2]!, typeOnly: m[2] === 'import' && m[1] === undefined && m[4] !== undefined } : { spec: `<non-literal ${m[2]}>`, typeOnly: false });
  }
  if (/\bcreateRequire\b/.test(code)) out.push({ spec: '<createRequire>', typeOnly: false });
  return out;
}

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\.(js|ts)$/, '');
/** Gate 2 R6 (G2-MCP-01): an absolute path or a `file:` URL names a repo file as surely as `./x` does, so both are resolved against the root too (a bad URL is its own marker). */
const resolve = (fromFile: string, spec: string): string => {
  let s = spec;
  if (/^file:/i.test(s)) { try { s = fileURLToPath(s); } catch { return '<bad file url>'; } }
  return s.startsWith('.') || path.isAbsolute(s) ? norm(path.relative(root, path.resolve(path.dirname(fromFile), s))) : s;
};

const SKIP = new Set(['node_modules', 'dist', 'vendor', '.claude', '.git', 'docs']);
/** G2-RL-01: symlinks are never followed; they are collected so a test can pin the set (a linked directory would give a guarded module a second path). */
const LINKS: string[] = [];
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = path.join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) { LINKS.push(p); continue; }
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.ts') && !/\.test\.ts$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}
const SOURCES = walk(root);
const rel = (f: string): string => path.relative(root, f).replace(/\\/g, '/');

const GUARDED = ['releases/service', 'releases/targets', 'db/repos/releases'];
/** The only importers. `value` may import for real; `typeOnly` only erased references. */
const VALUE_IMPORTERS = new Set(['app.ts', 'discord/commands/release.ts']);
const TYPE_IMPORTERS = new Set(['discord/commands/types.ts', 'tools/builtin/releases.ts', 'agents/tasks/ai-digest.ts']);

export function importerViolations(files: { rel: string; src: string }[]): string[] {
  const bad: string[] = [];
  for (const f of files) {
    if (f.rel.startsWith('releases/') && !f.rel.endsWith('.test.ts')) continue; // intra-directory imports are pinned by the second block below
    for (const r of scanRefs(f.src)) {
      const target = resolve(path.join(root, f.rel), r.spec);
      if (!GUARDED.includes(target)) continue;
      if (VALUE_IMPORTERS.has(f.rel)) continue;
      if (TYPE_IMPORTERS.has(f.rel) && r.typeOnly) continue;
      bad.push(`${f.rel} -> ${target}${r.typeOnly ? ' (type)' : ''}`);
    }
  }
  return bad;
}

const files = SOURCES.map((f) => ({ rel: rel(f), src: readFileSync(f, 'utf8') }));

describe('the reference parser (bypass probes)', () => {
  it('reads static, side-effect, multi-line and type imports', () => {
    expect(refs("import { a } from './x.js';\nimport './z.js';\nimport type { T } from './t.js';\nimport {\n  a,\n  b,\n} from './multi.js';")).toEqual([
      { spec: './x.js', typeOnly: false }, { spec: './z.js', typeOnly: false }, { spec: './t.js', typeOnly: true }, { spec: './multi.js', typeOnly: false },
    ]);
  });
  it('an inline `import { type X }` is NOT type-only (it can survive as a side-effect import)', () => {
    expect(refs("import { type X } from './x.js';")).toEqual([{ spec: './x.js', typeOnly: false }]);
  });
  it('probe 1, a barrel: export ... from and export * from', () => {
    expect(refs("export { a } from './re.js';\nexport * from './all.js';\nexport * as q from './q.js';\nexport type { T } from './tt.js';")).toEqual([
      { spec: './re.js', typeOnly: false }, { spec: './all.js', typeOnly: false }, { spec: './q.js', typeOnly: false }, { spec: './tt.js', typeOnly: true },
    ]);
  });
  it('probe 2, dynamic import: literal, computed and concatenated are reported; a qualified type expression is type-only, an awaited one is not', () => {
    expect(refs("const m = await import('./dyn.js');")).toEqual([{ spec: './dyn.js', typeOnly: false }]);
    expect(refs('const m = await import(name);')).toEqual([{ spec: '<non-literal import>', typeOnly: false }]);
    expect(refs("await import('./' + 'x.js')")).toEqual([{ spec: '<non-literal import>', typeOnly: false }]);
    expect(refs("type S = Pick<import('./s.js').Service, 'a'>;")).toEqual([{ spec: './s.js', typeOnly: true }]);
    expect(refs("const x = (await import('./s.js')).Service;")).toEqual([{ spec: './s.js', typeOnly: false }]);
    expect(refs("const x = (import('./s.js')).Service;")).toEqual([{ spec: './s.js', typeOnly: false }]);
  });
  it('probe 3, require and createRequire', () => {
    expect(refs("const x = require('./cjs.js');")).toEqual([{ spec: './cjs.js', typeOnly: false }]);
    expect(refs('const x = require(p);')).toEqual([{ spec: '<non-literal require>', typeOnly: false }]);
    expect(refs("import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);")).toEqual([{ spec: 'node:module', typeOnly: false }, { spec: '<createRequire>', typeOnly: false }]);
  });
  it('probe 4, comments hide nothing and add nothing', () => {
    expect(refs("// import { a } from './commented.js';\n/* import './block.js'; */\nimport { b } from './real.js';")).toEqual([{ spec: './real.js', typeOnly: false }]);
  });
  it('the importer check reports a planted barrel re-export, an unlisted value import and a type-only file that imports for real', () => {
    const plant = (r: string, src: string) => importerViolations([{ rel: r, src }]);
    expect(plant('db/repos/index.ts', "export * from './releases.js';")).toEqual(['db/repos/index.ts -> db/repos/releases']);
    expect(plant('tools/builtin/index.ts', "export { releaseTools } from './releases.js'; export * from '../../releases/service.js';")).toEqual(['tools/builtin/index.ts -> releases/service']);
    expect(plant('grow/x.ts', "import { ReleaseService } from '../releases/service.js';")).toEqual(['grow/x.ts -> releases/service']);
    expect(plant('agents/x.ts', `import { ReleaseService } from '${path.join(root, 'releases/service.js')}';`)).toEqual(['agents/x.ts -> releases/service']); // G2-MCP-01: absolute path
    expect(plant('agents/x.ts', `import { ReleaseService } from '${pathToFileURL(path.join(root, 'releases/service.js')).href}';`)).toEqual(['agents/x.ts -> releases/service']); // G2-MCP-01: file URL
    expect(plant('tools/builtin/releases.ts', "import { ReleaseService } from '../../releases/service.js';")).toEqual(['tools/builtin/releases.ts -> releases/service']);
    expect(plant('tools/builtin/releases.ts', "import { type ReleaseService } from '../../releases/service.js';")).toEqual(['tools/builtin/releases.ts -> releases/service']);
    expect(plant('tools/builtin/releases.ts', "import type { ReleaseService } from '../../releases/service.js';")).toEqual([]);
    expect(plant('agents/x.ts', "const m = await import('../releases/targets.js');")).toEqual(['agents/x.ts -> releases/targets']);
    expect(plant('agents/x.ts', "const m = require('../db/repos/releases.js');")).toEqual(['agents/x.ts -> db/repos/releases']);
    expect(plant('agents/x.ts', "import { x } from '../db/repos/releases';")).toEqual(['agents/x.ts -> db/repos/releases']);
    expect(plant('app.ts', "import { ReleaseService } from './releases/service.js';")).toEqual([]);
    expect(plant('discord/commands/types.ts', "type T = Pick<import('../../releases/service.js').ReleaseService, 'decide'>;")).toEqual([]);
  });
  it('G2-RL-01: a regex literal that looks like a comment opener hides nothing (raw pass)', () => {
    const plant = (r: string, src: string) => importerViolations([{ rel: r, src }]);
    expect(plant('grow/x.ts', "export const re = /[/*]/; export const m = await import('../releases/service.js'); /* */")).toContain('grow/x.ts -> releases/service');
    expect(plant('grow/x.ts', "export const re = /[//]/; import { ReleaseService } from '../releases/service.js';")).toContain('grow/x.ts -> releases/service');
    expect(scanRefs('export const re = /[/*]/; await import(p); /* */').some((r) => r.spec === '<non-literal import>')).toBe(true);
  });
});

describe('RL-C1(a): only the listed files import the release modules', () => {
  it('the scanner sees the repository (not an empty walk)', () => {
    expect(files.length).toBeGreaterThan(400);
    expect(files.some((f) => f.rel === 'releases/service.ts')).toBe(true);
    expect(files.some((f) => f.rel === 'db/repos/releases.ts')).toBe(true);
  });
  it('every non-test source importing releases/service, releases/targets or db/repos/releases is on the allowlist, and only type-only where listed so', () => {
    expect(importerViolations(files)).toEqual([]);
  });
  it('a non-literal import(), a require() or a createRequire anywhere is a pinned, reviewed set (a new one could reach the release code, RL-C1e)', () => {
    const hits = files.filter((f) => scanRefs(f.src).some((r) => r.spec.startsWith('<'))).map((f) => f.rel).sort();
    // all three only mention the words in a regex, a message text or (runner.ts, seen by the raw pass) a comment; none calls them
    expect(hits).toEqual(['devjob/closure.ts', 'scripts/import-discord-bot.ts', 'tools/plugins/schedule/runner.ts']);
  });
  it('G2-RL-01: no source loads code by reflection (Function constructor, eval, getBuiltinModule, Module._load, node:vm, node:module); an empty, reviewed set', () => {
    const REFLECT = /\bnew\s+Function\b|\bFunction\s*\(|\beval\s*\(|getBuiltinModule|\._load\b|['"`](node:)?(vm|module)['"`]/;
    expect(files.filter((f) => REFLECT.test(f.src)).map((f) => f.rel)).toEqual([]);
    expect("new Function('p', 'return imp' + 'ort(p)')").toMatch(REFLECT);
    expect("process.getBuiltinModule('module')").toMatch(REFLECT);
  });
  it('G2-RL-01: no module specifier carries an escape, a query or a hash, and the tree has no symlink (each would give a guarded module a second spelling)', () => {
    expect(files.flatMap((f) => scanRefs(f.src).filter((r) => /[\\?#]/.test(r.spec)).map((r) => `${f.rel}: ${r.spec}`))).toEqual([]);
    expect(LINKS.map(rel)).toEqual([]);
    expect(scanRefs("import { A } from '../releases/servic\\u0065.js';").some((r) => /[\\?#]/.test(r.spec))).toBe(true);
    expect(scanRefs("await import('../releases/service.js?x')").some((r) => /[\\?#]/.test(r.spec))).toBe(true);
  });
  it('no source anywhere (db/repos/index.ts barrel included) re-exports the release repo', () => {
    const idx = files.find((f) => f.rel === 'db/repos/index.ts')!;
    expect(idx.src).not.toMatch(/releases/);
  });
});

describe('RL-C1(b): the release modules import only from a named allowlist', () => {
  const ALLOW: Record<string, string[]> = {
    'releases/service.ts': ['node:crypto', 'agents/loop/payload', 'company/types', 'db/repos/projects', 'db/repos/releases', 'discord/embeds/approval', 'governance/audit', 'knowledge/screen', 'workspaces/errors', 'workspaces/service', 'tools/plugins/workspace/sandbox', 'releases/targets', 'forge/validate', 'forge/types'],  // R7: the plugin validator and the leaf types only (forge/boundary.test.ts pins the rule from the forge side)
    'releases/targets.ts': ['agents/loop/payload', 'company/types', 'db/repos/releases', 'discord/embeds/approval', 'forge/types'],
    'db/repos/releases.ts': ['db/pool'],
    'tools/builtin/releases.ts': ['zod', 'releases/service', 'workspaces/files', 'tools/types'],
  };
  for (const [f, ok] of Object.entries(ALLOW)) {
    it(`${f} imports only ${ok.length} named modules`, () => {
      const src = files.find((x) => x.rel === f)!.src;
      const got = scanRefs(src).map((r) => resolve(path.join(root, f), r.spec));
      expect(got.filter((g) => !ok.includes(g)), f).toEqual([]);
    });
  }
  it('the AI paths are not among them (the old denylist, kept as a second view)', () => {
    for (const f of ['releases/service.ts', 'releases/targets.ts', 'db/repos/releases.ts', 'tools/builtin/releases.ts']) {
      const src = files.find((x) => x.rel === f)!.src;
      expect(src, f).not.toMatch(/ai-approver|governance\/autopilot|judge-call|skill-judge|tools\/autopilot|admin\//);
    }
  });
  it('tools/builtin/releases.ts takes the service only as a type', () => {
    const src = files.find((x) => x.rel === 'tools/builtin/releases.ts')!.src;
    const svc = refs(src).filter((r) => resolve(path.join(root, 'tools/builtin/releases.ts'), r.spec) === 'releases/service');
    expect(svc).toHaveLength(1);
    expect(svc[0]!.typeOnly).toBe(true);
  });
  it('the releases/ directory holds only the expected sources', () => {
    expect(files.filter((f) => f.rel.startsWith('releases/')).map((f) => f.rel).sort()).toEqual(['releases/service.ts', 'releases/targets.ts']);
  });
});

describe('RL-C1(d): admin/ has no release reference', () => {
  it('no admin source mentions the release modules, the tool, the card or the tool names', () => {
    const admin = files.filter((f) => f.rel.startsWith('admin/'));
    expect(admin.length).toBeGreaterThan(5);
    const TOKENS = /releases\/(service|targets)|db\/repos\/releases|release_request|ReleaseService|ReleaseRepo|relcard|RELEASE_TOOL_NAMES|releaseTools/;
    for (const f of admin) expect(f.src, f.rel).not.toMatch(TOKENS);
  });
  it('G2-RL-02: admin/ never touches the `releases` member of the CommandDeps it holds (AdminConsole gets the whole object as `cmd`)', () => {
    const MEMBER = /\.\s*releases\b|\[\s*['"`]releases|\breleases\s*[,}:=]|['"`]releases['"`]/;
    // G2-RL-09: the one allowed mention is the constructor guard in admin/console.ts, a whole line that is removed before the scan; it must occur exactly once (G2-MCP-04: it now loops over the reviewed ADMIN_FORBIDDEN_CMD_KEYS, so the file holds no `releases` literal at all).
    const GUARD = /^[ \t]*for \(const k of ADMIN_FORBIDDEN_CMD_KEYS\) if \(k in d\.cmd\) throw new Error\('AdminConsole: cmd must not carry a human-only command group'\); \/\/ G2-RL-09, G2-MCP-04\r?\n/m;
    for (const f of files.filter((x) => x.rel.startsWith('admin/'))) {
      const src = f.rel === 'admin/console.ts' ? f.src.replace(GUARD, '') : f.src;
      if (f.rel === 'admin/console.ts') expect(src.length, 'the guard line is present exactly once').toBe(f.src.length - (GUARD.exec(f.src)?.[0].length ?? -1));
      expect(src, f.rel).not.toMatch(MEMBER);
      expect(stripComments(src), f.rel).not.toMatch(/\breleases\b/);
    }
    expect(files.find((x) => x.rel === 'admin/console.ts')!.src.match(/k in d\.cmd/g)).toHaveLength(1);
    expect('const r = cmd.releases?.reject(x)').toMatch(MEMBER);
    expect('const { releases } = d.cmd').toMatch(MEMBER);
    expect("d.cmd['releases']").toMatch(MEMBER);
  });
  it('release.enabled appears in admin/ only in keys.ts (BE2 lists it there as a handler key, psql only); no AdminOp or admin tool writes it', () => {
    for (const f of files.filter((x) => x.rel.startsWith('admin/') && x.rel !== 'admin/keys.ts')) expect(f.src, f.rel).not.toMatch(/release\.enabled/);
  });
});

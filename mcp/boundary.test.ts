import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * R6 MCP-1 BE2 (spec 6, MC-C14, MCP-AC19, MCP-AC24): the MCP admin code has no path from an AI or tool run to add, approve, test, disable or depts.
 * This is an ALLOWLIST of the files that may import mcp/admin and db/repos/mcp.
 * The parser reads static `import`, `export ... from`, dynamic `import()` and `require()`; a non-literal one and `createRequire` are reported.
 * It lives under releases/ so a bot diff cannot weaken it (devjob/paths.ts protects the prefix mcp/). The parser is self-contained: importing another
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

const GUARDED_ADMIN = 'mcp/admin';
const GUARDED_REPO = 'db/repos/mcp';
/** mcp/admin: the only run-time importers. Type-only references may sit in the command types (the CommandDeps closure type). */
const ADMIN_VALUE_IMPORTERS = new Set(['app.ts', 'discord/commands/mcp.ts']);
const ADMIN_TYPE_IMPORTERS = new Set(['discord/commands/types.ts']);
/** discord/commands/mcp.ts takes only the view and input types today (the closure arrives through CommandDeps); a value import there would also be allowed. */
/** db/repos/mcp: `mcp/` itself and app.ts (the barrel db/repos/index.ts must not re-export it). */
const REPO_VALUE_IMPORTERS = new Set(['app.ts']);

export function importerViolations(files: { rel: string; src: string }[]): string[] {
  const bad: string[] = [];
  for (const f of files) {
    const inMcp = f.rel.startsWith('mcp/');
    for (const r of scanRefs(f.src)) {
      const target = resolve(path.join(root, f.rel), r.spec);
      if (target === GUARDED_ADMIN) {
        if (ADMIN_VALUE_IMPORTERS.has(f.rel)) continue;
        if (ADMIN_TYPE_IMPORTERS.has(f.rel) && r.typeOnly) continue;
        bad.push(`${f.rel} -> ${target}${r.typeOnly ? ' (type)' : ''}`);
      } else if (target === GUARDED_REPO) {
        if (inMcp || REPO_VALUE_IMPORTERS.has(f.rel)) continue;
        bad.push(`${f.rel} -> ${target}${r.typeOnly ? ' (type)' : ''}`);
      }
    }
  }
  return bad;
}

const files = SOURCES.map((f) => ({ rel: rel(f), src: readFileSync(f, 'utf8') }));

describe('the reference parser (bypass probes)', () => {
  it('reads static, side-effect, multi-line, type, barrel, dynamic and require references; comments hide nothing', () => {
    expect(refs("import { a } from './x.js';\nimport './z.js';\nimport type { T } from './t.js';\nimport {\n  a,\n  b,\n} from './multi.js';")).toEqual([
      { spec: './x.js', typeOnly: false }, { spec: './z.js', typeOnly: false }, { spec: './t.js', typeOnly: true }, { spec: './multi.js', typeOnly: false },
    ]);
    expect(refs("import { type X } from './x.js';")).toEqual([{ spec: './x.js', typeOnly: false }]);
    expect(refs("export { a } from './re.js';\nexport * from './all.js';\nexport type { T } from './tt.js';")).toEqual([
      { spec: './re.js', typeOnly: false }, { spec: './all.js', typeOnly: false }, { spec: './tt.js', typeOnly: true },
    ]);
    expect(refs("const m = await import('./dyn.js');")).toEqual([{ spec: './dyn.js', typeOnly: false }]);
    expect(refs("await import('./' + 'x.js')")).toEqual([{ spec: '<non-literal import>', typeOnly: false }]);
    expect(refs("type S = Pick<import('./s.js').Service, 'a'>;")).toEqual([{ spec: './s.js', typeOnly: true }]);
    expect(refs("const x = require('./cjs.js');")).toEqual([{ spec: './cjs.js', typeOnly: false }]);
    expect(refs("import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);")).toEqual([{ spec: 'node:module', typeOnly: false }, { spec: '<createRequire>', typeOnly: false }]);
    expect(refs("// import { a } from './commented.js';\n/* import './block.js'; */\nimport { b } from './real.js';")).toEqual([{ spec: './real.js', typeOnly: false }]);
  });
  it('the importer check reports planted barrels, unlisted value imports, type-only files that import for real, dynamic imports and require', () => {
    const plant = (r: string, src: string) => importerViolations([{ rel: r, src }]);
    expect(plant('db/repos/index.ts', "export * from './mcp.js';")).toEqual(['db/repos/index.ts -> db/repos/mcp']);
    expect(plant('tools/builtin/index.ts', "export * from '../../mcp/admin.js';")).toEqual(['tools/builtin/index.ts -> mcp/admin']);
    expect(plant('grow/x.ts', "import { McpAdmin } from '../mcp/admin.js';")).toEqual(['grow/x.ts -> mcp/admin']);
    expect(plant('releases/service.ts', "import type { McpAdmin } from '../mcp/admin.js';")).toEqual(['releases/service.ts -> mcp/admin (type)']);
    expect(plant('admin/console.ts', "import { x } from '../db/repos/mcp.js';")).toEqual(['admin/console.ts -> db/repos/mcp']);
    expect(plant('tools/x.ts', "const m = await import('../mcp/admin.js');")).toEqual(['tools/x.ts -> mcp/admin']);
    expect(plant('skills/x.ts', "const m = require('../db/repos/mcp.js');")).toEqual(['skills/x.ts -> db/repos/mcp']);
    expect(plant('agents/x.ts', "import { x } from '../mcp/admin';")).toEqual(['agents/x.ts -> mcp/admin']);
    expect(plant('agents/x.ts', `import { McpAdmin } from '${path.join(root, 'mcp/admin.js')}';`)).toEqual(['agents/x.ts -> mcp/admin']); // G2-MCP-01: absolute path
    expect(plant('agents/x.ts', `import { McpRepo } from '${pathToFileURL(path.join(root, 'db/repos/mcp.js')).href}';`)).toEqual(['agents/x.ts -> db/repos/mcp']); // G2-MCP-01: file URL
    expect(plant('discord/commands/types.ts', "import { McpAdmin } from '../../mcp/admin.js';")).toEqual(['discord/commands/types.ts -> mcp/admin']);
    expect(plant('discord/commands/types.ts', "type T = Pick<import('../../mcp/admin.js').McpAdmin, 'list'>;")).toEqual([]);
    expect(plant('discord/commands/mcp.ts', "import { McpAdmin } from '../../mcp/admin.js';")).toEqual([]);
    expect(plant('app.ts', "import { McpAdmin } from './mcp/admin.js'; import { McpRepo } from './db/repos/mcp.js';")).toEqual([]);
    expect(plant('mcp/host.ts', "import type { McpRepo } from '../db/repos/mcp.js';")).toEqual([]);
    expect(plant('app.ts', "export const re = /[/*]/; await import('./x.js'); /* */")).toEqual([]);
    expect(plant('grow/x.ts', "export const re = /[/*]/; import { McpAdmin } from '../mcp/admin.js'; /* */")).toContain('grow/x.ts -> mcp/admin');
  });
});

describe('MC-C14 / spec 6: who may import the MCP admin and repo modules', () => {
  it('the scanner sees the repository (not an empty walk)', () => {
    expect(files.length).toBeGreaterThan(400);
    expect(files.some((f) => f.rel === 'mcp/admin.ts')).toBe(true);
    expect(files.some((f) => f.rel === 'db/repos/mcp.ts')).toBe(true);
  });
  it('every non-test source importing mcp/admin or db/repos/mcp is on the allowlist, and type-only where listed so', () => {
    expect(importerViolations(files)).toEqual([]);
  });
  it('mcp/admin is imported for real only by app.ts (discord/commands/mcp.ts may import its types; nothing in releases/, admin/, grow/, skills/ or tools/ imports it at all)', () => {
    const real = files.filter((f) => scanRefs(f.src).some((r) => resolve(path.join(root, f.rel), r.spec) === GUARDED_ADMIN && !r.typeOnly)).map((f) => f.rel).sort();
    expect(real).toEqual(['app.ts']);
    const cmdRefs = scanRefs(files.find((f) => f.rel === 'discord/commands/mcp.ts')!.src).filter((r) => resolve(path.join(root, 'discord/commands/mcp.ts'), r.spec) === GUARDED_ADMIN);
    expect(cmdRefs.every((r) => r.typeOnly)).toBe(true);
    for (const dir of ['releases/', 'admin/', 'grow/', 'skills/', 'tools/']) {
      const hits = files.filter((f) => f.rel.startsWith(dir) && scanRefs(f.src).some((r) => /mcp\/admin/.test(resolve(path.join(root, f.rel), r.spec))));
      expect(hits.map((f) => f.rel), dir).toEqual([]);
    }
  });
  it('db/repos/mcp is imported only from mcp/ and app.ts, and the repo barrel does not re-export it', () => {
    const importers = files.filter((f) => scanRefs(f.src).some((r) => resolve(path.join(root, f.rel), r.spec) === GUARDED_REPO)).map((f) => f.rel).sort();
    for (const i of importers) expect(i.startsWith('mcp/') || i === 'app.ts', i).toBe(true);
    expect(files.find((f) => f.rel === 'db/repos/index.ts')!.src).not.toMatch(/\bmcp\b/);
  });
  it('a non-literal import(), a require() or a createRequire anywhere is a pinned, reviewed set', () => {
    const hits = files.filter((f) => scanRefs(f.src).some((r) => r.spec.startsWith('<'))).map((f) => f.rel).sort();
    expect(hits).toEqual(['devjob/closure.ts', 'scripts/import-discord-bot.ts', 'tools/plugins/schedule/runner.ts']);
  });
  it('no source loads code by reflection (Function constructor, eval, getBuiltinModule, Module._load, node:vm, node:module)', () => {
    const REFLECT = /\bnew\s+Function\b|\bFunction\s*\(|\beval\s*\(|getBuiltinModule|\._load\b|['"`](node:)?(vm|module)['"`]/;
    expect(files.filter((f) => REFLECT.test(f.src)).map((f) => f.rel)).toEqual([]);
  });
  it('no module specifier carries an escape, a query or a hash, and the tree has no symlink', () => {
    expect(files.flatMap((f) => scanRefs(f.src).filter((r) => /[\\?#]/.test(r.spec)).map((r) => `${f.rel}: ${r.spec}`))).toEqual([]);
    expect(LINKS.map(rel)).toEqual([]);
    expect(scanRefs("import { A } from '../mcp/admi\\u006e.js';").some((r) => /[\\?#]/.test(r.spec))).toBe(true);
  });
});

describe('MC-C14: admin/ has no mcp member; the AdminConsole gets nothing', () => {
  it('no admin source mentions the mcp modules, the closures, the commands or the tool names (only admin/keys.ts lists the config keys)', () => {
    const admin = files.filter((f) => f.rel.startsWith('admin/'));
    expect(admin.length).toBeGreaterThan(5);
    const TOKENS = /mcp\/(admin|host|tool|boot)|db\/repos\/mcp|McpAdmin|McpRepo|McpHost|mcpCommandDeps|mcpDigestDeps|externalNames|mcp_[rw]_/;
    for (const f of admin) expect(f.src, f.rel).not.toMatch(TOKENS);
    const MEMBER = /\.\s*mcp\b|\[\s*['"`]mcp|\bmcp\s*[,}:=]|['"`]mcp['"`]/;
    for (const f of admin) expect(stripComments(f.src), f.rel).not.toMatch(MEMBER);
    // G2-MCP-04: the run-time guard is the one loop over the reviewed ADMIN_FORBIDDEN_CMD_KEYS (no `mcp` literal in admin/); the list itself names both groups.
    expect(files.find((x) => x.rel === 'admin/console.ts')!.src.match(/for \(const k of ADMIN_FORBIDDEN_CMD_KEYS\) if \(k in d\.cmd\)/g)).toHaveLength(1);
    expect(files.find((x) => x.rel === 'discord/commands/types.ts')!.src).toMatch(/ADMIN_FORBIDDEN_CMD_KEYS: readonly string\[\] = \['releases', 'mcp', 'forge'\];/);
    expect('const r = cmd.mcp?.list()').toMatch(MEMBER);
    expect('const { mcp } = d.cmd').toMatch(MEMBER);
    expect("d.cmd['mcp']").toMatch(MEMBER);
  });
  it('the mcp config keys appear in admin/ only in keys.ts (handler keys, psql or /settings only)', () => {
    for (const f of files.filter((x) => x.rel.startsWith('admin/') && x.rel !== 'admin/keys.ts')) expect(f.src, f.rel).not.toMatch(/mcp\.(enabled|maxCalls)/);
  });
});

describe('MCP-AC24 and mcp/ isolation', () => {
  it('mcp/ never imports providers/, and no providers/ file imports mcp/', () => {
    for (const f of files.filter((x) => x.rel.startsWith('mcp/'))) {
      expect(scanRefs(f.src).map((r) => resolve(path.join(root, f.rel), r.spec)).filter((t) => t.startsWith('providers/')), f.rel).toEqual([]);
    }
    for (const f of files.filter((x) => x.rel.startsWith('providers/'))) {
      expect(scanRefs(f.src).map((r) => resolve(path.join(root, f.rel), r.spec)).filter((t) => t === 'mcp' || t.startsWith('mcp/') || t === 'db/repos/mcp'), f.rel).toEqual([]);
    }
  });
  it('the local Claude CLI provider keeps zero MCP servers (both flags pinned in the argv)', () => {
    const src = files.find((f) => f.rel === 'providers/claude-code-local/protocol.ts')!.src;
    expect(src).toContain("'--strict-mcp-config'");
    expect(src).toContain("'--mcp-config={\"mcpServers\":{}}'");
  });
  it('MC-C18: nothing under mcp/ imports a store the model reads back (memory, KB, except the pure screen helper and the HIDDEN class, lessons, skills, tasks, workspaces files, grow, agents, admin, releases)', () => {
    const DENY = /^(knowledge\/(?!screen$)|skills\/|grow\/|agents\/|admin\/|releases\/|workspaces\/(service|files|errors)|db\/repos\/(tasks|lessons|knowledge|skills|workspaces|projects|grow|board|room-entries|releases)|discord\/(?!embeds\/approval$))/;
    for (const f of files.filter((x) => x.rel.startsWith('mcp/'))) {
      expect(scanRefs(f.src).map((r) => resolve(path.join(root, f.rel), r.spec)).filter((t) => DENY.test(t)), f.rel).toEqual([]);
    }
  });
  it('MCP-AC25 (BE2 guard): a logger call in mcp/ carries only errName, code or fixed keys, never a message, error or text member', () => {
    for (const f of files.filter((x) => x.rel.startsWith('mcp/'))) {
      for (const m of f.src.matchAll(/\blog\.(?:error|warn|info|debug)\(\s*(\{[^}]*\})/g)) {
        const keys = [...m[1]!.matchAll(/([A-Za-z_]+)\s*[:,}]/g)].map((k) => k[1]!);
        for (const k of keys) expect(['errName', 'code', 'slug'], `${f.rel}: ${m[1]}`).toContain(k);
      }
    }
  });
});

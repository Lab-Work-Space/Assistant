/**
 * Import-graph tests (spec 5.4 + R2 forward; Gate 1 S12 inverse). The walker lexes the TypeScript source (strings, templates,
 * comments and regex literals are skipped, never mistaken for code) and follows every module edge: `import … from`, side-effect
 * `import '…'`, `export … from`, `export * from`, dynamic `import('…')` and `require('…')` (also TS `import x = require`). Type-only
 * edges are skipped the way tsc erases them: `import type`, `export type`, and an import or re-export whose specifiers are all
 * inline `type` ones. A value import that is only used as a type is still counted (tsc would drop it): the check over-approximates.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

type Kind = 'import' | 'reexport' | 'dynamic' | 'require';
/** One module edge. `names` are the imported (or re-exported) names: '*' for a namespace/star, 'default' for a default import. */
/** `pairs`: [name in the target, local/exported name here], for import and re-export edges ('*' for a namespace/star). */
type Edge = { spec: string; kind: Kind; names: string[]; pairs?: [string, string][] };
type Tok = { t: 'id' | 'str' | 'p' | 'num' | 'tpl' | 're'; v: string };

const REGEX_AFTER_KEYWORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/** A small JavaScript lexer: enough to find module edges without being fooled by strings, comments, templates or regexes. */
function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const regexAllowed = (): boolean => {
    const last = out.at(-1);
    if (!last) return true;
    if (last.t === 'p') return last.v !== ')' && last.v !== ']';
    if (last.t === 'id') return REGEX_AFTER_KEYWORD.has(last.v);
    return false;
  };
  const readString = (q: string): string => {
    let v = '';
    i++;
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') {
        v += src[i + 1] ?? '';
        i += 2;
      } else v += src[i++];
    }
    i++;
    return v;
  };
  const scan = (untilBrace: boolean): void => {
    let depth = 0;
    while (i < src.length) {
      const c = src[i]!;
      const n = src[i + 1];
      if (c === '/' && n === '/') {
        while (i < src.length && src[i] !== '\n') i++;
      } else if (c === '/' && n === '*') {
        const end = src.indexOf('*/', i + 2);
        i = end < 0 ? src.length : end + 2;
      } else if (c === "'" || c === '"') {
        out.push({ t: 'str', v: readString(c) });
      } else if (c === '`') {
        i++;
        while (i < src.length && src[i] !== '`') {
          if (src[i] === '\\') i += 2;
          else if (src[i] === '$' && src[i + 1] === '{') {
            i += 2;
            scan(true); // the expression inside ${ … } is code (it may hold a dynamic import)
          } else i++;
        }
        i++;
        out.push({ t: 'tpl', v: '' });
      } else if (c === '/' && regexAllowed()) {
        i++;
        let cls = false;
        while (i < src.length && (cls || src[i] !== '/')) {
          if (src[i] === '\\') i++;
          else if (src[i] === '[') cls = true;
          else if (src[i] === ']') cls = false;
          i++;
        }
        i++;
        while (i < src.length && /[a-z]/i.test(src[i]!)) i++;
        out.push({ t: 're', v: '' });
      } else if (/[A-Za-z_$]/.test(c)) {
        const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 200))!;
        out.push({ t: 'id', v: m[0] });
        i += m[0].length;
      } else if (/[0-9]/.test(c)) {
        const m = /^[0-9][\w.]*/.exec(src.slice(i, i + 100))!;
        out.push({ t: 'num', v: m[0] });
        i += m[0].length;
      } else if (/\s/.test(c)) {
        i++;
      } else {
        if (untilBrace && c === '{') depth++;
        if (untilBrace && c === '}') {
          if (depth === 0) {
            i++;
            return;
          }
          depth--;
        }
        out.push({ t: 'p', v: c });
        i++;
      }
    }
  };
  scan(false);
  return out;
}

/**
 * Names inside `{ a, b as c, default as d, type T }` starting at the `{` token: the left-hand (imported) value names, how many
 * specifiers there were (inline `type` ones included), and the index after `}`.
 */
function braceNames(toks: Tok[], k: number): { names: string[]; pairs: [string, string][]; count: number; next: number } {
  const names: string[] = [];
  const pairs: [string, string][] = [];
  let count = 0;
  k++;
  while (k < toks.length && toks[k]!.v !== '}') {
    const tk = toks[k]!;
    if (tk.t === 'id' || tk.t === 'str') {
      count++;
      const nx = toks[k + 1];
      const typeOnly = tk.t === 'id' && tk.v === 'type' && nx !== undefined && (nx.t === 'id' || nx.t === 'str') && !(nx.v === 'as' && (toks[k + 2]?.v === ',' || toks[k + 2]?.v === '}'));
      if (typeOnly) {
        k += 2; // `type T` (or `type T as U`): a type-only specifier
        if (toks[k]?.v === 'as') k += 2;
        continue;
      }
      names.push(tk.v);
      k++;
      let right = tk.v;
      if (toks[k]?.v === 'as') {
        right = toks[k + 1]?.v ?? tk.v;
        k += 2;
      }
      pairs.push([tk.v, right]);
      continue;
    }
    k++;
  }
  return { names, pairs, count, next: k + 1 };
}

const ENDS = new Set([';', '=']);

/** Every module edge of one TypeScript source text. */
export function edgesOf(tsSource: string): Edge[] {
  const toks = lex(tsSource);
  const edges: Edge[] = [];
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k]!;
    if (tk.t !== 'id' || toks[k - 1]?.v === '.') continue;
    const nx = toks[k + 1];
    if (tk.v === 'require' && nx?.v === '(' && toks[k + 2]?.t === 'str') {
      edges.push({ spec: toks[k + 2]!.v, kind: 'require', names: ['*'] });
    } else if (tk.v === 'import' && nx?.v === '(') {
      const arg = toks[k + 2];
      // a computed specifier cannot be checked: record it so the allowlist test fails on it
      edges.push({ spec: arg?.t === 'str' && toks[k + 3]?.v === ')' ? arg.v : '<computed>', kind: 'dynamic', names: ['*'] });
    } else if (tk.v === 'import' && nx?.t === 'str') {
      edges.push({ spec: nx.v, kind: 'import', names: [] });
    } else if (tk.v === 'import' && nx && nx.v !== '.') {
      // `import type X from`, `import type { … } from`, `import type * as N from`: erased
      const typeOnly = nx.v === 'type' && toks[k + 2] !== undefined && toks[k + 2]!.v !== 'from' && toks[k + 2]!.v !== ',' && toks[k + 2]!.v !== '=';
      const names: string[] = [];
      const pairs: [string, string][] = [];
      let braces = 0;
      let specifiers = 0;
      let other = false;
      let j = k + 1;
      while (j < toks.length && !(toks[j]!.t === 'id' && toks[j]!.v === 'from') && !ENDS.has(toks[j]!.v)) {
        const x = toks[j]!;
        if (x.v === '{') {
          const b = braceNames(toks, j);
          names.push(...b.names);
          pairs.push(...b.pairs);
          braces++;
          specifiers += b.count;
          j = b.next;
          continue;
        }
        if (x.v === '*') {
          names.push('*');
          pairs.push(['*', toks[j + 1]?.v === 'as' ? (toks[j + 2]?.v ?? '*') : '*']);
          other = true;
        } else if (x.t === 'id' && x.v !== 'as' && toks[j - 1]?.v !== 'as' && !(typeOnly && j === k + 1)) {
          names.push('default');
          pairs.push(['default', x.v]);
          other = true;
        }
        j++;
      }
      if (toks[j]?.v !== 'from' || toks[j + 1]?.t !== 'str') continue; // `import x = require(…)`: the require branch takes it
      const erased = typeOnly || (!other && braces > 0 && specifiers > 0 && names.length === 0);
      if (!erased) edges.push({ spec: toks[j + 1]!.v, kind: 'import', names, pairs });
      k = j + 1;
    } else if (tk.v === 'export' && (nx?.v === '{' || nx?.v === '*' || (nx?.v === 'type' && (toks[k + 2]?.v === '{' || toks[k + 2]?.v === '*')))) {
      const typeOnly = nx.v === 'type';
      const at = typeOnly ? k + 2 : k + 1;
      let names: string[];
      let pairs: [string, string][];
      let j: number;
      let erased = typeOnly;
      if (toks[at]!.v === '{') {
        const b = braceNames(toks, at);
        names = b.names;
        pairs = b.pairs;
        j = b.next;
        if (b.count > 0 && names.length === 0) erased = true;
      } else {
        names = ['*'];
        j = at + 1;
        pairs = [['*', '*']];
        if (toks[j]?.v === 'as') {
          pairs = [['*', toks[j + 1]?.v ?? '*']];
          j += 2;
        }
      }
      if (!erased && toks[j]?.v === 'from' && toks[j + 1]?.t === 'str') edges.push({ spec: toks[j + 1]!.v, kind: 'reexport', names, pairs });
    }
  }
  return edges;
}

const DECL = new Set(['function', 'class', 'const', 'let', 'var', 'enum']);

/**
 * The value names a module exports by itself: `export function|class|const|let|var|enum x`, `export async function x`,
 * `export abstract class x`, `export default`, and `export { a as b }` without `from` ([local, exported] in `aliases`).
 * `export type`, `export interface` and `export declare` are types only and skipped.
 */
export function exportsOf(tsSource: string): { names: string[]; aliases: [string, string][] } {
  const toks = lex(tsSource);
  const names: string[] = [];
  const aliases: [string, string][] = [];
  for (let k = 0; k < toks.length; k++) {
    if (toks[k]!.t !== 'id' || toks[k]!.v !== 'export' || toks[k - 1]?.v === '.') continue;
    let j = k + 1;
    const nx = toks[j];
    if (!nx) break;
    if (nx.v === 'default') {
      names.push('default');
      continue;
    }
    if (nx.v === '{') {
      const b = braceNames(toks, j);
      const after = toks[b.next];
      if (!(after?.t === 'id' && after.v === 'from')) aliases.push(...b.pairs);
      continue;
    }
    while (toks[j]?.t === 'id' && (toks[j]!.v === 'async' || toks[j]!.v === 'abstract')) j++;
    const kw = toks[j];
    if (kw?.t === 'id' && DECL.has(kw.v)) {
      let n = j + 1;
      if (toks[n]?.v === '*') n++; // export function* gen
      const id = toks[n];
      if (id?.t === 'id') names.push(id.v);
    }
  }
  return { names, aliases };
}

/** Repo-relative path of a relative specifier from `from` (`./x.js` → `x.ts`, a directory → its `index.ts`). */
function resolveRel(from: string, spec: string): string {
  const p = posix.normalize(posix.join(posix.dirname(from), spec)).replace(/\.js$/, '.ts');
  if (existsSync(join(ROOT, p))) return p;
  if (existsSync(join(ROOT, p, 'index.ts'))) return posix.join(p, 'index.ts');
  if (existsSync(join(ROOT, `${p}.ts`))) return `${p}.ts`;
  return p;
}

const isRelative = (s: string) => s.startsWith('./') || s.startsWith('../');

/** The graph from `entry`: module → its edges, each with the resolved target (a repo path, or the bare/node specifier). */
function walk(entry: string, read: (p: string) => string = (p) => readFileSync(join(ROOT, p), 'utf8')): Map<string, (Edge & { to: string })[]> {
  const g = new Map<string, (Edge & { to: string })[]>();
  const queue = [entry];
  while (queue.length) {
    const f = queue.shift()!;
    if (g.has(f)) continue;
    const es = edgesOf(read(f)).map((e) => ({ ...e, to: isRelative(e.spec) ? resolveRel(f, e.spec) : e.spec }));
    g.set(f, es);
    for (const e of es) if (isRelative(e.spec)) queue.push(e.to);
  }
  return g;
}

/** R2 + spec 5.4 (with the C4 amendment): what the sidecar entry may load. */
const SIDECAR_ALLOWED = (p: string): boolean =>
  p.startsWith('node:') ||
  (/^media\/[a-z-]+\.ts$/.test(p) && !p.endsWith('.test.ts')) ||
  ['voice/music/source.ts', 'voice/binaries.ts', 'voice/exec.ts', 'core/child-env.ts'].includes(p);

function sidecarViolations(g: Map<string, (Edge & { to: string })[]>): string[] {
  const bad: string[] = [];
  for (const [f, es] of g) {
    if (!SIDECAR_ALLOWED(f)) bad.push(`${f} (module)`);
    for (const e of es) if (!SIDECAR_ALLOWED(e.to)) bad.push(`${f} -> ${e.to}`);
  }
  return bad;
}

describe('media import graph', () => {
  it('media/main.ts import graph uses only node:*, media/*, voice/music/source.ts, voice/binaries.ts, voice/exec.ts, core/child-env.ts', () => {
    const g = walk('media/main.ts');
    expect(sidecarViolations(g)).toEqual([]);
    // the walker really followed the graph (a lexer bug that saw nothing would pass the check above vacuously)
    for (const m of ['media/server.ts', 'media/protocol.ts', 'media/decode.ts', 'voice/music/source.ts', 'voice/binaries.ts', 'voice/exec.ts', 'core/child-env.ts'])
      expect([...g.keys()], m).toContain(m);
    for (const forbidden of ['voice/index.ts', 'voice/chat/tts.ts', 'core/index.ts', 'config/schema.ts', 'app.ts'])
      expect([...g.keys()], forbidden).not.toContain(forbidden);
  });

  it('LM2: relay-container.ts and relay-host.ts load only node:* and media/relay-*.ts (no server, voice, spawn or child_process)', () => {
    for (const entry of ['media/relay-container.ts', 'media/relay-host.ts']) {
      const g = walk(entry);
      const bad: string[] = [];
      for (const [f, es] of g) {
        if (!/^media\/relay-[a-z]+\.ts$/.test(f)) bad.push(`${f} (module)`);
        for (const e of es) if (!(e.to.startsWith('node:') && e.to !== 'node:child_process') && !/^media\/relay-[a-z]+\.ts$/.test(e.to)) bad.push(`${f} -> ${e.to}`);
      }
      expect(bad, entry).toEqual([]);
      expect([...g.keys()], entry).toContain('media/relay-core.ts');
      expect([...g.keys()], entry).not.toContain('media/server.ts');
    }
    // the sidecar entry does not pull the relays in, and the app never loads them
    expect([...walk('media/main.ts').keys()].filter((k) => k.includes('relay'))).toEqual([]);
    expect([...walk('main.ts').keys()].filter((k) => k.includes('relay'))).toEqual([]);
  });

  it('skips import type', () => {
    const src = [
      "import type { A } from './a.js';",
      "import { type B, c } from './c.js';",
      "export type { T } from './t.js';",
      "import { type OnlyType } from 'zod';",
      "export { type T2 } from './t2.js';",
      "import type Def from './def-type.js';",
      "import type * as NS from './ns-type.js';",
      "export const f = (a: Array<A>, b: { k: 'x' | \"y\" }): number => a.length / 2;",
      'export const x: A = c as B;',
    ].join('\n');
    expect(edgesOf(src).map((e) => e.spec)).toEqual(['./c.js']);
    expect(edgesOf(src)[0]!.names).toEqual(['c']);
  });

  it('fails on a bare package specifier', () => {
    const files: Record<string, string> = {
      'media/main.ts': "import { a } from './x.js';\n",
      'media/x.ts': "import { z } from 'zod';\nexport const a = z;\n",
    };
    const g = walk('media/main.ts', (p) => files[p]!);
    expect(sidecarViolations(g)).toEqual(['media/x.ts -> zod']);
    // a builtin without the node: prefix is not node:* either
    expect(sidecarViolations(walk('media/main.ts', () => "import fs from 'fs';\n"))).toContain('media/main.ts -> fs');
  });

  it('follows dynamic import(), require(), export * and export … from; strings, comments, templates and regexes are not code', () => {
    const src = [
      "const later = await import('./dyn.js');",
      "const cjs = require('./req.js');",
      "export * from './star.js';",
      "export * as ns from './ns.js';",
      "export { a as b, c } from './re.js';",
      "import * as all from './all.js';",
      "import def, { x } from './def.js';",
      "import './side.js';",
      "const t = `${await import('./in-template.js')}`;",
      "// import { no } from './comment.js';",
      "/* export * from './block.js'; */",
      "const s = \"import { no } from './string.js'\";",
      "const r = /['\"]import('.\\/regex.js')/;",
      'const d = 4 / 2 / 1;',
      "const m = import.meta.url;",
      "const name = './x.js'; const v = await import(name);",
      "obj.require('./method.js');",
    ].join('\n');
    const es = edgesOf(src);
    expect(es.find((e) => e.spec === './re.js')?.pairs).toEqual([['a', 'b'], ['c', 'c']]); // renames are kept for the S12 derivation
    expect(es.find((e) => e.spec === './def.js')?.pairs).toEqual([['default', 'def'], ['x', 'x']]);
    expect(es.map(({ pairs: _p, ...e }) => e)).toEqual([
      { spec: './dyn.js', kind: 'dynamic', names: ['*'] },
      { spec: './req.js', kind: 'require', names: ['*'] },
      { spec: './star.js', kind: 'reexport', names: ['*'] },
      { spec: './ns.js', kind: 'reexport', names: ['*'] },
      { spec: './re.js', kind: 'reexport', names: ['a', 'c'] },
      { spec: './all.js', kind: 'import', names: ['*'] },
      { spec: './def.js', kind: 'import', names: ['default', 'x'] },
      { spec: './side.js', kind: 'import', names: [] },
      { spec: './in-template.js', kind: 'dynamic', names: ['*'] },
      { spec: '<computed>', kind: 'dynamic', names: ['*'] },
    ]);
    // a dynamic import to a forbidden module is caught like a static one
    const files: Record<string, string> = { 'media/main.ts': "export async function f() { return import('../voice/index.js'); }\n" };
    expect(sidecarViolations(walk('media/main.ts', (p) => files[p] ?? ''))).toEqual(['media/main.ts -> voice/index.ts', 'voice/index.ts (module)']);
  });
});

/**
 * Gate 1 S12, inverse: the app (main.ts) must not load the sidecar's server, and only the guarded spawners may start a child.
 * At file level child_process is reachable from the app through barrels (voice/music/index.ts re-exports source.ts for
 * normaliseQuery), so the check is by name, and the names are derived, never hand-kept: every value export of a module that
 * imports child_process or is a gateway is "spawn-reachable", and so is every name a module re-exports from one (renames
 * followed: `export { a as b } from`, `export *`, `export * as ns`, `import { a } …; export { a as b }`), to a fixpoint. Every
 * import of a spawn-reachable name (or a namespace of a module that has one) by a module outside the gateways must be on
 * S12_ALLOWED, the reviewed list below: a new pair fails until it is reviewed, a pair that went away fails until it is removed.
 */
/** LocalMediaBackend (refuses in a container) and what it is built from, plus the guarded claude-code-local provider (guard.ts). */
const GATEWAYS = (p: string): boolean =>
  ['media/backend.ts', 'media/decode.ts', 'voice/binaries.ts', 'voice/exec.ts', 'voice/music/source.ts'].includes(p) || p.startsWith('providers/claude-code-local/');
const CHILD_PROCESS = new Set(['node:child_process', 'child_process']);

type Graph = Map<string, (Edge & { to: string })[]>;

/** module → its spawn-reachable exported names (see the block comment above). */
function spawnReachable(g: Graph, read: (p: string) => string, isGateway: (p: string) => boolean = GATEWAYS): Map<string, Set<string>> {
  const exp = new Map([...g.keys()].map((f) => [f, exportsOf(read(f))] as const));
  const t = new Map([...g.keys()].map((f) => [f, new Set<string>()] as const));
  for (const [f, es] of g) {
    if (!isGateway(f) && !es.some((e) => CHILD_PROCESS.has(e.to))) continue;
    const own = t.get(f)!;
    for (const n of exp.get(f)!.names) own.add(n);
    for (const [, e] of exp.get(f)!.aliases) own.add(e);
    for (const e of es) if (e.kind === 'reexport') for (const [, out] of e.pairs ?? []) if (out !== '*') own.add(out);
  }
  const of = (m: string) => t.get(m) ?? new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    const add = (f: string, n: string) => {
      const s = t.get(f)!;
      if (!s.has(n)) {
        s.add(n);
        changed = true;
      }
    };
    for (const [f, es] of g) {
      const bindings = new Map<string, { from: string; name: string }>();
      for (const e of es) {
        if (e.kind === 'import') for (const [name, local] of e.pairs ?? []) bindings.set(local, { from: e.to, name });
        if (e.kind !== 'reexport') continue;
        for (const [inner, out] of e.pairs ?? []) {
          if (inner === '*' && out === '*') for (const n of of(e.to)) n !== 'default' && add(f, n);
          else if (inner === '*') of(e.to).size && add(f, out);
          else if (of(e.to).has(inner)) add(f, out);
        }
      }
      for (const [local, out] of exp.get(f)!.aliases) {
        const b = bindings.get(local);
        if (b && (b.name === '*' ? of(b.from).size > 0 : of(b.from).has(b.name))) add(f, out);
      }
    }
  }
  return t;
}

/** Every `importer <- name` (or `importer <- * from target`) where a non-gateway module takes a spawn-reachable name. */
function spawnImports(g: Graph, read: (p: string) => string, isGateway: (p: string) => boolean = GATEWAYS): string[] {
  const t = spawnReachable(g, read, isGateway);
  const out = new Set<string>();
  for (const [f, es] of g) {
    if (isGateway(f)) continue;
    for (const e of es) {
      if (CHILD_PROCESS.has(e.to)) out.add(`${f} <- ${e.to}`);
      if (e.kind === 'reexport') continue; // a pass-through: its importers are checked (the names are followed above)
      const reach = t.get(e.to);
      if (e.spec === '<computed>') out.add(`${f} <- * from <computed>`);
      if (!reach || reach.size === 0) continue;
      if (e.kind === 'dynamic' || e.kind === 'require') out.add(`${f} <- * from ${e.to}`);
      for (const [name] of e.pairs ?? []) {
        if (name === '*') out.add(`${f} <- * from ${e.to}`);
        else if (reach.has(name)) out.add(`${f} <- ${name}`);
      }
    }
  }
  return [...out].sort();
}

/**
 * S12 reviewed list: every non-gateway import of a spawn-reachable name in today's app, with why it cannot start a media child.
 */
const S12_ALLOWED: Record<string, string> = {
  // app.ts builds the guarded provider and LocalMediaBackend (which refuses in a container); nodeGuardExec runs only `claude --version` behind localProviderAllowed
  'app.ts <- LocalMediaBackend': 'the local backend: refuses in a container (inContainer injected), never built when MEDIA_SOCKET is set',
  'app.ts <- createClaudeCodeLocalProvider': 'the guarded local provider, registered only when localProviderAllowed passed (darwin, no container)',
  'app.ts <- inContainer': 'pure fs check (no spawn)',
  'app.ts <- nodeGuardExec': 'the guard\'s `claude --version` probe, run only inside localProviderAllowed after every static check',
  'app.ts <- nodeGuardFs': 'fs reads only (no spawn)',
  'app.ts <- localProviderAllowed': 'the L9 guard itself',
  'app.ts <- processGuardEnv': 'reads process.env (no spawn)',
  'app.ts <- LOCAL_PROVIDER_ID': 'a constant',
  'app.ts <- toLocalModel': 'a pure string mapping',
  'app.ts <- localFlagOk': 'G2-PV-05: the guard\'s flag provenance check (env var, env-file reads, platform); no spawn',
  'app.ts <- localModeOf': 'R8: a pure boolean function of the guard result, the env flag and the container check (no spawn)',
  'app.ts <- localOffByOwner': 'LOCAL-OFF-1: a pure boolean read of ASSISTANT_LOCAL_PROVIDER_OFF in the process env (no spawn)',
  'app.ts <- PINNED_BINARIES': 'constants (paths, hashes, versions)',
  'app.ts <- pinnedFor': 'a pure lookup',
  'app.ts <- DevJobService': 'the dev-job service (Gate 1 self-code); built only when devjob.enabled, runs git and docker through the fixed-argv launcher',
  'app.ts <- DockerSandbox': 'the fixed-argv launcher (OD-1a); no caller-supplied mount, image, network or flag',
  'app.ts <- loadImages': 'reads docker/devjob/images.json (no spawn)',
  'app.ts <- localSource': 'git on the owner repository, committed objects only, fixed argv and scrubbed env',
  'app.ts <- proxyControl': 'HTTP to the loopback control port of the model proxy (no spawn)',
  'app.ts <- realDocker': 'the docker runner behind the launcher; only ever receives launcher-built argv',
  'app.ts <- realDockerCli': 'the ws docker port (fixed argv, env {PATH, HOME, DOCKER_HOST?}; workspaces/runner.ts)',
  'devjob/boot.ts <- node:child_process': 'git with fixed argv and a scrubbed env',
  'devjob/facts.ts <- listTree': 'git ls-tree through the hardened GitPort',
  'devjob/facts.ts <- readBlobs': 'git cat-file through the hardened GitPort',
  'devjob/git.ts <- node:child_process': 'the one hardened git runner (hooks, protocols and config off)',
  'devjob/launcher.ts <- node:child_process': 'docker with launcher-built argv only',
  'workspaces/runner.ts <- node:child_process': 'docker with the ws argv builder only (WS-C1: array argv, no shell, env {PATH, HOME, DOCKER_HOST?})',
  'workspaces/boot.ts <- IMAGE_ID': 'a constant (the image id pattern)',
  'workspaces/boot.ts <- removeVerified': 'docker rm -f of the ws=1 sweep with fixed argv',
  'workspaces/service.ts <- PROXY_CONTAINER': 'a constant (the fixed proxy container name)',
  'workspaces/service.ts <- WS_NETWORK': 'a constant (the fixed network name)',
  'workspaces/service.ts <- buildArgv': 'the ws argv builder (validated parts only)',
  'workspaces/service.ts <- formatOutput': 'a pure text function (no spawn)',
  'workspaces/service.ts <- removeVerified': 'docker rm -f of ws containers with fixed argv',
  'workspaces/service.ts <- runContainer': 'the ws container runner (argv from buildArgv only)',
  // R6 MCP-1 (BE2): the MCP sandbox. The argv is built only in mcp/sandbox.ts from validated parts (shell:false, env {PATH, HOME, DOCKER_HOST?}); nothing caller-supplied reaches docker.
  'app.ts <- StuckLatch': 'the in-memory E_STUCK latch (no spawn)',
  'app.ts <- realMcpSpawner': 'the MCP sandbox spawner: docker with the argv built only by mcp/sandbox.ts (array argv, shell:false, env {PATH, HOME, DOCKER_HOST?})',
  'mcp/admin.ts <- checkImage': 'docker image inspect with fixed argv',
  'mcp/admin.ts <- checkSeccomp': 'docker info with fixed argv (the shared MC-C3 check, run before every admin probe)',
  'mcp/admin.ts <- withSandbox': 'the MCP sandbox runner (argv built only in mcp/sandbox.ts)',
  'mcp/boot.ts <- SANDBOX_NAME': 'a constant (the container name pattern)',
  'mcp/boot.ts <- checkImage': 'docker image inspect with fixed argv',
  'mcp/boot.ts <- checkSeccomp': 'docker info with fixed argv (the shared MC-C3 check)',
  'forge/builder.ts <- removeVerified': 'docker rm -f -v of the forge build container (exact name) with fixed argv, through the injected docker port (R7)',
  'forge/notes.ts <- ANSI': 'a constant (a regex from workspaces/runner.ts)',
  'mcp/boot.ts <- removeVerified': 'docker rm -f -v of the mcp=1 sweep with fixed argv',
  'mcp/fields.ts <- IMAGE_ID': 'a constant (the image id pattern)',
  'mcp/output.ts <- ANSI': 'a constant (a regex from workspaces/runner.ts)',
  'mcp/output.ts <- C0': 'a constant (a regex from workspaces/runner.ts)',
  'mcp/sandbox.ts <- IMAGE_ID': 'a constant (the image id pattern)',
  'mcp/sandbox.ts <- dockerEnv': 'the scrubbed docker env {PATH, HOME, DOCKER_HOST?}',
  'mcp/sandbox.ts <- node:child_process': 'docker run with the argv built only here from validated parts (no shell)',
  'mcp/sandbox.ts <- removeVerified': 'docker rm -f -v of the MCP container with fixed argv',
  'mcp/tool.ts <- withSandbox': 'the MCP sandbox runner (argv built only in mcp/sandbox.ts)',
  'devjob/service.ts <- node:child_process': 'git init of a scratch bare repository, fixed argv',
  'devjob/service.ts <- readBlobs': 'git cat-file through the hardened GitPort',
  'devjob/service.ts <- realGit': 'the hardened git runner',
  'voice/index.ts <- binaryGroupsDisabled': 'a pure mapping of a check result',
  'voice/music/index.ts <- MusicInputError': 'an Error class',
  'voice/music/index.ts <- normaliseQuery': 'pure query validation (no spawn)',
  'media/client.ts <- normaliseQuery': 'pure query validation (no spawn)',
  'media/client.ts <- PCM_CAP': 'a constant',
  'media/select.ts <- NOT_CONFIGURED': 'a constant (the refusal text)',
  'discord/commands/plans.ts <- LOCAL_MODELS': 'a constant (claude-code-local/protocol.ts)',
  'discord/commands/plans.ts <- PROVIDER_ID': 'a constant (claude-code-local/protocol.ts)',
  'governance/quota/quota.ts <- QUOTA_WINDOWS': 'a constant (window names); quota.ts itself spawns nothing',
  'governance/quota/quota.ts <- SHARED_WINDOWS': 'a constant (the windows whose rejection holds); quota.ts itself spawns nothing',
  'governance/budget.ts <- PROVIDER_ID': 'a constant (claude-code-local/protocol.ts)',
  'providers/registry.ts <- PROVIDER_ID': 'a constant (claude-code-local/protocol.ts)',
  'providers/registry.ts <- toLocalModel': 'a pure string mapping (claude-code-local/protocol.ts)',
  'providers/route.ts <- fromLocalModel': 'R8: a pure string mapping, the inverse of toLocalModel (claude-code-local/protocol.ts)',
};

describe('app import graph (Gate 1 S12 inverse)', () => {
  const g = walk('main.ts');
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

  it('the app never loads the sidecar server or entry (media/server.ts, media/main.ts)', () => {
    expect(g.size).toBeGreaterThan(100); // the walker sees the whole app
    expect([...g.keys()]).toContain('media/backend.ts');
    expect([...g.keys()]).toContain('media/client.ts');
    expect([...g.keys()]).not.toContain('media/server.ts');
    expect([...g.keys()]).not.toContain('media/main.ts');
  });

  it('child_process is imported only by voice/exec.ts, voice/music/source.ts, the guarded claude-code-local provider and the dev-job git/docker modules (Gate 1 self-code OD-1, X16)', () => {
    const users = [...g].filter(([, es]) => es.some((e) => CHILD_PROCESS.has(e.to))).map(([f]) => f).sort();
    expect(users).toEqual(['devjob/boot.ts', 'devjob/git.ts', 'devjob/launcher.ts', 'devjob/service.ts', 'mcp/sandbox.ts', 'providers/claude-code-local/guard.ts', 'providers/claude-code-local/spawn.ts', 'voice/exec.ts', 'voice/music/source.ts', 'workspaces/runner.ts']);
  });

  it('every app import of a spawn-reachable name outside the gateways is on the reviewed S12 list (derived names, renames followed)', () => {
    const reach = spawnReachable(g, read);
    // derivation sanity: the real spawners are reachable, including through the barrels the app imports from
    for (const [m, n] of [['voice/exec.ts', 'nodeExec'], ['voice/music/source.ts', 'spawnSafe'], ['media/decode.ts', 'decodeToPcm'], ['providers/claude-code-local/guard.ts', 'nodeGuardExec'],
      ['providers/claude-code-local/spawn.ts', 'runCli'], ['providers/index.ts', 'nodeGuardExec'], ['voice/index.ts', 'bootBinaries'], ['voice/music/index.ts', 'spawnSafe'], ['voice/chat/index.ts', 'decodeToPcm']] as const)
      expect(reach.get(m)?.has(n), `${m} ${n}`).toBe(true);
    expect(spawnImports(g, read)).toEqual(Object.keys(S12_ALLOWED).sort());
  });

  it('the inverse check bites: an unlisted spawner name through a non-gateway barrel, a renamed re-export, a local re-export and a namespace are reported', () => {
    const files: Record<string, string> = {
      'main.ts': [
        "import { probe } from './barrel/index.js';", // an unlisted name, re-exported by a barrel that is not a gateway
        "import { run } from './alias.js';", // a renamed re-export
        "import { go } from './local.js';", // imported, then re-exported under a new name
        "import * as all from './barrel/index.js';",
        "import { harmless } from './plain.js';",
        "const later = await import('./alias.js');",
      ].join('\n'),
      'barrel/index.ts': "export * from '../gw/spawner.js';\n",
      'gw/spawner.ts': "import { spawn } from 'node:child_process';\nexport function probe() { return spawn('x', []); }\nexport const quiet = 1;\n",
      'alias.ts': "export { probe as run } from './gw/spawner.js';\n",
      'local.ts': "import { probe } from './gw/spawner.js';\nexport { probe as go };\n",
      'plain.ts': 'export const harmless = 1;\n',
    };
    const rd = (p: string) => files[p] ?? '';
    const fake = walk('main.ts', rd);
    const none = () => false; // no gateway: anything reaching child_process counts
    expect(spawnReachable(fake, rd, none).get('alias.ts')).toEqual(new Set(['run']));
    expect(spawnImports(fake, rd, none)).toEqual([
      'gw/spawner.ts <- node:child_process',
      'local.ts <- probe',
      'main.ts <- * from alias.ts',
      'main.ts <- * from barrel/index.ts',
      'main.ts <- go',
      'main.ts <- probe',
      'main.ts <- run',
    ]);
  });
});

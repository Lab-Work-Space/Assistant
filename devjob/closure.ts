/**
 * Import closure of a program entry (Gate 1 self-code X9), computed at base AND head. TypeScript 7 ships no synchronous JS resolver API, so this
 * is a literal-specifier scanner: relative imports (NodeNext `.js` maps to `.ts`), bare specifiers mapped to their package, and a refusal for any
 * `import()` or `require()` whose argument is not a string literal. A change to any file in the closure, or to a lockfile entry of a package in
 * it, is non-self-modifiable.
 */
export type Reader = (path: string) => string | null;
export interface Closure { files: Set<string>; packages: Set<string>; refusals: string[] }

const STATIC = /(?:^|[\n;])\s*(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\s+from\s*)?['"]([^'"\n]+)['"]/g;
const DYN_LIT = /\b(?:import|require)\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;
const DYN_ANY = /(?<![\w.$])(?:import|require)\s*\(\s*([^'")\s][^)]{0,40})?/g;

const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
function join(dir: string, rel: string): string | null {
  const out = dir === '' ? [] : dir.split('/');
  for (const s of rel.split('/')) {
    if (s === '.' || s === '') continue;
    if (s === '..') { if (out.length === 0) return null; out.pop(); } else out.push(s);
  }
  return out.join('/');
}
function resolveRel(from: string, spec: string, read: Reader): string | null {
  const joined = join(dirOf(from), spec);
  if (joined === null) return null;
  const base = joined.replace(/\.[cm]?js$/, '');
  for (const c of [`${base}.ts`, `${base}.tsx`, joined, `${joined}.ts`, `${joined}/index.ts`]) if (read(c) !== null) return c;
  return null;
}
const pkgOf = (spec: string): string => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);

export function computeClosure(entries: readonly string[], read: Reader): Closure {
  const files = new Set<string>();
  const packages = new Set<string>();
  const refusals: string[] = [];
  const queue = [...entries];
  while (queue.length) {
    const f = queue.pop()!;
    if (files.has(f)) continue;
    const src = read(f);
    if (src === null) { refusals.push(`closure: cannot read ${f}`); continue; }
    files.add(f);
    const specs = new Set<string>();
    for (const m of src.matchAll(STATIC)) specs.add(m[1]!);
    for (const m of src.matchAll(DYN_LIT)) specs.add(m[1]!);
    for (const m of src.matchAll(DYN_ANY)) if (m[1] !== undefined && m[1] !== '') refusals.push(`closure: non-literal import() or require() in ${f}`);
    for (const s of specs) {
      if (s.startsWith('node:')) continue;
      if (s.startsWith('.')) {
        const r = resolveRel(f, s, read);
        if (r === null) refusals.push(`closure: ${f} imports ${s}, which does not resolve`);
        else queue.push(r);
      } else packages.add(pkgOf(s));
    }
  }
  return { files, packages, refusals };
}

type LockPkg = { version?: string; integrity?: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
/** The lockfile entries (key -> JSON) reachable from `pkgs`, resolved like node does: nearest node_modules first. */
export function lockEntries(lock: unknown, pkgs: Iterable<string>): Map<string, string> {
  const all = ((lock as { packages?: Record<string, LockPkg> }).packages ?? {});
  const out = new Map<string, string>();
  const find = (name: string, from: string): string | null => {
    for (let at = from; ; ) {
      const k = at === '' ? `node_modules/${name}` : `${at}/node_modules/${name}`;
      if (k in all) return k;
      if (at === '') return null;
      const i = at.lastIndexOf('/node_modules/');
      at = i < 0 ? '' : at.slice(0, i);
    }
  };
  const stack = [...pkgs].map((p) => find(p, '')).filter((k): k is string => k !== null);
  while (stack.length) {
    const k = stack.pop()!;
    if (out.has(k)) continue;
    const e = all[k]!;
    out.set(k, JSON.stringify(e));
    for (const d of Object.keys({ ...(e.dependencies ?? {}), ...(e.optionalDependencies ?? {}) })) {
      const r = find(d, k);
      if (r) stack.push(r);
    }
  }
  return out;
}

export interface ClosureFacts { files: string[]; refusals: string[] }
/** Refusals for every closure file or dependency entry that differs between base and head. `files` is the union of both closures. */
export function closureChange(entries: readonly string[], base: { read: Reader; lock: unknown }, head: { read: Reader; lock: unknown }): ClosureFacts {
  const b = computeClosure(entries, base.read);
  const h = computeClosure(entries, head.read);
  const refusals = [...new Set([...b.refusals, ...h.refusals])];
  const files = [...new Set([...b.files, ...h.files])].sort();
  for (const f of files) if (base.read(f) !== head.read(f)) refusals.push(`closure: ${f} changed`);
  const bl = lockEntries(base.lock, b.packages);
  const hl = lockEntries(head.lock, h.packages);
  for (const k of new Set([...bl.keys(), ...hl.keys()])) if (bl.get(k) !== hl.get(k)) refusals.push(`closure: dependency ${k} changed`);
  return { files, refusals };
}

/** The two programs whose closure is frozen. */
export const CLOSURE_ENTRIES = ['executor/main.ts', 'devjob/service.ts'] as const;

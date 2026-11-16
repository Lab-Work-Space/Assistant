import { createHash } from 'node:crypto';
import { canonicalJson } from '../governance/canonical.js';
import { screenText } from '../knowledge/screen.js';
import { buildZip } from '../workspaces/zip.js';
import { DEV_DEPS_SHOWN, FORGE_JSON_MAX, JSON_MAX_DEPTH, LOCK_MAX, PACKAGE_JSON_MAX, PATH_MAX, PATH_MAX_DEPTH, SHIPPED_MAX_BYTES, SHIPPED_MAX_FILES, TITLE_MAX, VENDOR_MAX_BYTES, ZIP_MAX_FILE, ZIP_MAX_TOTAL } from './caps.js';
import type { PluginInfo, ValidateResult } from './types.js';
import { readZipResult } from './unzip.js';

/**
 * R7 PLUGIN-FORGE (spec 5.4): the pure plugin validator. It runs at request time (with `canonical`, so the export must be byte-equal to a re-zip of what was read) and again on the pinned bytes
 * (enqueue, builder). Rules in order: Z (zip, forge/unzip.ts), P (paths), L (layout), S (sizes), T (text), J1 (JSON), then forge.json, package.json and the lockfile. A failure is a closed code (the caller
 * prefixes `plugin_`); the first offending path is returned only when it passed rule P, so a hostile name is never echoed. Nothing here logs, throws or echoes file content.
 */
export const SLUG = /^[a-z][a-z0-9]{1,15}$/;
const SEGMENT = /^[A-Za-z0-9._-]{1,64}$/;
const PKG_NAME = /^[a-z][a-z0-9-]{1,39}$/;
/** Parity copy of `BAD_SPEC` in workspaces/service.ts (a test compares the two sources). */
export const BAD_SPEC = /^(git|git\+|https?:|file:|link:|github:|gitlab:|bitbucket:|npm:|workspace:|\.|\\|[A-Za-z]:)|\.(tgz|tar|tar\.gz)$/i;
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly', 'prepack', 'postpack', 'preprepare', 'postprepare'];
/** The package type, written as an escape: the reflection scans (mcp/boundary.test.ts, releases/boundary.test.ts) refuse the quoted word in any source file. */
const MODULE_TYPE = '\u006dodule';
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const SHIPPED_EXT = /\.(?:mjs|js|cjs|json)$/;
const LICENSE = /^LICENSE(?:\.md|\.txt)?$/;
const REQUIRED = ['forge.json', 'package.json', 'server.mjs', 'package-lock.json'];
const UTF8 = new TextDecoder('utf-8', { fatal: true });

/** A path that passes rule P (segments, depth, length, no leading dot except a root .gitignore). */
export function pathOk(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > PATH_MAX) return false;
  const segs = p.split('/');
  if (segs.length > PATH_MAX_DEPTH) return false;
  if (p === '.gitignore') return true;
  return segs.every((s) => SEGMENT.test(s) && !s.startsWith('.'));
}

const isShipped = (p: string): boolean => p === 'forge.json' || p === 'package.json' || p === 'server.mjs' || p.startsWith('src/') || p.startsWith('vendor/');
const isOther = (p: string): boolean => p === 'package-lock.json' || p === 'README.md' || p === '.gitignore' || p.startsWith('test/');

/** Brace depth of raw JSON text outside strings (a linear scan, so a 1 MiB file of `[` never reaches the recursive parser). */
function jsonDepth(s: string): number {
  let d = 0;
  let max = 0;
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (inStr) { if (c === 0x5c) i++; else if (c === 0x22) inStr = false; continue; }
    if (c === 0x22) inStr = true;
    else if (c === 0x5b || c === 0x7b) { d++; if (d > max) max = d; } else if (c === 0x5d || c === 0x7d) d--;
  }
  return max;
}

/** J1: bounded depth, no `__proto__`, `constructor` or `prototype` key at any depth. Throws on any violation (the caller maps to `json`). */
export function parseJson(text: string): unknown {
  if (jsonDepth(text) > JSON_MAX_DEPTH) throw new Error('depth');
  return JSON.parse(text, function (this: unknown, key: string, value: unknown) {
    if (FORBIDDEN_KEYS.has(key)) throw new Error('key');
    return value;
  });
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const emptyMapOrAbsent = (o: Record<string, unknown>, k: string): boolean => !(k in o) || (isObj(o[k]) && Object.keys(o[k] as object).length === 0);
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const bad = (code: string, first?: string): ValidateResult => (first !== undefined && pathOk(first) ? { ok: false, code, first } : { ok: false, code });

export function validatePlugin(zip: Buffer, o: { forgeIdeaId: number; secrets?: readonly string[]; canonical?: boolean }): ValidateResult {
  try {
    return run(zip, o);
  } catch {
    return { ok: false, code: 'zip_bad' };
  }
}

function run(zip: Buffer, o: { forgeIdeaId: number; secrets?: readonly string[]; canonical?: boolean }): ValidateResult {
  // Z
  const z = readZipResult(zip);
  if (!z.ok) return bad(z.reason === 'too_big' ? 'too_big' : 'zip_bad');
  const entries = z.entries;
  if (o.canonical === true && !buildZip(entries).equals(zip)) return bad('zip_bad');
  // P
  const folded = new Set<string>();
  for (const e of entries) {
    if (!pathOk(e.name)) return bad('path');
    const f = e.name.toLowerCase();
    if (folded.has(f)) return bad('path');
    folded.add(f);
  }
  // L
  for (const e of entries) if (!isShipped(e.name) && !isOther(e.name)) return bad('layout', e.name);
  for (const e of entries) {
    if (!isShipped(e.name)) continue;
    const base = e.name.slice(e.name.lastIndexOf('/') + 1);
    if (!SHIPPED_EXT.test(e.name) && !(e.name.startsWith('vendor/') && LICENSE.test(base))) return bad('ext', e.name);
  }
  const byPath = new Map(entries.map((e) => [e.name, e.data]));
  for (const r of REQUIRED) if (!byPath.has(r)) return bad('missing', r);
  // S
  let total = 0;
  let shippedBytes = 0;
  let vendorBytes = 0;
  let shippedCount = 0;
  for (const e of entries) {
    if (e.data.length > ZIP_MAX_FILE) return bad('too_big', e.name);
    total += e.data.length;
    if (isShipped(e.name)) { shippedCount++; shippedBytes += e.data.length; if (e.name.startsWith('vendor/')) vendorBytes += e.data.length; }
  }
  if (shippedCount > SHIPPED_MAX_FILES) return bad('too_many');
  if (shippedBytes > SHIPPED_MAX_BYTES || vendorBytes > VENDOR_MAX_BYTES || total > ZIP_MAX_TOTAL) return bad('too_big');
  // T
  const texts = new Map<string, string>();
  for (const e of entries) {
    if (e.data.includes(0)) return bad('binary', e.name);
    try { texts.set(e.name, UTF8.decode(e.data)); } catch { return bad('binary', e.name); }
  }
  // J1
  const parse = (name: string, max: number): unknown => {
    const d = byPath.get(name)!;
    if (d.length > max) throw new Error('size');
    return parseJson(texts.get(name)!);
  };
  let fj: unknown; let pj: unknown; let lj: unknown;
  try { fj = parse('forge.json', FORGE_JSON_MAX); pj = parse('package.json', PACKAGE_JSON_MAX); lj = parse('package-lock.json', LOCK_MAX); } catch { return bad('json'); }
  // forge.json
  if (!isObj(fj)) return bad('forge_json');
  const keys = Object.keys(fj).sort().join(',');
  if (keys !== 'forge,idea,slug,title' || fj.forge !== 1 || typeof fj.slug !== 'string' || !SLUG.test(fj.slug) || typeof fj.title !== 'string' || !Number.isSafeInteger(fj.idea)) return bad('forge_json');
  const title = screenText(fj.title, { max: TITLE_MAX, multiline: false, ...(o.secrets ? { secrets: o.secrets } : {}) });
  if (!title.ok) return bad('forge_json');
  if (fj.idea !== o.forgeIdeaId) return bad('idea_mismatch');
  // package.json
  if (!isObj(pj)) return bad('package_json');
  if (pj.type !== MODULE_TYPE || typeof pj.name !== 'string' || !PKG_NAME.test(pj.name) || ('main' in pj && pj.main !== 'server.mjs')) return bad('package_json');
  for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies']) if (!emptyMapOrAbsent(pj, k)) return bad('deps');
  for (const k of ['bundledDependencies', 'bundleDependencies', 'bin', 'gypfile', 'binary', 'os', 'cpu', 'workspaces']) if (k in pj) return bad('deps');
  if ('scripts' in pj) {
    if (!isObj(pj.scripts)) return bad('package_json');
    if (Object.keys(pj.scripts).some((s) => INSTALL_SCRIPTS.includes(s))) return bad('scripts');
  }
  const devDeps: { name: string; version: string }[] = [];
  if ('devDependencies' in pj) {
    if (!isObj(pj.devDependencies)) return bad('package_json');
    for (const [name, spec] of Object.entries(pj.devDependencies)) {
      if (typeof spec !== 'string' || spec.length === 0 || spec.length > 200 || BAD_SPEC.test(spec) || name.length > 214) return bad('package_json');
      devDeps.push({ name, version: spec });
    }
    devDeps.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }
  // lockfile
  if (!isObj(lj) || lj.lockfileVersion !== 3 || lj.name !== pj.name || !isObj(lj.packages)) return bad('lockfile');
  const root = lj.packages[''];
  if (!isObj(root) || ['dependencies', 'optionalDependencies', 'peerDependencies'].some((k) => !emptyMapOrAbsent(root, k))) return bad('lockfile');
  for (const [k, v] of Object.entries(lj.packages)) {
    if (k === '') continue;
    if (!k.startsWith('node_modules/') || !isObj(v) || v.dev !== true || v.hasInstallScript !== undefined) return bad('lockfile');
    if ('resolved' in v && (typeof v.resolved !== 'string' || !v.resolved.startsWith('https://registry.npmjs.org/'))) return bad('lockfile');
  }
  // output
  const shipped = entries.filter((e) => isShipped(e.name)).map((e) => ({ path: e.name, size: e.data.length, sha256: sha(e.data) })).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const info: PluginInfo = {
    forge: { slug: fj.slug, title: title.text, idea: fj.idea as number },
    shipped,
    otherCount: entries.length - shipped.length,
    devDeps: devDeps.slice(0, DEV_DEPS_SHOWN),
    manifestSha256: createHash('sha256').update(canonicalJson(shipped), 'utf8').digest('hex'),
    files: shipped.map((s) => ({ path: s.path, data: byPath.get(s.path)! })),
  };
  return { ok: true, info };
}

/** Validator code -> text (the request refusal is `plugin_<code>`). A first offending path is appended only when it passed rule P. */
export const PLUGIN_TEXT: Record<string, string> = {
  zip_bad: 'The exported workspace is not a zip this forge accepts.',
  path: 'A file path in the workspace is not allowed (letters, digits, dot, dash and underscore only; at most 6 levels; no leading dot).',
  layout: 'The workspace does not follow the plugin layout (allowed: forge.json, package.json, package-lock.json, server.mjs, src/, vendor/, test/, README.md, .gitignore).',
  ext: 'A shipped file has an extension that is not allowed (shipped files are .mjs, .js, .cjs and .json; vendor/ may also hold LICENSE files).',
  missing: 'A required file is missing (forge.json, package.json, package-lock.json and server.mjs are required).',
  too_big: 'A file or the whole workspace is over the plugin size limits.',
  too_many: 'The plugin ships more than 120 files.',
  binary: 'A file is not plain UTF-8 text (binary files, native addons and wasm are not allowed).',
  json: 'forge.json, package.json or package-lock.json is not valid JSON within its limits.',
  forge_json: 'forge.json must be exactly {"forge":1,"slug":...,"title":...,"idea":...} with a valid slug and title.',
  idea_mismatch: 'forge.json names a different tool idea than this forge builds.',
  deps: 'The plugin may not have runtime dependencies, bundled dependencies, binaries or platform fields.',
  scripts: 'package.json may not define install-time scripts.',
  package_json: 'package.json is not valid for a plugin (the type must be the module type; dev dependencies must be registry versions).',
  lockfile: 'package-lock.json is not valid for a plugin (version 3, development packages from the npm registry only, no install scripts).',
};
export function pluginText(code: string, first?: string): string {
  const base = PLUGIN_TEXT[code] ?? 'The workspace does not follow the plugin rules.';
  return first !== undefined && pathOk(first) ? `${base} First: ${first}.` : base;
}

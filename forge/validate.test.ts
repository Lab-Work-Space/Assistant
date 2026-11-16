import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildZip } from '../workspaces/zip.js';
import { rawZip } from './test-helpers.js';
import { BAD_SPEC, pathOk, validatePlugin } from './validate.js';

const HELLO = fileURLToPath(new URL('../tests/fixtures/forge/hello/', import.meta.url));
function load(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) load(p, base, out); else out[relative(base, p)] = readFileSync(p, 'utf8');
  }
  return out;
}
const hello = load(HELLO);
type Files = Record<string, string | null>;
const zipOf = (over: Files = {}): Buffer => {
  const f: Record<string, string> = { ...hello };
  for (const [k, v] of Object.entries(over)) { if (v === null) delete f[k]; else f[k] = v; }
  return buildZip(Object.entries(f).map(([name, data]) => ({ name, data: Buffer.from(data) })));
};
const v = (over: Files = {}, o: { canonical?: boolean; idea?: number } = {}) => validatePlugin(zipOf(over), { forgeIdeaId: o.idea ?? 1, ...(o.canonical !== undefined ? { canonical: o.canonical } : {}) });
const code = (over: Files, idea?: number): string => { const r = v(over, idea === undefined ? {} : { idea }); return r.ok ? 'ok' : r.code; };
const pj = (o: Record<string, unknown>): string => JSON.stringify({ ...JSON.parse(hello['package.json']!), ...o });
const lock = (packages: Record<string, unknown>, o: Record<string, unknown> = {}): string => JSON.stringify({ name: 'hello-plugin', lockfileVersion: 3, packages: { '': { name: 'hello-plugin' }, ...packages }, ...o });

describe('FG-AC03: the hello fixture is a valid plugin', () => {
  it('validates, with the shipped list, manifest hash and counts the card needs', () => {
    const r = v({}, { canonical: true });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.forge).toEqual({ slug: 'hello', title: 'Hello plugin', idea: 1 });
    expect(r.info.shipped.map((s) => s.path)).toEqual(['forge.json', 'package.json', 'server.mjs', 'src/tools.mjs']);
    expect(r.info.otherCount).toBe(4); // README.md, .gitignore, package-lock.json, test/tools.test.mjs
    expect(r.info.devDeps).toEqual([]);
    expect(r.info.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(r.info.files.map((f) => f.path)).toEqual(r.info.shipped.map((s) => s.path));
  });
  it('the manifest hash is independent of entry order and of the non-shipped files, and changes with a shipped byte', () => {
    const a = v({}); const b = v({ 'README.md': 'other', 'test/x.test.mjs': 'x' });
    const entries = Object.entries(hello).map(([name, data]) => ({ name, data: Buffer.from(data) })).reverse();
    const c = validatePlugin(buildZip(entries), { forgeIdeaId: 1 });
    const d = v({ 'server.mjs': hello['server.mjs'] + '\n// x' });
    if (!a.ok || !b.ok || !c.ok || !d.ok) throw new Error('expected ok');
    expect(b.info.manifestSha256).toBe(a.info.manifestSha256);
    expect(c.info.manifestSha256).toBe(a.info.manifestSha256);
    expect(d.info.manifestSha256).not.toBe(a.info.manifestSha256);
  });
  it('canonical mode: an equal-content zip that buildZip would not emit byte for byte is zip_bad; the default mode accepts a differently ordered one only if it parses', () => {
    const entries = Object.entries(hello).map(([name, data]) => ({ name, data: Buffer.from(data) }));
    const canon = buildZip(entries);
    expect(validatePlugin(canon, { forgeIdeaId: 1, canonical: true }).ok).toBe(true);
    const stored = rawZip(entries.map((e) => ({ name: e.name, data: e.data, method: 0, body: e.data })));
    expect(validatePlugin(stored, { forgeIdeaId: 1 }).ok).toBe(true);
    expect(validatePlugin(stored, { forgeIdeaId: 1, canonical: true })).toEqual({ ok: false, code: 'zip_bad' });
  });
});

describe('FG-AC03: one fixture per refusal code (spec 5.4)', () => {
  it('zip_bad: not a zip, trailing bytes', () => {
    expect(validatePlugin(Buffer.from('nope'), { forgeIdeaId: 1 })).toEqual({ ok: false, code: 'zip_bad' });
    expect(validatePlugin(Buffer.concat([zipOf(), Buffer.from([0])]), { forgeIdeaId: 1 })).toEqual({ ok: false, code: 'zip_bad' });
  });
  it.each([
    ['a dot-dot segment', '../x.mjs'], ['an absolute path', '/server.mjs'], ['a backslash', 'src\\a.mjs'], ['a colon', 'src/a:b.mjs'], ['a space', 'src/a b.mjs'], ['a leading-dot directory', 'src/.hidden/a.mjs'],
    ['a leading-dot file', 'src/.env'], ['a non-ASCII name', 'src/é.mjs'], ['depth 7', 'src/a/b/c/d/e/f.mjs'], ['a 65-character segment', `src/${'a'.repeat(65)}.mjs`], ['a path over 200', `src/${'a/'.repeat(0)}${'b'.repeat(64)}/${'c'.repeat(64)}/${'d'.repeat(64)}.mjs`], ['a double slash', 'src//a.mjs'],
  ])('path: %s', (_n, name) => { expect(code({ [name]: 'x' })).toBe('path'); });
  it('path: a case-insensitive duplicate', () => { expect(code({ 'src/A.mjs': 'x', 'src/a.mjs': 'y' })).toBe('path'); });
  it('path: .dockerignore is refused by rule P (leading dot) before rule L can name it (spec 5.4 lists it under L: the code is `path`)', () => { expect(code({ '.dockerignore': 'x' })).toBe('path'); });
  it('path: a root .gitignore is the one allowed dot file', () => { expect(pathOk('.gitignore')).toBe(true); expect(pathOk('src/.gitignore')).toBe(false); expect(pathOk('a/b/c/d/e/f')).toBe(true); });
  it.each([['Dockerfile'], ['Dockerfile.prod'], ['dist/x.js'], ['index.ts'], ['docs/a.md'], ['srcx/a.mjs'], ['lib/a.mjs']])('layout: %s', (n) => { expect(code({ [n]: 'x' })).toBe('layout'); });
  it('layout: the first offending path is returned only when it passed rule P', () => {
    const r = v({ Dockerfile: 'FROM x' });
    expect(r).toEqual({ ok: false, code: 'layout', first: 'Dockerfile' });
  });
  it.each([['src/a.ts'], ['src/a.node'], ['src/a.wasm'], ['src/a'], ['vendor/README'], ['src/LICENSE'], ['vendor/a.txt']])('ext: %s', (n) => { expect(code({ [n]: 'x' })).toBe('ext'); });
  it('ext: vendor allows LICENSE, LICENSE.md and LICENSE.txt, test and README are not ext-checked', () => {
    expect(code({ 'vendor/LICENSE': 'MIT', 'vendor/LICENSE.md': 'MIT', 'vendor/LICENSE.txt': 'MIT', 'test/data.bin.txt': 'x', 'vendor/a.json': '{}', 'vendor/b.cjs': '1' })).toBe('ok');
  });
  it.each([['forge.json'], ['package.json'], ['server.mjs'], ['package-lock.json']])('missing: %s', (n) => { expect(code({ [n]: null })).toBe('missing'); });
  it('too_big: a file over 512 KiB, shipped over 2 MiB, vendor over 1.5 MiB; too_many: 121 shipped files', () => {
    expect(code({ 'src/big.mjs': 'a'.repeat(512 * 1024 + 1) })).toBe('too_big');
    expect(code({ 'src/a.mjs': 'a'.repeat(500 * 1024), 'src/b.mjs': 'a'.repeat(500 * 1024), 'src/c.mjs': 'a'.repeat(500 * 1024), 'src/d.mjs': 'a'.repeat(500 * 1024), 'src/e.mjs': 'a'.repeat(100 * 1024) })).toBe('too_big');
    expect(code({ 'vendor/a.js': 'a'.repeat(400 * 1024), 'vendor/b.js': 'a'.repeat(400 * 1024), 'vendor/c.js': 'a'.repeat(400 * 1024), 'vendor/d.js': 'a'.repeat(400 * 1024) })).toBe('too_big');
    const many: Files = {};
    for (let i = 0; i < 118; i++) many[`src/f${i}.mjs`] = 'x'; // 4 shipped + 118 = 122
    expect(code(many)).toBe('too_many');
    const edge: Files = {};
    for (let i = 0; i < 116; i++) edge[`src/f${i}.mjs`] = 'x'; // exactly 120
    expect(code(edge)).toBe('ok');
  });
  it('too_big: all entries over 4 MiB (non-shipped files count)', () => {
    const f: Files = {};
    for (let i = 0; i < 9; i++) f[`test/t${i}.mjs`] = 'a'.repeat(500 * 1024);
    expect(code(f)).toBe('too_big');
  });
  it('binary: NUL byte, invalid UTF-8, in a shipped or a test file', () => {
    expect(code({ 'src/a.mjs': 'a\0b' })).toBe('binary');
    expect(code({ 'test/a.mjs': 'a\0b' })).toBe('binary');
    const bad = rawZip(Object.entries(hello).map(([name, data]) => ({ name, data: name === 'src/tools.mjs' ? Buffer.from([0xff, 0xfe, 0x41]) : Buffer.from(data) })));
    expect(validatePlugin(bad, { forgeIdeaId: 1 })).toEqual({ ok: false, code: 'binary', first: 'src/tools.mjs' });
  });
  it.each([
    ['forge.json', '{"forge":1,"slug":"hello","__proto__":{"x":1},"title":"t","idea":1}'], ['forge.json', '{"forge":1,"slug":"hello","title":"t","idea":1,"x":{"constructor":1}}'],
    ['package.json', pj({ x: JSON.parse('{"a":{"prototype":1}}') })], ['package-lock.json', lock({}, { x: [{ constructor: 1 }] })],
    ['forge.json', '{not json'], ['package.json', ''], ['package-lock.json', '[1,'],
  ])('json: %s with a forbidden key or a syntax error', (n, body) => { expect(code({ [n]: body })).toBe('json'); });
  it('json: the size caps (forge.json 2 KiB, package.json 16 KiB, lock 1 MiB) and depth 32', () => {
    expect(code({ 'forge.json': `{"forge":1,"slug":"hello","title":"t","idea":1,"pad":"${'a'.repeat(2048)}"}` })).toBe('json');
    expect(code({ 'package.json': pj({ pad: 'a'.repeat(16 * 1024) }) })).toBe('json');
    expect(code({ 'package-lock.json': lock({}, { pad: 'a'.repeat(300 * 1024) }) })).toBe('ok'); // under the cap
    expect(code({ 'package-lock.json': '[' .repeat(40) + ']'.repeat(40) })).toBe('json');
    expect(code({ 'package.json': `{"a":${'['.repeat(100000)}${']'.repeat(100000)}}` })).toBe('json'); // never reaches the recursive parser
  });
  it.each([
    ['an extra key', '{"forge":1,"slug":"hello","title":"t","idea":1,"x":1}'], ['a missing key', '{"forge":1,"slug":"hello","title":"t"}'], ['forge 2', '{"forge":2,"slug":"hello","title":"t","idea":1}'],
    ['an upper-case slug', '{"forge":1,"slug":"Hello","title":"t","idea":1}'], ['a 17-character slug', `{"forge":1,"slug":"${'a'.repeat(17)}","title":"t","idea":1}`], ['a one-character slug', '{"forge":1,"slug":"a","title":"t","idea":1}'],
    ['an empty title', '{"forge":1,"slug":"hello","title":"","idea":1}'], ['an 81-character title', `{"forge":1,"slug":"hello","title":"${'a'.repeat(81)}","idea":1}`], ['a multi-line title', '{"forge":1,"slug":"hello","title":"a\\nb","idea":1}'],
    ['a secret-shaped title', '{"forge":1,"slug":"hello","title":"sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123","idea":1}'], ['a hidden character', '{"forge":1,"slug":"hello","title":"a\\u200Bb","idea":1}'],
    ['a string idea', '{"forge":1,"slug":"hello","title":"t","idea":"1"}'], ['a fractional idea', '{"forge":1,"slug":"hello","title":"t","idea":1.5}'], ['an array', '[1]'], ['null', 'null'],
  ])('forge_json: %s', (_n, body) => { expect(code({ 'forge.json': body })).toBe('forge_json'); });
  it('idea_mismatch: the idea is another forge', () => { expect(code({}, 2)).toBe('idea_mismatch'); });
  it.each([
    ['not an object', '[]'], ['type commonjs', pj({ type: 'commonjs' })], ['no type', JSON.stringify({ name: 'hello-plugin' })], ['a bad name', pj({ name: 'Hello_Plugin' })], ['a main other than server.mjs', pj({ main: 'index.js' })],
    ['a non-object scripts', pj({ scripts: 'x' })], ['devDependencies as an array', pj({ devDependencies: [] })], ['a git devDependency', pj({ devDependencies: { x: 'git+https://x/y.git' } })],
    ['a file devDependency', pj({ devDependencies: { x: 'file:../x' } })], ['a tarball devDependency', pj({ devDependencies: { x: 'x.tgz' } })], ['a non-string spec', pj({ devDependencies: { x: 1 } })],
  ])('package_json: %s', (_n, body) => { expect(code({ 'package.json': body, 'package-lock.json': lock({}) })).toBe('package_json'); });
  it.each([
    ['dependencies', { dependencies: { left: '1.0.0' } }], ['optionalDependencies', { optionalDependencies: { a: '1' } }], ['peerDependencies', { peerDependencies: { a: '1' } }], ['bundledDependencies', { bundledDependencies: [] }],
    ['bundleDependencies', { bundleDependencies: [] }], ['bin', { bin: 'x.js' }], ['gypfile', { gypfile: true }], ['binary', { binary: {} }], ['os', { os: ['linux'] }], ['cpu', { cpu: ['x64'] }], ['workspaces', { workspaces: ['a'] }],
    ['a non-object dependencies', { dependencies: [] }],
  ])('deps: %s', (_n, over) => { expect(code({ 'package.json': pj(over) })).toBe('deps'); });
  it('deps: empty runtime maps are fine', () => { expect(code({ 'package.json': pj({ dependencies: {}, optionalDependencies: {}, peerDependencies: {} }) })).toBe('ok'); });
  it.each(['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'prepublishOnly', 'prepack', 'postpack', 'preprepare', 'postprepare'])('scripts: %s', (s) => {
    expect(code({ 'package.json': pj({ scripts: { [s]: 'node x' } }) })).toBe('scripts');
  });
  it('devDependencies: listed (sorted, at most 20) and never shipped', () => {
    const dev: Record<string, string> = {};
    for (let i = 0; i < 25; i++) dev[`d${String(i).padStart(2, '0')}`] = '^1.0.0';
    const r = v({ 'package.json': pj({ devDependencies: dev }), 'package-lock.json': lock({}) });
    if (!r.ok) throw new Error('expected ok');
    expect(r.info.devDeps).toHaveLength(20);
    expect(r.info.devDeps[0]).toEqual({ name: 'd00', version: '^1.0.0' });
    expect(r.info.shipped.some((s) => s.path === 'package-lock.json')).toBe(false);
  });
  it.each([
    ['lockfileVersion 2', lock({}, { lockfileVersion: 2 })], ['another name', lock({}, { name: 'other' })], ['no packages', JSON.stringify({ name: 'hello-plugin', lockfileVersion: 3 })], ['no root entry', JSON.stringify({ name: 'hello-plugin', lockfileVersion: 3, packages: {} })],
    ['root dependencies', lock({ '': { name: 'hello-plugin', dependencies: { a: '1' } } })], ['a runtime entry (no dev flag)', lock({ 'node_modules/a': { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' } })],
    ['an install script', lock({ 'node_modules/a': { version: '1.0.0', dev: true, hasInstallScript: true } })], ['a non node_modules key', lock({ 'packages/a': { dev: true } })],
    ['a foreign resolved host', lock({ 'node_modules/a': { version: '1', dev: true, resolved: 'https://evil.example/a.tgz' } })], ['a git resolved', lock({ 'node_modules/a': { version: '1', dev: true, resolved: 'git+ssh://x/y' } })],
    ['a non-string resolved', lock({ 'node_modules/a': { version: '1', dev: true, resolved: 1 } })],
  ])('lockfile: %s', (_n, body) => { expect(code({ 'package-lock.json': body })).toBe('lockfile'); });
  it('lockfile: a dev-only entry from the npm registry is accepted', () => {
    expect(code({ 'package-lock.json': lock({ 'node_modules/a': { version: '1.0.0', dev: true, resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' } }), 'package.json': pj({ devDependencies: { a: '1.0.0' } }) })).toBe('ok');
  });
});

describe('parity and safety', () => {
  it('BAD_SPEC is the same regex as workspaces/service.ts (rule 16: one rule, two copies, compared by source)', () => {
    const src = readFileSync(fileURLToPath(new URL('../workspaces/service.ts', import.meta.url)), 'utf8');
    const m = /const BAD_SPEC = (\/.*\/i);/.exec(src);
    expect(m).not.toBeNull();
    expect(String(BAD_SPEC)).toBe(m![1]);
  });
  it('validatePlugin never throws on hostile input', () => {
    for (const b of [Buffer.alloc(0), Buffer.alloc(22), Buffer.from('PK\x05\x06' + 'x'.repeat(18)), Buffer.alloc(1000, 0xff)]) expect(validatePlugin(b, { forgeIdeaId: 1 }).ok).toBe(false);
    expect(validatePlugin(null as never, { forgeIdeaId: 1 }).ok).toBe(false);
  });
});

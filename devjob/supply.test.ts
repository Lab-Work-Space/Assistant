import { describe, expect, it } from 'vitest';
import { checkSupply, type SupplyPort } from './supply.js';

const NOW = Date.parse('2026-11-02T00:00:00Z');
const old = '2026-01-01T00:00:00Z';
const pkgN = (n: string, v: string, o: Record<string, unknown> = {}) => ({ version: v, resolved: `https://registry.npmjs.org/${n}/-/${n}-${v}.tgz`, integrity: 'sha512-AAAA', ...o });
const pkg = (v: string, o: Record<string, unknown> = {}) => pkgN('x', v, o);
const lock = (p: Record<string, unknown>) => ({ packages: { '': {}, ...p } });
const port = (o: Partial<SupplyPort> = {}): SupplyPort => ({ publishedAt: async () => old, integrity: async () => 'sha512-AAAA', audit: async () => ({ high: 0, critical: 0, databaseDate: '2026-11-02' }), ...o });
const m = (deps: Record<string, string> = {}, scripts: Record<string, string> = { test: 'vitest' }) => ({ name: 'a', scripts, dependencies: deps });
const run = (i: Parameters<typeof checkSupply>[0], p = port()) => checkSupply(i, p, () => NOW);

describe('X14 supply chain', () => {
  const base = lock({ 'node_modules/a': pkgN('a', '1.0.0') });
  it('unchanged dependencies pass without touching the network', async () => {
    const r = await run({ baseManifest: m({ a: '1.0.0' }), headManifest: m({ a: '1.0.0' }), baseLock: base, headLock: base }, port({ audit: async () => { throw new Error('no'); } }));
    expect(r.refusals).toEqual([]);
  });
  it('a lockfile change without a manifest change is refused', async () => {
    const r = await run({ baseManifest: m({ a: '1.0.0' }), headManifest: m({ a: '1.0.0' }), baseLock: base, headLock: lock({ 'node_modules/a': pkgN('a', '1.0.0'), 'node_modules/b': pkgN('b', '2.0.0') }) });
    expect(r.refusals.join()).toMatch(/without a manifest change/);
  });
  it('a changed integrity for an unchanged version is refused', async () => {
    const r = await run({ baseManifest: m({ a: '1.0.0' }), headManifest: m({ a: '1.0.0', c: '1.0.0' }), baseLock: base, headLock: lock({ 'node_modules/a': pkgN('a', '1.0.0', { integrity: 'sha512-BBBB' }), 'node_modules/c': pkgN('c', '1.0.0') }) });
    expect(r.refusals.join()).toMatch(/integrity of an unchanged version/);
  });
  it('refuses git/http/file/link/tarball specs and non-registry resolved values', async () => {
    for (const spec of ['git+https://x/y.git', 'github:a/b', 'file:../x', 'link:../x', 'https://x/y.tgz', 'npm:other@1', 'a/b']) {
      const r = await run({ baseManifest: m(), headManifest: m({ z: spec }), baseLock: base, headLock: lock({ 'node_modules/a': pkgN('a', '1.0.0'), 'node_modules/z': pkgN('z', '1.0.0') }) });
      expect(r.refusals.join(), spec).toMatch(/non-registry spec/);
    }
    const r = await run({ baseManifest: m(), headManifest: m({ z: '1.0.0' }), baseLock: base, headLock: lock({ 'node_modules/a': pkgN('a', '1.0.0'), 'node_modules/z': pkgN('z', '1.0.0', { resolved: 'https://evil.example/z.tgz' }) }) });
    expect(r.refusals.join()).toMatch(/resolved is not/);
    const r2 = await run({ baseManifest: m(), headManifest: m({ z: '1.0.0' }), baseLock: base, headLock: lock({ 'node_modules/a': pkgN('a', '1.0.0'), 'node_modules/z': pkgN('z', '1.0.0', { integrity: 'sha1-xx' }) }) });
    expect(r2.refusals.join()).toMatch(/sha512/);
    const r3 = await run({ baseManifest: m(), headManifest: m({ z: '1.0.0' }), baseLock: base, headLock: lock({ 'node_modules/a': pkgN('a', '1.0.0'), 'node_modules/z': { link: true } }) });
    expect(r3.refusals.join()).toMatch(/link/);
  });
  it('lists new packages with the install-script flag; too-young or unknown-age versions are refused', async () => {
    const head = lock({ 'node_modules/a': pkgN('a', '1.0.0'), 'node_modules/n': pkgN('n', '3.0.0', { hasInstallScript: true }) });
    const ok = await run({ baseManifest: m({ a: '1.0.0' }), headManifest: m({ a: '1.0.0', n: '3.0.0' }), baseLock: base, headLock: head });
    expect(ok.refusals).toEqual([]);
    expect(ok.newPackages).toEqual([{ name: 'n', version: '3.0.0', hasInstallScript: true, publishedAt: old }]);
    const young = await run({ baseManifest: m({ a: '1.0.0' }), headManifest: m({ a: '1.0.0', n: '3.0.0' }), baseLock: base, headLock: head }, port({ publishedAt: async () => '2026-10-30T00:00:00Z' }));
    expect(young.refusals.join()).toMatch(/less than 7 days/);
    const unknown = await run({ baseManifest: m({ a: '1.0.0' }), headManifest: m({ a: '1.0.0', n: '3.0.0' }), baseLock: base, headLock: head }, port({ publishedAt: async () => null }));
    expect(unknown.refusals.join()).toMatch(/publish date unknown/);
  });
  it('more than 3 new direct dependencies are refused', async () => {
    const d = { p1: '1.0.0', p2: '1.0.0', p3: '1.0.0', p4: '1.0.0' };
    const head = lock({ 'node_modules/a': pkgN('a', '1.0.0'), ...Object.fromEntries(Object.keys(d).map((k) => [`node_modules/${k}`, pkgN(k, '1.0.0')])) });
    const r = await run({ baseManifest: m({ a: '1.0.0' }), headManifest: m({ a: '1.0.0', ...d }), baseLock: base, headLock: head });
    expect(r.refusals.join()).toMatch(/4 new direct/);
  });
  it('audit findings and an unreachable audit both refuse', async () => {
    const head = lock({ 'node_modules/a': pkgN('a', '1.0.0'), 'node_modules/n': pkgN('n', '3.0.0') });
    const i = { baseManifest: m({ a: '1.0.0' }), headManifest: m({ a: '1.0.0', n: '3.0.0' }), baseLock: base, headLock: head };
    expect((await run(i, port({ audit: async () => ({ high: 1, critical: 1, databaseDate: '2026-11-01' }) }))).refusals.join()).toMatch(/1 critical, 1 high \(database 2026-11-01\)/);
    expect((await run(i, port({ audit: async () => { throw new Error('x'); } }))).refusals.join()).toMatch(/could not be reached/);
  });
  it('G2SC-11: resolved must be the tarball of name@version and integrity must be the registry\'s own', async () => {
    const i = (entry: Record<string, unknown>) => ({ baseManifest: m({ a: '1.0.0' }), headManifest: m({ a: '1.0.0', n: '3.0.0' }), baseLock: base, headLock: lock({ 'node_modules/a': pkgN('a', '1.0.0'), 'node_modules/n': entry }) });
    // an entry that claims an old harmless package but points at another tarball
    expect((await run(i(pkgN('n', '3.0.0', { resolved: 'https://registry.npmjs.org/fresh-evil/-/fresh-evil-9.9.9.tgz' })))).refusals.join()).toMatch(/not the tarball of that name and version/);
    expect((await run(i(pkgN('n', '3.0.0', { resolved: 'https://registry.npmjs.org/n/-/n-3.0.1.tgz' })))).refusals.join()).toMatch(/not the tarball/);
    expect((await run(i(pkgN('n', '3.0.0')), port({ integrity: async () => 'sha512-DIFFERENT' }))).refusals.join()).toMatch(/not the registry's integrity/);
    expect((await run(i(pkgN('n', '3.0.0')), port({ integrity: async () => null }))).refusals.join()).toMatch(/not the registry's integrity/);
    expect((await run(i(pkgN('n', '3.0.0')))).refusals).toEqual([]);
    const scoped = { baseManifest: m(), headManifest: m({ '@s/p': '1.0.0' }), baseLock: base, headLock: lock({ 'node_modules/a': pkgN('a', '1.0.0'), 'node_modules/@s/p': { version: '1.0.0', resolved: 'https://registry.npmjs.org/@s/p/-/p-1.0.0.tgz', integrity: 'sha512-AAAA' } }) };
    expect((await run(scoped)).refusals).toEqual([]);
  });
  it('a changed scripts block is refused even with no dependency change', async () => {
    const r = await run({ baseManifest: m({}, { test: 'vitest' }), headManifest: m({}, { test: 'true' }), baseLock: base, headLock: base });
    expect(r.refusals.join()).toMatch(/scripts block/);
  });
});

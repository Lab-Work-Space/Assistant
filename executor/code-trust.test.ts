import { chmodSync, realpathSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { trustProblem } from './code-trust.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const uid = process.getuid!();

function world() {
  const base = mkdtempSync(join(tmpdir(), 'trust-'));
  dirs.push(base);
  chmodSync(base, 0o755);
  const root = join(base, 'code');
  mkdirSync(join(root, 'repo.git', 'objects', 'info'), { recursive: true });
  for (const d of [root, join(root, 'repo.git'), join(root, 'repo.git/objects'), join(root, 'repo.git/objects/info')]) chmodSync(d, 0o755);
  writeFileSync(join(root, 'repo.git', 'HEAD'), 'ref: refs/heads/main\n', { mode: 0o644 });
  mkdirSync(join(base, 'bin'), { mode: 0o755 });
  writeFileSync(join(base, 'bin', 'tsc.js'), '1', { mode: 0o755 });
  writeFileSync(join(base, 'bin', 'npm'), '1', { mode: 0o755 });
  // rootUid = this uid in tests: the real value is 0
  return { base, root, tsc: join(base, 'bin/tsc.js'), npm: join(base, 'bin/npm'), o: (extra = {}) => ({ root, tsc: join(base, 'bin/tsc.js'), npm: join(base, 'bin/npm'), uid, rootUid: uid, anchor: realpathSync(base), ...extra }) };
}

describe('G2SC-02 trust', () => {
  it('accepts a code root, a repository and tools owned correctly', () => {
    const w = world();
    expect(trustProblem(w.o())).toBeNull();
  });
  it('refuses a foreign owner of the root or the tools (owner uid vs executor uid)', () => {
    const w = world();
    expect(trustProblem(w.o({ uid: uid + 1 }))).toMatch(/not owned by the executor/);
    expect(trustProblem(w.o({ rootUid: uid + 1 }))).toMatch(/not root-owned/);
  });
  it('refuses group/other write on the root, inside repo.git, and on the tools or their directories', () => {
    for (const [target, re] of [['root', /group\/other writable/], ['repo', /group\/other writable/], ['head', /group\/other writable/], ['tsc', /not root-owned or is group\/other writable/], ['bin', /not root-owned or is group\/other writable/]] as const) {
      const w = world();
      const p = { root: w.root, repo: join(w.root, 'repo.git'), head: join(w.root, 'repo.git/HEAD'), tsc: w.tsc, bin: join(w.base, 'bin') }[target];
      chmodSync(p, target === 'head' ? 0o666 : 0o775);
      expect(trustProblem(w.o()), target).toMatch(re);
    }
  });
  it('refuses alternates, a symlink inside repo.git, a missing root and tools under /Users', () => {
    const w = world();
    writeFileSync(join(w.root, 'repo.git/objects/info/alternates'), '/Users/owner/repo/.git/objects\n', { mode: 0o644 });
    expect(trustProblem(w.o())).toMatch(/alternates/);
    const x = world();
    symlinkSync('/etc', join(x.root, 'repo.git/evil'));
    expect(trustProblem(x.o())).toMatch(/symlink/);
    expect(trustProblem({ ...x.o(), root: join(x.base, 'nope') })).toMatch(/does not exist/);
    expect(trustProblem(x.o({ tsc: '/Users/owner/tsc.js' }))).toMatch(/LW_CODE_TSC/);
  });
});

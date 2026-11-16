import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findForgeImagesFile } from './service.js';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) if (d.startsWith(join(tmpdir(), 'forge-find-'))) rmSync(d, { recursive: true, force: true }); });
const tree = (): { top: string; repo: string; from: string } => {
  const top = mkdtempSync(join(tmpdir(), 'forge-find-'));
  made.push(top);
  const repo = join(top, 'repo');
  const from = join(repo, 'dist', 'forge');
  mkdirSync(from, { recursive: true });
  writeFileSync(join(repo, 'package.json'), '{}');
  return { top, repo, from };
};
const put = (dir: string): void => { mkdirSync(join(dir, 'docker', 'forge'), { recursive: true }); writeFileSync(join(dir, 'docker', 'forge', 'images.json'), '{}'); };

describe('G2-FG-08: findForgeImagesFile never leaves the repo', () => {
  it('uses the repo\'s file when it exists', () => {
    const t = tree();
    put(t.repo);
    put(t.top);
    expect(findForgeImagesFile(undefined, t.from)).toBe(join(t.repo, 'docker', 'forge', 'images.json'));
  });
  it('stops at the directory that holds package.json: a file in an ancestor of the repo is NOT used; the answer is the repo\'s (missing) path', () => {
    const t = tree();
    put(t.top);
    expect(findForgeImagesFile(undefined, t.from)).toBe(join(t.repo, 'docker', 'forge', 'images.json'));
  });
  it('an explicit dir wins', () => {
    expect(findForgeImagesFile('/x')).toBe('/x/docker/forge/images.json');
  });
});

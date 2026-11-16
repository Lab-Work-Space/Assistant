import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Who owns what the executor runs and reads (Gate 2 G2SC-02). The executor is `_lwadmin`; the owner's uid must not be able to change its release
 * root, its bare repository, or the compiler and package manager it executes. Checked at boot and before every check and apply; any problem refuses.
 *   root, repo.git (recursively), releases/, bundles/, state.json: owned by the executor's uid, no group or other write bit, no symlinks inside repo.git,
 *   no alternates; tsc and npm (and every parent directory): owned by root, no group or other write bit, not under /Users.
 */
export interface TrustOptions { root: string; tsc: string; npm: string; uid?: number; rootUid?: number; /** Tests only: stop walking up at this directory (inclusive). Production walks to `/`. */ anchor?: string }
const writable = (mode: number): boolean => (mode & 0o022) !== 0;

function walk(dir: string, uid: number, problems: string[], depth = 0): void {
  if (depth > 12 || problems.length > 3) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) { problems.push(`a symlink inside the repository: ${p}`); continue; }
    if (st.uid !== uid || writable(st.mode)) problems.push(`${p} is not owned by the executor or is group/other writable`);
    if (st.isDirectory()) walk(p, uid, problems, depth + 1);
  }
}

export function trustProblem(o: TrustOptions): string | null {
  const uid = o.uid ?? (typeof process.getuid === 'function' ? process.getuid() : -1);
  const rootUid = o.rootUid ?? 0;
  const problems: string[] = [];
  const own = (p: string, required: boolean) => {
    if (!existsSync(p)) { if (required) problems.push(`${p} does not exist`); return; }
    const st = lstatSync(p);
    if (st.isSymbolicLink()) problems.push(`${p} is a symlink`);
    else if (st.uid !== uid || writable(st.mode)) problems.push(`${p} is not owned by the executor user or is group/other writable`);
  };
  own(o.root, true);
  own(join(o.root, 'releases'), false);
  own(join(o.root, 'bundles'), false);
  own(join(o.root, 'state.json'), false);
  const repo = join(o.root, 'repo.git');
  own(repo, true);
  if (existsSync(repo) && !lstatSync(repo).isSymbolicLink()) {
    if (existsSync(join(repo, 'objects', 'info', 'alternates'))) problems.push('the repository has alternates');
    walk(repo, uid, problems);
  }
  for (const [label, path] of [['LW_CODE_TSC', o.tsc], ['LW_CODE_NPM', o.npm]] as const) {
    let real: string;
    try { real = realpathSync(path); } catch { problems.push(`${label} does not exist`); continue; }
    if (real.startsWith('/Users/') || path.startsWith('/Users/')) problems.push(`${label} is under /Users`);
    for (let p = real; ; p = dirname(p)) {
      const st = lstatSync(p);
      if (st.uid !== rootUid || writable(st.mode)) { problems.push(`${label}: ${p} is not root-owned or is group/other writable`); break; }
      if (p === '/' || dirname(p) === p || p === o.anchor) break;
    }
  }
  return problems.length ? problems.slice(0, 3).join('; ') : null;
}

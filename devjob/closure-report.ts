import { closureChange, CLOSURE_ENTRIES } from './closure.js';
import { listTree, readBlobs, type GitPort } from './git.js';

/**
 * What changed in the executor's import closure between the installed commit and the one being installed (Gate 1 self-code X9, install side).
 * `executor-service.sh install` prints this, flags commits made by dev jobs (the fixed committer identity) and asks for a typed confirmation,
 * because the executor is root-owned at run time but a rebuild copies whatever the tree holds.
 */
export const DEVJOB_AUTHOR = 'devjob@assistant.invalid';
export interface ClosureReport { changed: string[]; devJobCommits: string[]; nothing: boolean }

export async function closureReport(git: GitPort, from: string, to: string): Promise<ClosureReport> {
  const code = (t: string[]) => t.filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts'));
  const [fa, ta] = await Promise.all([listTree(git, from), listTree(git, to)]);
  const [bf, hf] = await Promise.all([readBlobs(git, from, code(fa), 1024 * 1024), readBlobs(git, to, code(ta), 1024 * 1024)]);
  const [bp, hp] = await Promise.all([readBlobs(git, from, ['package-lock.json'], 16 * 1024 * 1024), readBlobs(git, to, ['package-lock.json'], 16 * 1024 * 1024)]);
  const lock = (s: string | null | undefined): unknown => { try { return s ? JSON.parse(s) : {}; } catch { return {}; } };
  const entries = CLOSURE_ENTRIES.filter((e) => bf.files.get(e) != null || hf.files.get(e) != null);
  const r = closureChange(entries, { read: (p) => bf.files.get(p) ?? null, lock: lock(bp.files.get('package-lock.json')) }, { read: (p) => hf.files.get(p) ?? null, lock: lock(hp.files.get('package-lock.json')) });
  const log = (await git.run(['log', '--format=%H %ae %s', `${from}..${to}`])).toString('utf8').split('\n').filter(Boolean);
  const devJobCommits = log.filter((l) => l.split(' ')[1] === DEVJOB_AUTHOR).map((l) => l.slice(0, 80));
  return { changed: r.refusals, devJobCommits, nothing: r.refusals.length === 0 };
}

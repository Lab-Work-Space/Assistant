import type { GitPort } from '../devjob/git.js';

/**
 * Bringing the owner's commits into the executor's bare repository (Gate 2 G2SC-02). The owner NEVER pushes into `repo.git`: it is owned by the
 * executor user. The owner hands over a bundle of `main`; `executor-service.sh import` copies it into the executor's directory and the executor
 * (as itself) verifies it, lists the incoming commits, asks for a typed confirmation, and moves `main` with compare-and-swap, fast-forward only.
 */
export interface ImportPlan { ok: true; head: string; current: string | null; commits: string[] }
export type ImportResult = ImportPlan | { ok: false; why: string };

export async function planImport(git: GitPort, bundlePath: string): Promise<ImportResult> {
  const text = async (...a: string[]) => (await git.run(a)).toString('utf8').trim();
  const current = (await text('rev-parse', '--verify', '-q', 'refs/heads/main').catch(() => '')) || null;
  try {
    await git.run(['bundle', 'verify', bundlePath]);
  } catch {
    // a bundle with no prerequisites verifies anywhere; a failing verify means missing history
    return { ok: false, why: 'git bundle verify failed (the bundle needs history the executor does not have)' };
  }
  const heads = (await text('bundle', 'list-heads', bundlePath)).split('\n').filter(Boolean);
  const m = heads.length === 1 ? /^([0-9a-f]{40}) refs\/heads\/main$/.exec(heads[0]!) : null;
  if (!m) return { ok: false, why: 'the bundle must contain exactly one head, refs/heads/main' };
  const head = m[1]!;
  try {
    await git.run(['bundle', 'unbundle', bundlePath]);
  } catch {
    return { ok: false, why: 'the bundle could not be unpacked' };
  }
  if (current) {
    if (current === head) return { ok: false, why: 'main is already at that commit' };
    const ff = await git.run(['merge-base', '--is-ancestor', current, head]).then(() => true, () => false);
    if (!ff) return { ok: false, why: 'not a fast-forward of the executor main' };
  }
  const range = current ? `${current}..${head}` : head;
  const commits = (await text('log', '--reverse', '--format=%h %an <%ae> %s', '-n', '200', range)).split('\n').filter(Boolean);
  return { ok: true, head, current, commits };
}

/** Moves main only from the commit that was planned (compare-and-swap). */
export async function applyImport(git: GitPort, plan: ImportPlan): Promise<void> {
  await git.run(plan.current ? ['update-ref', 'refs/heads/main', plan.head, plan.current] : ['update-ref', 'refs/heads/main', plan.head, '']);
}

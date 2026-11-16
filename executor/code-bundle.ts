import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { GitPort } from '../devjob/git.js';

/**
 * Bundle intake and verification inside the executor's OWN bare repository (Gate 1 self-code X16). The bundle bytes come from the database
 * (written by the main application) and are data to check: copied into the executor's directory (O_NOFOLLOW, O_EXCL, a regular file, a size cap),
 * hashed, and only then handed to git, run with hooks, protocols and every config file off. Git never runs inside a directory a sandbox produced.
 */
export const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const JOB = /^J-[0-9a-f]{16}$/;

export function intakeBundle(dir: string, jobId: string, data: Buffer): { path: string; sha256: string } {
  if (!JOB.test(jobId)) throw new Error('bad job id');
  if (data.length === 0 || data.length > MAX_BUNDLE_BYTES) throw new Error('the bundle is empty or above the size cap');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('the bundle directory is not a real directory');
  const sha256 = createHash('sha256').update(data).digest('hex');
  const path = join(dir, `${jobId}-${sha256.slice(0, 16)}-${randomBytes(4).toString('hex')}.bundle`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  return { path, sha256 };
}

export type Verified = { ok: true; commits: number } | { ok: false; why: string };

/** Everything X16 lists under "Checks", in order; the first failure refuses. */
export async function verifyBundle(git: GitPort, o: { bundlePath: string; jobId: string; base: string; head: string }): Promise<Verified> {
  if (!SHA.test(o.base) || !SHA.test(o.head) || !JOB.test(o.jobId)) return { ok: false, why: 'malformed ids' };
  const text = async (...a: string[]) => (await git.run(a)).toString('utf8').trim();
  const main = await text('rev-parse', '--verify', '-q', 'refs/heads/main').catch(() => '');
  if (main !== o.base) return { ok: false, why: 'the base is not the executor\'s current main (the job must be run again)' };
  try {
    await git.run(['bundle', 'verify', o.bundlePath]);
  } catch {
    return { ok: false, why: 'git bundle verify failed' };
  }
  const heads = (await text('bundle', 'list-heads', o.bundlePath)).split('\n').filter(Boolean);
  if (heads.length !== 1) return { ok: false, why: `the bundle has ${heads.length} heads (exactly one allowed)` };
  const m = /^([0-9a-f]{40}) refs\/heads\/[A-Za-z0-9._/-]{1,60}$/.exec(heads[0]!);
  if (!m || m[1] !== o.head) return { ok: false, why: 'the bundle head is not the head that was confirmed' };
  try {
    await git.run(['bundle', 'unbundle', o.bundlePath]);
  } catch {
    return { ok: false, why: 'the bundle could not be unpacked' };
  }
  const has = await git.run(['cat-file', '-e', `${o.head}^{commit}`]).then(() => true, () => false);
  if (!has) return { ok: false, why: 'the head commit is not in the bundle' };
  const desc = await git.run(['merge-base', '--is-ancestor', o.base, o.head]).then(() => true, () => false);
  if (!desc) return { ok: false, why: 'the head does not descend from the base' };
  await git.run(['update-ref', `refs/jobs/${o.jobId}`, o.head]);
  return { ok: true, commits: Number(await text('rev-list', '--count', `${o.base}..${o.head}`)) };
}

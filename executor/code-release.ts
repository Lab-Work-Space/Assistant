import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GitPort } from '../devjob/git.js';

/**
 * Release directories (Gate 1 self-code OD-2a, X16b, X18). A release is built by the executor from its OWN verified checkout of the confirmed head
 * sha: `git archive` into a staging directory, `npm ci --ignore-scripts` from the verified lockfile and a root-owned pinned `tsc` with the base
 * tsconfig. No test, no package.json script and no project code runs here. The release records the head sha and the tree hash; the running
 * application reports that sha on /healthz and the executor compares them.
 *
 *   <root>/releases/<head>/{dist,node_modules,package.json,release.json}   read-only
 *   <root>/current -> releases/<head>                                      only the executor switches it
 */
export interface BuildPorts {
  /** Unpacks the tree of `head` into `dir` (an empty directory). */
  extract(git: GitPort, head: string, dir: string): Promise<void>;
  /** `npm ci --ignore-scripts` in `dir`. */
  install(dir: string): Promise<void>;
  /** The pinned compiler with the tree's own tsconfig.build.json; writes `dir/dist`. */
  compile(dir: string): Promise<void>;
}

/** What `npm run build` copies besides compiled code. The executor cannot run that script, so the list is fixed here. */
export const RUNTIME_COPIES: readonly { from: string; to: string }[] = [
  { from: 'db/migrations', to: 'dist/db/migrations' },
  { from: 'prompts/system', to: 'dist/prompts/system' },
  { from: 'prompts/heads', to: 'dist/prompts/heads' },
  { from: 'prompts/members', to: 'dist/prompts/members' },
  { from: 'prompts/fragments', to: 'dist/prompts/fragments' },
  { from: 'tools/plugins/github/deploy-repos.json', to: 'dist/tools/plugins/github/deploy-repos.json' },
];

export function copyRuntimeFiles(dir: string): void {
  for (const c of RUNTIME_COPIES) {
    const src = join(dir, c.from);
    if (!existsSync(src)) continue;
    if (lstatSync(src).isSymbolicLink()) throw new Error(`refusing a symlink at ${c.from}`);
    mkdirSync(dirname(join(dir, c.to)), { recursive: true });
    cpSync(src, join(dir, c.to), { recursive: true, dereference: false, verbatimSymlinks: true });
  }
}

/** A tree with any symlink in it is refused (the diff checks already refuse them; this is the second line). */
export function assertNoSymlinks(dir: string): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error(`a symlink in the release tree: ${e.name}`);
    if (e.isDirectory() && e.name !== 'node_modules') assertNoSymlinks(p);
  }
}

const chmodTree = (dir: string, mode: (dir: boolean) => number): void => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) chmodTree(p, mode);
    else chmodSync(p, mode(false));
  }
  chmodSync(dir, mode(true));
};
export const makeReadOnly = (dir: string): void => chmodTree(dir, (isDir) => (isDir ? 0o555 : 0o444));
export const makeWritable = (dir: string): void => chmodTree(dir, (isDir) => (isDir ? 0o755 : 0o644));

export interface ReleaseInfo { head: string; tree: string; builtAt: string }
export const releasesDir = (root: string): string => join(root, 'releases');
export const releaseDir = (root: string, head: string): string => join(releasesDir(root), head);

/** Builds `releases/<head>` and returns its directory. Nothing is switched. */
export async function buildRelease(o: { git: GitPort; head: string; root: string; ports: BuildPorts; now?: () => Date }): Promise<{ dir: string; tree: string }> {
  if (!/^[0-9a-f]{40}$/.test(o.head)) throw new Error('head must be a full commit id');
  const tree = (await o.git.run(['rev-parse', `${o.head}^{tree}`])).toString('utf8').trim();
  const staging = join(o.root, 'staging', o.head);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  mkdirSync(releasesDir(o.root), { recursive: true });
  try {
    await o.ports.extract(o.git, o.head, staging);
    assertNoSymlinks(staging);
    await o.ports.install(staging);
    await o.ports.compile(staging);
    if (!existsSync(join(staging, 'dist', 'main.js'))) throw new Error('the build produced no dist/main.js');
    copyRuntimeFiles(staging);
    // Only what the application needs at run time goes into the release.
    const dest = releaseDir(o.root, o.head);
    if (existsSync(dest)) { makeWritable(dest); rmSync(dest, { recursive: true, force: true }); }
    mkdirSync(dest, { mode: 0o755 });
    for (const n of ['dist', 'node_modules', 'package.json']) if (existsSync(join(staging, n))) renameSync(join(staging, n), join(dest, n));
    const info: ReleaseInfo = { head: o.head, tree, builtAt: (o.now?.() ?? new Date()).toISOString() };
    writeFileSync(join(dest, 'release.json'), JSON.stringify(info));
    makeReadOnly(dest);
    return { dir: dest, tree };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Atomic switch: a new link beside `current`, then a rename over it. */
export function switchCurrent(root: string, head: string): void {
  const target = releaseDir(root, head);
  if (!existsSync(join(target, 'release.json'))) throw new Error('that release does not exist');
  const tmp = join(root, `.current-${process.pid}-${Date.now()}`);
  symlinkSync(target, tmp);
  renameSync(tmp, join(root, 'current'));
}

/** The head of the release `current` points at, or null. */
export function currentHead(root: string): string | null {
  try {
    const link = readlinkSync(join(root, 'current'));
    const h = link.split('/').pop() ?? '';
    return /^[0-9a-f]{40}$/.test(h) ? h : null;
  } catch {
    return null;
  }
}

/** Deletes old releases, keeping `keep` heads (the running one and the rollback point are always kept). */
export function pruneReleases(root: string, keep: readonly string[], max = 5): string[] {
  const dir = releasesDir(root);
  if (!existsSync(dir)) return [];
  const all = readdirSync(dir).filter((n) => /^[0-9a-f]{40}$/.test(n)).map((n) => ({ n, t: lstatSync(join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t);
  const gone: string[] = [];
  for (const r of all.slice(max)) {
    if (keep.includes(r.n)) continue;
    makeWritable(join(dir, r.n));
    rmSync(join(dir, r.n), { recursive: true, force: true });
    gone.push(r.n);
  }
  return gone;
}

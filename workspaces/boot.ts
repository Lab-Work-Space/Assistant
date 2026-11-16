import { chmod, lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IMAGE_ID, removeVerified, type DockerCli } from './runner.js';

/**
 * WS-1 boot (SA-1 3.1, Gate 1 WS-C5, WS-C13): the checks on WS_ROOT, before anything else in ws is built. This file holds the
 * filesystem part; WS-BE2 adds the Docker checks and the container sweep to the same function. Every refusal is a fixed reason
 * (no path, no errno text): it reaches the tool-groups alert and the model.
 */
export type WsBoot = { ok: true; root: string; /** The verified runner image id (set when the Docker checks ran). */ runner?: string } | { ok: false; reason: string; /** WS_ROOT was set explicitly: the alert marks the group as failed, not just unconfigured. */ failed: boolean };

export type WsBootOpts = {
  /** WS_ROOT from env (absolute); unset: `<home>/.config/assistant/workspaces`. */
  wsRoot?: string;
  /** Home directories to protect: the HOME env value and the passwd home (they can differ). Default: both. */
  homes?: string[];
  cwd?: string;
  /** The resolved Praw workspace root (app.ts DEFAULT_WORKSPACE_DIR resolved against cwd). */
  prawRoot: string;
  /** EXECUTOR_SOCKET path: its directory is protected (Docker Desktop forwards unix sockets over bind mounts). */
  executorSocket?: string;
  uid?: number;
  timeoutMs?: number;
  /**
   * The Docker checks and the container sweep (SA-1 3.1, WS-C13) run only when this is set (app.ts always sets it; the file-system tests of
   * WS_ROOT placement leave it out so no unit test calls a real Docker). With it, any failure leaves ws disabled.
   */
  docker?: DockerCli;
  /** Directory that holds docker/ws/images.json. Default: the nearest ancestor of this file that has it (works from src and from dist). */
  imagesDir?: string;
};

const ROOT_RE = /^\/[A-Za-z0-9._/-]{1,200}$/;
const code = (e: unknown) => (e as { code?: string }).code;

/** realpath of a path that may not exist yet: the real path of its nearest existing ancestor plus the missing tail. */
export async function realish(p: string): Promise<string> {
  const abs = resolve(p);
  try {
    return await realpath(abs);
  } catch (e) {
    if (code(e) !== 'ENOENT' && code(e) !== 'ENOTDIR') throw e;
    const parent = dirname(abs);
    if (parent === abs) return abs;
    return join(await realish(parent), basename(abs));
  }
}

/** a equals b, or a is an ancestor of b. */
const covers = (a: string, b: string) => a === b || a === sep || b.startsWith(a + sep);

async function protectedDirs(o: WsBootOpts, homes: string[], cwd: string): Promise<{ never: string[]; outside: string[] }> {
  const never: string[] = [];
  const outside: string[] = [];
  const add = async (list: string[], p: string) => void list.push(await realish(p));
  for (const h of homes) {
    for (const rel of ['', '.config', '.config/assistant', '.config/assistant/media', '.config/assistant/backups']) await add(never, join(h, rel));
    await add(outside, join(h, '.claude'));
    await add(never, join(h, '.claude'));
  }
  if (o.executorSocket) await add(never, dirname(o.executorSocket));
  for (const p of [cwd, o.prawRoot]) {
    await add(never, p);
    await add(outside, p);
  }
  return { never, outside };
}

async function bootFs(o: WsBootOpts): Promise<WsBoot> {
  const failed = o.wsRoot !== undefined;
  const no = (reason: string): WsBoot => ({ ok: false, reason, failed });
  const uid = o.uid ?? process.getuid?.() ?? -1;
  if (uid === 0 || uid < 0) return no('workspaces do not run as root (uid 0)');
  const homes = [...new Set((o.homes ?? [process.env.HOME, userInfo().homedir]).filter((h): h is string => typeof h === 'string' && h.startsWith('/')))];
  if (homes.length === 0) return no('no home directory');
  const cwd = await realish(o.cwd ?? process.cwd());
  const want = o.wsRoot ?? join(process.env.HOME && process.env.HOME.startsWith('/') ? process.env.HOME : homes[0]!, '.config', 'assistant', 'workspaces');
  if (!want.startsWith('/') || want.includes('\0')) return no('workspace root must be an absolute path');

  // The root entry itself must not be a symlink (checked before realpath follows it).
  const lexical = resolve(want);
  const first = await lstat(lexical).catch((e) => { if (code(e) === 'ENOENT' || code(e) === 'ENOTDIR') return null; throw e; });
  if (first?.isSymbolicLink()) return no('workspace root is a symlink');

  const prot = await protectedDirs(o, homes, cwd);
  const placement = (real: string): string | null => {
    for (const n of prot.never) if (covers(real, n)) return 'workspace root is, or contains, a protected directory';
    for (const n of prot.outside) if (covers(n, real)) return 'workspace root is inside a protected directory';
    return null;
  };
  // Judged before anything is created, on the real path of the nearest existing ancestor plus the rest.
  const planned = await realish(lexical);
  const bad = placement(planned);
  if (bad) return no(bad);
  if (!ROOT_RE.test(planned)) return no('workspace root path uses characters that are not allowed');

  try {
    await mkdir(planned, { recursive: true, mode: 0o700 });
  } catch {
    return no('workspace root could not be created');
  }
  const real = await realpath(planned);
  const again = placement(real);
  if (again) return no(again);
  if (!ROOT_RE.test(real)) return no('workspace root path uses characters that are not allowed');
  const st = await lstat(real);
  if (st.isSymbolicLink() || !st.isDirectory()) return no('workspace root is not a directory');
  if (st.uid !== uid) return no('workspace root is not owned by the app user');
  for (let d = real; ; d = dirname(d)) {
    if (await lstat(join(d, '.git')).then(() => true, () => false)) return no('workspace root is inside a git repository');
    if (dirname(d) === d) break;
  }
  if ((st.mode & 0o777) !== 0o700) {
    try {
      await chmod(real, 0o700);
    } catch {
      return no('workspace root mode could not be set to 0700');
    }
  }
  return { ok: true, root: real };
}

async function findImagesFile(dir?: string): Promise<string> {
  if (dir) return join(dir, 'docker', 'ws', 'images.json');
  for (let d = dirname(fileURLToPath(import.meta.url)); ; d = dirname(d)) {
    const f = join(d, 'docker', 'ws', 'images.json');
    if (await lstat(f).then(() => true, () => false)) return f;
    if (dirname(d) === d) return join(process.cwd(), 'docker', 'ws', 'images.json');
  }
}

/**
 * Docker version (10 s), the runner image id against docker/ws/images.json, then the sweep: every `label=ws=1` container is removed and a second
 * `docker ps` must show none (a failed sweep never leaves the group enabled). Reasons are fixed text; docker output never reaches them.
 */
async function bootDocker(d: DockerCli, fs: Extract<WsBoot, { ok: true }>, o: WsBootOpts): Promise<WsBoot> {
  const failedUnset = o.wsRoot !== undefined;
  const v = await d.exec(['version', '--format', '{{.Server.Version}}'], 10_000);
  if (v.code !== 0 || v.timedOut || v.stdout.trim() === '') return { ok: false, reason: v.missing ? 'the docker CLI is not installed' : 'docker is not reachable', failed: failedUnset };
  let runner: string;
  try {
    const j = JSON.parse(await readFile(await findImagesFile(o.imagesDir), 'utf8')) as { runner?: unknown };
    if (typeof j.runner !== 'string' || !IMAGE_ID.test(j.runner)) throw new Error('bad');
    runner = j.runner;
  } catch {
    return { ok: false, reason: 'docker/ws/images.json is missing or invalid (run bash docker/ws/build.sh)', failed: true };
  }
  const img = await d.exec(['image', 'inspect', '--format', '{{.Id}}', runner], 10_000);
  if (img.code !== 0 || img.stdout.trim() !== runner) return { ok: false, reason: 'the runner image is missing or does not match images.json (run bash docker/ws/build.sh)', failed: true };
  const ps = await d.exec(['ps', '-aq', '--filter', 'label=ws=1'], 15_000);
  if (ps.code !== 0) return { ok: false, reason: 'the container sweep failed', failed: true };
  for (const id of ps.stdout.split('\n').map((x) => x.trim()).filter(Boolean)) {
    if (!/^[0-9a-f]{12,64}$/.test(id) || !(await removeVerified(d, id))) return { ok: false, reason: 'the container sweep failed', failed: true };
  }
  const again = await d.exec(['ps', '-aq', '--filter', 'label=ws=1'], 15_000);
  if (again.code !== 0 || again.stdout.trim() !== '') return { ok: false, reason: 'the container sweep failed', failed: true };
  return { ...fs, runner };
}

/** Never throws; a hang or an error leaves ws disabled with a fixed reason (20 s overall, as SA-1 3.1). */
export async function bootWorkspaces(o: WsBootOpts): Promise<WsBoot> {
  const failed = o.wsRoot !== undefined;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<WsBoot>((r) => {
    timer = setTimeout(() => r({ ok: false, reason: 'workspace boot timed out', failed }), o.timeoutMs ?? 20_000);
    timer.unref();
  });
  try {
    return await Promise.race([bootFs(o).then((r) => (r.ok && o.docker ? bootDocker(o.docker, r, o) : r)), timeout]);
  } catch {
    return { ok: false, reason: 'workspace root could not be checked', failed };
  } finally {
    clearTimeout(timer);
  }
}

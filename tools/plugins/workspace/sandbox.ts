import { randomBytes } from 'node:crypto';
import { constants as C, type Stats } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readdir, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/**
 * Praw's workspace sandbox (Gate 1 P18, AC8). Every path is relative to one root directory and validated lexically
 * first; then each directory component is lstat'ed and opened with O_DIRECTORY|O_NOFOLLOW (a symlink or non-directory is
 * refused), the final file is opened with O_NOFOLLOW, fstat must show a regular file with nlink 1, and every component is
 * re-lstat'ed afterwards and must still be the same directory (dev/ino). New files are written through an
 * O_CREAT|O_EXCL|O_NOFOLLOW temp file in the target directory, then linked (no clobber) or renamed into place.
 *
 * Residual TOCTOU: Node has no openat(), so the checks are path based. A component swapped for a symlink and swapped back
 * entirely between the open and the re-check is not detected (and a write's temp file may briefly land behind it). No
 * tool can create a symlink, hard link or rename a directory, so this needs write access to the volume from outside the
 * tool surface. There is no approval path out of the sandbox: escaping it is refused, never asked.
 */
export const LIMITS = { fileBytes: 1_048_576, totalBytes: 50 * 1_048_576, files: 500, depth: 6, relLength: 120 } as const;
export type Quota = { fileBytes: number; totalBytes: number; files: number };
/** Reserved for in-flight writes: refused in paths and hidden from listings. */
export const TMP_PREFIX = '.praw-tmp-';
const SEGMENT = /^[\w.\- ]+$/; // ASCII only (no `u` flag)
const LIST_MAX = 200;

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

/**
 * WS-1 (SA-1 C12): per-caller path limits. Defaults are Praw's (depth 6, 120 characters, `.praw-tmp-`), so existing callers are unchanged.
 * ws uses depth 12, 240 characters and its own reserved prefix `.ws-tmp-`.
 */
export type PathOpts = { depth?: number; relLength?: number; tmpPrefix?: string };

/** Lexical check: relative, no `.`/`..`/empty segment, no NUL, `[\w.\- ]` per segment, depth ≤ 6, length ≤ 120 (or the limits in `o`). The reserved prefix is matched case-insensitively (APFS). */
export function validateRel(rel: string, o: PathOpts = {}): string[] {
  const maxLen = o.relLength ?? LIMITS.relLength;
  const maxDepth = o.depth ?? LIMITS.depth;
  const reserved = (o.tmpPrefix ?? TMP_PREFIX).toLowerCase();
  if (typeof rel !== 'string' || rel.length === 0) throw new SandboxError('a path is required');
  if (rel.length > maxLen) throw new SandboxError(`path is too long (at most ${maxLen} characters)`);
  if (rel.includes('\0')) throw new SandboxError('path contains NUL');
  if (rel.startsWith('/')) throw new SandboxError('absolute paths are refused; use a path inside the workspace');
  const segs = rel.split('/');
  if (segs.length > maxDepth) throw new SandboxError(`path depth is at most ${maxDepth}`);
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') throw new SandboxError('path segments must not be empty, "." or ".."');
    if (!SEGMENT.test(s)) throw new SandboxError('path segments may only use letters, digits, "_", "-", "." and spaces');
    if (s.toLowerCase().startsWith(reserved)) throw new SandboxError('that name is reserved');
  }
  return segs;
}

type Hooks = { afterCheck?: () => void | Promise<void> };
export type Link = { path: string; st: Stats };
export const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;
export const code = (e: unknown) => (e as { code?: string }).code;

export async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await lstat(p);
  } catch (e) {
    if (code(e) === 'ENOENT') return null;
    if (code(e) === 'ENOTDIR') throw new SandboxError('a path component is not a directory');
    throw e;
  }
}

/** Creates the root (0700) when missing and returns its real path; the root itself must be a real directory. */
async function realRoot(root: string): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const real = await realpath(root);
  const st = await lstat(real);
  if (!st.isDirectory()) throw new SandboxError('workspace root is not a directory');
  if ((st.mode & 0o777) !== 0o700) await chmod(real, 0o700); // umask may have widened mkdir's mode
  return real;
}

/** lstat + O_DIRECTORY|O_NOFOLLOW open of each component below the root; `create` makes missing ones (0700). */
export async function walk(root: string, dirs: string[], create: boolean): Promise<Link[]> {
  const chain: Link[] = [{ path: root, st: await lstat(root) }];
  let cur = root;
  for (const seg of dirs) {
    const p = join(cur, seg);
    let st = await lstatOrNull(p);
    if (!st && create) {
      await mkdir(p, { mode: 0o700 }).catch((e) => { if (code(e) !== 'EEXIST') throw e; });
      st = await lstat(p);
    }
    if (!st) throw new SandboxError('no such directory');
    if (st.isSymbolicLink() || !st.isDirectory()) throw new SandboxError('a path component is a symlink or not a directory');
    const fh = await open(p, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW).catch(() => { throw new SandboxError('a path component is a symlink or not a directory'); });
    try {
      if (!same(await fh.stat(), st)) throw new SandboxError('a path component changed during the check');
    } finally {
      await fh.close();
    }
    chain.push({ path: p, st });
    cur = p;
  }
  return chain;
}

/** Every component must still be the same real directory. */
export async function recheck(chain: Link[]): Promise<void> {
  for (const l of chain) {
    const now = await lstatOrNull(l.path);
    if (!now || now.isSymbolicLink() || !now.isDirectory() || !same(now, l.st)) throw new SandboxError('a path component changed during the operation');
  }
}

export function checkFile(st: Stats, rootSt: Stats): void {
  if (!st.isFile()) throw new SandboxError('not a regular file');
  if (st.nlink !== 1) throw new SandboxError('hard-linked files are refused');
  if (st.dev !== rootSt.dev) throw new SandboxError('file is not on the workspace volume');
}

export type ReadHandle = { fh: FileHandle; size: number };
export type WriteHandle = { fh: FileHandle; commit(overwrite: boolean): Promise<void>; abort(): Promise<void> };

/**
 * Opens `rel` inside `root`. 'r' returns a checked read handle; 'w' returns a fresh temp file in the target directory
 * (written through the handle) whose `commit` links (no clobber) or renames it into place.
 */
export async function openInWorkspace(root: string, rel: string, mode: 'r', hooks?: Hooks, o?: PathOpts): Promise<ReadHandle>;
export async function openInWorkspace(root: string, rel: string, mode: 'w', hooks?: Hooks, o?: PathOpts): Promise<WriteHandle>;
export async function openInWorkspace(root: string, rel: string, mode: 'r' | 'w', hooks: Hooks = {}, o: PathOpts = {}): Promise<ReadHandle | WriteHandle> {
  const segs = validateRel(rel, o);
  const real = await realRoot(root);
  const name = segs.at(-1)!;
  const chain = await walk(real, segs.slice(0, -1), mode === 'w');
  const dir = chain.at(-1)!.path;
  const target = join(dir, name);
  await hooks.afterCheck?.();
  if (mode === 'r') {
    const fh = await open(target, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK).catch((e) => {
      throw new SandboxError(code(e) === 'ENOENT' ? 'no such file' : code(e) === 'ELOOP' ? 'symlinks are refused' : 'the file cannot be opened');
    });
    try {
      const st = await fh.stat();
      checkFile(st, chain[0]!.st);
      await recheck(chain);
      const now = await lstatOrNull(target);
      if (!now || !same(now, st)) throw new SandboxError('the file changed during the check');
      return { fh, size: st.size };
    } catch (e) {
      await fh.close();
      throw e;
    }
  }
  const tmp = join(dir, `${o.tmpPrefix ?? TMP_PREFIX}${randomBytes(8).toString('hex')}`);
  const fh = await open(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
  const drop = async () => {
    await fh.close().catch(() => {});
    await unlink(tmp).catch(() => {});
  };
  try {
    checkFile(await fh.stat(), chain[0]!.st);
    await recheck(chain);
  } catch (e) {
    await drop();
    throw e;
  }
  return {
    fh,
    abort: drop,
    async commit(overwrite) {
      try {
        await fh.sync();
        await fh.close();
        await recheck(chain);
        if (!overwrite) {
          await link(tmp, target).catch((e) => { throw code(e) === 'EEXIST' ? new SandboxError('the file exists; set overwrite to replace it') : e; });
          await unlink(tmp);
          return;
        }
        const old = await lstatOrNull(target);
        if (old) checkFile(old, chain[0]!.st);
        await rename(tmp, target);
      } catch (e) {
        await drop();
        throw e;
      }
    },
  };
}

export type Entry = { name: string; kind: 'file' | 'dir' | 'other'; size: number };
export type ReadResult = { text: string; size: number; truncated: boolean; binary: boolean };

/** The tools' view of one workspace root. Writes are serialised so concurrent runs cannot both pass the quota. */
export class Workspace {
  private lock: Promise<unknown> = Promise.resolve();
  private readonly quota: Quota;

  constructor(private readonly root: string, private readonly opts: Hooks & { limits?: Partial<Quota> } = {}) {
    this.quota = { fileBytes: LIMITS.fileBytes, totalBytes: LIMITS.totalBytes, files: LIMITS.files, ...opts.limits };
  }

  async list(rel = ''): Promise<Entry[]> {
    const real = await realRoot(this.root);
    const chain = await walk(real, rel === '' ? [] : validateRel(rel), false);
    const dir = chain.at(-1)!.path;
    const names = (await readdir(dir)).filter((n) => !n.startsWith(TMP_PREFIX)).sort().slice(0, LIST_MAX);
    await recheck(chain);
    const out: Entry[] = [];
    for (const name of names) {
      const st = await lstatOrNull(join(dir, name));
      if (!st) continue;
      out.push({ name, kind: st.isSymbolicLink() ? 'other' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other', size: st.isFile() ? st.size : 0 });
    }
    return out;
  }

  /** Reads at most `maxBytes`; a cut never splits a UTF-8 character. NUL bytes mark the file binary (no text). */
  async read(rel: string, maxBytes: number = LIMITS.fileBytes): Promise<ReadResult> {
    const { fh, size } = await openInWorkspace(this.root, rel, 'r', this.opts);
    try {
      const buf = Buffer.alloc(Math.min(size, maxBytes));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const bytes = buf.subarray(0, bytesRead);
      if (bytes.includes(0)) return { text: '', size, truncated: size > bytesRead, binary: true };
      return { text: new StringDecoder('utf8').write(bytes), size, truncated: size > bytesRead, binary: false };
    } finally {
      await fh.close();
    }
  }

  /** `content` may be bytes (a generated PDF); a string is written as UTF-8. Every sandbox check applies to both. */
  async write(rel: string, content: string | Buffer, overwrite: boolean): Promise<{ bytes: number; created: boolean }> {
    const run = this.lock.then(() => this.writeNow(rel, content, overwrite));
    this.lock = run.catch(() => {});
    return run;
  }

  /** Regular files and their bytes under the root (symlinks are not followed and count as nothing). */
  async usage(): Promise<{ bytes: number; files: number }> {
    const real = await realRoot(this.root);
    let bytes = 0;
    let files = 0;
    const visit = async (dir: string, depth: number): Promise<void> => {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory() && depth < LIMITS.depth + 1) await visit(p, depth + 1);
        else if (e.isFile()) {
          const st = await lstatOrNull(p);
          bytes += st?.size ?? 0;
          if (!e.name.startsWith(TMP_PREFIX)) files++;
        }
      }
    };
    await visit(real, 0);
    return { bytes, files };
  }

  private async writeNow(rel: string, content: string | Buffer, overwrite: boolean): Promise<{ bytes: number; created: boolean }> {
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    if (data.length > this.quota.fileBytes) throw new SandboxError(`a file is at most ${this.quota.fileBytes} bytes`);
    const segs = validateRel(rel);
    const real = await realRoot(this.root);
    const old = await lstatOrNull(join(real, ...segs));
    const replacing = old?.isFile() === true && overwrite;
    const use = await this.usage();
    if (use.bytes - (replacing ? old!.size : 0) + data.length > this.quota.totalBytes) throw new SandboxError(`the workspace is full (at most ${this.quota.totalBytes} bytes in total)`);
    if (!old && use.files + 1 > this.quota.files) throw new SandboxError(`the workspace holds at most ${this.quota.files} files`);
    const w = await openInWorkspace(this.root, rel, 'w', this.opts);
    try {
      await w.fh.write(data, 0, data.length, 0);
    } catch (e) {
      await w.abort();
      throw e;
    }
    await w.commit(overwrite);
    return { bytes: data.length, created: !old };
  }
}

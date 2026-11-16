import { lstat, opendir, rm, rmdir, unlink } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { SandboxError, lstatOrNull, openInWorkspace, recheck, same, validateRel, walk, type PathOpts } from '../tools/plugins/workspace/sandbox.js';
import { WsError } from './errors.js';

/**
 * WS-1 host-side file access for one workspace (SA-1 5.1, Gate 1 WS-C6 to WS-C9). A container can plant any symlink, hard link, FIFO or
 * very deep or very large tree in the bind mount, so nothing here follows a symlink: every open goes through the sandbox's no-follow
 * chain (lstat + O_DIRECTORY|O_NOFOLLOW per component, O_NOFOLLOW leaf, regular file, nlink 1, dev/ino re-check), every walk streams
 * with opendir over lstat'ed directories, and every walk stops at an entry and time budget (over budget counts as over quota).
 */
export const WS_TMP = '.ws-tmp-';
export const PATH_OPTS: Required<PathOpts> = { depth: 12, relLength: 240, tmpPrefix: WS_TMP };
export const WS_LIMITS = {
  bytes: 314_572_800,
  files: 2000,
  nmBytes: 1_073_741_824,
  writeBytes: 204_800,
  readMax: 65_536,
  listMax: 500,
  entryBudget: 200_000,
  timeBudgetMs: 20_000,
} as const;
export const EXPORT_FILE_MAX = 5_000_000;
export const EXPORT_MAX_FILES = 2000;
export const SLUG_RE = /^[a-z][a-z0-9-]{1,39}$/;

/** Lexical path check with the ws limits; throws a SandboxError with a fixed message. */
export const wsRel = (p: string): string[] => validateRel(p, PATH_OPTS);

export type Usage = {
  /** Bytes of every non-node_modules file (temp files included, any depth). */
  bytes: number;
  /** Non-directory entries outside node_modules. */
  files: number;
  /** Bytes under the top-level node_modules. */
  nmBytes: number;
  /** The entry or time budget was hit: the workspace counts as over quota. */
  over: boolean;
};
export type FileEntry = { name: string; kind: 'file' | 'dir' | 'other'; size: number };
export type ReadWindow = { text: string; binary: boolean; from: number; to: number; size: number };
export type ExportList = { files: { rel: string; size: number }[]; skipped: number };
export type FilesOpts = { entryBudget?: number; timeBudgetMs?: number; now?: () => number; afterCheck?: () => void | Promise<void> };

const isTmp = (name: string) => name.toLowerCase().startsWith(WS_TMP);
const NPMRC = '.npmrc';
const code = (e: unknown) => (e as { code?: string }).code;

export class ProjectFiles {
  private readonly entryBudget: number;
  private readonly timeBudgetMs: number;
  private readonly now: () => number;

  constructor(private readonly root: string, private readonly opts: FilesOpts = {}) {
    this.entryBudget = opts.entryBudget ?? WS_LIMITS.entryBudget;
    this.timeBudgetMs = opts.timeBudgetMs ?? WS_LIMITS.timeBudgetMs;
    this.now = opts.now ?? Date.now;
  }

  /** The workspace directory: it must be a real directory (not a symlink) under the root. Returns its path and stat (dev/ino for the mount check). */
  async rootDir(slug: string): Promise<{ path: string; st: Stats }> {
    if (!SLUG_RE.test(slug)) throw new SandboxError('no such workspace');
    const path = join(this.root, slug);
    const st = await lstat(path).catch((e) => { throw code(e) === 'ENOENT' ? new WsError('E_IO') : e; });
    if (st.isSymbolicLink() || !st.isDirectory()) throw new SandboxError('the workspace folder is not a real directory');
    return { path, st };
  }

  /** Streams the whole tree (no depth limit) and counts. Never follows a symlink; hits the budget -> `over`. */
  async usage(slug: string): Promise<Usage> {
    const { path } = await this.rootDir(slug);
    const u: Usage = { bytes: 0, files: 0, nmBytes: 0, over: false };
    const start = this.now();
    let entries = 0;
    const stack: { dir: string; nm: boolean; top: boolean }[] = [{ dir: path, nm: false, top: true }];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      let d;
      try {
        d = await opendir(cur.dir);
      } catch (e) {
        if (code(e) === 'ENOENT') continue;
        u.over = true; // unreadable or too deep: fail closed
        return u;
      }
      try {
        for await (const ent of d) {
          if (++entries > this.entryBudget || this.now() - start > this.timeBudgetMs) {
            u.over = true;
            return u;
          }
          const p = join(cur.dir, ent.name);
          const st = await lstatOrNull(p).catch(() => null);
          if (!st) continue;
          if (st.isDirectory() && !st.isSymbolicLink()) {
            stack.push({ dir: p, nm: cur.nm || (cur.top && ent.name === 'node_modules'), top: false });
            continue;
          }
          if (cur.nm) {
            if (st.isFile()) u.nmBytes += st.size;
          } else {
            u.files++;
            if (st.isFile()) u.bytes += st.size;
          }
        }
      } catch {
        u.over = true;
        return u;
      } finally {
        await d.close().catch(() => undefined);
      }
    }
    return u;
  }

  /** Lowercased names of the workspace's top-level entries, streamed with the walk budget (WS-C14: `.NPMRC`, a `.npmrc` directory or symlink). */
  async rootNames(slug: string): Promise<string[]> {
    const { path } = await this.rootDir(slug);
    const out: string[] = [];
    const start = this.now();
    let n = 0;
    const d = await opendir(path).catch(() => { throw new WsError('E_IO'); });
    try {
      for await (const ent of d) {
        if (++n > this.entryBudget || this.now() - start > this.timeBudgetMs) throw new WsError('E_QUOTA');
        out.push(ent.name.toLowerCase());
      }
    } finally {
      await d.close().catch(() => undefined);
    }
    return out;
  }

  /** The whole content of a regular file through the no-follow chain (symlink, FIFO, hard link refused); larger than `max` is refused. */
  async readFull(slug: string, rel: string, max: number): Promise<Buffer> {
    const { path } = await this.rootDir(slug);
    const { fh, size } = await openInWorkspace(path, rel, 'r', { afterCheck: this.opts.afterCheck }, PATH_OPTS);
    try {
      if (size > max) throw new SandboxError('the file is too large');
      const buf = Buffer.alloc(size);
      let off = 0;
      while (off < size) {
        const { bytesRead } = await fh.read(buf, off, size - off, off);
        if (bytesRead === 0) break;
        off += bytesRead;
      }
      return buf.subarray(0, off);
    } finally {
      await fh.close();
    }
  }

  /** Opens a path with the same checks as a read (a regular file, no symlink in the chain, nlink 1) and closes it. Throws a SandboxError otherwise. */
  async assertFile(slug: string, rel: string): Promise<void> {
    const { path } = await this.rootDir(slug);
    const { fh } = await openInWorkspace(path, rel, 'r', { afterCheck: this.opts.afterCheck }, PATH_OPTS);
    await fh.close();
  }

  /**
   * The files an export may include (SA-1 4B, WS-C15): regular files only, `node_modules` and `.git` skipped at any depth (case-insensitive),
   * temp names skipped, names that fail the ws path rule (so no `\`, `:` or `..`) and files over 5 MB or deeper than 12 levels are skipped and
   * counted. More than 2 000 files is E_EXPORT_SIZE; the entry or time budget is E_QUOTA. Streams with opendir over lstat'ed folders.
   */
  async exportList(slug: string): Promise<ExportList> {
    const { path } = await this.rootDir(slug);
    const files: { rel: string; size: number }[] = [];
    let skipped = 0;
    let entries = 0;
    const start = this.now();
    const stack: { dir: string; segs: string[] }[] = [{ dir: path, segs: [] }];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      const d = await opendir(cur.dir).catch(() => null);
      if (!d) {
        skipped++;
        continue;
      }
      try {
        for await (const ent of d) {
          if (++entries > this.entryBudget || this.now() - start > this.timeBudgetMs) throw new WsError('E_QUOTA');
          const lower = ent.name.toLowerCase();
          if (isTmp(ent.name) || lower === 'node_modules' || lower === '.git') continue;
          const st = await lstatOrNull(join(cur.dir, ent.name)).catch(() => null);
          if (!st) continue;
          const segs = [...cur.segs, ent.name];
          if (st.isSymbolicLink() || (!st.isDirectory() && !st.isFile())) {
            skipped++;
            continue;
          }
          if (st.isDirectory()) {
            if (segs.length >= PATH_OPTS.depth) skipped++;
            else stack.push({ dir: join(cur.dir, ent.name), segs });
            continue;
          }
          const rel = segs.join('/');
          try {
            wsRel(rel);
          } catch {
            skipped++;
            continue;
          }
          if (st.size > EXPORT_FILE_MAX) {
            skipped++;
            continue;
          }
          files.push({ rel, size: st.size });
          if (files.length > EXPORT_MAX_FILES) throw new WsError('E_EXPORT_SIZE');
        }
      } finally {
        await d.close().catch(() => undefined);
      }
    }
    files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    return { files, skipped };
  }

  /** E_QUOTA when any limit is already exceeded (or the walk ran out of budget); returns the usage otherwise. */
  async assertUnderQuota(slug: string): Promise<Usage> {
    const u = await this.usage(slug);
    if (u.over || u.bytes > WS_LIMITS.bytes || u.files > WS_LIMITS.files || u.nmBytes > WS_LIMITS.nmBytes) throw new WsError('E_QUOTA');
    return u;
  }

  /** Up to 500 names, sorted, temp names hidden. A directory with more entries than the walk budget is E_QUOTA. */
  async list(slug: string, rel: string): Promise<{ entries: FileEntry[]; more: boolean }> {
    const { path } = await this.rootDir(slug);
    const chain = await walk(path, rel === '' ? [] : wsRel(rel), false);
    const dir = chain.at(-1)!.path;
    const names: string[] = [];
    const start = this.now();
    let n = 0;
    const d = await opendir(dir).catch(() => { throw new SandboxError('no such directory'); });
    try {
      for await (const ent of d) {
        if (++n > this.entryBudget || this.now() - start > this.timeBudgetMs) throw new WsError('E_QUOTA');
        if (!isTmp(ent.name)) names.push(ent.name);
      }
    } finally {
      await d.close().catch(() => undefined);
    }
    await recheck(chain);
    names.sort();
    const entries: FileEntry[] = [];
    for (const name of names.slice(0, WS_LIMITS.listMax)) {
      const st = await lstatOrNull(join(dir, name));
      if (!st) continue;
      entries.push({ name, kind: st.isSymbolicLink() ? 'other' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other', size: st.isFile() ? st.size : 0 });
    }
    return { entries, more: names.length > WS_LIMITS.listMax };
  }

  /** A byte window of a regular file; a cut never splits a UTF-8 character; a NUL byte in the window means binary (no text). */
  async read(slug: string, rel: string, offset: number, limit: number): Promise<ReadWindow> {
    const { path } = await this.rootDir(slug);
    const { fh, size } = await openInWorkspace(path, rel, 'r', { afterCheck: this.opts.afterCheck }, PATH_OPTS);
    try {
      const want = Math.max(0, Math.min(limit, WS_LIMITS.readMax, size - offset));
      const buf = Buffer.alloc(want);
      const { bytesRead } = want > 0 ? await fh.read(buf, 0, want, offset) : { bytesRead: 0 };
      let bytes = buf.subarray(0, bytesRead);
      let from = offset;
      if (offset > 0) {
        let i = 0;
        while (i < 3 && i < bytes.length && (bytes[i]! & 0xc0) === 0x80) i++;
        bytes = bytes.subarray(i);
        from += i;
      }
      if (offset + bytesRead < size) {
        for (let back = 1; back <= Math.min(3, bytes.length); back++) {
          const b = bytes[bytes.length - back]!;
          if ((b & 0xc0) === 0x80) continue; // continuation byte: keep looking for its lead
          const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
          if (need > back) bytes = bytes.subarray(0, bytes.length - back);
          break;
        }
      }
      const to = from + bytes.length;
      if (bytes.includes(0)) return { text: '', binary: true, from, to, size };
      return { text: new StringDecoder('utf8').write(bytes), binary: false, from, to, size };
    } finally {
      await fh.close();
    }
  }

  /**
   * Creates or replaces one regular file (the sandbox refuses a symlink, directory, FIFO or hard-linked target). The quota is checked first:
   * current usage must be under every limit and the new state must stay under the byte and file limits. Returns the new total bytes.
   */
  async write(slug: string, rel: string, content: string): Promise<{ bytes: number; created: boolean; total: number }> {
    const data = Buffer.from(content, 'utf8');
    if (data.length > WS_LIMITS.writeBytes) throw new SandboxError(`a file is at most ${WS_LIMITS.writeBytes} bytes`);
    const segs = wsRel(rel);
    if (segs.some((s) => s.toLowerCase() === NPMRC)) throw new WsError('E_NPMRC');
    const { path } = await this.rootDir(slug);
    const u = await this.assertUnderQuota(slug);
    const old = await lstatOrNull(join(path, ...segs));
    const replaced = old?.isFile() === true ? old.size : 0;
    if (u.bytes - replaced + data.length > WS_LIMITS.bytes) throw new WsError('E_QUOTA');
    if (!old && u.files + 1 > WS_LIMITS.files) throw new WsError('E_QUOTA');
    const w = await openInWorkspace(path, rel, 'w', { afterCheck: this.opts.afterCheck }, PATH_OPTS);
    try {
      await w.fh.write(data, 0, data.length, 0);
    } catch (e) {
      await w.abort();
      throw e;
    }
    await w.commit(true);
    return { bytes: data.length, created: !old, total: u.bytes - replaced + data.length };
  }

  /**
   * Removes a file, an empty folder, or a symlink ENTRY (unlink never follows). `recursive` removes a folder tree with fs.rm (which does not
   * follow symlinks) after the parent chain was checked: a symlink in any parent component is refused, so nothing outside is ever touched.
   */
  async delete(slug: string, rel: string, recursive: boolean): Promise<void> {
    const segs = wsRel(rel);
    const { path } = await this.rootDir(slug);
    const chain = await walk(path, segs.slice(0, -1), false);
    const dir = chain.at(-1)!.path;
    const target = join(dir, segs.at(-1)!);
    const st = await lstatOrNull(target);
    if (!st) throw new SandboxError('no such file or folder');
    await this.opts.afterCheck?.();
    await recheck(chain);
    if (st.isDirectory() && !st.isSymbolicLink()) {
      if (recursive) {
        const now = await lstat(target);
        if (!same(now, st) || now.isSymbolicLink()) throw new SandboxError('a path component changed during the operation');
        await rm(target, { recursive: true, force: false });
      } else {
        await rmdir(target).catch((e) => { throw code(e) === 'ENOTEMPTY' || code(e) === 'EEXIST' ? new SandboxError('the folder is not empty; set recursive to remove it with its contents') : e; });
      }
      return;
    }
    await unlink(target); // a file, a FIFO, or a symlink: the entry itself
  }
}

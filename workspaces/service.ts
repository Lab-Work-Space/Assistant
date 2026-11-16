import type { WorkspaceRepo, WorkspaceRow } from '../db/repos/workspaces.js';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncidentSink } from '../core/incidents.js';
import { SandboxError, same } from '../tools/plugins/workspace/sandbox.js';
import { needsNetwork, parseCommand, SCRIPT_RE, type Parsed, type Verb } from './command.js';
import { WsError } from './errors.js';
import { EXPORT_FILE_MAX, SLUG_RE, type FileEntry, type ProjectFiles, type ReadWindow } from './files.js';
import type { SlugLock } from './lock.js';
import { buildArgv, formatOutput, PROXY_CONTAINER, removeVerified, runContainer, WS_NETWORK, type DockerCli } from './runner.js';
import { buildZip } from './zip.js';

type Repo = Pick<WorkspaceRepo, 'create' | 'remove' | 'get' | 'list' | 'archive' | 'setUsage'> & Partial<Pick<WorkspaceRepo, 'claim'>>;

/** What ws_run needs (SA-1 5.3; built in app.ts after the Docker boot checks). Without it ws_run and ws_export are refused with E_IO. */
export type RunDeps = {
  docker: DockerCli;
  /** The runner image id from docker/ws/images.json (boot has verified it against `docker image inspect`). */
  image: string;
  uid: number;
  gid: number;
  /** Per-tree and per-day run caps, read from config just before each claim. */
  caps: () => { tree: number; day: number };
  /** The latched halt flag (`Halt.isHalted`), not the optional plugin field. */
  isHalted: () => boolean;
  /** The live literal secrets (the array grows at boot), read at each use. */
  secrets?: () => readonly string[];
  incidents?: IncidentSink;
  now?: () => number;
  timeoutMs?: number;
  clientGraceMs?: number;
  haltPollMs?: number;
};

export type RunOutcome = 'timeout' | 'oom' | 'start' | 'halted' | 'stuck';
export type RunResult = { verb: Verb; secs: number } & ({ outcome: 'exit'; exit: number; output: string } | { outcome: RunOutcome; exit: number });
export type ExportResult = { zip: Buffer; files: number; sha256: string; skipped: number };

export const GLOBAL_RUN_CAP = 2;
const DEP_MAPS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
// Gate 2 (WS-1): also the forms npm-package-arg reads as a local path or tarball without a "/": a leading "." (".", ".."), a leading "\", a drive letter ("C:"), and a name ending .tgz/.tar/.tar.gz.
const BAD_SPEC = /^(git|git\+|https?:|file:|link:|github:|gitlab:|bitbucket:|npm:|workspace:|\.|\\|[A-Za-z]:)|\.(tgz|tar|tar\.gz)$/i;
const EXPORT_READ_MAX = 50 * 1024 * 1024;
const ZIP_MAX = 10_000_000;
const NAME = /^ws-[a-z][a-z0-9-]{1,39}-[0-9a-f]{8}$/;

/**
 * WS-1 service: the workspace registry plus the locked, row-checked file operations the tools call (SA-1 3.2 steps 5 and 6).
 * It throws WsError (a code) or SandboxError (a fixed message); the tools turn both into toolError text. It never logs or
 * audits file content. The container side (ws_run, ws_export, killAll of containers) is added by WS-BE2.
 */
export class WsService {
  private active = 0;
  private closed = false;
  /** Every container name this process has chosen and not yet seen removed; killAll removes them all (WS-C12). */
  private readonly names = new Set<string>();
  private readonly aborts = new Map<string, AbortController>();

  constructor(private readonly o: { repo: Repo; root: string; files: ProjectFiles; lock: SlugLock; run?: RunDeps }) {}

  /** Row check (step 5): the workspace exists; `active` is required for write, delete and run (archived allows list, read and export). */
  async row(slug: string, need: 'any' | 'active'): Promise<WorkspaceRow> {
    const r = SLUG_RE.test(slug) ? await this.o.repo.get(slug) : null;
    if (!r) throw new WsError('E_SLUG');
    if (need === 'active' && r.status !== 'active') throw new WsError('E_ARCHIVED');
    return r;
  }

  /** DB insert first (5-active cap and unique slug under an advisory lock), then the 0700 folder; a folder failure deletes the row. */
  async create(slug: string, title: string, createdBy: string): Promise<void> {
    const r = await this.o.repo.create(slug, title, createdBy);
    if (r === 'limit') throw new WsError('E_LIMIT');
    if (r === 'exists') throw new WsError('E_EXISTS');
    try {
      await mkdir(join(this.o.root, slug), { mode: 0o700 });
    } catch (e) {
      await this.o.repo.remove(slug).catch(() => undefined);
      throw new WsError((e as { code?: string }).code === 'EEXIST' ? 'E_DIR' : 'E_IO');
    }
  }

  list(): Promise<WorkspaceRow[]> {
    return this.o.repo.list();
  }

  /** For `/ws archive` (WS-BE3). */
  archive(slug: string, userId: string): Promise<boolean> {
    return this.o.repo.archive(slug, userId);
  }

  private async locked<T>(slug: string, mode: 'read' | 'write', fn: () => Promise<T>): Promise<T> {
    const r = await this.o.lock.op(slug, mode, fn);
    if (r.busy) throw new WsError('E_BUSY');
    return r.value;
  }

  listFiles(slug: string, rel: string): Promise<{ entries: FileEntry[]; more: boolean }> {
    return this.row(slug, 'any').then(() => this.locked(slug, 'read', () => this.o.files.list(slug, rel)));
  }

  read(slug: string, rel: string, offset: number, limit: number): Promise<ReadWindow> {
    return this.row(slug, 'any').then(() => this.locked(slug, 'read', () => this.o.files.read(slug, rel, offset, limit)));
  }

  async write(slug: string, rel: string, content: string): Promise<{ bytes: number; created: boolean }> {
    await this.row(slug, 'active');
    return this.locked(slug, 'write', async () => {
      const r = await this.o.files.write(slug, rel, content);
      await this.o.repo.setUsage(slug, r.total, null).catch(() => undefined); // informational: quotas re-measure the tree each time
      return { bytes: r.bytes, created: r.created };
    });
  }

  async delete(slug: string, rel: string, recursive: boolean): Promise<void> {
    await this.row(slug, 'active');
    await this.locked(slug, 'write', async () => {
      await this.o.files.delete(slug, rel, recursive);
      const u = await this.o.files.usage(slug).catch(() => null);
      if (u && !u.over) await this.o.repo.setUsage(slug, u.bytes, u.nmBytes).catch(() => undefined);
    });
  }

  // ---- ws_run ---------------------------------------------------------------------------------------------------------------------

  /** Package.json for the spec and script checks: missing is null; invalid JSON, over 1 MiB or not an object is `bad`. */
  private async pkg(slug: string): Promise<Record<string, unknown> | null | 'bad'> {
    let buf: Buffer;
    try {
      buf = await this.o.files.readFull(slug, 'package.json', 1024 * 1024);
    } catch (e) {
      if (e instanceof SandboxError && /no such file|not found|does not exist/i.test(e.message)) return null;
      if (e instanceof SandboxError && e.message === 'the file is too large') return 'bad';
      throw e;
    }
    try {
      const j: unknown = JSON.parse(buf.toString('utf8'));
      return j !== null && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : 'bad';
    } catch {
      return 'bad';
    }
  }

  private specsOk(v: unknown, depth = 0): boolean {
    if (depth > 20) return false;
    if (typeof v === 'string') return !BAD_SPEC.test(v) && !v.includes('/');
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return Object.values(v).every((x) => this.specsOk(x, depth + 1));
    return false;
  }

  /** Checks before the claim (SA-1 3.4, WS-C14): .npmrc, package.json specs, script, the file to run, quota, and the proxy for install verbs. */
  private async prechecks(slug: string, p: Parsed): Promise<void> {
    const r = this.o.run!;
    const npm = p.verb !== 'node' && p.verb !== 'tsc';
    if (npm && (await this.o.files.rootNames(slug)).includes('.npmrc')) throw new WsError('E_NPMRC');
    if (p.verb === 'ci' || p.verb === 'install') {
      const pkg = await this.pkg(slug);
      if (pkg === 'bad') throw new WsError('E_SPEC');
      if (pkg) {
        for (const k of DEP_MAPS) if (pkg[k] !== undefined && !this.specsOk(pkg[k])) throw new WsError('E_SPEC');
        if (pkg.overrides !== undefined && !this.specsOk(pkg.overrides)) throw new WsError('E_SPEC');
      }
    }
    if (p.verb === 'run') {
      const pkg = await this.pkg(slug);
      const scripts = pkg && pkg !== 'bad' ? pkg.scripts : undefined;
      if (!SCRIPT_RE.test(p.script!) || scripts === null || typeof scripts !== 'object' || Array.isArray(scripts) || !Object.hasOwn(scripts as object, p.script!)) throw new WsError('E_SCRIPT');
    }
    if (p.verb === 'node') await this.o.files.assertFile(slug, p.rel!);
    if (p.verb === 'tsc') {
      try {
        await this.o.files.assertFile(slug, 'node_modules/typescript/bin/tsc');
      } catch {
        throw new WsError('E_TSC');
      }
    }
    await this.o.files.assertUnderQuota(slug);
    if (needsNetwork(p.verb)) {
      const net = await r.docker.exec(['network', 'inspect', WS_NETWORK, '-f', '{{.Internal}}']);
      const up = await r.docker.exec(['inspect', '-f', '{{.State.Running}}', PROXY_CONTAINER]);
      if (net.code !== 0 || net.stdout.trim() !== 'true' || up.code !== 0 || up.stdout.trim() !== 'true') throw new WsError('E_PROXY');
    }
  }

  /**
   * One sandboxed command. Throws WsError for every refusal before the claim (and the claim itself: E_CAP_*); returns an outcome once a slot
   * was claimed. A claimed slot is never refunded and nothing is retried. The result never carries docker stderr or a path.
   */
  async run(a: { slug: string; command: string; rootId: string }): Promise<RunResult> {
    const r = this.o.run;
    if (!r || !this.o.repo.claim) throw new WsError('E_IO');
    const parsed = parseCommand(a.command);
    await this.row(a.slug, 'active');
    const release = this.o.lock.tryRun(a.slug);
    if (!release) throw new WsError('E_BUSY');
    const halted = () => this.closed || r.isHalted();
    let slot = false;
    let stuck = false;
    try {
      if (this.active >= GLOBAL_RUN_CAP) throw new WsError('E_GLOBAL');
      this.active++;
      slot = true;
      const src = await this.o.files.rootDir(a.slug);
      await this.prechecks(a.slug, parsed);
      const caps = r.caps();
      const day = new Date((r.now ?? Date.now)()).toISOString().slice(0, 10);
      const c = await this.o.repo.claim(a.rootId, day, caps.tree, caps.day);
      if (c === 'tree') throw new WsError('E_CAP_TREE');
      if (c === 'day') throw new WsError('E_CAP_DAY');

      // From here a slot is spent. The name is remembered before anything can start, so killAll can always find the container.
      const name = `ws-${a.slug}-${randomBytes(4).toString('hex')}`;
      const ac = new AbortController();
      this.names.add(name);
      this.aborts.set(name, ac);
      const done = (outcome: RunOutcome, exit = 0): RunResult => ({ verb: parsed.verb, secs: 0, outcome, exit });
      try {
        if (halted()) return done('halted');
        // The mount source is rebuilt from the validated root and slug and must still be the same real directory (WS-C2).
        const now = await lstat(src.path).catch(() => null);
        if (!now || now.isSymbolicLink() || !now.isDirectory() || !same(now, src.st)) return done('start', 1);
        const argv = buildArgv({ name, slug: a.slug, uid: r.uid, gid: r.gid, wsReal: this.o.root, image: r.image, parsed });
        const res = await runContainer(r.docker, { argv, name, isHalted: halted, signal: ac.signal, ...(r.timeoutMs ? { timeoutMs: r.timeoutMs } : {}), ...(r.clientGraceMs !== undefined ? { clientGraceMs: r.clientGraceMs } : {}), ...(r.haltPollMs ? { haltPollMs: r.haltPollMs } : {}) });
        if (!res.removed) {
          stuck = true;
          this.o.lock.markStuck(a.slug);
          try {
            r.incidents?.report({ source: 'tool', stage: 'ws.cleanup', err: new Error('ws container could not be removed'), toolName: 'ws_run' });
          } catch { /* the reporter never breaks the path */ }
          return { ...done('stuck'), secs: res.secs };
        }
        this.names.delete(name);
        // Quotas after EVERY run, bytes and node_modules both (WS-C8), also after a timeout or an OOM.
        const u = await this.o.files.usage(a.slug).catch(() => null);
        if (u && !u.over) await this.o.repo.setUsage(a.slug, u.bytes, u.nmBytes).catch(() => undefined);
        const base = { verb: parsed.verb, secs: res.secs };
        if (res.timedOut) return { ...base, outcome: 'timeout', exit: 137 };
        if (res.stopped) return { ...base, outcome: 'halted', exit: 137 };
        if (res.spawnFailed || res.code === 125 || !res.info || !res.info.started) return { ...base, outcome: 'start', exit: res.code };
        if (res.info.oom) return { ...base, outcome: 'oom', exit: res.info.exit };
        return { ...base, outcome: 'exit', exit: res.info.exit, output: formatOutput(res.tail, res.overflowed, r.secrets?.() ?? []) };
      } finally {
        this.aborts.delete(name);
        if (!stuck) this.names.delete(name);
      }
    } finally {
      if (slot && !stuck) this.active--;
      release();
    }
  }

  // ---- ws_export ------------------------------------------------------------------------------------------------------------------

  /**
   * The zip of a workspace (SA-1 4B, WS-C15). No run may be active (E_BUSY). A file that cannot be opened through the no-follow chain is skipped
   * and counted; a literal secret in any file without a NUL byte refuses the whole export with a count only (no path).
   */
  async export(slug: string, secrets: readonly string[]): Promise<ExportResult> {
    if (!this.o.run) throw new WsError('E_IO');
    await this.row(slug, 'any');
    return this.locked(slug, 'write', async () => {
      const list = await this.o.files.exportList(slug);
      let skipped = list.skipped;
      const lits = secrets.filter((x) => x.length > 0).map((x) => Buffer.from(x, 'utf8'));
      const entries: { name: string; data: Buffer }[] = [];
      let total = 0;
      let leaks = 0;
      for (const f of list.files) {
        let data: Buffer;
        try {
          data = await this.o.files.readFull(slug, f.rel, EXPORT_FILE_MAX);
        } catch (e) {
          if (e instanceof SandboxError) {
            skipped++;
            continue;
          }
          throw e;
        }
        total += data.length;
        if (total > EXPORT_READ_MAX) throw new WsError('E_EXPORT_SIZE');
        if (!data.includes(0) && lits.some((l) => data.includes(l))) leaks++;
        entries.push({ name: f.rel, data });
      }
      if (leaks > 0) throw new WsError('E_EXPORT_SECRET', leaks);
      if (entries.length === 0) throw new WsError('E_EXPORT_SIZE');
      let zip: Buffer;
      try {
        zip = buildZip(entries);
      } catch {
        throw new WsError('E_EXPORT_SIZE');
      }
      if (zip.length > ZIP_MAX) throw new WsError('E_EXPORT_SIZE');
      return { zip, files: entries.length, sha256: createHash('sha256').update(zip).digest('hex'), skipped };
    });
  }

  // ---- halt and stop --------------------------------------------------------------------------------------------------------------

  /**
   * Removes every ws container: the ones in `docker ps -a --filter label=ws=1` whose name starts with `ws-`, and every name this process chose.
   * Called by halt (after the halt flag is latched) and by stop. In-flight runs are aborted so their own loop repeats `rm -f` and verifies it.
   * Never throws.
   */
  async killAll(): Promise<void> {
    const r = this.o.run;
    if (!r) return;
    try {
      for (const ac of this.aborts.values()) ac.abort();
      const all = new Set(this.names);
      const ps = await r.docker.exec(['ps', '-a', '--filter', 'label=ws=1', '--format', '{{.Names}}']);
      if (ps.code === 0) for (const l of ps.stdout.split('\n')) if (NAME.test(l.trim())) all.add(l.trim());
      await Promise.all([...all].map((n) => removeVerified(r.docker, n)));
    } catch { /* best effort: the run loops and the next boot sweep finish the job */ }
  }

  /** For app.stop: nothing starts after this, then the containers are removed. */
  async shutdown(): Promise<void> {
    this.closed = true;
    await this.killAll();
  }
}

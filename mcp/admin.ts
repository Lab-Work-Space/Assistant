import type { McpClass, McpRepo, McpRow, McpStatus } from '../db/repos/mcp.js';
import type { AuditFn } from '../governance/audit.js';
import type { DockerCli } from '../workspaces/runner.js';
import { ADMIN_TEXT, McpError, type AdminCode } from './errors.js';
import { parseClass, parseCommand, parseDepartments, parseEnv, parseImage, parseNumbers, parseRef, parseSlug, parseTitle } from './fields.js';
import { parseJson } from '../forge/validate.js';
import { SLUG } from './names.js';
import type { ReleaseStageBy, StageReleaseFn } from '../forge/types.js';
import { checkImage, checkSeccomp, withSandbox, type SandboxCfg, type SandboxDeps } from './sandbox.js';
import { buildSnapshot, configHash, configSha256, hashRaw, modelView, type Built } from './snapshot.js';

/**
 * R6 MCP-1: the Bot Admin operations (spec 3.2, 3.3, 3.7; MC-C2, MC-C7 data, MC-C8). Only discord/commands/mcp.ts and app.ts will import this file (boundary test, BE2);
 * no tool, AdminOp or config path reaches it. `stage` is the one function that creates a `pending` row; its `by` type is admin-only in R6 (R7 widens it).
 * Every refusal is a fixed code with a fixed text and an audit row `refused:<code>`; nothing echoes input text, server text or a zod error.
 */
export type AdminBy = { kind: 'admin'; userId: string };
export interface AddInput { slug: string; image: string; class?: string; departments: string; title: string; command?: string; env?: string; timeout?: number; daily?: number; ref?: string }

export interface McpAdminDeps {
  repo: Pick<McpRepo, 'get' | 'list' | 'stage' | 'activate' | 'disable' | 'setDepts' | 'releaseBound' | 'forgedImage'>;
  docker: Pick<DockerCli, 'exec'>;
  sandbox: SandboxDeps;
  /** `McpHost.refresh`: never throws. */
  host: { refresh(slug?: string): Promise<void> };
  halted(): boolean;
  deptExists(id: string): boolean;
  audit: AuditFn;
  secrets(): readonly string[];
  /** Closes the cards of approvals that leaving `active` expired (BE2 wires the Discord side). Failures are swallowed. */
  closeCards?: (ids: number[]) => Promise<void>;
  log: { error(o: unknown, m?: string): void };
}

/** What the Bot Admin reviews: exactly what the model will see (MC-C7), plus the two hashes. */
export interface AdminView {
  slug: string; title: string; class: McpClass; status: McpStatus; depts: string[];
  /** Display only (MC-C16: escaped in every view): the pinned image id and the admin's reference text. */
  imageId: string; imageRef: string | null;
  tools: { name: string; description: string; schema: Record<string, unknown> }[];
  toolCount: number;
  /** The first 12 hex of the snapshot hash (display). */
  hash12: string;
  /** MC-C8: the approve token, over the whole config. */
  config12: string;
  approveLine: string;
}
export type Fail = { ok: false; code: AdminCode | 'E_HALTED' | 'E_INTERNAL' | 'E_CHANGED'; text: string };
export type StageOut = { ok: true; view: AdminView } | Fail;
export type ListItem = { slug: string; title: string; class: McpClass; status: McpStatus; depts: string[]; tools: number; hash12: string };

const SNOWFLAKE = /^[0-9]{17,20}$/;
const TOKEN = /^[0-9a-f]{12}$/;
const errName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown');
const probeCode = (e: unknown): 'E_HALTED' | 'E_SECCOMP' | 'E_PROBE' => (e instanceof McpError && (e.code === 'E_HALTED' || e.code === 'E_SECCOMP') ? e.code : 'E_PROBE');
const failOf = (code: Fail['code']): Fail => ({ ok: false, code, text: ADMIN_TEXT[code] });

export class McpAdmin {
  constructor(private readonly d: McpAdminDeps) {}

  private async refuse(by: AdminBy | ReleaseStageBy, action: string, code: Fail['code'], tool: string | null = null): Promise<Fail> {
    await this.d.audit({ actor: by.kind === 'release' ? 'system:forge' : `user:${by.userId}`, action, tool, outcome: `refused:${code}` });
    return failOf(code);
  }

  private check(by: AdminBy): void {
    if (by.kind !== 'admin' || !SNOWFLAKE.test(by.userId)) throw new Error('McpAdmin: an admin actor is required');
  }

  private cfgOf(row: { slug: string; imageId: string; command: readonly string[]; env: Readonly<Record<string, string>>; timeoutMs: number }): SandboxCfg {
    return { slug: row.slug, imageId: row.imageId, command: row.command, env: row.env, timeoutMs: row.timeoutMs };
  }

  /**
   * A fresh container: initialize, tools/list, close. Any sandbox failure is E_PROBE (E_HALTED stays itself). G2-MCP-02: this is the ONLY place McpAdmin spawns, and the MC-C3 seccomp check
   * (the same function as the boot's) runs first, on every probe, with the switch on or off; a failed or unreadable check is E_SECCOMP and nothing is spawned.
   */
  /**
   * PF-C10: may this admin-added server be class read? Not when the image carries a label starting `assistant.forge`, when a plugin build recorded this image id, or when the slug's existing
   * row came from a release (a re-add resets `source`, which would unbind the `mcp_servers_release_write` CHECK). An inspect or parse error refuses: this can only fail safe.
   */
  private async forgeTainted(image: string, existing: { source: string } | null): Promise<boolean> {
    if (existing?.source === 'release') return true;
    try {
      if (await this.d.repo.forgedImage(image)) return true;
      const r = await this.d.docker.exec(['image', 'inspect', '--format', '{{json .Config.Labels}}', image]);
      if (r.code !== 0 || r.timedOut) return true;
      const v = parseJson(r.stdout.trim());
      if (v === null) return false;
      if (typeof v !== 'object' || Array.isArray(v)) return true;
      const labels = v as Record<string, unknown>;
      return Object.entries(labels).some(([k, x]) => typeof x !== 'string' || k.startsWith('assistant.forge'));
    } catch {
      return true;
    }
  }

  private async probe(cfg: SandboxCfg): Promise<unknown[]> {
    if (!(await checkSeccomp(this.d.docker))) throw new McpError('E_SECCOMP');
    try {
      return await withSandbox(this.d.sandbox, cfg, async (rpc) => {
        await rpc.handshake();
        return rpc.listTools();
      });
    } catch (e) {
      throw new McpError(probeCode(e));
    }
  }

  private viewOf(i: { slug: string; title: string; toolClass: McpClass; status: McpStatus; depts: string[]; snapshotSha256: string; config12: string; imageId: string; imageRef: string | null }, built: Built): AdminView {
    return {
      imageId: i.imageId, imageRef: i.imageRef, slug: i.slug, title: i.title, class: i.toolClass, status: i.status, depts: i.depts, tools: built.entries.map(modelView), toolCount: built.entries.length,
      hash12: i.snapshotSha256.slice(0, 12), config12: i.config12, approveLine: `Run /mcp approve slug:${i.slug} hash:${i.config12} to install.`,
    };
  }

  private mapBuild(e: unknown): AdminCode | 'E_INTERNAL' {
    if (!(e instanceof McpError)) return 'E_INTERNAL';
    if (e.code === 'E_PROTOCOL') return 'E_PROBE';
    if (e.code === 'E_TOO_BIG') return 'E_SCHEMA';
    const ok: readonly string[] = ['E_TOOLS_NONE', 'E_TOOLS_MANY', 'E_NAME', 'E_COLLISION', 'E_SCHEMA', 'E_SCREEN'];
    return ok.includes(e.code) ? (e.code as AdminCode) : 'E_INTERNAL';
  }

  /** `/mcp add`: validate, check the image, probe in a fresh container, build the snapshot, write the pending row. */
  async stage(input: AddInput, by: AdminBy): Promise<StageOut> {
    this.check(by);
    return this.stageBody(input, by, { source: 'admin', releaseId: null, adderId: by.userId });
  }

  /**
   * R7 (PF-C9): the code-driven stage of a forged plugin image. `by` must be the release actor with a positive integer release id and a snowflake `decidedBy`; `stage`, `add` and `/mcp add` stay AdminBy only.
   * The input has no class, command, env, timeout or daily: they are hard-coded here (`write`, `[]`, `{}`, 60 s, 100/day). The repo then binds the release, the build, the forge, the slug, the sha256, the
   * image id, the project state and the department under its lock. The probe goes through the same private body, so the seccomp check still runs first.
   */
  async stageRelease(input: Parameters<StageReleaseFn>[0], by: ReleaseStageBy): Promise<{ ok: true; slug: string; config12: string; toolCount: number } | { ok: false; code: string }> {
    if (by?.kind !== 'release' || !Number.isSafeInteger(by.releaseId) || by.releaseId < 1 || typeof by.decidedBy !== 'string' || !SNOWFLAKE.test(by.decidedBy)) throw new Error('McpAdmin: a release actor is required');
    const r = await this.stageBody({ slug: input.slug, image: input.image, class: 'write', departments: input.departments, title: input.title, timeout: 60, daily: 100, ref: input.ref }, by,
      { source: 'release', releaseId: by.releaseId, adderId: by.decidedBy });
    return r.ok ? { ok: true, slug: r.view.slug, config12: r.view.config12, toolCount: r.view.toolCount } : { ok: false, code: r.code };
  }

  private async stageBody(input: AddInput, by: AdminBy | ReleaseStageBy, w: { source: 'admin' | 'release'; releaseId: number | null; adderId: string }): Promise<StageOut> {
    const refuse = (code: Fail['code']): Promise<Fail> => this.refuse(by, 'mcp.add', code);
    if (this.d.halted()) return refuse('E_HALTED');
    const slug = parseSlug(input.slug);
    if (!slug.ok) return refuse(slug.code);
    const image = parseImage(input.image);
    if (!image.ok) return refuse(image.code);
    const cls = parseClass(input.class);
    if (!cls.ok) return refuse(cls.code);
    if (w.source === 'release' && cls.value !== 'write') return refuse('E_CLASS');
    const command = parseCommand(input.command);
    if (!command.ok) return refuse(command.code);
    const env = parseEnv(input.env, this.d.secrets());
    if (!env.ok) return refuse(env.code);
    const depts = parseDepartments(input.departments, (x) => this.d.deptExists(x));
    if (!depts.ok) return refuse(depts.code);
    const title = parseTitle(input.title);
    if (!title.ok) return refuse(title.code);
    const nums = parseNumbers({ ...(input.timeout !== undefined ? { timeout: input.timeout } : {}), ...(input.daily !== undefined ? { daily: input.daily } : {}) });
    if (!nums.ok) return refuse(nums.code);
    const ref = parseRef(input.ref);
    if (!ref.ok) return refuse(ref.code);
    try {
      const ex = await this.d.repo.get(slug.value);
      if (ex && (ex.status === 'pending' || ex.status === 'active')) return await refuse('E_EXISTS');
      if (w.source === 'admin' && cls.value === 'read' && (await this.forgeTainted(image.value, ex ?? null))) return await refuse('E_CLASS'); // PF-C10, before the probe
      if (w.source === 'release' && !(await this.d.repo.releaseBound({ releaseId: w.releaseId!, by: w.adderId, slug: slug.value, imageId: image.value, depts: depts.value, toolClass: cls.value }))) return await refuse('E_STATE'); // nothing is spawned for a call that is not bound to a real approved release
      if (!(await checkImage(this.d.docker, image.value))) return await refuse('E_IMAGE');
      let raw: unknown[];
      try {
        raw = await this.probe({ slug: slug.value, imageId: image.value, command: command.value, env: env.value, timeoutMs: nums.value.timeoutMs });
      } catch (e) {
        return await refuse(probeCode(e));
      }
      let built: Built;
      try {
        built = buildSnapshot(raw, { slug: slug.value, toolClass: cls.value, secrets: this.d.secrets() });
      } catch (e) {
        return await refuse(this.mapBuild(e));
      }
      const sorted = [...new Set(depts.value)].sort();
      const config12 = configHash({ imageId: image.value, command: command.value, env: env.value, toolClass: cls.value, depts: sorted, snapshotSha256: built.sha256 });
      const r = await this.d.repo.stage({
        slug: slug.value, title: title.value, imageId: image.value, imageRef: ref.value, command: command.value, env: env.value, toolClass: cls.value, timeoutMs: nums.value.timeoutMs,
        maxCallsPerDay: nums.value.maxCallsPerDay, snapshot: built.raw, snapshotSha256: built.sha256, depts: sorted, by: w.adderId, cfg12: config12, source: w.source, releaseId: w.releaseId,
      });
      if (!r.ok) return await refuse(r.code);
      if (r.expired.length > 0) await this.d.closeCards?.(r.expired).catch(() => undefined);
      return { ok: true, view: this.viewOf({ slug: slug.value, title: title.value, toolClass: cls.value, status: 'pending', depts: sorted, snapshotSha256: built.sha256, config12, imageId: image.value, imageRef: ref.value }, built) };
    } catch (e) {
      this.d.log.error({ errName: errName(e) }, 'mcp add failed');
      return failOf('E_INTERNAL');
    }
  }

  /** The one entry point named in the spec for adding a server (stage plus its view). */
  add(input: AddInput, by: AdminBy): Promise<StageOut> {
    return this.stage(input, by);
  }

  /**
   * `/mcp approve`: the token is the full-config hash. Re-probe live (a fresh container) and compare with the stored snapshot hash; then the repo checks the token
   * again against the row it read FOR UPDATE under the lock, and sets `active` by compare-and-set on (id, pending, snapshot hash).
   */
  async approve(a: { slug: string; token: string }, by: AdminBy): Promise<{ ok: true; slug: string; cfg12: string } | Fail> {
    this.check(by);
    const refuse = (code: Fail['code']): Promise<Fail> => this.refuse(by, 'mcp.approve', code);
    if (this.d.halted()) return refuse('E_HALTED');
    if (!SLUG.test(a.slug)) return refuse('E_SLUG');
    if (!TOKEN.test(a.token)) return refuse('E_HASH');
    try {
      const row = await this.d.repo.get(a.slug);
      if (!row || row.status !== 'pending') return await refuse('E_STATE');
      const tokenOf = (x: McpRow): string => configHash({ imageId: x.imageId, command: x.command, env: x.env, toolClass: x.toolClass, depts: x.depts, snapshotSha256: x.snapshotSha256 });
      if (tokenOf(row) !== a.token) return await refuse('E_HASH'); // spec 3.3 step 1: before any docker call; the locked re-check in activate still closes the race
      if (!(await checkImage(this.d.docker, row.imageId))) return await refuse('E_IMAGE');
      let raw: unknown[];
      try {
        raw = await this.probe(this.cfgOf(row));
      } catch (e) {
        return await refuse(probeCode(e));
      }
      let live: string | null = null;
      try { live = hashRaw(raw); } catch { live = null; }
      if (live !== row.snapshotSha256) return await refuse('E_CHANGED');
      const r = await this.d.repo.activate({
        slug: a.slug, snapshotSha256: row.snapshotSha256, by: by.userId, fullHash: (locked: McpRow) => configSha256(locked),
        check: (locked: McpRow) => (tokenOf(locked) === a.token ? a.token : null),
      });
      if (!r.ok) return await refuse(r.code);
      await this.d.host.refresh(a.slug);
      return { ok: true, slug: a.slug, cfg12: r.cfg12 };
    } catch (e) {
      this.d.log.error({ errName: errName(e) }, 'mcp approve failed');
      return failOf('E_INTERNAL');
    }
  }

  /** `/mcp test`: image check, fresh probe, compare the live hash with the stored one. No state change. */
  async test(slug: string, by: AdminBy): Promise<{ ok: true; result: 'ok' | 'mismatch' } | Fail> {
    this.check(by);
    if (this.d.halted()) return this.refuse(by, 'mcp.test', 'E_HALTED');
    if (!SLUG.test(slug)) return this.refuse(by, 'mcp.test', 'E_SLUG');
    const done = async (outcome: string): Promise<void> => this.d.audit({ actor: `user:${by.userId}`, action: 'mcp.test', outcome: `${slug} ${outcome}` });
    try {
      const row = await this.d.repo.get(slug);
      if (!row) { await done('E_STATE'); return failOf('E_STATE'); }
      if (!(await checkImage(this.d.docker, row.imageId))) { await done('E_IMAGE'); return failOf('E_IMAGE'); }
      let raw: unknown[];
      try {
        raw = await this.probe(this.cfgOf(row));
      } catch (e) {
        const code = probeCode(e);
        await done(code);
        return failOf(code);
      }
      let live: string | null = null;
      try { live = hashRaw(raw); } catch { live = null; }
      const result = live === row.snapshotSha256 ? 'ok' : 'mismatch';
      await done(result);
      if (result === 'ok' && row.status === 'active') await this.d.host.refresh(slug); // G2-MCP-06: an active server that boot left out (image missing) is loaded again now that its image and tool list check out
      return { ok: true, result };
    } catch (e) {
      this.d.log.error({ errName: errName(e) }, 'mcp test failed');
      return failOf('E_INTERNAL');
    }
  }

  /** `/mcp disable`: allowed while halted. Takes effect live (the host refresh); in-flight calls finish. */
  async disable(slug: string, by: AdminBy): Promise<{ ok: true } | Fail> {
    this.check(by);
    if (!SLUG.test(slug)) return this.refuse(by, 'mcp.disable', 'E_SLUG');
    try {
      const r = await this.d.repo.disable(slug, by.userId);
      if (!r.ok) return await this.refuse(by, 'mcp.disable', r.code);
      await this.d.host.refresh();
      if (r.expired.length > 0) await this.d.closeCards?.(r.expired).catch(() => undefined);
      return { ok: true };
    } catch (e) {
      this.d.log.error({ errName: errName(e) }, 'mcp disable failed');
      return failOf('E_INTERNAL');
    }
  }

  /** `/mcp depts`: replaces the grants; refused while halted. */
  async depts(slug: string, departments: string, by: AdminBy): Promise<{ ok: true } | Fail> {
    this.check(by);
    if (this.d.halted()) return this.refuse(by, 'mcp.depts', 'E_HALTED');
    if (!SLUG.test(slug)) return this.refuse(by, 'mcp.depts', 'E_SLUG');
    const ds = parseDepartments(departments, (x) => this.d.deptExists(x));
    if (!ds.ok) return this.refuse(by, 'mcp.depts', ds.code);
    try {
      const r = await this.d.repo.setDepts(slug, ds.value, by.userId, (r) => configSha256(r));
      if (!r.ok) return await this.refuse(by, 'mcp.depts', r.code);
      await this.d.host.refresh();
      return { ok: true };
    } catch (e) {
      this.d.log.error({ errName: errName(e) }, 'mcp depts failed');
      return failOf('E_INTERNAL');
    }
  }

  async list(): Promise<ListItem[]> {
    return (await this.d.repo.list()).map((r) => ({ slug: r.slug, title: r.title, class: r.toolClass, status: r.status, depts: r.depts, tools: r.tools, hash12: r.snapshotSha256.slice(0, 12) }));
  }

  /** The stored snapshot rendered through the same model view the add reply used. */
  async show(slug: string): Promise<{ ok: true; view: AdminView } | Fail> {
    if (!SLUG.test(slug)) return failOf('E_SLUG');
    try {
      const row = await this.d.repo.get(slug);
      if (!row) return failOf('E_STATE');
      const built = buildSnapshot(row.snapshot, { slug: row.slug, toolClass: row.toolClass, secrets: this.d.secrets() });
      const config12 = configHash({ imageId: row.imageId, command: row.command, env: row.env, toolClass: row.toolClass, depts: row.depts, snapshotSha256: row.snapshotSha256 });
      return { ok: true, view: this.viewOf({ slug: row.slug, title: row.title, toolClass: row.toolClass, status: row.status, depts: row.depts, snapshotSha256: row.snapshotSha256, config12, imageId: row.imageId, imageRef: row.imageRef }, built) };
    } catch (e) {
      if (e instanceof McpError) return failOf(this.mapBuild(e));
      this.d.log.error({ errName: errName(e) }, 'mcp show failed');
      return failOf('E_INTERNAL');
    }
  }
}

/** What `CommandDeps.mcp` is: the seven operations the slash layer needs, as closures (spec 5.10). The AdminConsole gets nothing of this. */
export type McpCommandDeps = Pick<McpAdmin, 'list' | 'show' | 'add' | 'approve' | 'test' | 'disable' | 'depts'>;
export function mcpCommandDeps(a: McpCommandDeps): McpCommandDeps {
  return {
    list: () => a.list(), show: (slug) => a.show(slug), add: (i, by) => a.add(i, by), approve: (x, by) => a.approve(x, by),
    test: (slug, by) => a.test(slug, by), disable: (slug, by) => a.disable(slug, by), depts: (slug, d, by) => a.depts(slug, d, by),
  };
}

/** Spec 5.12: what the AI digest gets: the day counts and nothing else of the repo. */
export function mcpDigestDeps(r: Pick<McpRepo, 'day'>): Pick<McpRepo, 'day'> {
  return { day: (tz) => r.day(tz) };
}

/**
 * R7 PLUGIN-FORGE (spec 5.3, PF-C19): the one closure through which `stageRelease` is reachable. Its holder is `ForgeService` only (a wiring test lists it); the input type has no class, command, env,
 * timeout or daily field. No other method of `McpAdmin` (stage, add, approve, disable, depts) is reachable through it.
 */
export function forgeStageDeps(a: Pick<McpAdmin, 'stageRelease'>): StageReleaseFn {
  return (input, by) => a.stageRelease(input, by);
}

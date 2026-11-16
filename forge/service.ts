import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ClaimedBuild, ForgeRepo, ReconcileEvent } from '../db/repos/forge.js';
import type { AuditFn } from '../governance/audit.js';
import type { DockerCli } from '../workspaces/runner.js';
import { Builder, BASE_RE, ForgeLatch, cleanStageRoot, forgeImagesArgv, imageInspectArgv, inspectBase, parseInspect, removeImageVerified, sweepForgeContainers, type BuildResult } from './builder.js';
import { EXEC_MS, IMAGES_KEPT_MAX } from './caps.js';
import { FORGE_BASE_ALERT, FORGE_STUCK_ALERT, NOTICE_FAILED_SOFTWARE, NOTICE_INSTALLED, NOTICE_STAGED_HQ, NOTICE_STAGED_HQ_ADOPTED, NOTICE_STAGED_SOFTWARE } from './texts.js';
import type { ForgeCancelResult, ForgeCommandDeps, ForgeDetail, ForgeListItem, StageReleaseFn } from './types.js';
import { parseJson } from './validate.js';

/**
 * R7 PLUGIN-FORGE (spec 3.6, 3.7): the service core, unwired in BE1 (BE2 constructs it in app.ts and starts the timers). Actor `system:forge`. Every public method never throws. The builder is code-owned:
 * no tool and no model drives it. One build at a time (the repo claim is the single flight; `running` guards the process). Notices carry fixed code text and ids only, through an injected sender.
 * Imports no `mcp/`, `providers/`, `agents/` or `governance/` module except the audit type; the stage is the injected `StageReleaseFn` closure.
 */
export type ForgeNotice =
  | { kind: 'staged_software'; deptId: string; taskId: string; text: string }
  | { kind: 'staged_hq'; text: string }
  | { kind: 'failed_software'; deptId: string; taskId: string; text: string }
  | { kind: 'installed'; deptId: string; text: string }
  | { kind: 'alert'; text: string };

export interface ForgeServiceDeps {
  repo: Pick<ForgeRepo, 'recover' | 'imageInUse' | 'imageEverHeld' | 'imageRemoved' | 'requeue' | 'fail' | 'claimNext' | 'staged' | 'serverOfRelease' | 'recordImage' | 'stillLive' | 'counts' | 'reconcile' | 'expireQueued' | 'gcCandidates' | 'imageKept' | 'imageOwner' | 'listItems' | 'detail' | 'adminCancel'>;
  docker: Pick<DockerCli, 'exec'>;
  stage: StageReleaseFn;
  /** The base image id, read ONCE at construction (`loadBaseId`); a changed file takes effect only after a restart. null: unusable. */
  baseImageId: string | null;
  stageRoot: string;
  isHalted(): boolean;
  forgeEnabled(): boolean;
  tz(): string;
  audit: AuditFn;
  notify(n: ForgeNotice): Promise<void>;
  log: { error(o: unknown, m?: string): void };
  now?: () => number;
  newSuffix?: () => string;
}

const errName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown');
const LABEL_BUILD = 'assistant.forge.build';

/**
 * Where `docker/forge/images.json` lives: under `dir` when given (tests), else the nearest ancestor of `from` (this file; works from the source tree and from dist) that has it, but never above the
 * repo: G2-FG-08, the search stops at the first directory that holds a `package.json`, and answers that directory's path (it may not exist: the base is then unusable).
 */
export function findForgeImagesFile(dir?: string, from: string = dirname(fileURLToPath(import.meta.url))): string {
  if (dir) return join(dir, 'docker', 'forge', 'images.json');
  for (let d = from; ; d = dirname(d)) {
    const f = join(d, 'docker', 'forge', 'images.json');
    if (existsSync(f) || existsSync(join(d, 'package.json')) || dirname(d) === d) return f;
  }
}

/** Reads `docker/forge/images.json` once: `{"base":"sha256:<64hex>"}`, parsed with the forbidden-key guard. null on any problem. Only the owner's build.sh writes this file (PF-C23). */
export function loadBaseId(path: string): string | null {
  try {
    const t = readFileSync(path, 'utf8');
    if (t.length > 1024) return null;
    const v = parseJson(t) as { base?: unknown } | null;
    return v !== null && typeof v === 'object' && typeof v.base === 'string' && BASE_RE.test(v.base) ? v.base : null;
  } catch {
    return null;
  }
}

export class ForgeService {
  readonly latch = new ForgeLatch();
  private readonly builder: Builder;
  private baseOk = false;
  private baseAlerted = false;
  private running = false;
  private gcRunning = false;

  constructor(private readonly d: ForgeServiceDeps) {
    this.builder = new Builder({
      docker: d.docker, repo: d.repo, stage: d.stage, baseImageId: d.baseImageId ?? '', stageRoot: d.stageRoot, isHalted: d.isHalted, forgeEnabled: d.forgeEnabled, latch: this.latch,
      onStuck: () => void this.say({ kind: 'alert', text: FORGE_STUCK_ALERT }),
      ...(d.now ? { now: d.now } : {}), ...(d.newSuffix ? { newSuffix: d.newSuffix } : {}), log: d.log,
    });
  }

  private async say(n: ForgeNotice): Promise<void> {
    try { await this.d.notify(n); } catch (e) { this.d.log.error({ errName: errName(e) }, 'forge notice failed'); }
  }
  private enabled(): boolean {
    try { return this.d.forgeEnabled() === true; } catch { return false; }
  }
  private halted(): boolean {
    try { return this.d.isHalted(); } catch { return true; }
  }

  /** The base check (3.6): false posts one alert and holds builds until it passes. */
  private async checkBase(): Promise<boolean> {
    this.baseOk = this.d.baseImageId !== null && (await inspectBase(this.d.docker, this.d.baseImageId)) !== null;
    if (!this.baseOk && !this.baseAlerted) { this.baseAlerted = true; await this.say({ kind: 'alert', text: FORGE_BASE_ALERT }); }
    return this.baseOk;
  }

  /**
   * Boot (3.6, PF-C3, PF-C5, PF-C6): clean the stage root (only exactly named children of a verified parent); sweep forge containers by exact name; then every `building` row: its image is removed first
   * (never one that a pending, active or quarantined server holds), then the row is requeued (a crash does not refund the attempt; at 3 attempts it fails `interrupted`); then the base check.
   */
  async recover(): Promise<void> {
    try {
      if (!(await cleanStageRoot(this.d.stageRoot))) this.d.log.error({ code: 'stage_root' }, 'forge stage root is not safe');
      if (!(await sweepForgeContainers(this.d.docker))) { this.latch.set(); await this.say({ kind: 'alert', text: FORGE_STUCK_ALERT }); }
      for (const r of await this.d.repo.recover()) {
        try {
          if (r.imageId !== null && !(await this.d.repo.imageInUse(r.imageId))) {
            // G2-FG-13: the id comes from the DB; only an image labelled as this build's is removed, anything else is not ours to touch
            if (!(await this.labelled(r.imageId, r.id))) { this.latch.set(); await this.d.repo.fail(r.id, 'stuck'); await this.say({ kind: 'alert', text: FORGE_STUCK_ALERT }); continue; }
            if (await removeImageVerified(this.d.docker, r.imageId)) await this.d.repo.imageRemoved(r.id, r.imageId.slice(7, 19));
            else { this.latch.set(); await this.d.repo.fail(r.id, 'stuck'); await this.say({ kind: 'alert', text: FORGE_STUCK_ALERT }); continue; }
          }
          await this.d.repo.requeue(r.id, { why: 'interrupted', refund: false });
        } catch (e) { this.d.log.error({ errName: errName(e) }, 'forge recover row failed'); }
      }
      await this.checkBase();
    } catch (e) {
      this.d.log.error({ errName: errName(e) }, 'forge recover failed');
    }
  }

  /** One tick (every 30 s): skipped when halted, switched off or latched; claim and build the oldest eligible build; reconcile; expire old queued builds. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (this.halted() || !this.enabled()) return;
      if (!this.latch.stuck && (this.baseOk || (await this.checkBase()))) {
        const b = await this.d.repo.claimNext();
        if (b !== null) await this.runBuild(b);
      }
      for (const e of await this.d.repo.reconcile()) await this.onEvent(e);
      await this.d.repo.expireQueued();
    } catch (e) {
      this.d.log.error({ errName: errName(e) }, 'forge tick failed');
    } finally {
      this.running = false;
    }
  }

  private async runBuild(b: ClaimedBuild): Promise<void> {
    let r: BuildResult;
    try {
      const c = await this.d.repo.counts(b.forgeId, this.d.tz());
      // the retained-image cap is re-checked at build time: this build has not made its image yet
      r = c.images >= IMAGES_KEPT_MAX ? { kind: 'failed', code: 'image_cap' } : await this.builder.build(b);
    } catch (e) {
      this.d.log.error({ errName: errName(e) }, 'forge build crashed');
      r = { kind: 'error' };
    }
    try {
      await this.apply(b, r);
    } catch (e) {
      this.d.log.error({ errName: errName(e) }, 'forge build result failed');
    }
  }

  private async apply(b: ClaimedBuild, r: BuildResult): Promise<void> {
    if (r.kind === 'requeue') { await this.d.repo.requeue(b.id, { why: 'halted', refund: true }); return; }
    if (r.kind === 'error') { await this.d.repo.requeue(b.id, { why: 'interrupted', refund: false }); return; }
    if (r.kind === 'failed') {
      if (await this.d.repo.fail(b.id, r.code)) await this.say({ kind: 'failed_software', deptId: b.releaseDeptId, taskId: b.releaseTaskId, text: NOTICE_FAILED_SOFTWARE(b.releaseId, r.code) });
      return;
    }
    const srv = await this.d.repo.serverOfRelease(b.releaseId);
    const ok = srv !== null && (await this.d.repo.staged(b.id, { imageId: r.imageId, baseImageId: r.baseImageId, imageBytes: r.imageBytes, serverId: srv.id, slug: r.slug, cfg12: r.config12 === '' ? 'adopted' : r.config12 }));
    if (!ok) {
      // the forge ended while the build ran: the pending server row stays for a Bot Admin to disable; the image stays (that server holds it)
      await this.d.repo.fail(b.id, 'stage_state');
      return;
    }
    await this.say({ kind: 'staged_software', deptId: b.releaseDeptId, taskId: b.releaseTaskId, text: NOTICE_STAGED_SOFTWARE(r.slug, b.releaseId) });
    await this.say({ kind: 'staged_hq', text: r.config12 !== '' ? NOTICE_STAGED_HQ(b.forgeId, r.slug, b.releaseId, r.imageId, r.toolCount, r.config12) : NOTICE_STAGED_HQ_ADOPTED(b.forgeId, r.slug, b.releaseId, r.imageId) });
  }

  private async onEvent(e: ReconcileEvent): Promise<void> {
    if (e.kind !== 'installed') return;
    const text = NOTICE_INSTALLED(e.ideaId, e.ideaName, e.slug, e.tools);
    // to the idea's department and to the software head's (the release requester's); once when they are the same
    for (const deptId of new Set([e.deptId, e.releaseDeptId])) await this.say({ kind: 'installed', deptId, text });
  }

  /**
   * Image GC (3.7, PF-C5), skipped while halted; only here, only with `docker image rm` and no `-f`. Remove image X only when ALL hold: (a) X is a build's kept image, (b) inspect shows the labels
   * `assistant.forge=1` and `assistant.forge.build` = that build id, (c) no pending, active or quarantined server holds X, (d) the build failed, or its server was disabled for 7 days, or it has no
   * server 1 h after it finished (the repo's candidate query). Then the orphan pass: a forge-labelled image the daemon lists whose build row has no or another image id, rule (c) holds, and (G2-FG-06) its sha256 label is that build's, its layers are the base's plus one and no server row of any status holds its id.
   * The base, the ws images, admin-added images and unlabelled images are never listed here and never match.
   */
  async gc(): Promise<void> {
    if (this.gcRunning) return;
    this.gcRunning = true;
    try {
      if (this.halted()) return;
      for (const c of await this.d.repo.gcCandidates()) {
        try {
          if (!(await this.labelled(c.imageId, c.buildId))) continue;
          if (await this.d.repo.imageInUse(c.imageId)) continue; // re-checked right before the removal
          if (await removeImageVerified(this.d.docker, c.imageId)) await this.d.repo.imageRemoved(c.buildId, c.imageId.slice(7, 19));
          else await this.d.audit({ actor: 'system:forge', action: 'forge.gc', outcome: `#${c.buildId} failed:rm` });
        } catch (e) { this.d.log.error({ errName: errName(e) }, 'forge gc candidate failed'); }
      }
      await this.orphans();
    } catch (e) {
      this.d.log.error({ errName: errName(e) }, 'forge gc failed');
    } finally {
      this.gcRunning = false;
    }
  }

  // ---- `/forge` (5.8): reads and the one cancel; none of them builds, stages or installs ------------------------------------------------------------------

  async list(n: number): Promise<ForgeListItem[]> {
    try { return await this.d.repo.listItems(n); } catch (e) { this.d.log.error({ errName: errName(e) }, 'forge list failed'); return []; }
  }
  async show(id: number): Promise<ForgeDetail | null> {
    try { return await this.d.repo.detail(id); } catch (e) { this.d.log.error({ errName: errName(e) }, 'forge show failed'); return null; }
  }
  async cancel(c: { id: number; userId: string }): Promise<ForgeCancelResult> {
    if (!Number.isSafeInteger(c.id) || c.id < 1) return { ok: false, code: 'not_found' };
    try {
      const r = await this.d.repo.adminCancel(c.id, c.userId);
      if (r.ok || r.code !== 'busy' || !(await this.requeueStale(c.id))) return r;
      return await this.d.repo.adminCancel(c.id, c.userId);
    } catch (e) { this.d.log.error({ errName: errName(e) }, 'forge cancel failed'); return { ok: false, code: 'exception' }; }
  }

  /**
   * G2-FG-11: `building` rows can outlive their build while the switch is off (the boot recover runs only while `forge.enabled` is on). With the switch off (or unreadable) and no build running in this
   * process, a `building` row of the named forge that holds no image is requeued as a crash would (no refund, no Docker), so `/forge cancel` can end it. A row with an image stays: removing the image needs Docker, which
   * only the recover touches, and only while the switch is on. Returns true when a row was requeued.
   */
  private async requeueStale(forgeId: number): Promise<boolean> {
    if (this.running || this.enabled()) return false;
    let any = false;
    for (const r of await this.d.repo.recover()) {
      if (r.forgeId !== forgeId || r.imageId !== null || this.running || this.enabled()) continue; // re-checked per row: a tick must never lose a build it just claimed
      if ((await this.d.repo.requeue(r.id, { why: 'interrupted', refund: false })) !== null) any = true;
    }
    return any;
  }

  /** The build id an image's label names, when the image carries `assistant.forge=1`; null otherwise (also on any inspect or parse failure). */
  private async buildOf(imageId: string): Promise<number | null> {
    return (await this.labelsOf(imageId))?.build ?? null;
  }
  /** The forge labels of an image (build id and sha256 label, null when absent or malformed) and its layers; null when it is not forge-labelled or could not be inspected. */
  private async labelsOf(imageId: string): Promise<{ build: number; sha256: string | null; layers: string[] } | null> {
    const r = await this.d.docker.exec(imageInspectArgv(imageId), EXEC_MS.inspect).catch(() => null);
    if (r === null || r.code !== 0 || r.timedOut) return null;
    const img = parseInspect(r.stdout);
    const labels = img?.config.Labels;
    if (img === null || img.id !== imageId || labels === null || typeof labels !== 'object' || Array.isArray(labels)) return null;
    const l = labels as Record<string, unknown>;
    const n = l[LABEL_BUILD];
    if (!(l['assistant.forge'] === '1' && typeof n === 'string' && /^[1-9][0-9]{0,11}$/.test(n))) return null;
    const sha = l['assistant.forge.sha256'];
    return { build: Number(n), sha256: typeof sha === 'string' ? sha : null, layers: img.layers };
  }
  private async labelled(imageId: string, buildId: number): Promise<boolean> {
    return (await this.buildOf(imageId)) === buildId;
  }

  private async orphans(): Promise<void> {
    const ls = await this.d.docker.exec(forgeImagesArgv(), EXEC_MS.inspect).catch(() => null);
    if (ls === null || ls.code !== 0 || ls.timedOut) return;
    const base = this.d.baseImageId === null ? null : await inspectBase(this.d.docker, this.d.baseImageId);
    if (base === null) return; // without the recorded base's layers nothing is provably ours
    const seen = new Set<string>();
    for (const line of ls.stdout.split('\n')) {
      const id = line.trim();
      if (!BASE_RE.test(id) || seen.has(id)) continue;
      seen.add(id);
      try {
        if (await this.d.repo.imageKept(id)) continue; // a row owns it
        const lab = await this.labelsOf(id);
        if (lab === null) continue; // label missing or malformed: not provably ours
        const n = lab.build;
        const owner = await this.d.repo.imageOwner(n);
        if (owner === null || owner.imageId === id || owner.status === 'building') continue; // unknown build, the same image, or a build that is still running
        // G2-FG-06: labels are image-author text. Also: the sha256 label is that build's, the layers are the base plus exactly one, and no server row of ANY status ever held the id
        if (lab.sha256 !== owner.sha256) continue;
        if (base === null || lab.layers.length !== base.layers.length + 1 || base.layers.some((l, i) => lab.layers[i] !== l)) continue;
        if (await this.d.repo.imageEverHeld(id)) continue;
        if (await this.d.repo.imageInUse(id)) continue;
        await this.d.audit({ actor: 'system:forge', action: 'forge.gc', outcome: (await removeImageVerified(this.d.docker, id)) ? `#${n} removed ${id.slice(7, 19)}` : `#${n} failed:rm` });
      } catch (e) { this.d.log.error({ errName: errName(e) }, 'forge orphan failed'); }
    }
  }
}

/** What the slash layer gets (5.3, 5.8, PF-C13): three closures, not the service, so no timer, recover, gc or latch method is reachable through CommandDeps or the AI-driven admin console. */
export function forgeCommandDeps(s: Pick<ForgeService, 'list' | 'show' | 'cancel'>): ForgeCommandDeps {
  return { list: (n) => s.list(n), show: (id) => s.show(id), cancel: (c) => s.cancel(c) };
}

/** What the AI digest gets (5.10): the day counts and nothing else of the repo. */
export function forgeDigestDeps(r: Pick<ForgeRepo, 'day'>): Pick<ForgeRepo, 'day'> {
  return { day: (tz) => r.day(tz) };
}

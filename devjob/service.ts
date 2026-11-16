import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { redactText } from '../core/logger.js';
import type { DevJob, DevJobRepo } from '../db/repos/devjobs.js';
import { verifyBundle, intakeBundle } from '../executor/code-bundle.js';
import { createHash } from 'node:crypto';
import type { AuditFn } from '../governance/audit.js';
import { computeFacts, type Facts } from './facts.js';
import { realGit, readBlobs, type GitPort } from './git.js';
import { admission, mayStart, RefusalGate, utcDayStart, utcMonthStart } from './limits.js';
import type { Sandbox } from './launcher.js';
import { reviewInput, REVIEW_CODE, REVIEW_SECURITY, wrapTask } from './prompts.js';
import { blocks, parseReview, type ReviewVerdict } from './review.js';
import type { SupplyPort } from './supply.js';
import { MAX_BUNDLE_BYTES } from '../executor/code-bundle.js';

/**
 * The dev-job service (Gate 1 self-code). A request becomes a job row; a runner moves it through
 * planning -> coding -> testing -> reviewing -> ready, always cleaning up, and finally asks for a card. Every step is audited with code-written text.
 *
 * What is trusted: nothing the agent or the reviewer says. The bundle the agent produced is imported into a scratch bare repository owned by this
 * process (git never runs inside a directory a sandbox produced), every fact is computed from git objects by code, and tests run in a fresh
 * checkout of the head built from that bundle, so the agent's own node_modules and config files never reach the test container.
 */
export const ASSISTANT_REPO = 'Lab-Work-Space/Assistant';

export interface ModelProxyControl {
  register(jobId: string, capUsd: number): Promise<string>;
  close(jobId: string): Promise<{ spentUsd: number } | null>;
}
export interface SourcePort {
  /** The commit the job starts from: the tip of main in the owner's repository (committed objects only, never the working tree). */
  baseSha(): Promise<string>;
  /** `git bundle create - <rev>`: a full bundle. */
  fullBundle(rev: string): Promise<Buffer>;
}
type Repo = Pick<DevJobRepo, 'create' | 'get' | 'transition' | 'addSpend' | 'claimNext' | 'runningCount' | 'countSince' | 'spendSince' | 'putBundle' | 'failRunning'>;

export interface ServiceDeps {
  repo: Repo;
  sandbox: Sandbox;
  models: ModelProxyControl;
  source: SourcePort;
  supply: SupplyPort;
  /** A private directory for scratch repositories. */
  workDir: string;
  cfg: { budgetUsd(): number; jobCapUsd(): number; ownerUserId(): string | null };
  halted(): boolean;
  offDay(): boolean;
  audit: AuditFn;
  log: { error(o: unknown, m?: string): void };
  /** Posts the confirmation card. `confirmerId` is the one user who can press it (the owner for protected paths, OD-5). */
  postCard(p: { confirmerId: string; requesterId: string; channelId: string | null }, payload: unknown): Promise<{ ok: true; cardId: string } | { ok: false; error: string }>;
  now?: () => Date;
  /** Tells the requester (code-written text). */
  notify?: (job: DevJob, text: string) => Promise<void>;
  wallClockMs?: number;
}

export type RequestResult = { ok: true; jobId: string; queued: boolean } | { ok: false; error: string };

const short = (s: string) => s.slice(0, 12);

export class DevJobService {
  private readonly gate = new RefusalGate();
  private running: Promise<void> | null = null;

  constructor(private readonly d: ServiceDeps) {}

  private now(): Date { return (this.d.now ?? (() => new Date()))(); }
  private async audit(job: { id: string; requesterId: string }, action: string, outcome: string): Promise<void> {
    await this.d.audit({ actor: `user:${job.requesterId} via devjob`, action: `devjob.${action}`, tool: 'assistant', outcome: `${outcome} job:${job.id}`.slice(0, 480) }).catch(() => undefined);
  }

  /** X22: a tainted run never proposes; the caller (the tool) passes `tainted` from the run context. */
  async request(r: { repo: string; request: string; requesterId: string; channelId: string | null; tainted: boolean }): Promise<RequestResult> {
    const refuse = async (why: string): Promise<RequestResult> => {
      this.gate.noteRefused(r.requesterId);
      await this.d.repo.create({ repo: r.repo.slice(0, 100).match(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/) ? r.repo : ASSISTANT_REPO, kind: 'assistant', requesterId: r.requesterId, channelId: r.channelId, request: r.request || '-', status: 'refused', outcome: why }).catch(() => undefined);
      return { ok: false, error: why };
    };
    if (this.gate.blocked(r.requesterId)) return { ok: false, error: 'too many refused code requests; wait a few minutes' };
    if (r.tainted) return refuse('code changes cannot be proposed from a run that read untrusted content; ask a Bot Admin to request it directly');
    if (r.repo !== ASSISTANT_REPO) return refuse('only the Assistant repository is handled here; other repositories go through the pull-request path');
    if (r.request.trim().length < 10 || r.request.length > 4000) return refuse('describe the change in 10 to 4000 characters');
    const n = this.now();
    const why = admission({ day: await this.d.repo.countSince(utcDayStart(n)), requesterDay: await this.d.repo.countSince(utcDayStart(n), r.requesterId), monthSpendUsd: await this.d.repo.spendSince(utcMonthStart(n)) }, { budgetUsd: this.d.cfg.budgetUsd() });
    if (why) return refuse(why);
    const job = await this.d.repo.create({ repo: r.repo, kind: 'assistant', requesterId: r.requesterId, channelId: r.channelId, request: r.request });
    await this.audit(job, 'request', `queued repo:${r.repo}`);
    void this.pump();
    const gate = mayStart({ running: await this.d.repo.runningCount(), halted: this.d.halted(), offDay: this.d.offDay() });
    return { ok: true, jobId: job.id, queued: !gate.start };
  }

  /** Starts the next queued job when allowed. Called after a request, after a job ends, when a work day starts and when the halt is lifted. */
  pump(): Promise<void> {
    this.running ??= this.loop().finally(() => { this.running = null; });
    return this.running;
  }

  private async loop(): Promise<void> {
    {
      for (;;) {
        const g = mayStart({ running: await this.d.repo.runningCount(), halted: this.d.halted(), offDay: this.d.offDay() });
        if (!g.start) return;
        const job = await this.d.repo.claimNext(1);
        if (!job) return;
        await this.run(job).catch(async (err: unknown) => {
          this.d.log.error({ err: redactText(err instanceof Error ? err.message : 'error'), job: job.id }, 'dev job crashed');
          await this.d.repo.transition(job.id, ['planning', 'coding', 'testing', 'reviewing'], 'failed', { outcome: 'internal error' });
        });
      }
    }
  }

  /** After a restart: a job that was running cannot be resumed (its containers were removed); queued jobs wait for the next pump. */
  async recover(): Promise<void> {
    await this.d.repo.failRunning('the application restarted while the job was running');
    void this.pump();
  }

  /** The halt switch: running containers die, the running job fails, the queue stays frozen (pump refuses while halted). */
  async halt(): Promise<void> {
    await (this.d.sandbox as { killAll?: () => Promise<number> }).killAll?.();
    await this.d.repo.failRunning('halted');
  }

  private async scratch(job: string): Promise<{ dir: string; git: GitPort }> {
    mkdirSync(this.d.workDir, { recursive: true, mode: 0o700 });
    const dir = mkdtempSync(join(this.d.workDir, `${job}-`));
    const git = realGit(join(dir, 'repo.git'));
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(dir, 'repo.git')], { env: { PATH: process.env.PATH ?? '', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
    return { dir, git };
  }

  private async run(job: DevJob): Promise<void> {
    const id = job.id;
    let scratchDir: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    let spent = 0;
    const fail = async (from: Parameters<Repo['transition']>[1], why: string, patch: Parameters<Repo['transition']>[3] = {}) => {
      await this.d.repo.transition(id, from, why.startsWith('refused') ? 'refused' : 'failed', { ...patch, outcome: why });
      await this.audit(job, 'end', `failed ${why}`);
      await this.d.notify?.(job, `Dev job ${id} did not produce a change: ${why}.`);
    };
    const report: string[] = [];
    const logs = (title: string, text: string) => report.push(`## ${title}\n${redactText(text).slice(0, 20_000)}`);
    try {
      const base = await this.d.source.baseSha();
      if (!/^[0-9a-f]{40}$/.test(base)) return await fail(['planning'], 'could not resolve the base commit');
      await this.d.repo.transition(id, ['planning'], 'planning', { baseSha: base });
      await this.audit(job, 'start', `base:${short(base)}`);
      timer = setTimeout(() => void this.d.sandbox.kill(id), this.d.wallClockMs ?? 30 * 60_000);
      timer.unref();
      const sc = await this.scratch(id);
      scratchDir = sc.dir;
      const baseBundle = await this.d.source.fullBundle(base);
      // 1. coding: a clean checkout of the base with dependencies from the lockfile (prep container), then the agent.
      await this.d.repo.transition(id, ['planning'], 'coding');
      const prepBase = await this.d.sandbox.prepare(id, 'work', { bundle: baseBundle, rev: base });
      logs('prepare (base)', prepBase.log);
      if (!prepBase.ok) return await fail(['coding'], 'the dependency install failed', { report: report.join('\n') });
      const cred = await this.d.models.register(id, this.d.cfg.jobCapUsd());
      const agent = await this.d.sandbox.runAgent(id, { volume: prepBase.volume, base, credential: cred, brief: wrapTask(job.request) });
      logs('agent', agent.log);
      spent = (await this.d.models.close(id))?.spentUsd ?? 0;
      await this.d.repo.addSpend(id, spent);
      if (!agent.ok) return await fail(['coding'], agent.timedOut ? 'the agent ran out of time' : 'the agent failed', { report: report.join('\n') });
      const out = await this.d.sandbox.exportBundle(id, { volume: prepBase.volume, base });
      if (!out || out.length > MAX_BUNDLE_BYTES) return await fail(['coding'], 'the agent produced no usable change', { report: report.join('\n') });
      // 2. import into OUR scratch repository and derive everything from the objects.
      const seed = intakeBundle(join(sc.dir, 'in'), id, baseBundle);
      await sc.git.run(['bundle', 'unbundle', seed.path]);
      await sc.git.run(['update-ref', 'refs/heads/main', base]);
      const jobIn = intakeBundle(join(sc.dir, 'in'), id, out);
      const heads = (await sc.git.run(['bundle', 'list-heads', jobIn.path])).toString('utf8').trim().split('\n').filter(Boolean);
      if (heads.length !== 1) return await fail(['coding'], 'the agent output did not have exactly one head', { report: report.join('\n') });
      const head = heads[0]!.split(' ')[0]!;
      const v = await verifyBundle(sc.git, { bundlePath: jobIn.path, jobId: id, base, head });
      if (!v.ok) return await fail(['coding'], `the agent output was refused: ${v.why}`, { report: report.join('\n') });
      const bundleSha256 = createHash('sha256').update(out).digest('hex');
      const facts = await computeFacts(sc.git, base, head, this.d.supply, this.d.now ? () => this.d.now!().getTime() : undefined);
      if (facts.refusals.length) return await fail(['coding'], `refused: ${facts.refusals[0]!.slice(0, 200)}${facts.refusals.length > 1 ? ` (+${facts.refusals.length - 1} more)` : ''}`, { facts, report: report.join('\n'), headSha: head });
      // 3. tests, type check and build in fresh checkouts built from OUR objects (base and head), never from the agent's volume.
      await this.d.repo.transition(id, ['coding'], 'testing', { headSha: head, bundleSha256, facts });
      const run = async (tag: string, rev: string) => {
        const full = (await sc.git.run(['bundle', 'create', '-', rev === head ? 'refs/jobs/' + id : 'refs/heads/main'], { maxBytes: MAX_BUNDLE_BYTES })) ;
        const p = await this.d.sandbox.prepare(id, tag, { bundle: full, rev });
        logs(`prepare (${tag})`, p.log);
        if (!p.ok) return null;
        const t = await this.d.sandbox.runTests(id, { volume: p.volume });
        logs(`tests (${tag})`, t.log);
        return t;
      };
      const tHead = await run('head', head);
      if (!tHead) return await fail(['testing'], 'the dependency install failed at the head', { report: report.join('\n') });
      const tBase = await run('base', base);
      const before = tBase?.testsRun ?? 0;
      const tests = { before, after: tHead.testsRun, typecheck: tHead.typecheck, build: tHead.build };
      // X12: the count must not fall.
      if (!tHead.ok) return await fail(['testing'], `tests, type check or build failed at the head (${tHead.testsFailed} failed)`, { report: report.join('\n'), facts: { ...facts, tests } });
      if (tHead.testsRun < before) return await fail(['testing'], `refused: the test count fell from ${before} to ${tHead.testsRun}`, { report: report.join('\n'), facts: { ...facts, tests } });
      // 4. review: code always; security for anything with protected paths. Each is its own run; both can only block.
      const diff = (await sc.git.run(['diff', '--no-ext-diff', '--no-textconv', base, head], { maxBytes: 4 * 1024 * 1024 })).toString('utf8');
      await this.d.repo.transition(id, ['testing'], 'reviewing', { facts: { ...facts, tests }, diff: diff.slice(0, 2 * 1024 * 1024) });
      const changed = facts.files.filter((f) => f.status !== 'D').map((f) => f.path);
      const blobs = await readBlobs(sc.git, head, changed, 64 * 1024);
      const input = reviewInput({ intent: `Change to the Assistant repository (${facts.files.length} files)`, diff, files: [...blobs.files].filter(([, c]) => c !== null).map(([path, content]) => ({ path, content: content! })) });
      const review = async (kind: 'code' | 'security'): Promise<ReviewVerdict> => {
        const c = await this.d.models.register(id, this.d.cfg.jobCapUsd());
        const r = await this.d.sandbox.review(id, { kind, credential: c, input: `${kind === 'code' ? REVIEW_CODE : REVIEW_SECURITY}\n\n${input}` });
        const s = (await this.d.models.close(id))?.spentUsd ?? 0;
        spent += s;
        await this.d.repo.addSpend(id, s);
        return r.ok ? parseReview(r.stdout) : parseReview('');
      };
      const code = await review('code');
      const security = facts.lowRiskOnly ? ({ verdict: 'APPROVE', findings: [] } as ReviewVerdict) : await review('security');
      const verdicts = { code: code.verdict, security: facts.lowRiskOnly ? 'NOT_NEEDED' : security.verdict, findings: [...code.findings, ...security.findings].slice(0, 30), tests };
      if (blocks(code, security)) return await fail(['reviewing'], 'an automated review rejected the change', { verdicts, report: report.join('\n'), facts: { ...facts, tests } });
      // 5. ready: store the bundle, then ask for the card. The confirmer is the owner when any path is protected (OD-5).
      await this.d.repo.putBundle(id, bundleSha256, out);
      const confirmerId = facts.lowRiskOnly ? job.requesterId : this.d.cfg.ownerUserId();
      if (!confirmerId) return await fail(['reviewing'], 'this change touches protected paths and no owner is configured', { verdicts, report: report.join('\n') });
      const ready = await this.d.repo.transition(id, ['reviewing'], 'ready', { verdicts, report: report.join('\n'), facts: { ...facts, tests } });
      if (!ready) return;
      const card = await this.d.postCard({ confirmerId, requesterId: job.requesterId, channelId: job.channelId }, { jobId: id, repo: ASSISTANT_REPO, base, head, bundleSha256, requesterId: job.requesterId });
      if (!card.ok) {
        await this.d.repo.transition(id, ['ready'], 'failed', { outcome: `the card could not be posted: ${card.error.slice(0, 200)}` });
        await this.audit(job, 'end', `card refused ${card.error.slice(0, 120)}`);
        return;
      }
      await this.d.repo.transition(id, ['ready'], 'ready', { cardId: card.cardId });
      await this.audit(job, 'ready', `card:${card.cardId} base:${short(base)} head:${short(head)} bundle:${bundleSha256.slice(0, 12)} verdicts:${verdicts.code}/${verdicts.security} spend:$${spent.toFixed(2)} owner-only:${!facts.lowRiskOnly}`);
      await this.d.notify?.(job, `Dev job ${id} is ready: card #${card.cardId.slice(0, 8)}.`);
    } finally {
      if (timer) clearTimeout(timer);
      await this.d.models.close(id).catch(() => null);
      const c = await this.d.sandbox.cleanup(id).catch(() => ({ removed: false }));
      if (!c.removed) await this.audit(job, 'cleanup', 'WARNING containers or volumes remain');
      if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
    }
  }

  /** For the facts shown on the dashboard. */
  static factsOf(job: DevJob): Facts | null { return (job.facts ?? null) as Facts | null; }
}

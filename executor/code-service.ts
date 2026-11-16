import { createHash } from 'node:crypto';
import { rmSync } from 'node:fs';
import { z } from 'zod';
import { canonical } from '../config/store.js';
import type { CardItem } from '../admin/card.js';
import type { AdminCard } from '../db/repos/adminCards.js';
import type { AuditFn } from '../governance/audit.js';
import type { OutboxKind } from '../db/repos/exec.js';
import { computeFacts, type Facts } from '../devjob/facts.js';
import type { GitPort } from '../devjob/git.js';
import type { SupplyPort } from '../devjob/supply.js';
import { fitSummary, summaryLines, type Evidence } from '../devjob/summary.js';
import { intakeBundle, verifyBundle } from './code-bundle.js';
import type { CodeApplier } from './code-apply.js';

/**
 * The executor's code-change brain (Gate 1 self-code X16, X20, OD-5). The `code` card row and the bundle row are written by the MAIN application,
 * so they are data to check, never authority: everything shown to the human and everything applied is re-derived here from the bundle, in the
 * executor's own bare repository. The click binds to the head sha and the bundle sha256 that were shown.
 */
export const ASSISTANT_REPO = 'Lab-Work-Space/Assistant';
/** The decider has 30 minutes to read the diff before clicking (X20). */
export const CODE_CONFIRM_TTL_MS = 30 * 60_000;

export const StoredCode = z.object({
  jobId: z.string().regex(/^J-[0-9a-f]{16}$/),
  repo: z.literal(ASSISTANT_REPO),
  base: z.string().regex(/^[0-9a-f]{40}$/),
  head: z.string().regex(/^[0-9a-f]{40}$/),
  bundleSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** G2SC-09: who asked. The card's proposer is the confirmer (the owner for protected paths), so the requester travels here. */
  requesterId: z.string().regex(/^\d{17,20}$/),
}).strict();
export type StoredCode = z.infer<typeof StoredCode>;

export interface JobRow {
  id: string;
  requesterId?: string;
  repo: string;
  kind: string;
  status: string;
  baseSha: string | null;
  headSha: string | null;
  bundleSha256: string | null;
  spendUsd: number;
  /** Written by the main application: advisory. */
  facts: unknown;
  verdicts: unknown;
}
export interface CodeDeps {
  jobs: {
    get(id: string): Promise<JobRow | null>;
    getBundle(id: string): Promise<{ sha256: string; size: number; data: Buffer } | null>;
    finish(id: string, status: 'applied' | 'rolled_back' | 'failed', outcome: string): Promise<void>;
  };
  git: GitPort;
  /** The executor's directory for bundle copies. */
  bundleDir: string;
  applier: Pick<CodeApplier, 'apply' | 'rollback' | 'isBusy'>;
  /** G2SC-02: a problem string refuses everything (ownership of the code root, repo.git and the tools). */
  trust?: () => string | null;
  supply: SupplyPort;
  /** OD-5: the one user who may confirm a protected-path change. Null = such changes are refused. */
  ownerUserId: string | null;
  exec: { push(kind: OutboxKind, payload: Record<string, unknown>): Promise<void> };
  audit: AuditFn;
  log: { error(o: unknown, m?: string): void };
  dashboardUrl?: (head: string) => string | undefined;
  now?: () => number;
}

type Prepared = { ok: true; code: StoredCode; facts: Facts; ownerOnly: boolean; summary: string } | { ok: false; why: string };
export type CodeCheck = { ok: true; summary: string; ownerOnly: boolean; bind: { head: string; bundleSha256: string } } | { ok: false; why: string };
export type CodeApply = { kind: 'refused'; why: string } | { kind: 'done'; ok: boolean; lines: string[]; applied: number; total: number };

const advisory = (v: unknown): { tests?: Evidence['tests']; verdicts?: Evidence['verdicts']; summary?: string; review?: string } => {
  const o = (v ?? {}) as Record<string, unknown>;
  const t = o.tests as { before?: unknown; after?: unknown; typecheck?: unknown; build?: unknown } | undefined;
  return {
    ...(t && typeof t.before === 'number' && typeof t.after === 'number' ? { tests: { before: t.before, after: t.after, typecheck: t.typecheck === true, build: t.build === true } } : {}),
    ...(typeof o.code === 'string' && typeof o.security === 'string' ? { verdicts: { code: o.code.slice(0, 20), security: o.security.slice(0, 20) } } : {}),
    ...(typeof o.summary === 'string' ? { summary: o.summary } : {}),
    ...(typeof o.review === 'string' ? { review: o.review } : {}),
  };
};

export class CodeService {
  constructor(private readonly d: CodeDeps) {}

  /** Re-derives everything from the bundle. The bundle copy is deleted before returning. */
  private async prepare(raw: unknown, snapshot?: unknown): Promise<Prepared> {
    const bad = this.d.trust?.();
    if (bad) return { ok: false, why: `the executor's code root is not trusted: ${bad.slice(0, 200)}` };
    const p = StoredCode.safeParse(raw);
    if (!p.success) return { ok: false, why: 'the stored code change is no longer valid' };
    const code = p.data;
    if (snapshot !== undefined && canonical(code) !== (snapshot as { canon?: unknown } | null)?.canon) return { ok: false, why: 'the stored code change differs from the one that was shown' };
    const job = await this.d.jobs.get(code.jobId);
    if (!job || job.kind !== 'assistant' || job.repo !== ASSISTANT_REPO) return { ok: false, why: 'the job is not an Assistant code job' };
    if (job.status !== 'ready' && job.status !== 'confirmed') return { ok: false, why: `the job is ${job.status}, not ready` };
    if (job.requesterId !== undefined && job.requesterId !== code.requesterId) return { ok: false, why: 'the job record does not match the card' };
    if (job.baseSha !== code.base || job.headSha !== code.head || job.bundleSha256 !== code.bundleSha256) return { ok: false, why: 'the job record does not match the card' };
    if (this.d.applier.isBusy()) return { ok: false, why: 'another code change is being applied' };
    const b = await this.d.jobs.getBundle(code.jobId);
    if (!b) return { ok: false, why: 'the bundle is no longer stored; run the job again' };
    // X16: the card binds to the bytes the human was shown. The digest is recomputed here; the row's value is not used.
    if (createHash('sha256').update(b.data).digest('hex') !== code.bundleSha256) return { ok: false, why: 'the stored bundle does not match the digest on the card' };
    let path: string | undefined;
    try {
      const inb = intakeBundle(this.d.bundleDir, code.jobId, b.data);
      path = inb.path;
      const v = await verifyBundle(this.d.git, { bundlePath: path, jobId: code.jobId, base: code.base, head: code.head });
      if (!v.ok) return { ok: false, why: v.why };
      const facts = await computeFacts(this.d.git, code.base, code.head, this.d.supply, this.d.now);
      const ownerOnly = !facts.lowRiskOnly;
      const a = advisory({ ...(job.facts as object | null), ...(job.verdicts as object | null) });
      const ev: Evidence = { repo: code.repo, bundleSha256: code.bundleSha256, jobId: code.jobId, ownerOnly, requesterId: code.requesterId, spendUsd: job.spendUsd, ...(a.tests ? { tests: a.tests } : {}), ...(a.verdicts ? { verdicts: a.verdicts } : {}), ...(this.d.dashboardUrl?.(code.head) ? { dashboardUrl: this.d.dashboardUrl(code.head)! } : {}) };
      const summary = fitSummary(summaryLines(facts, ev, { ...(a.summary ? { summary: a.summary } : {}), ...(a.review ? { review: a.review } : {}) }));
      return { ok: true, code, facts, ownerOnly, summary };
    } catch (err) {
      this.d.log.error({ err: err instanceof Error ? err.name : 'error' }, 'code prepare failed');
      return { ok: false, why: 'the change could not be verified' };
    } finally {
      if (path) rmSync(path, { force: true });
    }
  }

  private items(code: StoredCode, facts: Facts, ownerOnly: boolean): CardItem[] {
    const prot = facts.files.filter((f) => f.protected).length;
    return [
      { label: 'Code change (Assistant)', old: `main ${code.base.slice(0, 12)}`, neu: `head ${code.head.slice(0, 12)}, ${facts.commits} commit(s), ${facts.files.length} file(s)`, risk: true },
      { label: 'Who can confirm', old: '-', neu: ownerOnly ? `owner only (${prot} protected path(s))` : 'a Bot Admin (documentation only)', risk: ownerOnly },
      ...(facts.deps.length ? [{ label: 'New dependencies', old: '-', neu: facts.deps.map((x) => `${x.name}@${x.version}`).join(', ').slice(0, 300), risk: true }] : []),
    ];
  }

  async propose(raw: unknown, userId: string): Promise<{ ok: true; payload: unknown; items: CardItem[]; snapshot: Record<string, unknown> } | { ok: false; error: string }> {
    const pre = StoredCode.safeParse(raw);
    if (!pre.success) return { ok: false, error: 'invalid code change' };
    const p = await this.prepare(pre.data);
    if (!p.ok) return { ok: false, error: p.why };
    if (p.facts.refusals.length) return { ok: false, error: `refused: ${p.facts.refusals[0]!.slice(0, 200)}${p.facts.refusals.length > 1 ? ` (+${p.facts.refusals.length - 1} more)` : ''}` };
    void userId;
    return { ok: true, payload: p.code, items: this.items(p.code, p.facts, p.ownerOnly), snapshot: { canon: canonical(p.code), ownerOnly: p.ownerOnly } };
  }

  /** Everything `apply` checks, without changing anything: what the second confirmation shows, or why the card is refused. */
  async check(card: Pick<AdminCard, 'payload' | 'snapshot'>, decidedBy: string): Promise<CodeCheck> {
    const p = await this.prepare(card.payload, card.snapshot);
    if (!p.ok) return p;
    if (p.facts.refusals.length) return { ok: false, why: `refused: ${p.facts.refusals[0]!.slice(0, 200)}${p.facts.refusals.length > 1 ? ` (+${p.facts.refusals.length - 1} more)` : ''}` };
    // OD-5: a protected-path diff needs the owner, a fixed user id in the executor's own environment. Unset = refused.
    if (p.ownerOnly && (!this.d.ownerUserId || decidedBy !== this.d.ownerUserId)) return { ok: false, why: this.d.ownerUserId ? 'this change touches protected paths: only the owner can confirm it' : 'this change touches protected paths and no owner is configured for the executor' };
    return { ok: true, summary: p.summary, ownerOnly: p.ownerOnly, bind: { head: p.code.head, bundleSha256: p.code.bundleSha256 } };
  }

  /** The one place a confirmed code card turns into a release. Re-derives, compares with what was shown, then applies under the lock. */
  async apply(card: Pick<AdminCard, 'id' | 'payload' | 'snapshot' | 'channelId'>, by: string, shown: { head: string; bundleSha256: string }): Promise<CodeApply> {
    const refuse = async (why: string): Promise<CodeApply> => {
      await this.d.audit({ actor: `user:${by} via code`, action: 'code.refused', tool: 'assistant', outcome: `refused card:${card.id} ${why.slice(0, 160)}` });
      return { kind: 'refused', why };
    };
    const c = await this.check(card, by);
    if (!c.ok) return refuse(c.why);
    if (c.bind.head !== shown.head || c.bind.bundleSha256 !== shown.bundleSha256) return refuse('the change differs from the one shown in the confirmation');
    const code = StoredCode.parse(card.payload);
    // X16: the verified bundle is imported again inside the lock; verifyBundle is repeated by prepare (main == base is checked under the same lock inside apply).
    const inb = await this.d.jobs.getBundle(code.jobId);
    if (!inb || createHash('sha256').update(inb.data).digest('hex') !== shown.bundleSha256) return refuse('the bundle changed after it was shown');
    await this.d.audit({ actor: `user:${by} via code`, action: 'code.requested-by', tool: 'assistant', outcome: `job:${code.jobId} requester:${code.requesterId} decider:${by} head:${code.head.slice(0, 12)}` });
    const r = await this.d.applier.apply({ jobId: code.jobId, base: code.base, head: code.head, by, bundleSha256: code.bundleSha256 });
    const status = r.ok ? 'applied' : r.outcome === 'rolled_back' || r.outcome === 'rollback_failed' ? 'rolled_back' : 'failed';
    await this.d.jobs.finish(code.jobId, status, r.lines[0] ?? '').catch((err: unknown) => this.d.log.error({ err: err instanceof Error ? err.name : 'error' }, 'job finish failed'));
    const text = `Code change ${code.head.slice(0, 12)} (job ${code.jobId}): ${r.ok ? 'applied and healthy' : r.outcome === 'refused' ? 'not applied' : r.outcome === 'rolled_back' ? 'ROLLED BACK' : 'ROLLBACK FAILED - manual action needed'}.`;
    await this.d.exec.push('code.result', { cardId: card.id, channelId: card.channelId, text }).catch(() => undefined);
    return r.outcome === 'refused' ? { kind: 'refused', why: r.lines[0]!.replace(/^Refused: /, '') } : { kind: 'done', ok: r.ok, lines: r.lines, applied: r.ok ? 1 : 0, total: 1 };
  }

  async rollback(by: string): Promise<{ ok: boolean; lines: string[] }> {
    const r = await this.d.applier.rollback(by);
    return { ok: r.ok, lines: r.lines };
  }
}

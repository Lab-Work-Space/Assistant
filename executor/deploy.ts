import { createHash } from 'node:crypto';
import { canonical } from '../config/store.js';
import { redactText } from '../core/logger.js';
import type { CardItem } from '../admin/card.js';
import type { AdminCard } from '../db/repos/adminCards.js';
import type { DeployJobRow } from '../db/repos/deploy.js';
import type { OutboxKind } from '../db/repos/exec.js';
import type { AuditFn } from '../governance/audit.js';
import { DeployRequest, ReadRequest, StoredDeploy, deriveName, describe, previewName, readRequest, requestLine, resolveRequest, resultRequest, urlOf, vpsRequest, type Category } from '../vps/ops.js';
import { readTar } from '../vps/static.js';
import type { CallResult } from '../vps/ssh.js';

/**
 * The executor's VPS deploy brain (Gate 1 V12, V21, V22, V23). Runs only inside the executor process (its own macOS user, OD-1), which alone
 * can read the deploy key. A card is data to be checked: apply re-validates the stored op and rebuilds the request from it.
 */
export interface DeployDeps {
  client: { call(line: string, stream?: Buffer, timeoutMs?: number): Promise<CallResult> };
  repo: {
    getUpload(sha256: string): Promise<{ size: number; data: Buffer } | null>;
    deleteUpload(sha256: string): Promise<void>;
    addJob(job: string, cardId: string, op: string, channelId: string): Promise<void>;
    finishJob(job: string, status: 'done' | 'failed' | 'lost'): Promise<void>;
    openJobs(): Promise<DeployJobRow[]>;
  };
  exec: { push(kind: OutboxKind, payload: Record<string, unknown>): Promise<void> };
  audit: AuditFn;
  log: { error(o: unknown, m?: string): void };
  secrets?: readonly string[];
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollEveryMs?: number;
  maxPollMs?: number;
}

export type DeployPropose = { ok: true; payload: unknown; items: CardItem[]; snapshot: Record<string, unknown> } | { ok: false; error: string };
export type DeployApply = { kind: 'refused'; why: string } | { kind: 'done'; ok: boolean; lines: string[]; applied: number; total: number };

const READ_PER_MIN_USER = 10;
const READ_PER_HOUR = 60;
const REPLY_CAP = 16 * 1024;
const MESSAGE_CAP = 1500;
const ERROR_TEXT: Record<string, string> = {
  KEY: 'the deploy key or the pinned host key is not set up correctly on this Mac',
  TIMEOUT: 'the VPS did not answer in time',
  UNREACHABLE: 'the VPS could not be reached',
  BAD_REQUEST: 'the VPS refused the request as malformed',
  BAD_REPLY: 'the VPS sent an unexpected answer',
  BUSY: 'the VPS has too many queued jobs; try again in a few minutes',
  TAR: 'the VPS refused the uploaded archive',
  DOWN: 'the VPS deploy receiver is not running',
};
const say = (code: string): string => ERROR_TEXT[code] ?? `the VPS refused the request (${code})`;

/** Untrusted text from the VPS (build log tails, lw-git errors): redacted again here, capped, and mentions defanged before it can reach Discord. */
export function safeText(s: unknown, secrets: readonly string[] = [], max = MESSAGE_CAP): string {
  const t = redactText(typeof s === 'string' ? s : '', secrets).replace(/[^\x09\x0a\x20-\x7e]/g, '?').replace(/@/g, '@\u200b');
  return t.length > max ? `${t.slice(0, max)} ...(cut)` : t;
}

export class DeployService {
  private readonly reads: { user: string; at: number }[] = [];
  private readonly watching = new Set<string>();

  constructor(private readonly d: DeployDeps) {}

  private now(): number { return (this.d.now ?? Date.now)(); }

  /** V22: reads are capped at 10 per minute per user and 60 per hour overall (every VPS call made for a proposal or a read counts). */
  private rateRead(userId: string): string | null {
    const t = this.now();
    while (this.reads.length && t - this.reads[0]!.at > 3_600_000) this.reads.shift();
    if (this.reads.filter((r) => r.user === userId && t - r.at < 60_000).length >= READ_PER_MIN_USER) return `rate limit: at most ${READ_PER_MIN_USER} deploy reads per minute per admin`;
    if (this.reads.length >= READ_PER_HOUR) return `rate limit: at most ${READ_PER_HOUR} deploy reads per hour in total`;
    this.reads.push({ user: userId, at: t });
    return null;
  }

  private async vps(userId: string, obj: Record<string, unknown>): Promise<CallResult | { ok: false; code: 'RATE'; why: string }> {
    const why = this.rateRead(userId);
    if (why) return { ok: false, code: 'RATE', why };
    const r = await this.d.client.call(requestLine(obj), undefined, 120_000);
    // The VPS worker handles one job at a time: a read that waits behind a build comes back as "queued". Say that, not a wrong refusal.
    if (r.ok && typeof (r.data as { queued?: unknown }).queued === 'string') return { ok: false, code: 'RATE', why: 'the VPS is busy with another job (a build can take up to 15 minutes); try again in a few minutes' };
    return r;
  }

  /** The head of a branch, as the VPS sees it right now. This sha goes on the card; apply sends only this one (V12). */
  private async resolve(userId: string, repo: string, branch: string, cardRef: string): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
    const r = await this.vps(userId, resolveRequest(repo, branch, cardRef));
    if (!r.ok) return { ok: false, error: 'why' in r ? r.why : say(r.code) };
    const d = r.data as { ok?: boolean; msg?: string; data?: { sha?: string } };
    if (d.ok !== true || typeof d.data?.sha !== 'string' || !/^[0-9a-f]{40}$/.test(d.data.sha)) return { ok: false, error: `the branch could not be resolved (${safeText(d.msg, this.d.secrets, 120)})` };
    return { ok: true, sha: d.data.sha };
  }

  private async registryEntry(userId: string, app: string): Promise<{ ok: true; repo: string; branch: string; kind: string } | { ok: false; error: string }> {
    const r = await this.vps(userId, readRequest({ kind: 'status', app }, 'propose'));
    if (!r.ok) return { ok: false, error: 'why' in r ? r.why : say(r.code) };
    const d = r.data as { ok?: boolean; msg?: string; data?: { apps?: { repo?: unknown; branch?: unknown; kind?: unknown }[] } };
    const row = d.data?.apps?.[0];
    if (d.ok !== true || !row) return { ok: false, error: `${app} is not an assistant-owned app (${safeText(d.msg, this.d.secrets, 120)})` };
    return { ok: true, repo: String(row.repo ?? ''), branch: String(row.branch ?? ''), kind: String(row.kind ?? '') };
  }

  /** Validates a request, fills in what only the VPS knows (the approved sha), and returns what the card stores and shows. */
  async propose(raw: unknown, userId: string): Promise<DeployPropose> {
    const req = DeployRequest.safeParse(raw);
    if (!req.success) return { ok: false, error: `invalid deploy request: ${req.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'op'}: ${i.message}`).join('; ').slice(0, 300)}` };
    const r = req.data;
    let stored: unknown;
    switch (r.op) {
      case 'add': {
        const n = r.name ?? deriveName(r.repo);
        if (!n) return { ok: false, error: 'give the site a name (lower case letters, digits and "-", at most 32 characters, no "--")' };
        const h = await this.resolve(userId, r.repo, r.branch ?? 'main', 'propose');
        if (!h.ok) return h;
        stored = { ...r, name: n, sha: h.sha };
        break;
      }
      case 'preview': {
        // The base is an app the assistant deployed from this repo (V7, V13); the preview name is computed HERE so the card shows the real address.
        const all = await this.vps(userId, readRequest({ kind: 'status' }, 'propose'));
        if (!all.ok) return { ok: false, error: 'why' in all ? all.why : say(all.code) };
        const rows = ((all.data as { data?: { apps?: { app?: unknown; kind?: unknown; repo?: unknown }[] } }).data?.apps ?? [])
          .filter((a) => a.kind === 'app' && typeof a.app === 'string' && a.app.startsWith('apps/') && a.repo === r.repo)
          .map((a) => (a.app as string).slice(5))
          .filter((n) => !r.base || n === r.base);
        if (rows.length !== 1) return { ok: false, error: rows.length === 0 ? `no app of ${r.repo} was deployed through this path, so there is nothing to preview (deploy it first)` : 'several apps of this repo exist: name the one to preview with "base"' };
        const pn = previewName(rows[0]!, r.branch);
        if (!pn) return { ok: false, error: 'the branch cannot be turned into a valid preview name' };
        const h = await this.resolve(userId, r.repo, r.branch, 'propose');
        if (!h.ok) return h;
        stored = { op: 'preview', repo: r.repo, branch: r.branch, ...(r.ttlHours ? { ttlHours: r.ttlHours } : {}), base: rows[0], name: pn, sha: h.sha };
        break;
      }
      case 'redeploy': {
        const e = await this.registryEntry(userId, r.app);
        if (!e.ok) return e;
        if (e.kind === 'static') return { ok: false, error: 'a static site is updated by publishing it again, not by redeploy' };
        const h = await this.resolve(userId, e.repo, e.branch, 'propose');
        if (!h.ok) return h;
        stored = { ...r, sha: h.sha };
        break;
      }
      case 'remove': {
        const e = await this.registryEntry(userId, r.app);
        if (!e.ok) return e;
        stored = r;
        break;
      }
      case 'publish_static': {
        const up = await this.d.repo.getUpload(r.sha256);
        if (!up || up.size !== r.size || up.data.length !== r.size) return { ok: false, error: 'the packed site is not in the upload store (pack it again)' };
        if (createHash('sha256').update(up.data).digest('hex') !== r.sha256) return { ok: false, error: 'the stored archive does not match its digest' };
        const t = readTar(up.data);
        if (!t.ok) return { ok: false, error: `the archive is not acceptable: ${t.error}` };
        stored = r;
        break;
      }
    }
    const parsed = StoredDeploy.safeParse(stored);
    if (!parsed.success) return { ok: false, error: 'the request could not be completed' };
    const desc = describe(parsed.data);
    const items: CardItem[] = [{ label: desc.label, old: desc.old, neu: desc.neu, risk: desc.risk }];
    return { ok: true, payload: parsed.data, items, snapshot: { canon: canonical(parsed.data) } };
  }

  /** All the checks of `apply` without any VPS call: what the second confirmation will show, or why the card is refused. */
  async check(card: Pick<AdminCard, 'id' | 'payload' | 'snapshot' | 'channelId'>): Promise<{ ok: true; summary: string } | { ok: false; why: string }> {
    const p = await this.prepare(card);
    if (!p.ok) return p;
    const d = describe(p.op);
    return { ok: true, summary: `${d.label}: ${d.neu}` };
  }

  private async prepare(card: Pick<AdminCard, 'id' | 'payload' | 'snapshot' | 'channelId'>): Promise<{ ok: true; op: StoredDeploy; stream?: Buffer } | { ok: false; why: string }> {
    const parsed = StoredDeploy.safeParse(card.payload);
    if (!parsed.success) return { ok: false, why: 'the stored operation is no longer valid' };
    const op = parsed.data;
    // V22: the stored op must be exactly what was proposed and shown (byte for byte, in canonical form).
    if (canonical(op) !== (card.snapshot as { canon?: unknown } | null)?.canon) return { ok: false, why: 'the stored operation differs from the one that was shown' };
    if (this.watching.size > 0) return { ok: false, why: 'another deploy is still running on the VPS; wait for its result' };
    if (op.op !== 'publish_static') return { ok: true, op };
    const up = await this.d.repo.getUpload(op.sha256);
    if (!up || createHash('sha256').update(up.data).digest('hex') !== op.sha256 || up.data.length !== op.size) return { ok: false, why: 'the packed site is no longer in the upload store; ask again' };
    const t = readTar(up.data);
    if (!t.ok) return { ok: false, why: `the archive is not acceptable: ${t.error}` };
    return { ok: true, op, stream: up.data };
  }

  /** The one place a confirmed deploy card turns into a request to the VPS. */
  async apply(card: Pick<AdminCard, 'id' | 'payload' | 'snapshot' | 'channelId'>, by: string): Promise<DeployApply> {
    const refuse = async (why: string): Promise<DeployApply> => {
      await this.d.audit({ actor: `user:${by} via deploy`, action: 'deploy.refused', tool: 'deploy', outcome: `refused card:${card.id} ${why.slice(0, 160)}` });
      return { kind: 'refused', why };
    };
    const prep = await this.prepare(card);
    if (!prep.ok) return refuse(prep.why);
    const { op, stream } = prep;
    const line = requestLine(vpsRequest(op, card.id));
    const res = await this.d.client.call(line, stream, op.op === 'publish_static' ? 900_000 : 180_000);
    const label = op.op === 'add' || op.op === 'publish_static' ? `${op.op === 'add' ? 'derived' : (op as { category: string }).category}/${'name' in op && op.name ? op.name : ''}` : 'app' in op ? op.app : (op as { repo: string }).repo;
    const sha = 'sha' in op ? op.sha : op.op === 'publish_static' ? op.sha256 : '-';
    if (!res.ok) {
      await this.d.audit({ actor: `user:${by} via deploy`, action: `deploy.${op.op}`, tool: label.slice(0, 80), outcome: `failed card:${card.id} sha:${sha.slice(0, 12)} ${res.code}` });
      return { kind: 'done', ok: false, applied: 0, total: 1, lines: [`Nothing was queued: ${say(res.code)}.`] };
    }
    const q = (res.data as { queued?: unknown }).queued;
    if (typeof q !== 'string' || !/^J-[0-9a-f]{16}$/.test(q)) {
      const msg = safeText((res.data as { msg?: unknown }).msg, this.d.secrets, 200);
      return { kind: 'done', ok: false, applied: 0, total: 1, lines: [`The VPS did not queue the job${msg ? `: ${msg}` : ''}.`] };
    }
    await this.d.repo.addJob(q, card.id, op.op, card.channelId);
    await this.d.audit({ actor: `user:${by} via deploy`, action: `deploy.${op.op}`, tool: label.slice(0, 80), outcome: `queued card:${card.id} job:${q} sha:${sha.slice(0, 12)}` });
    void this.watch({ job: q, cardId: card.id, op: op.op, channelId: card.channelId }, op);
    if (op.op === 'publish_static') await this.d.repo.deleteUpload(op.sha256).catch(() => undefined);
    return { kind: 'done', ok: true, applied: 1, total: 1, lines: [`Queued on the VPS as ${q}. The result is posted here when it finishes (a build can take several minutes).`] };
  }

  /** Polls `result` until the job ends, then queues one message for the card's channel (the executor cannot post). */
  private async watch(j: { job: string; cardId: string; op: string; channelId: string }, op?: StoredDeploy): Promise<void> {
    if (this.watching.has(j.job)) return;
    this.watching.add(j.job);
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const every = this.d.pollEveryMs ?? 15_000;
    const deadline = this.now() + (this.d.maxPollMs ?? 30 * 60_000);
    let text = '';
    let status: 'done' | 'failed' | 'lost' = 'lost';
    try {
      for (;;) {
        await sleep(every);
        const r = await this.d.client.call(requestLine(resultRequest(j.job, j.cardId)), undefined, 60_000);
        if (r.ok) {
          const d = r.data as { state?: string; ok?: boolean; msg?: string; data?: { url?: string; app?: string; sha?: string } };
          if (d.state !== 'pending' && typeof d.ok === 'boolean') {
            status = d.ok ? 'done' : 'failed';
            const url = d.data?.url && /^https:\/\/[a-z0-9.-]+\.labworkspace\.net\/[a-z0-9/-]*$/.test(d.data.url) ? d.data.url : '';
            text = d.ok
              ? `Deploy ${j.op} finished${url ? `: ${url}` : ''}${d.data?.sha ? ` (${safeText(d.data.sha, [], 12)})` : ''}. Card #${j.cardId.slice(0, 8)}.`
              : `Deploy ${j.op} FAILED: ${safeText(d.msg, this.d.secrets, 400)}. Card #${j.cardId.slice(0, 8)}.`;
            break;
          }
        }
        if (this.now() > deadline) {
          text = `Deploy ${j.op}: no result after ${Math.round((this.d.maxPollMs ?? 1_800_000) / 60_000)} minutes. Check the status with deploy_read. Card #${j.cardId.slice(0, 8)}.`;
          break;
        }
      }
    } catch (err) {
      this.d.log.error({ err: err instanceof Error ? err.name : 'error', job: j.job }, 'deploy poll failed');
      text = `Deploy ${j.op}: the result could not be read. Check the status with deploy_read. Card #${j.cardId.slice(0, 8)}.`;
    } finally {
      this.watching.delete(j.job);
    }
    await this.d.repo.finishJob(j.job, status).catch(() => undefined);
    await this.d.exec.push('deploy.result', { cardId: j.cardId, channelId: j.channelId, text: safeText(text, this.d.secrets) }).catch((err: unknown) => this.d.log.error({ err: err instanceof Error ? err.name : 'error' }, 'deploy result outbox failed'));
    await this.d.audit({ actor: 'system:executor', action: 'deploy.result', tool: j.op, outcome: `${status} card:${j.cardId} job:${j.job}` }).catch(() => undefined);
    void op;
  }

  /** After a restart: keep polling jobs that were queued and not yet reported. */
  async resume(): Promise<number> {
    const open = await this.d.repo.openJobs();
    for (const j of open) void this.watch({ job: j.job, cardId: j.cardId, op: j.op, channelId: j.channelId });
    return open.length;
  }

  /** `deploy_read` (status, logs). The caller has checked Bot Admin. The output is untrusted text: redacted again, capped, mentions defanged (V21). */
  async read(userId: string, raw: unknown): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const req = ReadRequest.safeParse(raw);
    if (!req.success) return { ok: false, error: 'invalid read request' };
    const r = await this.vps(userId, readRequest(req.data, `read-${Math.floor(this.now() / 1000)}`));
    if (!r.ok) return { ok: false, error: 'why' in r ? r.why : say(r.code) };
    const d = r.data as { ok?: boolean; msg?: string; data?: unknown };
    if (d.ok !== true) return { ok: false, error: safeText(d.msg ?? 'refused', this.d.secrets, 200) };
    return { ok: true, text: safeText(JSON.stringify(d.data), this.d.secrets, REPLY_CAP) };
  }

  /** For tests and the status display. */
  busy(): boolean { return this.watching.size > 0; }
}

export type { Category };
export { urlOf };

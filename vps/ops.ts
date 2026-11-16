import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * The deploy vocabulary (Gate 1 V6, V22). The same closed set the VPS receiver accepts (infra/vps/files/assistant/lw_assistant_core.py); the
 * regexes are copies, and vps/ops.test.ts checks the shared examples. A card stores a `StoredDeploy`; the executor re-validates it at apply and
 * builds the request line from it byte for byte, so the card is the only thing that decides what is sent.
 */
export const ORG = 'Lab-Work-Space';
export const CATEGORIES = ['apps', 'api'] as const;
export type Category = (typeof CATEGORIES)[number];

const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
const REPO_RE = /^(?![-.])[A-Za-z0-9._-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const CARD_RE = /^[A-Za-z0-9_-]{1,64}$/;
const JOB_RE = /^J-[0-9a-f]{16}$/;
const APP_RE = /^(apps|api)\/[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/;
export const MAX_STATIC_BYTES = 50 * 1024 * 1024;

const name = z.string().regex(NAME_RE).refine((v) => !v.includes('--'), { error: "'--' is reserved for previews" });
const repo = z.string().regex(REPO_RE);
const branch = z.string().regex(/^(?!-)[A-Za-z0-9._/-]{1,100}$/).refine((v) => !v.includes('..') && !v.includes('//') && !v.includes('@{') && !v.endsWith('.lock') && !v.endsWith('/') && !v.startsWith('/'), { error: 'not a plain branch name' });
const category = z.enum(CATEGORIES);
const app = z.string().regex(APP_RE);
const sha = z.string().regex(SHA_RE);

/** What the model or a front end may ask for (no sha: the executor resolves the branch head at propose time and shows it on the card). */
export const DeployRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), repo, category, name: name.optional(), branch: branch.optional() }).strict(),
  z.object({ op: z.literal('redeploy'), app }).strict(),
  z.object({ op: z.literal('remove'), app }).strict(),
  z.object({ op: z.literal('preview'), repo, branch, ttlHours: z.number().int().min(1).max(168).optional(), base: name.optional() }).strict(),
  z.object({ op: z.literal('publish_static'), name, category: z.literal('apps'), sha256: z.string().regex(SHA256_RE), size: z.number().int().min(1).max(MAX_STATIC_BYTES) }).strict(),
]);
export type DeployRequest = z.infer<typeof DeployRequest>;

/** What a card stores: the request plus the sha the Bot Admin approved (V12). */
export const StoredDeploy = z.discriminatedUnion('op', [
  // The card always carries the final name (add) and base + computed name (preview): the VPS never picks a name the Bot Admin did not see.
  z.object({ op: z.literal('add'), repo, category, name, branch: branch.optional(), sha }).strict(),
  z.object({ op: z.literal('redeploy'), app, sha }).strict(),
  z.object({ op: z.literal('remove'), app }).strict(),
  z.object({ op: z.literal('preview'), repo, branch, ttlHours: z.number().int().min(1).max(168).optional(), base: name, name: z.string().regex(NAME_RE), sha }).strict(),
  z.object({ op: z.literal('publish_static'), name, category: z.literal('apps'), sha256: z.string().regex(SHA256_RE), size: z.number().int().min(1).max(MAX_STATIC_BYTES) }).strict(),
]);
export type StoredDeploy = z.infer<typeof StoredDeploy>;

export const ReadRequest = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('status'), app: app.optional() }).strict(),
  z.object({ kind: z.literal('logs'), app, lines: z.number().int().min(1).max(200).optional() }).strict(),
]);
export type ReadRequest = z.infer<typeof ReadRequest>;

/** A site name from a repo name when the model gave none (lower case, runs of other characters become one '-', at most 32). Null = give a name. */
export function deriveName(repoName: string): string | null {
  const n = repoName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '');
  return NAME_RE.test(n) && !n.includes('--') ? n : null;
}

/**
 * V14, the same function as `preview_name` in infra/vps/files/assistant-deploy/lw_assistant_core.py (shared vectors in vps/ops.test.ts and
 * assistant_core_test.py): `<base>--<slug>`, or `<base>--<slugN>-<h6>` when longer than 32 characters. Null = refused.
 */
export function previewName(base: string, br: string): string | null {
  if (base.includes('--') || !NAME_RE.test(base)) return null;
  let slug = br.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return null;
  slug = slug.replace(/-{2,}/g, '-');
  let n = `${base}--${slug}`;
  if (n.length > 32 || !NAME_RE.test(n)) {
    const h = createHash('sha256').update(br).digest('hex').slice(0, 6);
    const room = 32 - base.length - 2 - 7;
    if (room < 1) return null;
    n = `${base}--${slug.slice(0, room).replace(/^-+|-+$/g, '') || 'b'}-${h}`;
  }
  return NAME_RE.test(n) && n.split('--').length === 2 && n.length <= 32 ? n : null;
}

/** The request object sent to the VPS (key order fixed; every value is ASCII by the regexes above). `cardId` is echoed in the VPS journal (V23). */
export function vpsRequest(op: StoredDeploy, cardId: string): Record<string, string | number> {
  if (!CARD_RE.test(cardId)) throw new Error('bad card id');
  switch (op.op) {
    case 'add': return { op: 'add', card_id: cardId, repo: op.repo, category: op.category, sha: op.sha, name: op.name, ...(op.branch ? { branch: op.branch } : {}) };
    case 'redeploy': return { op: 'redeploy', card_id: cardId, app: op.app, sha: op.sha };
    case 'remove': return { op: 'remove', card_id: cardId, app: op.app };
    case 'preview': return { op: 'preview', card_id: cardId, repo: op.repo, branch: op.branch, sha: op.sha, base: op.base, ...(op.ttlHours ? { ttl_hours: op.ttlHours } : {}) };
    case 'publish_static': return { op: 'publish_static', card_id: cardId, name: op.name, category: op.category, sha256: op.sha256, size: op.size };
  }
}

export function readRequest(r: ReadRequest, cardId: string): Record<string, string | number> {
  if (!CARD_RE.test(cardId)) throw new Error('bad card id');
  return r.kind === 'status' ? { op: 'status', card_id: cardId, ...(r.app ? { app: r.app } : {}) } : { op: 'logs', card_id: cardId, app: r.app, lines: r.lines ?? 100 };
}
export const resolveRequest = (repoName: string, br: string, cardId: string) => ({ op: 'resolve', card_id: cardId, repo: repo.parse(repoName), branch: branch.parse(br) });
export const resultRequest = (job: string, cardId: string) => {
  if (!JOB_RE.test(job) || !CARD_RE.test(cardId)) throw new Error('bad job');
  return { op: 'result', card_id: cardId, job };
};

/** One request line: compact JSON, ASCII only, at most 4096 bytes (V6). */
export function requestLine(o: Record<string, unknown>): string {
  const s = JSON.stringify(o);
  if (!/^[\x20-\x7e]+$/.test(s) || s.length > 4096) throw new Error('request is not plain ASCII within 4 KiB');
  return `${s}\n`;
}

/** The public address of an app (display only; the VPS computes the real one). */
export function urlOf(cat: Category, n: string): string {
  return cat === 'apps' ? `https://${n}.labworkspace.net/` : `https://api.labworkspace.net/${n}/`;
}

/** Human summary shown on the card (code-written; the model's words never reach it). */
export function describe(op: StoredDeploy): { label: string; old: string; neu: string; risk: boolean } {
  const short = (s: string) => s.slice(0, 12);
  switch (op.op) {
    case 'add': return { label: 'Deploy new site', old: '(not deployed)', neu: `${ORG}/${op.repo}@${short(op.sha)} (branch ${op.branch ?? 'main'}) -> ${urlOf(op.category, op.name)}; no auto-redeploy (pinned to this sha)`, risk: true };
    case 'redeploy': return { label: 'Redeploy', old: op.app, neu: `build and run sha ${short(op.sha)} of ${op.app}`, risk: true };
    case 'remove': return { label: 'Remove site', old: op.app, neu: '(removed: DNS record, Caddy site, images, registration)', risk: true };
    case 'preview': return { label: 'Branch preview', old: '(none)', neu: `${ORG}/${op.repo}@${short(op.sha)} (branch ${op.branch}) -> ${urlOf('apps', op.name)} for ${Math.min(op.ttlHours ?? 72, 168)} h; noindex; app ${op.base} is not touched`, risk: true };
    case 'publish_static': return { label: 'Publish static site', old: '(upload)', neu: `${op.category}/${op.name}: ${(op.size / 1024).toFixed(0)} KiB, sha256 ${op.sha256.slice(0, 12)}; served with a strict CSP at ${urlOf(op.category, op.name)}`, risk: true };
  }
}

/** The reply grammar of the relay: `OK {json}` or `ERR CODE`. */
export const Reply = z.union([z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) }).strict(), z.object({ ok: z.literal(false), code: z.string().regex(/^[A-Z_]{1,20}$/) }).strict()]);
export function parseReply(line: string): { ok: true; data: Record<string, unknown> } | { ok: false; code: string } {
  const t = line.replace(/\r?\n$/, '');
  if (/^ERR [A-Z_]{1,20}$/.test(t)) return { ok: false, code: t.slice(4) };
  if (t.startsWith('OK {') && t.length <= 17_000 && /^[\x20-\x7e]+$/.test(t)) {
    try {
      const v: unknown = JSON.parse(t.slice(3));
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) return { ok: true, data: v as Record<string, unknown> };
    } catch { /* fall through */ }
  }
  return { ok: false, code: 'BAD_REPLY' };
}

import { promptRefAllowed } from '../../knowledge/targets.js';
import type { Pool } from '../pool.js';

export const KB_BODY_MAX = 20_000;
export const KB_TITLE_MAX = 200;
export const SNIPPET_MAX = 600;
export const SEARCH_QUERY_MAX = 200;
export const SEARCH_RESULTS_MAX = 5;

export interface KbDoc {
  id: number; scope: string; title: string; body: string; version: number; status: 'active' | 'archived';
  sources: unknown; tainted: boolean; createdBy: string; createdAt: Date; updatedAt: Date;
}
export interface KbVersion { id: number; docId: number; version: number; title: string; body: string; sources: unknown; tainted: boolean; createdBy: string; createdAt: Date }
export interface KbHit { id: number; scope: string; title: string; version: number; tainted: boolean; snippet: string }
/** Who is reading. Taken from the actor profile by code, never from a tool argument (K11). */
export type KbViewer = { dept: string; praw: boolean };

const DOC_COLS = 'id, scope, title, body, version, status, sources, tainted, created_by AS "createdBy", created_at AS "createdAt", updated_at AS "updatedAt"';
const VER_COLS = 'id, doc_id AS "docId", version, title, body, sources, tainted, created_by AS "createdBy", created_at AS "createdAt"';

/**
 * K11: scope is a SQL filter here, not only a check in the tool. A department reads its own scope plus 'company'. Praw reads every
 * scope except other departments' tainted documents (K11). `$n` placeholders are bound by the callers; nothing is concatenated.
 */
const VISIBLE = (dept: string, praw: string) => `(${dept}::text = scope OR scope = 'company' OR (${praw}::boolean AND (NOT tainted OR scope = 'praw')))`;

export class KbRepo {
  constructor(private readonly pool: Pool) {}

  async create(d: { scope: string; title: string; body: string; sources: unknown; tainted: boolean; createdBy: string }): Promise<KbDoc> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const doc = (await c.query<KbDoc>(
        `INSERT INTO kb_docs (scope, title, body, sources, tainted, created_by) VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING ${DOC_COLS}`,
        [d.scope, d.title, d.body, JSON.stringify(d.sources), d.tainted, d.createdBy])).rows[0]!;
      await c.query('INSERT INTO kb_versions (doc_id, version, title, body, sources, tainted, created_by) VALUES ($1,1,$2,$3,$4::jsonb,$5,$6)',
        [doc.id, d.title, d.body, JSON.stringify(d.sources), d.tainted, d.createdBy]);
      await c.query('COMMIT');
      return doc;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  /** New version only if the doc is still at `expected` (compare-and-swap); `status` 'archived' archives it. Taint is sticky: it can only be raised. */
  async revise(id: number, expected: number, d: { title?: string; body?: string; sources: unknown; tainted: boolean; by: string; status?: 'active' | 'archived' }): Promise<{ ok: true; doc: KbDoc } | { ok: false; reason: 'stale' | 'not_found' }> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const cur = (await c.query<KbDoc>(`SELECT ${DOC_COLS} FROM kb_docs WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!cur) { await c.query('ROLLBACK'); return { ok: false, reason: 'not_found' }; }
      if (cur.version !== expected) { await c.query('ROLLBACK'); return { ok: false, reason: 'stale' }; }
      const title = d.title ?? cur.title;
      const body = d.body ?? cur.body;
      const tainted = cur.tainted || d.tainted;
      const doc = (await c.query<KbDoc>(
        `UPDATE kb_docs SET title = $2, body = $3, version = version + 1, status = $4, sources = $5::jsonb, tainted = $6, updated_at = now() WHERE id = $1 RETURNING ${DOC_COLS}`,
        [id, title, body, d.status ?? cur.status, JSON.stringify(d.sources), tainted])).rows[0]!;
      await c.query('INSERT INTO kb_versions (doc_id, version, title, body, sources, tainted, created_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)', [id, doc.version, title, body, JSON.stringify(d.sources), tainted, d.by]);
      await c.query('COMMIT');
      return { ok: true, doc };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  /**
   * K14: hard delete of the document and (by cascade) every version, and the text it left elsewhere: the proposals that created or
   * changed it lose their title and body (open ones are withdrawn), and the cards made from them lose their stored preview.
   */
  async purge(id: number): Promise<boolean> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const del = await c.query('DELETE FROM kb_docs WHERE id = $1', [id]);
      const scrubbed = await c.query<{ id: number }>(
        `UPDATE kb_proposals SET payload = payload - 'body' - 'title', status = CASE WHEN status IN ('open','card') THEN 'withdrawn' ELSE status END
         WHERE (kind IN ('kb_edit','kb_archive','kb_purge') AND payload->>'docId' = $1::text) OR (kind = 'kb_create' AND outcome LIKE 'doc:' || $1::text || ' %')
         RETURNING id`, [id]);
      await c.query(`UPDATE admin_cards SET snapshot = '{"scrubbed":true}'::jsonb WHERE kind = 'knowledge' AND (payload->>'proposalId')::bigint = ANY($1::bigint[])`, [scrubbed.rows.map((r) => r.id)]);
      await c.query('COMMIT');
      return del.rowCount === 1;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  async get(id: number): Promise<KbDoc | null> {
    return (await this.pool.query<KbDoc>(`SELECT ${DOC_COLS} FROM kb_docs WHERE id = $1`, [id])).rows[0] ?? null;
  }
  async getVisible(id: number, v: KbViewer): Promise<KbDoc | null> {
    return (await this.pool.query<KbDoc>(`SELECT ${DOC_COLS} FROM kb_docs WHERE id = $1 AND ${VISIBLE('$2', '$3')}`, [id, v.dept, v.praw])).rows[0] ?? null;
  }
  async versions(docId: number): Promise<KbVersion[]> {
    return (await this.pool.query<KbVersion>(`SELECT ${VER_COLS} FROM kb_versions WHERE doc_id = $1 ORDER BY version DESC`, [docId])).rows;
  }
  /** Dashboard (Bot Admin, read only): every document, newest update first. */
  async listAll(limit: number): Promise<KbDoc[]> {
    return (await this.pool.query<KbDoc>(`SELECT ${DOC_COLS} FROM kb_docs ORDER BY updated_at DESC, id DESC LIMIT $1`, [limit])).rows;
  }
  async countActive(scope: string): Promise<number> {
    return (await this.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM kb_docs WHERE scope = $1 AND status = 'active'", [scope])).rows[0]!.n;
  }

  /**
   * K17: websearch_to_tsquery with the query as a bound parameter (never concatenated, never a raw tsquery), at most 200 characters,
   * at most 5 hits, a snippet of at most 600 characters. Scope comes from the viewer (K11).
   */
  async search(query: string, v: KbViewer, limit = SEARCH_RESULTS_MAX): Promise<KbHit[]> {
    const q = query.normalize('NFKC').slice(0, SEARCH_QUERY_MAX).trim();
    if (!q) return [];
    const rows = (await this.pool.query<{ id: number; scope: string; title: string; version: number; tainted: boolean; snippet: string }>(
      `SELECT id, scope, title, version, tainted, left(body, ${SNIPPET_MAX}) AS snippet
       FROM kb_docs, websearch_to_tsquery('simple', $1) AS q
       WHERE status = 'active' AND fts @@ q AND ${VISIBLE('$2', '$3')}
       ORDER BY ts_rank_cd(fts, q) DESC, id DESC LIMIT $4`, [q, v.dept, v.praw, Math.min(limit, SEARCH_RESULTS_MAX)])).rows;
    return rows;
  }
}

export type ProposalKind = 'kb_create' | 'kb_edit' | 'kb_archive' | 'kb_purge' | 'note_promote' | 'note_pin' | 'lesson_edit' | 'lesson_retire' | 'prompt_set' | 'prompt_rollback';
export type ProposalStatus = 'open' | 'card' | 'applied' | 'rejected' | 'stale' | 'withdrawn';
export interface Proposal {
  id: number; deptId: string; kind: ProposalKind; ref: string | null; payload: unknown; baseVersion: number; tainted: boolean; sources: unknown;
  proposer: string; via: 'tool' | 'weekly' | 'dashboard'; verdict: unknown; status: ProposalStatus; reviewedBy: string | null; reviewedAt: Date | null;
  cardId: string | null; outcome: string | null; createdAt: Date; decidedAt: Date | null;
}
const P_COLS = `id, dept_id AS "deptId", kind, ref, payload, base_version AS "baseVersion", tainted, sources, proposer, via, verdict, status,
  reviewed_by AS "reviewedBy", reviewed_at AS "reviewedAt", card_id AS "cardId", outcome, created_at AS "createdAt", decided_at AS "decidedAt"`;

/** Proposals wait here; a Bot Admin turns one into a card (single use, proposer-bound) from the dashboard. */
export class ProposalRepo {
  constructor(private readonly pool: Pool, private readonly memberRefsOf?: (deptId: string) => readonly string[]) {}

  /** `maxOpen` (K16): refuse when the department already has that many open proposals. `pending` = a prompt proposal for this ref is already open (K8c). */
  async create(p: { deptId: string; kind: ProposalKind; ref?: string; payload: unknown; baseVersion?: number; tainted: boolean; sources: unknown; proposer: string; via: Proposal['via']; verdict?: unknown; maxOpen?: number }): Promise<{ ok: true; proposal: Proposal } | { ok: false; reason: 'full' | 'pending' }> {
    // K5 at the repo layer: a prompt proposal can only name the department's own head text or a member prompt, whoever calls this.
    const prompt = p.kind === 'prompt_set' || p.kind === 'prompt_rollback';
    if (prompt ? !p.ref || !promptRefAllowed(p.ref, p.deptId, this.memberRefsOf?.(p.deptId)) : p.ref !== undefined) throw new Error('proposal ref not allowed');
    try {
      const r = await this.pool.query<Proposal>(
        `INSERT INTO kb_proposals (dept_id, kind, ref, payload, base_version, tainted, sources, proposer, via, verdict)
         SELECT $1::text,$2::text,$3::text,$4::jsonb,$5::int,$6::boolean,$7::jsonb,$8::text,$9::text,$10::jsonb
         WHERE $11::int IS NULL OR (SELECT count(*) FROM kb_proposals WHERE dept_id = $1 AND status IN ('open','card')) < $11::int
         RETURNING ${P_COLS}`,
        [p.deptId, p.kind, p.ref ?? null, JSON.stringify(p.payload), p.baseVersion ?? 0, p.tainted, JSON.stringify(p.sources), p.proposer, p.via, p.verdict === undefined ? null : JSON.stringify(p.verdict), p.maxOpen ?? null]);
      return r.rows[0] ? { ok: true, proposal: r.rows[0] } : { ok: false, reason: 'full' };
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return { ok: false, reason: 'pending' };
      throw e;
    }
  }
  async get(id: number): Promise<Proposal | null> {
    return (await this.pool.query<Proposal>(`SELECT ${P_COLS} FROM kb_proposals WHERE id = $1`, [id])).rows[0] ?? null;
  }
  async list(statuses: ProposalStatus[], limit: number): Promise<Proposal[]> {
    return (await this.pool.query<Proposal>(`SELECT ${P_COLS} FROM kb_proposals WHERE status = ANY($1::text[]) ORDER BY id DESC LIMIT $2`, [statuses, limit])).rows;
  }
  async recent(limit: number): Promise<Proposal[]> {
    return (await this.pool.query<Proposal>(`SELECT ${P_COLS} FROM kb_proposals ORDER BY id DESC LIMIT $1`, [limit])).rows;
  }
  async countOpen(deptId: string): Promise<number> {
    return (await this.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM kb_proposals WHERE dept_id = $1 AND status IN ('open','card')", [deptId])).rows[0]!.n;
  }
  /** K3 second step: the Bot Admin read the tainted sources. Only for an open (or carded) proposal. */
  async markReviewed(id: number, by: string): Promise<boolean> {
    return (await this.pool.query("UPDATE kb_proposals SET reviewed_by = $2, reviewed_at = now() WHERE id = $1 AND status IN ('open','card')", [id, by])).rowCount === 1;
  }
  /** open -> card, once, binding the card id. */
  async attachCard(id: number, cardId: string): Promise<boolean> {
    return (await this.pool.query("UPDATE kb_proposals SET status = 'card', card_id = $2 WHERE id = $1 AND status = 'open'", [id, cardId])).rowCount === 1;
  }
  /** card -> open again (the card was cancelled or expired), so a fresh card can be minted. */
  async releaseCard(cardId: string): Promise<void> {
    await this.pool.query("UPDATE kb_proposals SET status = 'open', card_id = NULL WHERE card_id = $1 AND status = 'card'", [cardId]);
  }
  /** One-way end states; only from open or card. */
  async finish(id: number, status: 'applied' | 'rejected' | 'stale' | 'withdrawn', outcome: string): Promise<boolean> {
    return (await this.pool.query("UPDATE kb_proposals SET status = $2, outcome = $3, decided_at = now() WHERE id = $1 AND status IN ('open','card')", [id, status, outcome.slice(0, 300)])).rowCount === 1;
  }
}

/** Idempotence claims for the background steps. */
export class KnowledgeStateRepo {
  constructor(private readonly pool: Pool) {}
  /** K15: true exactly once per task. */
  async claimReflection(taskId: string): Promise<boolean> {
    return (await this.pool.query('INSERT INTO kb_reflections (task_id) VALUES ($1) ON CONFLICT DO NOTHING', [taskId])).rowCount === 1;
  }
  /**
   * BOTLOG-1: true when `digest` differs from the one stored for `key` at the previous call (the first call ever counts as changed). Reuses
   * kb_review_runs (dept_id = `boot:<key>`, week = digest; no migration): the new digest is claimed and every other row of the key removed,
   * so A -> B -> A reads as changed twice. Stores a digest only, never text.
   */
  async bootNoteChanged(key: string, digest: string): Promise<boolean> {
    const dept = `boot:${key}`.slice(0, 64);
    const ins = (await this.pool.query('INSERT INTO kb_review_runs (dept_id, week) VALUES ($1,$2) ON CONFLICT DO NOTHING', [dept, digest])).rowCount === 1;
    await this.pool.query('DELETE FROM kb_review_runs WHERE dept_id = $1 AND week <> $2', [dept, digest]);
    return ins;
  }
  /** K16: true exactly once per department and ISO week label. */
  async claimWeek(deptId: string, week: string): Promise<boolean> {
    return (await this.pool.query('INSERT INTO kb_review_runs (dept_id, week) VALUES ($1,$2) ON CONFLICT DO NOTHING', [deptId, week])).rowCount === 1;
  }
}

import type { Pool } from '../pool.js';

export type ReleaseStatus = 'pending' | 'releasing' | 'released' | 'rejected' | 'expired' | 'failed';
export type ReleaseTarget = 'handoff' | 'install_plugin';
export type RunVerb = 'ci' | 'install' | 'test' | 'run' | 'tsc' | 'node';

/** What the card shows of the workspace's recorded test runs (RL-C4). Code-written audit rows only. */
export interface Evidence {
  runs: { verb: RunVerb; result: string; at: string }[];
  /** ws_write / ws_delete audited after the newest listed run (no upper bound: a write audited after the export may be in the zip). null when there is no run. */
  writesAfterLastRun: boolean | null;
}

/** Every column except `zip` and `token`. Only `claim` ever selects the bytes (RL-C14); no row or view carries the token (G2-RL-03: the token is the button secret, so it is held only by the card). */
export interface ReleaseRow {
  id: number; deptId: string; requester: string; taskId: string; rootId: string; projectId: number | null; target: ReleaseTarget;
  title: string; summary: string; slug: string; sha256: string; bytes: number; files: number; skipped: number; evidence: Evidence; tainted: boolean; catalogDigest: string;
  sourceChannelId: string; sourceThreadId: string | null; status: ReleaseStatus; channelId: string | null; messageId: string | null;
  createdAt: Date; expiresAt: Date; decidedBy: string | null; decidedAt: Date | null; reason: string | null; releasedMessageId: string | null; releasedAt: Date | null; outcome: string | null;
  /** R7: set exactly when `target = 'install_plugin'` (the `releases_plugin` CHECK). */
  forgeId: number | null; pluginSlug: string | null; pluginManifestSha256: string | null;
}
export type ReleaseView = ReleaseRow & { live: boolean };
export type ClaimedReleaseRow = ReleaseRow & { zip: Buffer };

export interface NewRelease {
  token: string; deptId: string; requester: string; taskId: string; rootId: string; projectId: number | null; target: ReleaseTarget; title: string; summary: string; slug: string;
  sha256: string; bytes: number; files: number; skipped: number; zip: Buffer; evidence: Evidence; tainted: boolean; catalogDigest: string; sourceChannelId: string; sourceThreadId: string | null;
  /** R7: all three for `install_plugin`, none (or null) for `handoff`. */
  forgeId?: number | null; pluginSlug?: string | null; pluginManifestSha256?: string | null;
}
export type CreateCode = 'tree_pending' | 'dept_cap' | 'total_cap' | 'day_cap';
export type ReleaseCreate = { ok: true; id: number; expiresAt: Date } | { ok: false; code: CreateCode };
export interface ReleaseDay { requested: number; released: number; rejected: number; expired: number; failed: number; waiting: number }

export const OPEN_PER_TREE = 1;
export const OPEN_PER_DEPT = 2;
export const OPEN_TOTAL = 5;
export const REQUESTS_PER_DEPT_DAY = 5;

const SLUG = /^[a-z][a-z0-9-]{1,39}$/; // the same shape as workspaces/files.ts SLUG_RE: no LIKE metacharacter, no `:`
const RUN_OUTCOME = /^([a-z][a-z0-9-]{1,39}):(ci|install|test|run|tsc|node):(exit=-?\d{1,5}|timeout|oom|start|halted|stuck)$/;
const ISO_US = (c: string): string => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const DAY = (tz: string): string => `(date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`;

// every column but zip and token; the row type is the source of truth for the aliases
const COLS = `id, dept_id AS "deptId", requester, task_id AS "taskId", root_id AS "rootId", project_id AS "projectId", target, title, summary, slug, sha256, bytes, files, skipped,
  evidence, tainted, catalog_digest AS "catalogDigest", source_channel_id AS "sourceChannelId", source_thread_id AS "sourceThreadId", status, channel_id AS "channelId", message_id AS "messageId",
  created_at AS "createdAt", expires_at AS "expiresAt", decided_by AS "decidedBy", decided_at AS "decidedAt", reason, released_message_id AS "releasedMessageId", released_at AS "releasedAt", outcome,
  forge_id AS "forgeId", plugin_slug AS "pluginSlug", plugin_manifest_sha256 AS "pluginManifestSha256"`;

/**
 * R5 RELEASE-1: the release rows. The only read that returns the zip is `claim` (RL-C14). Every read inside a transaction uses the transaction client;
 * every state change is one conditional UPDATE (a CAS on the status). Time is database time (`now()`), never the process clock (RL-C5, RL-C11).
 */
export class ReleaseRepo {
  constructor(private readonly pool: Pool) {}

  /** The database clock as ISO text with microseconds, so a bound taken from it compares exactly with audit_log.ts. */
  async now(): Promise<string> {
    return (await this.pool.query<{ t: string }>(`SELECT ${ISO_US('now()')} AS t`)).rows[0]!.t;
  }

  async openCounts(dept: string, rootId: string, tz: string): Promise<{ tree: number; dept: number; total: number; today: number }> {
    const r = await this.pool.query<{ tree: number; dept: number; total: number; today: number }>(
      `SELECT (SELECT count(*) FROM releases WHERE root_id = $2 AND status IN ('pending','releasing'))::int AS tree,
              (SELECT count(*) FROM releases WHERE dept_id = $1 AND status IN ('pending','releasing'))::int AS dept,
              (SELECT count(*) FROM releases WHERE status IN ('pending','releasing'))::int AS total,
              (SELECT count(*) FROM releases WHERE dept_id = $1 AND created_at >= ${DAY('$3::text')})::int AS today`, [dept, rootId, tz]);
    return r.rows[0]!;
  }

  /**
   * One transaction under `pg_advisory_xact_lock(hashtext('releases'))`: the re-count (1 open per tree, 2 per department, 5 in total, 5 requests per
   * department per local day), then the insert. The expiry is computed in SQL (RL-C11). A unique violation on the open-per-tree index is `tree_pending`.
   */
  async create(r: NewRelease, tz: string): Promise<ReleaseCreate> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(hashtext('releases'))");
      const n = (await c.query<{ tree: number; dept: number; total: number; today: number }>(
        `SELECT (SELECT count(*) FROM releases WHERE root_id = $2 AND status IN ('pending','releasing'))::int AS tree,
                (SELECT count(*) FROM releases WHERE dept_id = $1 AND status IN ('pending','releasing'))::int AS dept,
                (SELECT count(*) FROM releases WHERE status IN ('pending','releasing'))::int AS total,
                (SELECT count(*) FROM releases WHERE dept_id = $1 AND created_at >= ${DAY('$3::text')})::int AS today`, [r.deptId, r.rootId, tz])).rows[0]!;
      const code: CreateCode | null = n.tree >= OPEN_PER_TREE ? 'tree_pending' : n.dept >= OPEN_PER_DEPT ? 'dept_cap' : n.total >= OPEN_TOTAL ? 'total_cap' : n.today >= REQUESTS_PER_DEPT_DAY ? 'day_cap' : null;
      if (code) { await c.query('ROLLBACK'); return { ok: false, code }; }
      const ins = await c.query<{ id: number; expiresAt: Date }>(
        `INSERT INTO releases (token, dept_id, requester, task_id, root_id, project_id, target, title, summary, slug, sha256, bytes, files, skipped, zip, evidence, tainted, catalog_digest, source_channel_id, source_thread_id, forge_id, plugin_slug, plugin_manifest_sha256, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18,$19,$20,$21,$22,$23, now() + interval '7 days') RETURNING id, expires_at AS "expiresAt"`,
        [r.token, r.deptId, r.requester, r.taskId, r.rootId, r.projectId, r.target, r.title, r.summary, r.slug, r.sha256, r.bytes, r.files, r.skipped, r.zip, JSON.stringify(r.evidence), r.tainted, r.catalogDigest, r.sourceChannelId, r.sourceThreadId, r.forgeId ?? null, r.pluginSlug ?? null, r.pluginManifestSha256 ?? null]);
      await c.query('COMMIT');
      return { ok: true, id: ins.rows[0]!.id, expiresAt: ins.rows[0]!.expiresAt };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      if ((e as { code?: string; constraint?: string }).code === '23505' && (e as { constraint?: string }).constraint === 'releases_one_open_per_tree') return { ok: false, code: 'tree_pending' };
      throw e;
    } finally {
      c.release();
    }
  }

  /** The card was posted: store where, so a click is checked against it. */
  async setCard(id: number, channelId: string, messageId: string): Promise<boolean> {
    return ((await this.pool.query("UPDATE releases SET channel_id = $2, message_id = $3 WHERE id = $1 AND status = 'pending'", [id, channelId, messageId])).rowCount ?? 0) === 1;
  }

  async byToken(token: string): Promise<ReleaseView | null> {
    return (await this.pool.query<ReleaseView>(`SELECT ${COLS}, (expires_at > now()) AS live FROM releases WHERE token = $1`, [token])).rows[0] ?? null;
  }

  async byId(id: number): Promise<ReleaseView | null> {
    if (!Number.isSafeInteger(id) || id < 1) return null;
    return (await this.pool.query<ReleaseView>(`SELECT ${COLS}, (expires_at > now()) AS live FROM releases WHERE id = $1`, [id])).rows[0] ?? null;
  }

  /** Approve claim: pending to releasing while live. The only read of the zip. null = someone else decided first, or it expired. */
  async claim(token: string, userId: string): Promise<ClaimedReleaseRow | null> {
    const r = await this.pool.query<ClaimedReleaseRow>(
      `UPDATE releases SET status = 'releasing', decided_by = $2, decided_at = now() WHERE token = $1 AND status = 'pending' AND expires_at > now() RETURNING ${COLS}, zip`, [token, userId]);
    return r.rows[0] ?? null;
  }

  /** A certain refusal of the post: back to pending, decision cleared. */
  async revert(id: number): Promise<boolean> {
    return ((await this.pool.query("UPDATE releases SET status = 'pending', decided_by = NULL, decided_at = NULL WHERE id = $1 AND status = 'releasing'", [id])).rowCount ?? 0) === 1;
  }

  async settleReleased(id: number, messageId: string): Promise<boolean> {
    return ((await this.pool.query(
      "UPDATE releases SET status = 'released', zip = NULL, released_at = now(), released_message_id = $2, outcome = 'ok' WHERE id = $1 AND status = 'releasing'", [id, messageId])).rowCount ?? 0) === 1;
  }

  async fail(id: number, outcome: string): Promise<boolean> {
    return ((await this.pool.query("UPDATE releases SET status = 'failed', zip = NULL, outcome = $2 WHERE id = $1 AND status = 'releasing'", [id, outcome.slice(0, 32)])).rowCount ?? 0) === 1;
  }

  async reject(token: string, userId: string, reason: string | null): Promise<ReleaseView | null> {
    const r = await this.pool.query<{ id: number }>(
      "UPDATE releases SET status = 'rejected', zip = NULL, decided_by = $2, decided_at = now(), reason = $3, outcome = 'rejected' WHERE token = $1 AND status = 'pending' RETURNING id", [token, userId, reason]);
    return r.rows[0] ? this.byId(r.rows[0].id) : null;
  }

  async rejectById(id: number, userId: string, reason: string): Promise<ReleaseView | null> {
    const r = await this.pool.query<{ id: number }>(
      "UPDATE releases SET status = 'rejected', zip = NULL, decided_by = $2, decided_at = now(), reason = $3, outcome = 'rejected' WHERE id = $1 AND status = 'pending' RETURNING id", [id, userId, reason]);
    return r.rows[0] ? this.byId(r.rows[0].id) : null;
  }

  /** The 7 day sweep: one UPDATE, returns what it expired. */
  async expire(): Promise<ReleaseView[]> {
    const r = await this.pool.query<{ id: number }>("UPDATE releases SET status = 'expired', zip = NULL, outcome = 'expired' WHERE status = 'pending' AND expires_at <= now() RETURNING id");
    return (await Promise.all(r.rows.map((x) => this.byId(x.id)))).filter((x): x is ReleaseView => x !== null);
  }

  /**
   * RL-C5 (boot): fails, in one UPDATE, only the `releasing` rows claimed before `bootTime` (database time taken before the clients came up). A claim
   * made after it belongs to a live process and is untouched. The zip is purged; nothing is ever re-posted.
   */
  async failInterrupted(bootTime: string): Promise<ReleaseView[]> {
    const r = await this.pool.query<{ id: number }>(
      "UPDATE releases SET status = 'failed', zip = NULL, outcome = 'interrupted' WHERE status = 'releasing' AND decided_at < $1::timestamptz RETURNING id", [bootTime]);
    return (await Promise.all(r.rows.map((x) => this.byId(x.id)))).filter((x): x is ReleaseView => x !== null);
  }

  async list(limit = 25): Promise<ReleaseView[]> {
    return (await this.pool.query<ReleaseView>(`SELECT ${COLS}, (expires_at > now()) AS live FROM releases ORDER BY id DESC LIMIT $1`, [Math.max(1, Math.min(100, Math.trunc(limit)))])).rows;
  }

  /** Today (local day of `tz`) per outcome; `waiting` is open now. */
  async day(tz: string): Promise<ReleaseDay> {
    const r = await this.pool.query<ReleaseDay>(
      `SELECT count(*) FILTER (WHERE created_at >= ${DAY('$1::text')})::int AS requested,
              count(*) FILTER (WHERE status = 'released' AND released_at >= ${DAY('$1::text')})::int AS released,
              count(*) FILTER (WHERE status = 'rejected' AND decided_at >= ${DAY('$1::text')})::int AS rejected,
              count(*) FILTER (WHERE status = 'expired' AND expires_at >= ${DAY('$1::text')})::int AS expired,
              count(*) FILTER (WHERE status = 'failed' AND decided_at >= ${DAY('$1::text')})::int AS failed,
              count(*) FILTER (WHERE status IN ('pending','releasing'))::int AS waiting
       FROM releases`, [tz]);
    return r.rows[0]!;
  }

  /**
   * RL-C4: the evidence window, read in one statement right after the export: `until` is the database clock now, `since` is the workspace's current
   * `created_at` (a deleted and re-created slug starts a new life). `since` is null when the workspace row is gone.
   */
  async window(slug: string): Promise<{ since: string | null; until: string }> {
    if (!SLUG.test(slug)) throw new Error('bad slug');
    const r = await this.pool.query<{ since: string | null; until: string }>(
      `SELECT (SELECT ${ISO_US('created_at')} FROM workspaces WHERE slug = $1) AS since, ${ISO_US('now()')} AS until`, [slug]);
    return r.rows[0]!;
  }

  /**
   * RL-C4: the last three well-formed recorded `ws_run` results (the 20 newest rows are read, so a dropped row cannot hide an older valid one) of this workspace's current life, `since < ts <= until`, parsed with a strict regex (anything else is dropped),
   * and whether a write or delete was audited after the newest of them (`ts > since` only: a write audited after the export may already be in the zip).
   * Both reads run in one read-only repeatable-read transaction on the transaction client.
   */
  async evidence(slug: string, since: string, until: string): Promise<Evidence> {
    if (!SLUG.test(slug)) throw new Error('bad slug');
    const like = `${slug}:%`;
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const rows = (await c.query<{ id: number; ts: Date; us: string; outcome: string }>(
        `SELECT id, ts, ${ISO_US('ts')} AS us, outcome FROM audit_log
         WHERE action = 'ws.run' AND tool = 'ws_run' AND outcome LIKE $1 AND ts > $2::timestamptz AND ts <= $3::timestamptz ORDER BY ts DESC, id DESC LIMIT 20`, [like, since, until])).rows;
      const runs: Evidence['runs'] = [];
      let newest: string | null = null;
      for (const row of rows) {
        if (runs.length === 3) break;
        const m = RUN_OUTCOME.exec(row.outcome);
        if (!m || m[1] !== slug) continue;
        newest ??= row.us;
        runs.push({ verb: m[2] as RunVerb, result: m[3]!, at: row.ts.toISOString() });
      }
      let writes: boolean | null = null;
      if (newest !== null) {
        writes = (await c.query<{ w: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM audit_log WHERE action IN ('ws.write','ws.delete') AND outcome LIKE $1 AND ts > $2::timestamptz AND ts > $3::timestamptz) AS w`, [like, since, newest])).rows[0]!.w;
      }
      await c.query('COMMIT');
      return { runs, writesAfterLastRun: writes };
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
}

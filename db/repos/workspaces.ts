import type { Pool } from 'pg';

export type WorkspaceRow = {
  slug: string;
  title: string;
  createdBy: string;
  status: 'active' | 'archived';
  bytes: number;
  nmBytes: number;
  createdAt: Date;
};

type Raw = { slug: string; title: string; created_by: string; status: 'active' | 'archived'; bytes: string; nm_bytes: string; created_at: Date };
const COLS = 'slug, title, created_by, status, bytes, nm_bytes, created_at';
const row = (r: Raw): WorkspaceRow => ({ slug: r.slug, title: r.title, createdBy: r.created_by, status: r.status, bytes: Number(r.bytes), nmBytes: Number(r.nm_bytes), createdAt: r.created_at });

/** WS-1 (SA-1 5.4): the workspace registry and the run counters. Every statement is the one given in the spec; every read inside a transaction uses the transaction client. */
export class WorkspaceRepo {
  constructor(private readonly pool: Pool) {}

  /** One transaction under an advisory lock, so concurrent creates cannot pass the 5-active cap together. 'limit' when 5 are active, 'exists' on a duplicate slug. */
  async create(slug: string, title: string, createdBy: string): Promise<'ok' | 'limit' | 'exists'> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(hashtext('ws.create'))");
      const r = await c.query(
        `INSERT INTO workspaces (slug, title, created_by)
         SELECT $1, $2, $3 WHERE (SELECT count(*) FROM workspaces WHERE status = 'active') < 5
         RETURNING slug`, [slug, title, createdBy]);
      await c.query('COMMIT');
      return r.rowCount === 1 ? 'ok' : 'limit';
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      if ((e as { code?: string }).code === '23505') return 'exists';
      throw e;
    } finally {
      c.release();
    }
  }

  /** Undo of a create whose directory could not be made. */
  async remove(slug: string): Promise<void> {
    await this.pool.query('DELETE FROM workspaces WHERE slug = $1', [slug]);
  }

  async get(slug: string): Promise<WorkspaceRow | null> {
    const r = await this.pool.query<Raw>(`SELECT ${COLS} FROM workspaces WHERE slug = $1`, [slug]);
    return r.rows[0] ? row(r.rows[0]) : null;
  }

  async list(): Promise<WorkspaceRow[]> {
    return (await this.pool.query<Raw>(`SELECT ${COLS} FROM workspaces ORDER BY created_at, slug`)).rows.map(row);
  }

  /** True when this call archived an active workspace. */
  async archive(slug: string, userId: string): Promise<boolean> {
    const r = await this.pool.query(
      "UPDATE workspaces SET status = 'archived', archived_at = now(), archived_by = $2 WHERE slug = $1 AND status = 'active' RETURNING slug", [slug, userId]);
    return r.rowCount === 1;
  }

  /** `nmBytes` null leaves the stored value alone. */
  async setUsage(slug: string, bytes: number, nmBytes: number | null): Promise<void> {
    await this.pool.query('UPDATE workspaces SET bytes = $2, nm_bytes = COALESCE($3, nm_bytes) WHERE slug = $1', [slug, Math.max(0, Math.floor(bytes)), nmBytes === null ? null : Math.max(0, Math.floor(nmBytes))]);
  }

  /**
   * One transaction, tree then day (the tree key is the task root id, the day key the UTC date). A refusal rolls both counters back.
   * Used by ws_run (WS-BE2); a claimed slot is never refunded.
   */
  async claim(treeKey: string, dayKey: string, treeCap: number, dayCap: number): Promise<'ok' | 'tree' | 'day'> {
    if (!Number.isInteger(treeCap) || treeCap < 1 || !Number.isInteger(dayCap) || dayCap < 1) return 'tree';
    const sql = `INSERT INTO ws_run_counts (scope, scope_key, used) VALUES ($1, $2, 1)
      ON CONFLICT (scope, scope_key) DO UPDATE SET used = ws_run_counts.used + 1 WHERE ws_run_counts.used < $3
      RETURNING used`;
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      if ((await c.query(sql, ['tree', treeKey, treeCap])).rowCount !== 1) {
        await c.query('ROLLBACK');
        return 'tree';
      }
      if ((await c.query(sql, ['day', dayKey, dayCap])).rowCount !== 1) {
        await c.query('ROLLBACK');
        return 'day';
      }
      await c.query('COMMIT');
      return 'ok';
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
}

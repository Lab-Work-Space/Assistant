import type { PoolClient } from 'pg';
import type { Pool } from '../pool.js';
import { taskCols, type Task, type TaskChange, type TaskStatus } from './tasks.js';

export type McpStatus = 'pending' | 'active' | 'quarantined' | 'disabled';
export type McpClass = 'read' | 'write';
export type McpSource = 'admin' | 'release';
export type QuarantineReason = 'snapshot_changed' | 'config_changed';

/** One `mcp_servers` row with its dept grants. `snapshot` is the raw `tools/list` tool array the hash covers (attacker text: never log it, never show it unescaped). */
export interface McpRow {
  id: number; slug: string; title: string; imageId: string; imageRef: string | null; command: string[]; env: Record<string, string>; toolClass: McpClass;
  timeoutMs: number; maxCallsPerDay: number; snapshot: unknown[]; snapshotSha256: string; status: McpStatus; source: McpSource; releaseId: number | null;
  addedBy: string; addedAt: Date; approvedBy: string | null; approvedAt: Date | null; quarantineReason: QuarantineReason | null; approvedConfigSha256: string | null; quarantinedAt: Date | null;
  disabledBy: string | null; disabledAt: Date | null; updatedAt: Date; depts: string[];
}
/** The list view: everything but the snapshot, plus the tool count. */
export type McpSummary = Omit<McpRow, 'snapshot'> & { tools: number };

export interface StageIn {
  slug: string; title: string; imageId: string; imageRef: string | null; command: readonly string[]; env: Readonly<Record<string, string>>; toolClass: McpClass;
  timeoutMs: number; maxCallsPerDay: number; snapshot: readonly unknown[]; snapshotSha256: string; depts: readonly string[]; by: string;
  /** The approve token (MC-C8) of the staged config, for the audit row. */
  cfg12: string;
  /** R7: `admin` (the default write path, `release_id` NULL) or `release` (forge/builder through `McpAdmin.stageRelease`: PF-C8 and PF-C9 are checked under the lock). */
  source?: McpSource; releaseId?: number | null;
}
export type StageResult = { ok: true; id: number; expired: number[] } | { ok: false; code: 'E_EXISTS' | 'E_MAX_SERVERS' | 'E_STATE' };
export type ActivateResult = { ok: true; cfg12: string } | { ok: false; code: 'E_STATE' | 'E_CHANGED' | 'E_HASH' | 'E_MAX_SERVERS' };
export type ClaimResult = 'ok' | 'tree' | 'day' | 'server';

export const MAX_OPEN_SERVERS = 8;
/** Today's external tool counts (audit rows only; spec 5.12). */
export interface McpDay { calls: number; failed: number; quarantined: number }

const COLS = `id, slug, title, image_id AS "imageId", image_ref AS "imageRef", command, env, tool_class AS "toolClass", timeout_ms AS "timeoutMs", max_calls_per_day AS "maxCallsPerDay",
  snapshot_sha256 AS "snapshotSha256", status, source, release_id AS "releaseId", added_by AS "addedBy", added_at AS "addedAt", approved_by AS "approvedBy", approved_at AS "approvedAt",
  approved_config_sha256 AS "approvedConfigSha256", quarantine_reason AS "quarantineReason", quarantined_at AS "quarantinedAt", disabled_by AS "disabledBy", disabled_at AS "disabledAt", updated_at AS "updatedAt"`;
const SLUG = /^[a-z][a-z0-9]{1,15}$/;
/** PF-C9: the one cross-check of a release stage (params: release id, decided_by, slug, image id). Run read-only before any docker call, and again with FOR UPDATE OF b, f under the lock. */
const RELEASE_BOUND = `SELECT r.forge_id, f.dept_id FROM releases r JOIN plugin_builds b ON b.release_id = r.id JOIN plugin_forges f ON f.id = b.forge_id JOIN projects p ON p.id = f.project_id
  WHERE r.id = $1 AND r.status = 'released' AND r.target = 'install_plugin' AND r.decided_by = $2 AND b.decided_by = $2 AND r.plugin_slug = $3 AND b.plugin_slug = $3
    AND b.forge_id = r.forge_id AND b.sha256 = r.sha256 AND b.status = 'building' AND b.image_id = $4 AND f.status = 'live' AND p.status = 'active'`;
const uniqSorted = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

/**
 * R6 MCP-1 (GROWTH-1): the Bot Admin allowlist of sandboxed MCP servers. Only `mcp/` and app.ts import this file (boundary test).
 * Every state change is one transaction under `pg_advisory_xact_lock(hashtext('mcp_servers'))`; the row is read FOR UPDATE and its depts on the same client;
 * every audit row is a THROWING insert on the transaction client, so a state change never commits without its row (and the reverse). Leaving `active`
 * (quarantine, disable) and a re-add expire the server's open tool approvals in the same transaction (MC-C8).
 */
export class McpRepo {
  /** `moved` (BE3): tasks the expiry took out of awaiting_approval, handed over AFTER the commit (app.ts mirrors them as task.changed). Never throws out of here. */
  private readonly moved = new WeakMap<PoolClient, TaskChange[]>();
  constructor(private readonly pool: Pool, private readonly opts: { onTasksMoved?: (changes: TaskChange[]) => Promise<void> | void } = {}) {}

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT pg_advisory_xact_lock(hashtext('mcp_servers'))");
      const out = await fn(c);
      await c.query('COMMIT');
      const m = this.moved.get(c);
      if (m && m.length > 0) { try { await this.opts.onTasksMoved?.(m); } catch { /* the mirror never fails a committed change */ } }
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  private async audit(c: PoolClient, e: { actor: string; action: string; outcome: string }): Promise<void> {
    await c.query('INSERT INTO audit_log (actor, action, outcome) VALUES ($1,$2,$3)', [e.actor, e.action, e.outcome]); // throws: no change without its row
  }

  private async depts(c: PoolClient, ids: number[]): Promise<Map<number, string[]>> {
    const m = new Map<number, string[]>();
    if (ids.length === 0) return m;
    for (const r of (await c.query<{ id: number; d: string }>('SELECT server_id AS id, dept_id AS d FROM mcp_server_depts WHERE server_id = ANY($1) ORDER BY dept_id', [ids])).rows) {
      const l = m.get(r.id) ?? [];
      l.push(r.d);
      m.set(r.id, l);
    }
    return m;
  }

  private async rows(c: PoolClient, where: string, params: unknown[], lock = false): Promise<McpRow[]> {
    const rs = (await c.query<Omit<McpRow, 'depts'>>(`SELECT ${COLS}, snapshot FROM mcp_servers WHERE ${where} ORDER BY id${lock ? ' FOR UPDATE' : ''}`, params)).rows;
    const d = await this.depts(c, rs.map((r) => r.id));
    return rs.map((r) => ({ ...r, depts: d.get(r.id) ?? [] }));
  }

  /** Expires, on the transaction client, every open tool approval whose tool starts `mcp_<r|w>_<slug>_` (starts_with, never LIKE: `_` is a wildcard). Returns their ids. */
  private async expire(c: PoolClient, slug: string): Promise<number[]> {
    const open = `kind = 'tool' AND (status = 'pending' OR (status = 'approved' AND executed_at IS NULL)) AND (starts_with(tool_name, $1) OR starts_with(tool_name, $2))`;
    const names = [`mcp_r_${slug}_`, `mcp_w_${slug}_`];
    // G2-MCP-07: the lock order is root -> approval rows, the same sorted root lock as Approvals.expireOld (and decide), so the two cannot deadlock each other.
    await c.query(`SELECT id FROM tasks WHERE id IN (SELECT t.root_id FROM approvals a JOIN tasks t ON t.id = a.task_id WHERE ${open.replace(/\b(kind|status|executed_at|tool_name)\b/g, 'a.$1')}) ORDER BY id FOR UPDATE`, names);
    const r = await c.query<{ id: number }>(
      `UPDATE approvals SET status = 'expired', decided_at = COALESCE(decided_at, now())
       WHERE ${open} RETURNING id`,
      names);
    const ids = r.rows.map((x) => x.id).sort((a, b) => a - b);
    if (ids.length > 0) {
      // Like Approvals.expireOld: a task waiting on an expired approval is cancelled, so it does not wait forever. Only `awaiting_approval_id = ANY(ids)` matches (MCP waiters always carry the id); expireOld also matches a NULL legacy waiter.
      const t = await c.query<Task & { prev: TaskStatus }>(
        `UPDATE tasks t SET status = 'cancelled', blocked_reason = NULL, blocked_note = NULL, awaiting_approval_id = NULL, updated_at = now()
         FROM tasks o WHERE o.id = t.id AND t.id = ANY($1) AND t.status = 'awaiting_approval' AND (t.awaiting_approval_id = ANY($2)) RETURNING ${taskCols('t.')}, o.status AS prev`,
        [(await c.query<{ task_id: string }>('SELECT task_id FROM approvals WHERE id = ANY($1)', [ids])).rows.map((x) => x.task_id), ids]);
      if (t.rows.length > 0) this.moved.set(c, [...(this.moved.get(c) ?? []), ...t.rows.map(({ prev, ...task }) => ({ task: task as Task, from: prev }))]);
    }
    return ids;
  }

  /** Spec 5.12: today (the local day of `tz`) calls started, calls that ended in anything but `ok`, and servers quarantined. Counts only. */
  async day(tz: string): Promise<McpDay> {
    const DAY = "(date_trunc('day', now() AT TIME ZONE $1::text) AT TIME ZONE $1::text)";
    const r = await this.pool.query<McpDay>(
      `SELECT count(*) FILTER (WHERE action = 'mcp.call')::int AS calls,
              count(*) FILTER (WHERE action = 'mcp.call.end' AND outcome <> 'ok')::int AS failed,
              count(*) FILTER (WHERE action = 'mcp.quarantine')::int AS quarantined
       FROM audit_log WHERE action IN ('mcp.call', 'mcp.call.end', 'mcp.quarantine') AND ts >= ${DAY}`, [tz]);
    return r.rows[0]!;
  }

  async get(slug: string): Promise<McpRow | null> {
    if (!SLUG.test(slug)) return null;
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const r = (await this.rows(c, 'slug = $1', [slug]))[0] ?? null;
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  /** Active rows with snapshot and depts: what the host builds its tools from. */
  async activeRows(): Promise<McpRow[]> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const r = await this.rows(c, "status = 'active'", []);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  async list(): Promise<McpSummary[]> {
    const rs = (await this.pool.query<Omit<McpSummary, 'depts'>>(`SELECT ${COLS}, jsonb_array_length(snapshot)::int AS tools FROM mcp_servers ORDER BY id`)).rows;
    const c = await this.pool.connect();
    try {
      const d = await this.depts(c, rs.map((r) => r.id));
      return rs.map((r) => ({ ...r, depts: d.get(r.id) ?? [] }));
    } finally {
      c.release();
    }
  }

  /** R7 PF-C10: is this image id one a plugin build recorded? (A read; `/mcp add` uses it so a forged image cannot be re-added as read class after its labels are stripped.) */
  async forgedImage(imageId: string): Promise<boolean> {
    return ((await this.pool.query('SELECT 1 FROM plugin_builds WHERE image_id = $1 LIMIT 1', [imageId])).rowCount ?? 0) > 0;
  }

  /** R7: the PF-C9 cross-check without locks, for `McpAdmin.stageRelease` to refuse an unbound call before it touches docker. `stage` re-checks under the lock; this answer is advisory. */
  async releaseBound(i: { releaseId: number; by: string; slug: string; imageId: string; depts: readonly string[]; toolClass: McpClass }): Promise<boolean> {
    const ds = uniqSorted(i.depts);
    const x = (await this.pool.query<{ forge_id: number; dept_id: string }>(RELEASE_BOUND, [i.releaseId, i.by, i.slug, i.imageId])).rows[0];
    return !!x && i.toolClass === 'write' && ds.length === 1 && ds[0] === x.dept_id;
  }

  /**
   * Add and re-add. Refused (`E_EXISTS`) over a `pending` or `active` row; a `quarantined` or `disabled` row is replaced and its approval, quarantine and disable
   * columns are cleared (re-add means re-approval). At most 8 rows may be pending or active (`E_MAX_SERVERS`), counted under the lock. The depts are replaced.
   */
  async stage(a: StageIn): Promise<StageResult> {
    const i = { ...a, source: a.source ?? 'admin', releaseId: a.releaseId ?? null } as StageIn & { source: McpSource; releaseId: number | null };
    const depts = uniqSorted(i.depts);
    return this.tx(async (c) => {
      // R7 PF-C9: a release stage is bound to a real approved release and its building build, under the lock, before anything else is read or written. Locks the build and its forge FOR UPDATE.
      if ((i.source === 'release') !== (i.releaseId !== null)) return { ok: false, code: 'E_STATE' } as const;
      let forgeOfRelease: number | null = null;
      if (i.source === 'release') {
        const x = (await c.query<{ forge_id: number; dept_id: string }>(`${RELEASE_BOUND} FOR UPDATE OF b, f`, [i.releaseId, i.by, i.slug, i.imageId])).rows[0];
        if (!x || i.toolClass !== 'write' || depts.length !== 1 || depts[0] !== x.dept_id) return { ok: false, code: 'E_STATE' } as const;
        forgeOfRelease = x.forge_id;
      }
      const ex = (await c.query<{ status: McpStatus; source: McpSource; release_id: number | null }>('SELECT status, source, release_id FROM mcp_servers WHERE slug = $1 FOR UPDATE', [i.slug])).rows[0];
      if (ex && (ex.status === 'pending' || ex.status === 'active')) return { ok: false, code: 'E_EXISTS' } as const;
      if (i.source === 'release' && ex) {
        // PF-C8: a release stage never overwrites an admin row; only a disabled or quarantined row of a release of THE SAME forge is replaced (a retry after a failed install).
        const same = ex.source === 'release' && ex.release_id !== null
          && (await c.query<{ forge_id: number | null }>('SELECT forge_id FROM releases WHERE id = $1', [ex.release_id])).rows[0]?.forge_id === forgeOfRelease;
        if (!same) return { ok: false, code: 'E_EXISTS' } as const;
      }
      const open = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM mcp_servers WHERE status IN ('pending','active')")).rows[0]!.n;
      if (open >= MAX_OPEN_SERVERS) return { ok: false, code: 'E_MAX_SERVERS' } as const;
      const ins = await c.query<{ id: number }>(
        `INSERT INTO mcp_servers (slug, title, image_id, image_ref, command, env, tool_class, timeout_ms, max_calls_per_day, snapshot, snapshot_sha256, status, added_by, source, release_id)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10::jsonb,$11,'pending',$12,$13,$14)
         ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title, image_id = EXCLUDED.image_id, image_ref = EXCLUDED.image_ref, command = EXCLUDED.command, env = EXCLUDED.env,
           tool_class = EXCLUDED.tool_class, timeout_ms = EXCLUDED.timeout_ms, max_calls_per_day = EXCLUDED.max_calls_per_day, snapshot = EXCLUDED.snapshot,
           snapshot_sha256 = EXCLUDED.snapshot_sha256, status = 'pending', added_by = EXCLUDED.added_by, added_at = now(), approved_by = NULL, approved_at = NULL, approved_config_sha256 = NULL,
           quarantine_reason = NULL, quarantined_at = NULL, disabled_by = NULL, disabled_at = NULL, source = EXCLUDED.source, release_id = EXCLUDED.release_id, updated_at = now()
         RETURNING id`,
        [i.slug, i.title, i.imageId, i.imageRef, JSON.stringify(i.command), JSON.stringify(i.env), i.toolClass, i.timeoutMs, i.maxCallsPerDay, JSON.stringify(i.snapshot), i.snapshotSha256, i.by, i.source, i.releaseId]);
      const id = ins.rows[0]!.id;
      await c.query('DELETE FROM mcp_server_depts WHERE server_id = $1', [id]);
      await c.query('INSERT INTO mcp_server_depts (server_id, dept_id, granted_by) SELECT $1, d, $3 FROM unnest($2::text[]) AS d', [id, depts, i.by]);
      const expired = await this.expire(c, i.slug);
      await this.audit(c, i.source === 'release'
        ? { actor: 'system:forge', action: 'mcp.add', outcome: `pending ${i.slug} ${i.cfg12} ${i.snapshot.length} release:#${i.releaseId}` }
        : { actor: `user:${i.by}`, action: 'mcp.add', outcome: `pending ${i.slug} ${i.cfg12} ${i.snapshot.length}` });
      return { ok: true, id, expired } as const;
    });
  }

  /**
   * Approve: under the lock the row is read FOR UPDATE with its depts on the same client. `check` recomputes the approve token from that locked row and returns it
   * when it equals the presented one, else null (E_HASH). The UPDATE is a compare-and-set on (id, pending, snapshot hash); the 8-active cap is counted under the lock.
   */
  async activate(a: { slug: string; snapshotSha256: string; check: (row: McpRow) => string | null; fullHash: (row: McpRow) => string; by: string }): Promise<ActivateResult> {
    return this.tx(async (c): Promise<ActivateResult> => {
      const row = (await this.rows(c, 'slug = $1', [a.slug], true))[0];
      if (!row || row.status !== 'pending') return { ok: false, code: 'E_STATE' };
      if (row.snapshotSha256 !== a.snapshotSha256) return { ok: false, code: 'E_CHANGED' };
      const cfg12 = a.check(row);
      if (cfg12 === null) return { ok: false, code: 'E_HASH' };
      const pin = a.fullHash(row); // 047: the full config hash of the locked row, stored with the approval
      const active = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM mcp_servers WHERE status = 'active'")).rows[0]!.n;
      if (active >= MAX_OPEN_SERVERS) return { ok: false, code: 'E_MAX_SERVERS' };
      const u = await c.query(
        "UPDATE mcp_servers SET status = 'active', approved_by = $3, approved_at = now(), approved_config_sha256 = $4, updated_at = now() WHERE id = $1 AND status = 'pending' AND snapshot_sha256 = $2", [row.id, a.snapshotSha256, a.by, pin]);
      if (u.rowCount !== 1) return { ok: false, code: 'E_STATE' };
      await this.audit(c, { actor: `user:${a.by}`, action: 'mcp.approve', outcome: `active ${a.slug} ${cfg12}` });
      return { ok: true, cfg12 };
    });
  }

  /** Compare-and-set quarantine (`WHERE id AND status = 'active' AND snapshot_sha256`): a stale call changes nothing and writes no row. Clears the approval and the pin (G2-MCP-R4: 048 CHECK) and expires the server's open approvals. */
  async quarantine(a: { id: number; slug: string; snapshotSha256: string; reason?: QuarantineReason }): Promise<{ ok: true; expired: number[] } | { ok: false }> {
    const reason: QuarantineReason = a.reason ?? 'snapshot_changed';
    return this.tx(async (c) => {
      const u = await c.query(
        "UPDATE mcp_servers SET status = 'quarantined', quarantine_reason = $4, quarantined_at = now(), approved_config_sha256 = NULL, approved_by = NULL, approved_at = NULL, updated_at = now() WHERE id = $1 AND slug = $2 AND status = 'active' AND snapshot_sha256 = $3",
        [a.id, a.slug, a.snapshotSha256, reason]);
      if (u.rowCount !== 1) return { ok: false } as const;
      const expired = await this.expire(c, a.slug);
      await this.audit(c, { actor: 'system:mcp', action: 'mcp.quarantine', outcome: `${a.slug} ${reason}` });
      return { ok: true, expired } as const;
    });
  }

  /** Allowed from pending, active and quarantined. Clears the quarantine columns and the approval and pin (G2-MCP-R4), expires the open approvals. */
  async disable(slug: string, by: string): Promise<{ ok: true; expired: number[] } | { ok: false; code: 'E_STATE' }> {
    return this.tx(async (c) => {
      const row = (await c.query<{ id: number; status: McpStatus }>('SELECT id, status FROM mcp_servers WHERE slug = $1 FOR UPDATE', [slug])).rows[0];
      if (!row || row.status === 'disabled') return { ok: false, code: 'E_STATE' } as const;
      await c.query(
        "UPDATE mcp_servers SET status = 'disabled', disabled_by = $2, disabled_at = now(), quarantine_reason = NULL, quarantined_at = NULL, approved_config_sha256 = NULL, approved_by = NULL, approved_at = NULL, updated_at = now() WHERE id = $1", [row.id, by]);
      const expired = await this.expire(c, slug);
      await this.audit(c, { actor: `user:${by}`, action: 'mcp.disable', outcome: slug });
      return { ok: true, expired } as const;
    });
  }

  /**
   * Replaces the grants. For an `active` row (047) the stored pin is first checked against the locked row as it stands (`hashOf`); a row that was edited behind the
   * approval is refused (`E_STATE`), never re-blessed, and the next host refresh quarantines it. Otherwise the pin is rewritten for the new grants in this transaction.
   */
  async setDepts(slug: string, depts: readonly string[], by: string, hashOf: (row: McpRow) => string): Promise<{ ok: true } | { ok: false; code: 'E_STATE' }> {
    const ds = uniqSorted(depts);
    return this.tx(async (c) => {
      const row = (await this.rows(c, 'slug = $1', [slug], true))[0];
      if (!row) return { ok: false, code: 'E_STATE' } as const;
      if (row.status === 'active' && row.approvedConfigSha256 !== hashOf(row)) return { ok: false, code: 'E_STATE' } as const;
      await c.query('DELETE FROM mcp_server_depts WHERE server_id = $1', [row.id]);
      await c.query('INSERT INTO mcp_server_depts (server_id, dept_id, granted_by) SELECT $1, d, $3 FROM unnest($2::text[]) AS d', [row.id, ds, by]);
      const pin = row.status === 'active' ? hashOf({ ...row, depts: ds }) : null;
      await c.query('UPDATE mcp_servers SET approved_config_sha256 = COALESCE($2, approved_config_sha256), updated_at = now() WHERE id = $1', [row.id, pin]);
      await this.audit(c, { actor: `user:${by}`, action: 'mcp.depts', outcome: `${slug} ${ds.length}` });
      return { ok: true } as const;
    });
  }

  /**
   * MC-C13: claim first, in one transaction: tree (only with a key), day, server_day, each `INSERT .. ON CONFLICT DO UPDATE .. WHERE used < cap RETURNING`; no row means
   * the cap; then the throwing `mcp.call` start row. Any cap rolls everything back (no counter, no row). A claimed slot is never refunded. No advisory lock: the
   * counters are independent rows. A bad cap counts as reached; a bad key throws (the table CHECKs it).
   */
  async claim(a: { treeKey: string | null; dayKey: string; slug: string; treeCap: number; dayCap: number; serverCap: number; actor: string; tool: string; taskId: string | null }): Promise<ClaimResult> {
    const good = (n: number): boolean => Number.isInteger(n) && n >= 1;
    if (a.treeKey !== null && !good(a.treeCap)) return 'tree';
    if (!good(a.dayCap)) return 'day';
    if (!good(a.serverCap)) return 'server';
    const sql = `INSERT INTO mcp_call_counts (scope, scope_key, used) VALUES ($1, $2, 1)
      ON CONFLICT (scope, scope_key) DO UPDATE SET used = mcp_call_counts.used + 1 WHERE mcp_call_counts.used < $3 RETURNING used`;
    const steps: [ClaimResult, string, string, number][] = [];
    if (a.treeKey !== null) steps.push(['tree', 'tree', a.treeKey, a.treeCap]);
    steps.push(['day', 'day', a.dayKey, a.dayCap], ['server', 'server_day', `${a.slug}:${a.dayKey}`, a.serverCap]);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      for (const [res, scope, key, cap] of steps) {
        if ((await c.query(sql, [scope, key, cap])).rowCount !== 1) {
          await c.query('ROLLBACK');
          return res;
        }
      }
      await c.query("INSERT INTO audit_log (actor, action, task_id, tool, outcome) VALUES ($1,'mcp.call',$2,$3,'start')", [a.actor, a.taskId, a.tool]); // throws: no claim without its row
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

import type { PoolClient } from 'pg';
import type { ForgeCancelResult, ForgeDetail, ForgeListItem } from '../../forge/types.js';
import type { Pool } from '../pool.js';
import { BUILDS_PER_DAY, BUILDS_PER_FORGE, GC_DISABLED_DAYS, GC_UNSTAGED_HOURS, IMAGES_KEPT_MAX, MAX_ATTEMPTS, QUEUE_TTL_DAYS } from '../../forge/caps.js';

export type ForgeStatus = 'live' | 'staged' | 'installed' | 'cancelled';
export type BuildStatus = 'queued' | 'building' | 'staged' | 'failed' | 'cancelled';
export type ForgeCloseReason = 'project_cancelled' | 'project_closed' | 'admin_cancel' | 'installed';

export interface ForgeRow {
  id: number; ideaId: number; projectId: number; deptId: string; proposer: string; status: ForgeStatus; serverId: number | null;
  createdAt: Date; updatedAt: Date; closedAt: Date | null; closeReason: ForgeCloseReason | null;
}
/** Every build column except the zip. */
export interface BuildRow {
  id: number; forgeId: number; releaseId: number; status: BuildStatus; pluginSlug: string; sha256: string; bytes: number; manifestSha256: string; attempts: number; decidedBy: string;
  baseImageId: string | null; imageId: string | null; imageBytes: number | null; imageRemovedAt: Date | null; code: string | null; createdAt: Date; startedAt: Date | null; finishedAt: Date | null;
}
/** What the builder works from (PF-C2: the release row's hashes come from the JOIN, so the builder can compare all three). */
export interface ClaimedBuild extends BuildRow {
  zip: Buffer; releaseSha256: string; releaseManifestSha256: string; releaseTaskId: string;
  /** The release requester's department (the software head's): the recipient of the build notices. `deptId` is the idea's department: the grant of the staged server (F9). */
  releaseDeptId: string; ideaId: number; deptId: string;
}
export interface NewBuild { releaseId: number; forgeId: number; pluginSlug: string; sha256: string; bytes: number; manifestSha256: string; decidedBy: string; zip: Buffer }
export interface ForgeCounts { forgeBuilds: number; today: number; images: number }
export interface ForgeDay { builds: number; staged: number; failed: number; installed: number; waiting: number }
export type ReconcileEvent =
  | { kind: 'cancelled'; forgeId: number; ideaId: number; deptId: string; reason: ForgeCloseReason }
  | { kind: 'live'; forgeId: number; ideaId: number; deptId: string; why: 'server_gone' | 'server_replaced' }
  | { kind: 'installed'; forgeId: number; ideaId: number; ideaName: string; deptId: string; releaseDeptId: string; slug: string; approvedBy: string; serverId: number; tools: number; closedIdea: boolean }
  | { kind: 'build_cancelled'; buildId: number; forgeId: number; code: string };
export interface GcCandidate { buildId: number; imageId: string }

const BUILD_COLS = `b.id, b.forge_id AS "forgeId", b.release_id AS "releaseId", b.status, b.plugin_slug AS "pluginSlug", b.sha256, b.bytes, b.manifest_sha256 AS "manifestSha256", b.attempts,
  b.decided_by AS "decidedBy", b.base_image_id AS "baseImageId", b.image_id AS "imageId", b.image_bytes AS "imageBytes", b.image_removed_at AS "imageRemovedAt", b.code,
  b.created_at AS "createdAt", b.started_at AS "startedAt", b.finished_at AS "finishedAt"`;
const FORGE_COLS = `id, idea_id AS "ideaId", project_id AS "projectId", dept_id AS "deptId", proposer, status, server_id AS "serverId", created_at AS "createdAt", updated_at AS "updatedAt", closed_at AS "closedAt", close_reason AS "closeReason"`;
const DAY = (tz: string): string => `(date_trunc('day', now() AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`;
const CODE = /^[a-z_]{1,40}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const ACTOR = 'system:forge';
class NotLive extends Error {}

/**
 * R7 PLUGIN-FORGE (spec 5.2): the forge and build rows. Only `forge/` and app.ts import this file. It READS `mcp_servers`, `releases` and `projects` and never writes them (a grep test); the
 * `mcp_servers` write is `McpRepo.stage` alone, under the mcp advisory lock. No transaction here takes that lock or calls into McpRepo, and a transaction that holds a build row never waits
 * for the mcp lock, so the two cannot form a cycle (stage: advisory lock, then the build and forge rows; here: build, then forge rows, never the advisory lock).
 * Every audit row is a THROWING insert on the transaction client, so a state change never commits without its row. Row text never reaches an audit outcome: codes, ids and hashes only.
 */
export class ForgeRepo {
  constructor(private readonly pool: Pool) {}

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  private async audit(c: PoolClient, action: string, outcome: string, actor: string = ACTOR): Promise<void> {
    await c.query('INSERT INTO audit_log (actor, action, outcome) VALUES ($1,$2,$3)', [actor, action, outcome]); // throws: no change without its row
  }

  async byProject(projectId: number): Promise<ForgeRow | null> {
    return (await this.pool.query<ForgeRow>(`SELECT ${FORGE_COLS} FROM plugin_forges WHERE project_id = $1`, [projectId])).rows[0] ?? null;
  }
  async byId(id: number): Promise<ForgeRow | null> {
    return (await this.pool.query<ForgeRow>(`SELECT ${FORGE_COLS} FROM plugin_forges WHERE id = $1`, [id])).rows[0] ?? null;
  }
  async list(n = 25): Promise<ForgeRow[]> {
    return (await this.pool.query<ForgeRow>(`SELECT ${FORGE_COLS} FROM plugin_forges ORDER BY id DESC LIMIT $1`, [Math.min(Math.max(Math.trunc(n) || 25, 1), 100)])).rows;
  }
  /**
   * FORGE_NOTE_HQ (5.5): up to 5 open, untainted tool ideas with no live or staged forge, oldest first. Plain rows: `forge/notes.ts` cleans, caps and delimits the text; nothing here reaches a log.
   */
  async eligibleIdeas(n = 5): Promise<{ id: number; name: string; deptId: string; problem: string; example: string; tainted: boolean; status: 'open' | 'closed' }[]> {
    return (await this.pool.query<{ id: number; name: string; deptId: string; problem: string; example: string; tainted: boolean; status: 'open' | 'closed' }>(
      `SELECT i.id, i.name, i.dept_id AS "deptId", i.problem, i.example, i.tainted, i.status FROM tool_ideas i
       WHERE i.status = 'open' AND i.tainted = false AND NOT EXISTS (SELECT 1 FROM plugin_forges f WHERE f.idea_id = i.id AND f.status IN ('live','staged'))
       ORDER BY i.id LIMIT $1`, [Math.min(Math.max(Math.trunc(n) || 5, 1), 5)])).rows;
  }

  /** FORGE_NOTE_SOFTWARE (5.5): the task root is the root of an `active` project whose forge is `live`: the project number and the idea. null on any other shape. */
  async softwareIdea(rootId: string): Promise<{ projectId: number; idea: { id: number; name: string; deptId: string; problem: string; example: string; tainted: boolean; status: 'open' | 'closed' } } | null> {
    if (!/^[0-9a-f-]{36}$/.test(rootId)) return null;
    const r = (await this.pool.query<{ projectId: number; id: number; name: string; deptId: string; problem: string; example: string; tainted: boolean; status: 'open' | 'closed' }>(
      `SELECT p.id AS "projectId", i.id, i.name, i.dept_id AS "deptId", i.problem, i.example, i.tainted, i.status
       FROM projects p JOIN plugin_forges f ON f.project_id = p.id AND f.status = 'live' JOIN tool_ideas i ON i.id = f.idea_id
       WHERE p.root_task_id = $1 AND p.status = 'active'`, [rootId])).rows[0];
    if (!r) return null;
    const { projectId, ...idea } = r;
    return { projectId, idea };
  }

  /** `/forge list` (5.8): newest first with the idea name, the server slug and the last build of each forge. */
  async listItems(n = 25): Promise<ForgeListItem[]> {
    const r = await this.pool.query<ForgeListItem>(
      `SELECT f.id, f.idea_id AS "ideaId", i.name AS "ideaName", f.dept_id AS "deptId", f.status, f.project_id AS "projectId", s.slug AS "serverSlug",
              CASE WHEN lb.id IS NULL THEN NULL ELSE jsonb_build_object('id', lb.id, 'status', lb.status, 'code', lb.code) END AS "lastBuild"
       FROM plugin_forges f JOIN tool_ideas i ON i.id = f.idea_id LEFT JOIN mcp_servers s ON s.id = f.server_id
       LEFT JOIN LATERAL (SELECT b.id, b.status, b.code FROM plugin_builds b WHERE b.forge_id = f.id ORDER BY b.id DESC LIMIT 1) lb ON true
       ORDER BY f.id DESC LIMIT $1`, [Math.min(Math.max(Math.trunc(n) || 25, 1), 100)]);
    return r.rows;
  }

  /** `/forge show` (5.8): the idea, the project, the releases, the builds (never the zip) and the server of one forge. */
  async detail(id: number): Promise<ForgeDetail | null> {
    if (!Number.isSafeInteger(id) || id < 1) return null;
    const f = (await this.pool.query<{ id: number; ideaId: number; ideaName: string; deptId: string; status: string; closeReason: string | null; projectId: number; projectTitle: string; projectStatus: string; serverId: number | null }>(
      `SELECT f.id, f.idea_id AS "ideaId", i.name AS "ideaName", f.dept_id AS "deptId", f.status, f.close_reason AS "closeReason", f.project_id AS "projectId", p.title AS "projectTitle", p.status AS "projectStatus", f.server_id AS "serverId"
       FROM plugin_forges f JOIN tool_ideas i ON i.id = f.idea_id JOIN projects p ON p.id = f.project_id WHERE f.id = $1`, [id])).rows[0];
    if (!f) return null;
    const releases = (await this.pool.query<{ id: number; status: string }>('SELECT id, status FROM releases WHERE forge_id = $1 ORDER BY id', [id])).rows;
    const builds = (await this.pool.query<{ id: number; releaseId: number; status: string; code: string | null; attempts: number; image12: string | null }>(
      `SELECT id, release_id AS "releaseId", status, code, attempts, substr(image_id, 8, 12) AS image12 FROM plugin_builds WHERE forge_id = $1 ORDER BY id`, [id])).rows;
    const server = f.serverId === null ? null : (await this.pool.query<{ slug: string; status: string }>('SELECT slug, status FROM mcp_servers WHERE id = $1', [f.serverId])).rows[0] ?? null;
    const { serverId: _s, ...rest } = f;
    return { ...rest, releases, builds, server };
  }

  /**
   * `/forge cancel` (3.2, 5.8): a `live` or `staged` forge becomes `cancelled` (`admin_cancel`) and its queued builds are cancelled (zip dropped). Refused `busy` while a build is `building`
   * (it would stage a server for a cancelled forge). A staged server is NOT touched: the caller tells the admin to use `/mcp disable`. The throwing audit row names the admin and carries no free text.
   */
  async adminCancel(id: number, userId: string): Promise<ForgeCancelResult> {
    if (!/^[0-9]{17,20}$/.test(userId)) throw new Error('forge: an admin snowflake is required');
    if (!Number.isSafeInteger(id) || id < 1) return { ok: false, code: 'not_found' };
    return this.tx(async (c): Promise<ForgeCancelResult> => {
      const f = (await c.query<{ status: ForgeStatus; server_id: number | null }>('SELECT status, server_id FROM plugin_forges WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!f) return { ok: false, code: 'not_found' };
      if (f.status !== 'live' && f.status !== 'staged') return { ok: false, code: 'not_open' };
      if ((await c.query("SELECT 1 FROM plugin_builds WHERE forge_id = $1 AND status = 'building'", [id])).rowCount) return { ok: false, code: 'busy' };
      await c.query("UPDATE plugin_builds SET status = 'cancelled', code = 'forge_cancelled', zip = NULL, finished_at = now() WHERE forge_id = $1 AND status = 'queued'", [id]);
      await c.query("UPDATE plugin_forges SET status = 'cancelled', closed_at = now(), close_reason = 'admin_cancel', updated_at = now() WHERE id = $1", [id]);
      await this.audit(c, 'forge.cancel', `#${id} admin_cancel`, `user:${userId}`);
      const s = f.server_id === null ? null : (await c.query<{ slug: string; status: string }>('SELECT slug, status FROM mcp_servers WHERE id = $1', [f.server_id])).rows[0] ?? null;
      return { ok: true, serverSlug: s?.slug ?? null, serverStatus: s?.status ?? null };
    });
  }

  async build(id: number): Promise<BuildRow | null> {
    return (await this.pool.query<BuildRow>(`SELECT ${BUILD_COLS} FROM plugin_builds b WHERE b.id = $1`, [id])).rows[0] ?? null;
  }
  async buildsOf(forgeId: number): Promise<BuildRow[]> {
    return (await this.pool.query<BuildRow>(`SELECT ${BUILD_COLS} FROM plugin_builds b WHERE b.forge_id = $1 ORDER BY b.id`, [forgeId])).rows;
  }

  /** The forge of a project with its idea name and department (the request port, 3.3 step 8b, and the card line). */
  async forgeOfProject(projectId: number): Promise<{ id: number; status: ForgeStatus; ideaId: number; ideaName: string; deptId: string } | null> {
    if (!Number.isSafeInteger(projectId) || projectId < 1) return null;
    return (await this.pool.query<{ id: number; status: ForgeStatus; ideaId: number; ideaName: string; deptId: string }>(
      `SELECT f.id, f.status, f.idea_id AS "ideaId", i.name AS "ideaName", f.dept_id AS "deptId" FROM plugin_forges f JOIN tool_ideas i ON i.id = f.idea_id WHERE f.project_id = $1`, [projectId])).rows[0] ?? null;
  }

  /**
   * F8 at request time (3.3 step 10): is the plugin slug used by an MCP server? Any row with the slug counts, except a `disabled` or `quarantined` row that came from a release of THIS forge (a retry after
   * a failed install). Advisory only: the stage re-checks under the McpRepo lock (PF-C8).
   */
  async slugTaken(slug: string, forgeId: number): Promise<boolean> {
    const r = await this.pool.query(
      `SELECT 1 FROM mcp_servers s WHERE s.slug = $1
         AND NOT (s.status IN ('disabled','quarantined') AND s.source = 'release' AND EXISTS (SELECT 1 FROM releases r WHERE r.id = s.release_id AND r.forge_id = $2))`, [slug, forgeId]);
    return (r.rowCount ?? 0) > 0;
  }

  /** The three request-time caps (3.3 step 8c): builds of this forge that are not cancelled, builds created today (local day of `tz`) that are not cancelled, retained images. */
  async counts(forgeId: number, tz: string): Promise<ForgeCounts> {
    const r = await this.pool.query<ForgeCounts>(
      `SELECT (SELECT count(*) FROM plugin_builds WHERE forge_id = $1 AND status <> 'cancelled')::int AS "forgeBuilds",
              (SELECT count(*) FROM plugin_builds WHERE status <> 'cancelled' AND created_at >= ${DAY('$2::text')})::int AS today,
              (SELECT count(*) FROM plugin_builds WHERE image_id IS NOT NULL AND image_removed_at IS NULL)::int AS images`, [forgeId, tz]);
    return r.rows[0]!;
  }
  /** True when a request must be refused for one of the three caps, in the spec order. */
  static capCode(c: ForgeCounts): 'forge_attempts' | 'forge_day_cap' | 'image_cap' | null {
    if (c.forgeBuilds >= BUILDS_PER_FORGE) return 'forge_attempts';
    if (c.today >= BUILDS_PER_DAY) return 'forge_day_cap';
    if (c.images >= IMAGES_KEPT_MAX) return 'image_cap';
    return null;
  }

  /**
   * 3.4 step 1: the inert build row. `ON CONFLICT (release_id) DO NOTHING`. PF-C11: when the conflict row is `queued` with the same forge, sha256 and manifest, only its `decided_by` is
   * updated (a re-approve by another admin after a certain revert); anything else is `exists`.
   */
  async enqueue(b: NewBuild): Promise<{ ok: true } | { ok: false; code: 'exists' }> {
    return this.tx(async (c) => {
      const ins = await c.query(
        `INSERT INTO plugin_builds (forge_id, release_id, plugin_slug, sha256, bytes, manifest_sha256, zip, decided_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (release_id) DO NOTHING RETURNING id`, [b.forgeId, b.releaseId, b.pluginSlug, b.sha256, b.bytes, b.manifestSha256, b.zip, b.decidedBy]);
      if (ins.rowCount === 1) return { ok: true } as const;
      const u = await c.query(
        `UPDATE plugin_builds SET decided_by = $2 WHERE release_id = $1 AND status = 'queued' AND forge_id = $3 AND sha256 = $4 AND manifest_sha256 = $5 AND plugin_slug = $6`,
        [b.releaseId, b.decidedBy, b.forgeId, b.sha256, b.manifestSha256, b.pluginSlug]);
      return u.rowCount === 1 ? ({ ok: true } as const) : ({ ok: false, code: 'exists' } as const);
    });
  }

  /**
   * The oldest eligible queued build, claimed in one transaction (`queued -> building`, attempts + 1, only while attempts < 3) with its throwing `forge.build #b start` row. Eligible: its
   * release is `released` and its forge `live`. The single-flight is the unique index `plugin_builds_one_building`; a unique violation (another build is running) is `null`.
   */
  async claimNext(): Promise<ClaimedBuild | null> {
    try {
      return await this.tx(async (c) => {
        if ((await c.query("SELECT 1 FROM plugin_builds WHERE status = 'building'")).rowCount! > 0) return null;
        const pick = await c.query<{ id: number }>(
          `SELECT b.id FROM plugin_builds b JOIN releases r ON r.id = b.release_id JOIN plugin_forges f ON f.id = b.forge_id
           WHERE b.status = 'queued' AND b.attempts < $1 AND r.status = 'released' AND f.status = 'live'
           ORDER BY b.created_at, b.id LIMIT 1 FOR UPDATE OF b SKIP LOCKED`, [MAX_ATTEMPTS]);
        const id = pick.rows[0]?.id;
        if (id === undefined) return null;
        const u = await c.query(`UPDATE plugin_builds SET status = 'building', started_at = now(), attempts = attempts + 1 WHERE id = $1 AND status = 'queued' AND attempts < $2`, [id, MAX_ATTEMPTS]);
        if (u.rowCount !== 1) return null;
        await this.audit(c, 'forge.build', `#${id} start`);
        const r = await c.query<ClaimedBuild>(
          `SELECT ${BUILD_COLS}, b.zip, r.sha256 AS "releaseSha256", r.plugin_manifest_sha256 AS "releaseManifestSha256", r.task_id AS "releaseTaskId", r.dept_id AS "releaseDeptId", f.idea_id AS "ideaId", f.dept_id AS "deptId"
           FROM plugin_builds b JOIN releases r ON r.id = b.release_id JOIN plugin_forges f ON f.id = b.forge_id WHERE b.id = $1`, [id]);
        return r.rows[0] ?? null;
      });
    } catch (e) {
      if ((e as { code?: string }).code === '23505') return null; // plugin_builds_one_building: another build is running
      throw e;
    }
  }

  /**
   * `building -> queued`. `refund` (halt or the forge switch going off) gives the attempt back, so a halt never uses one up (PF-C17); a crash or restart does not refund, and at
   * attempts = 3 the build becomes `failed:interrupted` instead. Returns what happened, or null when the row is no longer `building`.
   */
  async requeue(id: number, o: { why: 'halted' | 'interrupted'; refund: boolean }): Promise<'queued' | 'failed' | null> {
    return this.tx(async (c) => {
      const row = (await c.query<{ attempts: number }>("SELECT attempts FROM plugin_builds WHERE id = $1 AND status = 'building' FOR UPDATE", [id])).rows[0];
      if (!row) return null;
      if (!o.refund && row.attempts >= MAX_ATTEMPTS) {
        await c.query("UPDATE plugin_builds SET status = 'failed', code = 'interrupted', zip = NULL, finished_at = now() WHERE id = $1", [id]);
        await this.audit(c, 'forge.build', `#${id} failed:interrupted`);
        return 'failed' as const;
      }
      // An image whose removal was recorded is forgotten here, so the next attempt can record its own (`recordImage` needs image_id NULL); an image that was kept (a server holds it) stays.
      await c.query(
        `UPDATE plugin_builds SET status = 'queued', started_at = NULL, attempts = CASE WHEN $2::boolean THEN GREATEST(attempts - 1, 0) ELSE attempts END,
           image_id = CASE WHEN image_removed_at IS NOT NULL THEN NULL ELSE image_id END, image_removed_at = NULL WHERE id = $1`, [id, o.refund]);
      await this.audit(c, 'forge.build', `#${id} requeued:${o.why}`);
      return 'queued' as const;
    });
  }

  /** `queued|building -> failed` with a closed code; the zip is dropped. A failed build keeps its `image_id` (the GC removes the image). False when the row is already terminal. */
  async fail(id: number, code: string): Promise<boolean> {
    if (!CODE.test(code)) throw new Error('forge: bad build code');
    return this.tx(async (c) => {
      const u = await c.query("UPDATE plugin_builds SET status = 'failed', code = $2, zip = NULL, finished_at = now() WHERE id = $1 AND status IN ('queued','building')", [id, code]);
      if (u.rowCount !== 1) return false;
      await this.audit(c, 'forge.build', `#${id} failed:${code}`);
      return true;
    });
  }

  /**
   * PF-C5 (spec gap: §5.2 lists no such method): ONE statement, right after `commit` passed its output regex, records the new image id while the build is still `building`, so a crash after
   * this point leaves a row that boot recovery and the GC can find. Only once per build.
   */
  async recordImage(id: number, imageId: string): Promise<boolean> {
    if (!IMAGE_ID.test(imageId)) throw new Error('forge: bad image id');
    return (await this.pool.query("UPDATE plugin_builds SET image_id = $2 WHERE id = $1 AND status = 'building' AND image_id IS NULL", [id, imageId])).rowCount === 1;
  }

  /**
   * One transaction: the build is `staged` (image, base, size, finish time, zip dropped) and its forge `live -> staged` with the server id; the throwing audit row. If the forge is no longer
   * `live` (cancelled while the build ran) nothing commits and the result is false.
   */
  async staged(id: number, a: { imageId: string; baseImageId: string; imageBytes: number; serverId: number; slug: string; cfg12: string }): Promise<boolean> {
    try {
      return await this.stagedTx(id, a);
    } catch (e) {
      if (e instanceof NotLive) return false;
      throw e;
    }
  }
  private async stagedTx(id: number, a: { imageId: string; baseImageId: string; imageBytes: number; serverId: number; slug: string; cfg12: string }): Promise<boolean> {
    return this.tx(async (c) => {
      const b = await c.query<{ forge_id: number }>(
        `UPDATE plugin_builds SET status = 'staged', image_id = COALESCE(image_id, $2), base_image_id = $3, image_bytes = $4, finished_at = now(), zip = NULL
         WHERE id = $1 AND status = 'building' AND (image_id IS NULL OR image_id = $2) RETURNING forge_id`, [id, a.imageId, a.baseImageId, a.imageBytes]);
      if (b.rowCount !== 1) return false;
      const f = await c.query("UPDATE plugin_forges SET status = 'staged', server_id = $2, updated_at = now() WHERE id = $1 AND status = 'live'", [b.rows[0]!.forge_id, a.serverId]);
      if (f.rowCount !== 1) throw new NotLive(); // rolls the build row back too
      await this.audit(c, 'forge.build', `#${id} staged ${a.slug} ${a.cfg12}`);
      return true;
    });
  }

  /** Builds that were `building` when the process stopped (boot recovery removes each one's image first, then requeues or fails it). */
  async recover(): Promise<{ id: number; forgeId: number; imageId: string | null; attempts: number }[]> {
    return (await this.pool.query<{ id: number; forgeId: number; imageId: string | null; attempts: number }>(`SELECT id, forge_id::int AS "forgeId", image_id AS "imageId", attempts FROM plugin_builds WHERE status = 'building' ORDER BY id`)).rows;
  }

  /** The server row staged for this release (3.5 step 8 idempotency). Read only. */
  async serverOfRelease(releaseId: number): Promise<{ id: number; slug: string; imageId: string; status: string } | null> {
    return (await this.pool.query<{ id: number; slug: string; imageId: string; status: string }>('SELECT id, slug, image_id AS "imageId", status FROM mcp_servers WHERE release_id = $1', [releaseId])).rows[0] ?? null;
  }

  /** The forge row as the builder re-checks it between steps: still live, its project still active. */
  async stillLive(forgeId: number): Promise<boolean> {
    const r = await this.pool.query("SELECT 1 FROM plugin_forges f JOIN projects p ON p.id = f.project_id WHERE f.id = $1 AND f.status = 'live' AND p.status = 'active'", [forgeId]);
    return r.rowCount === 1;
  }

  /** Queued builds older than 7 days: `cancelled:expired`, zip dropped. */
  async expireQueued(): Promise<number> {
    const r = await this.pool.query(
      `UPDATE plugin_builds SET status = 'cancelled', code = 'expired', zip = NULL, finished_at = now() WHERE status = 'queued' AND created_at < now() - make_interval(days => $1)`, [QUEUE_TTL_DAYS]);
    return r.rowCount ?? 0;
  }

  /**
   * 3.2 + PF-C12. One transaction per forge, rows locked FOR UPDATE (forge, then the queued builds of it); the mcp advisory lock is never taken. Returns what changed, for the notices.
   *  - queued builds whose release is failed, rejected or expired, or whose forge is cancelled: cancelled (`release_<status>`, `forge_cancelled`);
   *  - a `live` forge whose project is `done`, or `cancelled` after it was activated: cancelled `project_closed`; a project cancelled before it ever had a root: `project_cancelled`;
   *  - a `staged` forge: its server row (the forge's `server_id`) disabled, quarantined, gone or no longer this forge's release row: back to `live`; `active` AND source release AND its release
   *    belongs to this forge AND its image id equals that build's image id: `installed`, and the idea is closed by compare-and-set on `status = 'open'` with the approving admin.
   */
  async reconcile(): Promise<ReconcileEvent[]> {
    const events: ReconcileEvent[] = [];
    const ids = (await this.pool.query<{ id: number }>("SELECT id FROM plugin_forges WHERE status IN ('live','staged') ORDER BY id")).rows.map((r) => r.id);
    for (const id of ids) {
      const ev = await this.tx(async (c) => {
        const f = (await c.query<ForgeRow>(`SELECT ${FORGE_COLS} FROM plugin_forges WHERE id = $1 AND status IN ('live','staged') FOR UPDATE`, [id])).rows[0];
        if (!f) return [];
        const out: ReconcileEvent[] = [];
        const cancel = async (reason: ForgeCloseReason): Promise<void> => {
          await c.query("UPDATE plugin_forges SET status = 'cancelled', closed_at = now(), close_reason = $2, updated_at = now() WHERE id = $1", [f.id, reason]);
          await this.audit(c, 'forge.cancel', `#${f.id} ${reason}`);
          out.push({ kind: 'cancelled', forgeId: f.id, ideaId: f.ideaId, deptId: f.deptId, reason });
        };
        if (f.status === 'live') {
          const p = (await c.query<{ status: string; root: string | null }>('SELECT status, root_task_id AS root FROM projects WHERE id = $1', [f.projectId])).rows[0];
          if (p && (p.status === 'done' || p.status === 'cancelled')) await cancel(p.status === 'cancelled' && p.root === null ? 'project_cancelled' : 'project_closed');
        } else {
          const s = f.serverId === null ? null : (await c.query<{ id: number; slug: string; status: string; source: string; release_id: number | null; image_id: string; approved_by: string | null; tools: number }>(
            'SELECT id, slug, status, source, release_id, image_id, approved_by, jsonb_array_length(snapshot)::int AS tools FROM mcp_servers WHERE id = $1', [f.serverId])).rows[0] ?? null;
          const mine = s !== null && s.source === 'release' && s.release_id !== null
            ? (await c.query<{ image_id: string | null }>("SELECT b.image_id FROM plugin_builds b WHERE b.release_id = $1 AND b.forge_id = $2 AND b.status = 'staged'", [s.release_id, f.id])).rows[0] ?? null
            : null;
          const own = s !== null && mine !== null && mine.image_id === s.image_id;
          const back = async (why: 'server_gone' | 'server_replaced'): Promise<void> => {
            await c.query("UPDATE plugin_forges SET status = 'live', server_id = NULL, updated_at = now() WHERE id = $1", [f.id]);
            await this.audit(c, 'forge.cancel', `#${f.id} live:${why}`);
            out.push({ kind: 'live', forgeId: f.id, ideaId: f.ideaId, deptId: f.deptId, why });
          };
          if (s === null) await back('server_gone');
          else if (s.status === 'disabled' || s.status === 'quarantined') await back('server_gone');
          else if (!own) await back('server_replaced');
          else if (s.status === 'active' && s.approved_by !== null) {
            await c.query("UPDATE plugin_forges SET status = 'installed', closed_at = now(), close_reason = 'installed', updated_at = now() WHERE id = $1", [f.id]);
            const closed = await c.query("UPDATE tool_ideas SET status = 'closed', closed_by = $2, closed_at = now(), close_reason = $3 WHERE id = $1 AND status = 'open'", [f.ideaId, s.approved_by, `Installed as MCP server ${s.slug}.`]);
            await this.audit(c, 'forge.install', `#${f.id} installed ${s.slug} idea #${f.ideaId}`);
            const name = (await c.query<{ name: string }>('SELECT name FROM tool_ideas WHERE id = $1', [f.ideaId])).rows[0]?.name ?? '';
            const relDept = (await c.query<{ dept_id: string }>('SELECT dept_id FROM releases WHERE id = $1', [s.release_id])).rows[0]?.dept_id ?? f.deptId;
            out.push({ kind: 'installed', forgeId: f.id, ideaId: f.ideaId, ideaName: name, deptId: f.deptId, releaseDeptId: relDept, slug: s.slug, approvedBy: s.approved_by, serverId: s.id, tools: s.tools, closedIdea: closed.rowCount === 1 });
          }
        }
        return out;
      });
      events.push(...ev);
    }
    // queued builds that can never run
    const q = await this.pool.query<{ buildId: number; forgeId: number; code: string }>(
      `UPDATE plugin_builds b SET status = 'cancelled', zip = NULL, finished_at = now(),
         code = CASE WHEN f.status = 'cancelled' THEN 'forge_cancelled' WHEN r.status = 'failed' THEN 'release_failed' WHEN r.status = 'rejected' THEN 'release_rejected' ELSE 'release_expired' END
       FROM plugin_forges f, releases r
       WHERE f.id = b.forge_id AND r.id = b.release_id AND b.status = 'queued' AND (f.status = 'cancelled' OR r.status IN ('failed','rejected','expired'))
       RETURNING b.id AS "buildId", b.forge_id AS "forgeId", b.code`);
    for (const r of q.rows) events.push({ kind: 'build_cancelled', ...r });
    return events;
  }

  /**
   * 3.7 (a), (c), (d), from the database side: builds with a kept image where no pending, active or quarantined server holds that image id AND (the build failed, OR its server row is
   * `disabled` for 7 days, OR it has no server row 1 h after it finished). Never a `building` build. Rule (b), the label check, is the service's (inspect).
   */
  async gcCandidates(): Promise<GcCandidate[]> {
    const r = await this.pool.query<GcCandidate>(
      `SELECT b.id AS "buildId", b.image_id AS "imageId" FROM plugin_builds b LEFT JOIN mcp_servers s ON s.release_id = b.release_id
       WHERE b.image_id IS NOT NULL AND b.image_removed_at IS NULL AND b.status IN ('failed','staged')
         AND NOT EXISTS (SELECT 1 FROM mcp_servers m WHERE m.image_id = b.image_id AND m.status IN ('pending','active','quarantined'))
         AND (b.status = 'failed'
              OR (s.id IS NOT NULL AND s.status = 'disabled' AND s.disabled_at < now() - make_interval(days => $1))
              OR (s.id IS NULL AND b.finished_at < now() - make_interval(hours => $2)))
       ORDER BY b.id`, [GC_DISABLED_DAYS, GC_UNSTAGED_HOURS]);
    return r.rows;
  }

  /** PF-C5 orphan check for an image the daemon lists with the forge label: the build id it names and what the database knows (null when there is no such build). */
  async imageOwner(buildId: number): Promise<{ imageId: string | null; status: BuildStatus; sha256: string } | null> {
    return (await this.pool.query<{ imageId: string | null; status: BuildStatus; sha256: string }>('SELECT image_id AS "imageId", status, sha256 FROM plugin_builds WHERE id = $1', [buildId])).rows[0] ?? null;
  }
  /** G2-FG-06: does ANY mcp_servers row (every status, every source) name this image id? An image a server row ever held is not provably the forge's. */
  async imageEverHeld(imageId: string): Promise<boolean> {
    return (await this.pool.query('SELECT 1 FROM mcp_servers WHERE image_id = $1', [imageId])).rowCount! > 0;
  }
  /** Rule (c): does a pending, active or quarantined server hold this image id? */
  async imageInUse(imageId: string): Promise<boolean> {
    return (await this.pool.query("SELECT 1 FROM mcp_servers WHERE image_id = $1 AND status IN ('pending','active','quarantined')", [imageId])).rowCount! > 0;
  }
  /** Is this image id the one a build row records and keeps? */
  async imageKept(imageId: string): Promise<boolean> {
    return (await this.pool.query('SELECT 1 FROM plugin_builds WHERE image_id = $1 AND image_removed_at IS NULL', [imageId])).rowCount! > 0;
  }

  /** The image is gone from the daemon (verified by the caller): `image_removed_at` and the throwing `forge.gc` row. False when it was already recorded. */
  async imageRemoved(id: number, image12: string): Promise<boolean> {
    return this.tx(async (c) => {
      const u = await c.query('UPDATE plugin_builds SET image_removed_at = now() WHERE id = $1 AND image_id IS NOT NULL AND image_removed_at IS NULL', [id]);
      if (u.rowCount !== 1) return false;
      await this.audit(c, 'forge.gc', `#${id} removed ${image12}`);
      return true;
    });
  }

  /** The digest line's counts (today, local day of `tz`); `waiting` is the forges staged now (a server waits for /mcp approve). */
  async day(tz: string): Promise<ForgeDay> {
    const r = await this.pool.query<ForgeDay>(
      `SELECT (SELECT count(*) FROM plugin_builds WHERE started_at >= ${DAY('$1::text')})::int AS builds,
              (SELECT count(*) FROM plugin_builds WHERE status = 'staged' AND finished_at >= ${DAY('$1::text')})::int AS staged,
              (SELECT count(*) FROM plugin_builds WHERE status = 'failed' AND finished_at >= ${DAY('$1::text')})::int AS failed,
              (SELECT count(*) FROM plugin_forges WHERE status = 'installed' AND closed_at >= ${DAY('$1::text')})::int AS installed,
              (SELECT count(*) FROM plugin_forges WHERE status = 'staged')::int AS waiting`, [tz]);
    return r.rows[0]!;
  }
}

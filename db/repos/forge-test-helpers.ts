import { randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from '../pool.js';

/** Seed helpers for the R7 integration tests (raw SQL: the repos under test never write projects, releases or ideas). */
export const ADMIN = '900000000000000001';
export const ADMIN2 = '900000000000000002';
export const SHA = 'a'.repeat(64);
export const MAN = 'b'.repeat(64);
export const BASE = `sha256:${'1'.repeat(64)}`;
export const IMG = `sha256:${'2'.repeat(64)}`;
const hex = (n: number): string => randomBytes(n).toString('hex');

export async function seedDepts(pool: Pool): Promise<void> {
  await pool.query("INSERT INTO departments (id, name) VALUES ('hq','hq'), ('software','software'), ('sales','sales') ON CONFLICT DO NOTHING");
}

export async function newProject(pool: Pool, o: { status?: 'proposed' | 'active' | 'done' | 'cancelled'; rooted?: boolean } = {}): Promise<{ id: number; root: string | null }> {
  const status = o.status ?? 'active';
  const rooted = o.rooted ?? (status === 'active' || status === 'done');
  let root: string | null = null;
  if (rooted) {
    root = randomUUID();
    await pool.query("INSERT INTO tasks (id, title, dept_id, owner, requester, root_id, origin, tainted) VALUES ($1,'root','hq','{}','{}',$1,'chat',false)", [root]);
  }
  const r = await pool.query<{ id: number }>(
    `INSERT INTO projects (token, title, goal, deadline, max_local_calls, max_usd, max_approvals, base_local_calls, base_usd, base_approvals, status, root_task_id, approved_by, approved_at, proposer, expires_at)
     VALUES ($1,'p','goal',current_date + 3,10,1,10,10,1,10,$2,$3,$4,$5,'head:hq', now() + interval '3 days') RETURNING id`,
    [hex(16), status, root, root ? ADMIN : null, root ? new Date() : null]);
  return { id: r.rows[0]!.id, root };
}

export async function newIdea(pool: Pool, o: { dept?: string; name?: string; tainted?: boolean } = {}): Promise<number> {
  const r = await pool.query<{ id: number }>(
    "INSERT INTO tool_ideas (dept_id, name, problem, example, tainted, proposer) VALUES ($1,$2,'a problem that is long enough','an example',$3,'head:software') RETURNING id",
    [o.dept ?? 'software', o.name ?? `idea${hex(3)}`, o.tainted ?? false]);
  return r.rows[0]!.id;
}

export async function newForge(pool: Pool, o: { status?: 'live' | 'staged' | 'installed' | 'cancelled'; projectStatus?: 'proposed' | 'active' | 'done' | 'cancelled'; dept?: string; serverId?: number } = {}): Promise<{ forgeId: number; ideaId: number; projectId: number; root: string | null }> {
  await seedDepts(pool);
  const p = await newProject(pool, { status: o.projectStatus ?? 'active' });
  const ideaId = await newIdea(pool);
  const status = o.status ?? 'live';
  const f = await pool.query<{ id: number }>(
    `INSERT INTO plugin_forges (idea_id, project_id, dept_id, proposer, status, server_id, closed_at, close_reason)
     VALUES ($1,$2,$3,'head:hq',$4,$5, CASE WHEN $4 IN ('installed','cancelled') THEN now() END, CASE WHEN $4 = 'installed' THEN 'installed' WHEN $4 = 'cancelled' THEN 'admin_cancel' END) RETURNING id`,
    [ideaId, p.id, o.dept ?? 'software', status, o.serverId ?? null]);
  return { forgeId: f.rows[0]!.id, ideaId, projectId: p.id, root: p.root };
}

export async function newRelease(pool: Pool, o: { forgeId: number; projectId?: number | null; status?: 'pending' | 'released' | 'failed' | 'rejected' | 'expired'; slug?: string; sha?: string; manifest?: string; decidedBy?: string; zip?: Buffer; bytes?: number; taskId?: string }): Promise<number> {
  const status = o.status ?? 'released';
  const open = status === 'pending';
  const zip = o.zip ?? Buffer.from('zip-bytes');
  const decided = status === 'pending' || status === 'expired' ? null : (o.decidedBy ?? ADMIN);
  const task = o.taskId ?? randomUUID();
  const r = await pool.query<{ id: number }>(
    `INSERT INTO releases (token, dept_id, requester, task_id, root_id, project_id, target, title, summary, slug, sha256, bytes, files, evidence, tainted, catalog_digest, source_channel_id,
       status, zip, expires_at, decided_by, decided_at, released_message_id, released_at, forge_id, plugin_slug, plugin_manifest_sha256)
     VALUES ($1,'software','head:software',$2,$2,$3,'install_plugin','t','s','hello-plugin',$4,$5,1,'{}'::jsonb,false,$6,'900000000000000010',
       $7,$8, now() + interval '3 days', $9, CASE WHEN $9::text IS NOT NULL THEN now() END, CASE WHEN $7 = 'released' THEN '900000000000000011' END, CASE WHEN $7 = 'released' THEN now() END, $10,$11,$12) RETURNING id`,
    [hex(16), task, o.projectId ?? null, o.sha ?? SHA, o.bytes ?? zip.length, 'c'.repeat(64), status, open ? zip : null, decided, o.forgeId, o.slug ?? 'hello', o.manifest ?? MAN]);
  return r.rows[0]!.id;
}

export async function newBuild(pool: Pool, o: { forgeId: number; releaseId: number; status?: 'queued' | 'building' | 'staged' | 'failed' | 'cancelled'; slug?: string; sha?: string; manifest?: string; decidedBy?: string; zip?: Buffer; attempts?: number; imageId?: string | null; code?: string; createdAgo?: string }): Promise<number> {
  const status = o.status ?? 'queued';
  const zip = o.zip ?? Buffer.from('zip-bytes');
  const live = status === 'queued' || status === 'building';
  const img = o.imageId === undefined ? (status === 'staged' ? IMG : null) : o.imageId;
  const r = await pool.query<{ id: number }>(
    `INSERT INTO plugin_builds (forge_id, release_id, status, plugin_slug, sha256, bytes, manifest_sha256, zip, attempts, decided_by, base_image_id, image_id, image_bytes, code, started_at, finished_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, CASE WHEN $3 <> 'queued' THEN now() END, CASE WHEN $3 IN ('staged','failed','cancelled') THEN now() END, now() - $15::interval) RETURNING id`,
    [o.forgeId, o.releaseId, status, o.slug ?? 'hello', o.sha ?? SHA, zip.length, o.manifest ?? MAN, live ? zip : null, o.attempts ?? (status === 'queued' ? 0 : 1), o.decidedBy ?? ADMIN,
      status === 'staged' ? BASE : null, img, status === 'staged' ? 1000 : null, status === 'failed' || status === 'cancelled' ? (o.code ?? 'verify_failed') : null, o.createdAgo ?? '0 seconds']);
  return r.rows[0]!.id;
}

export async function newServer(pool: Pool, o: { slug?: string; status?: 'pending' | 'active' | 'quarantined' | 'disabled'; source?: 'admin' | 'release'; releaseId?: number | null; imageId?: string; cls?: 'read' | 'write'; approvedBy?: string; disabledDaysAgo?: number }): Promise<number> {
  const status = o.status ?? 'pending';
  const source = o.source ?? (o.releaseId ? 'release' : 'admin');
  const r = await pool.query<{ id: number }>(
    `INSERT INTO mcp_servers (slug, title, image_id, tool_class, snapshot, snapshot_sha256, added_by, status, source, release_id, approved_by, approved_at, approved_config_sha256, quarantine_reason, quarantined_at, disabled_by, disabled_at)
     VALUES ($1,'t',$2,$3,'[{"name":"x"}]',$4,$5,$6,$7,$8,
       CASE WHEN $6 = 'active' THEN $9::text END, CASE WHEN $6 = 'active' THEN now() END, CASE WHEN $6 = 'active' THEN $10::text END,
       CASE WHEN $6 = 'quarantined' THEN 'snapshot_changed' END, CASE WHEN $6 = 'quarantined' THEN now() END,
       CASE WHEN $6 = 'disabled' THEN $5::text END, CASE WHEN $6 = 'disabled' THEN now() - make_interval(days => $11::int) END) RETURNING id`,
    [o.slug ?? 'hello', o.imageId ?? IMG, o.cls ?? 'write', 'd'.repeat(64), ADMIN, status, source, source === 'release' ? (o.releaseId ?? null) : null, o.approvedBy ?? ADMIN, 'e'.repeat(64), o.disabledDaysAgo ?? 0]);
  return r.rows[0]!.id;
}

/** The forge, release, server, project and task rows reference each other in a ring (forge -> server -> release -> forge): a test resets them with one TRUNCATE .. CASCADE. */
export async function resetForgeTables(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE plugin_builds, plugin_forges, mcp_server_depts, mcp_servers, releases, projects, tool_ideas, audit_log, tasks RESTART IDENTITY CASCADE');
}

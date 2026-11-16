import type { Pool } from './pool.js';

/**
 * OD-1 (Gate 1 vps-deploy, closes G2SM-01 on the Mac): the LW Admin executor connects to PostgreSQL as its OWN role with the least privilege its
 * queries need, instead of the owner's role that the main application uses. This module is the one list of what it may touch. The grants are
 * applied by the owner (scripts/executor-role.ts), never by a migration (a role is cluster-wide and needs a login password).
 *
 * What the executor does with each table (grep the queries in executor/, db/repos/exec.ts, db/repos/adminCards.ts):
 *  - admin_cards: reads the confirmed card; its claim sets executed_at and nothing else (column-level UPDATE).
 *  - audit_log: appends its audit rows, counts them for the rate caps, purges member-id rows after 90 days.
 *  - exec_state, welcome_seen, server_archives, exec_outbox: its own tables.
 *  - config, channel_map: read only (tier roles, welcome settings, mapped channels).
 *  - deploy_uploads (read, delete after the send) and deploy_jobs (its queue record), migration 016.
 *  - dev_jobs (read; column update of the outcome only) and dev_job_bundles (read), migration 017 (self-code).
 * Everything else (tasks, approvals, provider_keys, secrets, ...) stays unreadable.
 */
export const EXECUTOR_ROLE = 'lw_executor';
const ROLE_RE = /^[a-z_][a-z0-9_]{0,30}$/;

export const EXECUTOR_TABLE_GRANTS: readonly { table: string; privileges: string }[] = [
  { table: 'admin_cards', privileges: 'SELECT' },
  { table: 'audit_log', privileges: 'SELECT, INSERT, DELETE' },
  { table: 'exec_state', privileges: 'SELECT, INSERT, UPDATE, DELETE' },
  { table: 'welcome_seen', privileges: 'SELECT, INSERT, UPDATE, DELETE' },
  { table: 'server_archives', privileges: 'SELECT, INSERT, UPDATE' },
  { table: 'exec_outbox', privileges: 'SELECT, INSERT, UPDATE, DELETE' },
  { table: 'config', privileges: 'SELECT' },
  { table: 'channel_map', privileges: 'SELECT' },
  { table: 'deploy_uploads', privileges: 'SELECT, DELETE' },
  { table: 'deploy_jobs', privileges: 'SELECT, INSERT, UPDATE, DELETE' },
  { table: 'dev_jobs', privileges: 'SELECT' },
  { table: 'dev_job_bundles', privileges: 'SELECT' },
];
export const EXECUTOR_SEQUENCE_TABLES = ['audit_log', 'exec_outbox'] as const;

const ident = (s: string): string => `"${s.replace(/"/g, '""')}"`;
const literal = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** The grant statements for `role` in `schema` (the role must exist). Idempotent: the role first loses everything it had in the schema. */
export function executorGrantStatements(role: string, schema: string): string[] {
  if (!ROLE_RE.test(role)) throw new Error('bad role name');
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(schema)) throw new Error('bad schema name');
  const r = ident(role);
  const s = ident(schema);
  const out = [
    `REVOKE ALL ON ALL TABLES IN SCHEMA ${s} FROM ${r}`,
    `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${s} FROM ${r}`,
    `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${s} FROM ${r}`,
    `GRANT USAGE ON SCHEMA ${s} TO ${r}`,
    `REVOKE CREATE ON SCHEMA ${s} FROM ${r}`,
  ];
  for (const g of EXECUTOR_TABLE_GRANTS) out.push(`GRANT ${g.privileges} ON ${s}.${ident(g.table)} TO ${r}`);
  out.push(`GRANT UPDATE (executed_at) ON ${s}.admin_cards TO ${r}`);
  out.push(`GRANT UPDATE (status, outcome, finished_at, updated_at) ON ${s}.dev_jobs TO ${r}`);
  for (const t of EXECUTOR_SEQUENCE_TABLES) out.push(`GRANT USAGE ON SEQUENCE ${s}.${ident(`${t}_id_seq`)} TO ${r}`);
  return out;
}

/** Creates the role with a login password (or only re-sets it) and applies the grants. Returns nothing secret. */
export async function applyExecutorRole(pool: Pick<Pool, 'query'>, o: { role?: string; password: string; schema?: string }): Promise<void> {
  const role = o.role ?? EXECUTOR_ROLE;
  if (!ROLE_RE.test(role)) throw new Error('bad role name');
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(o.password)) throw new Error('the password must be 32 to 128 plain characters');
  const exists = (await pool.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount ?? 0;
  const attrs = 'LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT NOBYPASSRLS CONNECTION LIMIT 8';
  await pool.query(exists ? `ALTER ROLE ${ident(role)} ${attrs} PASSWORD ${literal(o.password)}` : `CREATE ROLE ${ident(role)} ${attrs} PASSWORD ${literal(o.password)}`);
  await pool.query(`GRANT CONNECT ON DATABASE ${ident((await pool.query<{ d: string }>('SELECT current_database() AS d')).rows[0]!.d)} TO ${ident(role)}`);
  const schema = o.schema ?? (await pool.query<{ s: string }>('SELECT current_schema() AS s')).rows[0]!.s;
  for (const st of executorGrantStatements(role, schema)) await pool.query(st);
}

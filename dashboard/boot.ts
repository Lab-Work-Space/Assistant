import type { DevJob } from '../db/repos/devjobs.js';
import type { AuditFn } from '../governance/audit.js';
import type { DashboardStore } from '../db/repos/dashboard.js';
import type { AdminConsole } from '../admin/console.js';
import type { SettingsRegistry } from '../admin/settings.js';
import type { DashboardKnowledge } from '../knowledge/dashboard.js';
import { DashboardAuth } from './auth.js';
import { createEnvEntry } from './envEntry.js';
import { startDashboard, type DashboardData, type DashboardServer } from './server.js';

export const DEFAULT_DASHBOARD_PORT = 8787;

/** `DASHBOARD_PORT` from the process env: a valid unprivileged port, else the default. */
export function dashboardPortFrom(v: string | undefined): number {
  const n = v !== undefined && /^\d{1,5}$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : DEFAULT_DASHBOARD_PORT;
}

export interface BootDashboardOptions {
  /** Local mode, read from the real process env by the caller (global rule 7, never from env.local). */
  local: boolean;
  /** A reason when the process runs in a container (providers' inContainer), else null. */
  inContainer: () => string | null;
  port: number;
  store: DashboardStore;
  audit: AuditFn;
  isAdmin(userId: string): Promise<boolean>;
  console: Pick<AdminConsole, 'applyFromDashboard' | 'cancelFromDashboard'> & Partial<Pick<AdminConsole, 'mintKnowledgeCard'>>;
  knowledge?: DashboardKnowledge;
  devjobs?: { list(): Promise<DevJob[]>; byHead(sha: string): Promise<DevJob | null> };
  settings: SettingsRegistry;
  data: DashboardData;
  /** Env entry: where the files are (tests inject a temp dir) and how a change is announced. Absent: no Secrets page. */
  env?: { dir: string; envFile?: string; adminFile?: string; notify(text: string): Promise<void>; now?: () => number };
  log: { info(o: unknown, m?: string): void; error(o: unknown, m?: string): void };
}

export interface RunningDashboard {
  server: DashboardServer;
  /** `/dashboard`: a one-time sign-in URL for an admin the caller already checked. */
  link(userId: string): Promise<{ ok: true; url: string } | { ok: false; error: string }>;
  close(): Promise<void>;
}

/**
 * Gate 1 S38: the dashboard starts only in local mode and never inside a container (so never in the VPS image). The listen address is the
 * literal 127.0.0.1 inside `startDashboard`; there is nothing to configure. Returns null when it must not run.
 */
export async function bootDashboard(o: BootDashboardOptions): Promise<RunningDashboard | null> {
  if (!o.local) return null;
  const why = o.inContainer();
  if (why) {
    o.log.info({ reason: why }, 'dashboard not started in a container');
    return null;
  }
  const auth = new DashboardAuth({ store: o.store, audit: o.audit, isAdmin: o.isAdmin });
  let server: DashboardServer;
  try {
    server = await startDashboard({ port: o.port, auth, console: o.console, settings: o.settings, data: o.data, log: o.log, ...(o.knowledge ? { knowledge: o.knowledge } : {}), ...(o.devjobs ? { devjobs: o.devjobs } : {}),
      ...(o.env ? { env: createEnvEntry({ paths: { dir: o.env.dir, ...(o.env.envFile ? { envFile: o.env.envFile } : {}), ...(o.env.adminFile ? { adminFile: o.env.adminFile } : {}) }, audit: o.audit, notify: o.env.notify, log: o.log, ...(o.env.now ? { now: o.env.now } : {}) }) } : {}) });
  } catch (err) {
    // Isolation: a port that is taken (8787 is also wrangler's default) must not stop the assistant; /dashboard then says it is unavailable.
    o.log.error({ err: err instanceof Error ? err.name : 'error', port: o.port }, 'dashboard could not start; continuing without it');
    return null;
  }
  const purge = setInterval(() => void runPurge(o).catch(() => undefined), 60 * 60_000);
  purge.unref();
  return {
    server,
    async link(userId) {
      const r = await auth.issueLink(userId);
      return r.ok ? { ok: true, url: `${server.url()}/login?t=${r.token}` } : { ok: false, error: 'You asked for 3 links in the last 10 minutes. Try again later.' };
    },
    async close() { clearInterval(purge); await server.close(); },
  };
}

/** S51: expired sessions leave an audit row with their count (no ids). */
export async function runPurge(o: Pick<BootDashboardOptions, 'store' | 'audit'>): Promise<number> {
  const n = await o.store.purge();
  if (n > 0) await o.audit({ actor: 'system:dashboard', action: 'dashboard.session', outcome: `expired:${n}` });
  return n;
}

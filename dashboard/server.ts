import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { redactText } from '../core/logger.js';
import type { AdminCard } from '../db/repos/adminCards.js';
import type { DevJob } from '../db/repos/devjobs.js';
import type { AuditRow } from '../db/repos/ledger.js';
import type { AdminConsole } from '../admin/console.js';
import { ADMIN_READ_KEYS } from '../admin/keys.js';
import type { SettingsRegistry } from '../admin/settings.js';
import type { ConfigKey } from '../config/schema.js';
import { COOKIE, type DashboardAuth, type Session } from './auth.js';
import { spendPage, devjobPage, devjobsPage, auditPage, cardsPage, channelsPage, configPage, CSS, envPage, knowledgePage, stepUpPage, layout, loginPage, membersPage, messagePage, proposePage, statusPage, type AuditQuery, type Ctx, type StatusView } from './pages.js';
import { html } from './html.js';
import type { EnvEntry } from './envEntry.js';
import type { DashboardKnowledge } from '../knowledge/dashboard.js';

/** What the pages read. The app wires these to the live services; tests wire fakes. Nothing here returns a secret. */
export interface DashboardData {
  status(): Promise<StatusView>;
  readConfig(keys: readonly ConfigKey[]): { key: string; value: unknown }[];
  pendingCards(): Promise<AdminCard[]>;
  audit(q: { actor?: string; action?: string; sort: 'ts' | 'actor' | 'action'; dir: 'asc' | 'desc'; limit: number; offset: number }): Promise<AuditRow[]>;
  /** Absent until server management is enabled (the members list goes through the LW Admin client). */
  members?(): Promise<{ id: string; name: string; roles: string[] }[]>;
  channels(): Promise<{ id: string; name: string; parentId: string | null; type: number }[] | null>;
  /** How many channels are protected (shown only as a count). */
  lockedChannels(): number;
  /** SPEND-1: the read-only /spend page. Absent: the page says it is unavailable. */
  spend?(): Promise<import('../governance/spend/spend.js').SpendView>;
}

export interface DashboardDeps {
  /** 0 picks a free port (tests). The host is NOT an option: it is the literal 127.0.0.1 (Gate 1 S38). */
  port: number;
  auth: DashboardAuth;
  console: Pick<AdminConsole, 'applyFromDashboard' | 'cancelFromDashboard'> & Partial<Pick<AdminConsole, 'mintKnowledgeCard'>>;
  settings: SettingsRegistry;
  data: DashboardData;
  /** Self-knowledge page and its proposal steps. Absent: the page says it is unavailable. */
  knowledge?: DashboardKnowledge;
  /** Dev jobs (Gate 1 self-code X21): a read-only list and the diff page keyed by head sha. */
  devjobs?: { list(): Promise<DevJob[]>; byHead(sha: string): Promise<DevJob | null> };
  /** Env entry (Gate 1 env-entry). Absent: the Secrets page says it is unavailable. */
  env?: EnvEntry;
  log: { info(o: unknown, m?: string): void; error(o: unknown, m?: string): void };
}

export interface DashboardServer {
  address(): { host: string; port: number };
  url(): string;
  close(): Promise<void>;
}

const HOST = '127.0.0.1';
const BODY_MAX = 64 * 1024;
/** E17: secret routes take a small urlencoded body only. */
const SECRET_BODY_MAX = 4 * 1024;
const isSecretRoute = (p: string): boolean => p === '/secrets/set' || p === '/secrets/clear';
const MAX_FIELDS = 40;
const FIELD_MAX = 4000;
const CONN_MAX = 32;

const HEADERS: Record<string, string> = {
  'content-security-policy': "default-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'",
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  // 'same-origin', not 'no-referrer': under no-referrer a browser sends `Origin: null` on same-origin form POSTs, which the exact-Origin check (S39) must refuse.
  // No Referer ever leaves this origin, and pages load nothing third-party, so the login token still cannot leak (S42).
  'referrer-policy': 'same-origin',
  'cache-control': 'no-store',
};

function send(res: ServerResponse, code: number, body: string, extra: Record<string, string | string[]> = {}, type = 'text/html; charset=utf-8'): void {
  res.writeHead(code, { ...HEADERS, 'content-type': type, ...extra }).end(body);
}
const redirect = (res: ServerResponse, to: string, extra: Record<string, string | string[]> = {}) => send(res, 303, '', { location: to, ...extra });

function cookieOf(req: IncomingMessage): string | null {
  const h = req.headers.cookie;
  if (typeof h !== 'string' || h.length > 2000) return null;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return null;
}

/** S39: exactly one Host header, and it is 127.0.0.1:<port> or localhost:<port>. */
function hostOk(req: IncomingMessage, port: number): string | null {
  let n = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i]!.toLowerCase() === 'host') n++;
  const host = req.headers.host;
  if (n !== 1 || typeof host !== 'string') return null;
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` ? host : null;
}

async function readForm(req: IncomingMessage, max = BODY_MAX): Promise<Record<string, string> | null> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded') return null;
  const len = Number(req.headers['content-length'] ?? '0');
  if (!Number.isFinite(len) || len > max) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) return null;
    chunks.push(c as Buffer);
  }
  const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  let n = 0;
  for (const [k, v] of params) {
    if (++n > MAX_FIELDS || k.length > 64 || v.length > FIELD_MAX || k in out) return null; // strict: a duplicate key is refused
    out[k] = v;
  }
  return out;
}

export async function startDashboard(d: DashboardDeps): Promise<DashboardServer> {
  let port = 0;
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<string> => {
    const host = hostOk(req, port);
    if (!host) { send(res, 421, 'Misdirected request', {}, 'text/plain'); return 'host'; }
    const method = req.method ?? '';
    if (method !== 'GET' && method !== 'POST') { send(res, 405, 'Method not allowed', { allow: 'GET, POST' }, 'text/plain'); return 'method'; }
    const url = new URL(req.url ?? '/', `http://${host}`);
    const path = url.pathname;
    let form: Record<string, string> | null = null;
    if (method === 'POST') {
      // S39: same origin, port included. Cookies and SameSite ignore ports, so this is a separate check from S44.
      const origin = req.headers.origin;
      const site = req.headers['sec-fetch-site'];
      if (origin !== `http://${host}` || (site !== undefined && site !== 'same-origin')) { send(res, 403, 'Forbidden', {}, 'text/plain'); return 'origin'; }
      form = await readForm(req, isSecretRoute(path) ? SECRET_BODY_MAX : BODY_MAX);
      if (!form) { send(res, 400, 'Bad request', {}, 'text/plain'); return 'body'; }
    }
    if (path === '/app.css' && method === 'GET') { send(res, 200, CSS, {}, 'text/css; charset=utf-8'); return 'css'; }

    // ---- login (S41): GET only shows a button; the POST consumes ----
    if (path === '/login') {
      if (method === 'GET') {
        const t = url.searchParams.get('t') ?? '';
        if (t.length < 20 || t.length > 100) { send(res, 400, messagePage('Sign in', 'This sign-in link is not valid. Run /dashboard in Discord for a new one.', null)); return 'login-get'; }
        send(res, 200, loginPage(t));
        return 'login-get';
      }
      const r = await d.auth.login(form!['t'] ?? '');
      if (!r.ok) {
        send(res, r.reason === 'locked' ? 429 : 403, messagePage('Sign in', r.reason === 'locked' ? 'Too many attempts. Try again in a few minutes.' : 'This sign-in link is invalid, expired or already used. Run /dashboard in Discord for a new one.', null));
        return 'login-refused';
      }
      redirect(res, '/', { 'set-cookie': `${COOKIE}=${r.sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400` });
      return 'login';
    }

    const write = method === 'POST';
    const s: Session | null = await d.auth.session(cookieOf(req), write);
    if (!s) { send(res, 401, messagePage('Not signed in', 'Run /dashboard in #setting on Discord to get a sign-in link.', null)); return 'unauth'; }
    const c: Ctx = { csrf: s.csrf, userId: s.userId };

    if (write) {
      // S44: a per-session token in the body, not a cookie. The header is accepted too. Compared as hashes in constant time.
      const given = form!['_csrf'] ?? (typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : '');
      if (!d.auth.csrfOk(s, given)) { send(res, 403, 'Forbidden', {}, 'text/plain'); return 'csrf'; }
      return post(path, form!, s, c, res);
    }
    return get(path, url, s, c, res);
  };

  const get = async (path: string, url: URL, s: Session, c: Ctx, res: ServerResponse): Promise<string> => {
    switch (path) {
      case '/': send(res, 200, statusPage(await d.data.status(), c)); return 'status';
      case '/config': send(res, 200, configPage(d.data.readConfig(ADMIN_READ_KEYS), (await d.data.status()).halted, c)); return 'config';
      case '/cards': {
        const channels = (await d.data.channels().catch(() => null)) ?? [];
        const byId = new Map(channels.map((x) => [x.id, x.name]));
        send(res, 200, cardsPage(await d.data.pendingCards(), c, (id) => byId.get(id) ?? null));
        return 'cards';
      }
      case '/knowledge': {
        if (!d.knowledge) { send(res, 404, messagePage('Knowledge', 'The knowledge store is not available in this process.', c)); return 'knowledge-off'; }
        send(res, 200, knowledgePage(await d.knowledge.overview(), c));
        return 'knowledge';
      }
      case '/devjobs': {
        if (!d.devjobs) { send(res, 404, messagePage('Dev jobs', 'Dev jobs are not available in this process.', c)); return 'devjobs-off'; }
        send(res, 200, devjobsPage(await d.devjobs.list(), c));
        return 'devjobs';
      }
      case '/propose': send(res, 200, proposePage(d.settings, await d.settings.capabilities(), c)); return 'propose';
      case '/audit': {
        const p = url.searchParams;
        const q: AuditQuery = {
          actor: (p.get('actor') ?? '').slice(0, 80), action: (p.get('action') ?? '').slice(0, 80),
          sort: p.get('sort') === 'actor' ? 'actor' : p.get('sort') === 'action' ? 'action' : 'ts', dir: p.get('dir') === 'asc' ? 'asc' : 'desc',
          page: Math.min(Math.max(Number.parseInt(p.get('page') ?? '0', 10) || 0, 0), 1000),
        };
        const rows = await d.data.audit({ ...(q.actor ? { actor: q.actor } : {}), ...(q.action ? { action: q.action } : {}), sort: q.sort, dir: q.dir, limit: 50, offset: q.page * 50 });
        send(res, 200, auditPage(rows, q, c));
        return 'audit';
      }
      case '/spend': send(res, 200, spendPage(d.data.spend ? await d.data.spend() : null, c)); return 'spend';
      case '/members': send(res, 200, membersPage(d.data.members ? await d.data.members() : 'Available after server management is enabled.', c)); return 'members';
      case '/channels': {
        const rows = await d.data.channels();
        send(res, 200, channelsPage(rows ?? 'The channel list could not be read.', d.data.lockedChannels(), c));
        return 'channels';
      }
      case '/secrets': {
        if (!d.env) { send(res, 404, messagePage('Not found', 'No such page.', c)); return 'notfound'; }
        if (!d.auth.stepUpOk(s)) { send(res, 403, stepUpPage(c)); return 'stepup'; }
        send(res, 200, envPage(await d.env.status(), c));
        return 'secrets';
      }
      default: {
        const m = /^\/devjobs\/([0-9a-f]{40})$/.exec(path);
        if (m && d.devjobs) {
          const j = await d.devjobs.byHead(m[1]!);
          if (j) { send(res, 200, devjobPage(j, c)); return 'devjob'; }
        }
        send(res, 404, messagePage('Not found', 'No such page.', c));
        return 'notfound';
      }
    }
  };

  const post = async (path: string, form: Record<string, string>, s: Session, c: Ctx, res: ServerResponse): Promise<string> => {
    switch (path) {
      case '/logout': await d.auth.logout(s); redirect(res, '/', { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` }); return 'logout';
      case '/revoke-all': await d.auth.revokeAll(s); redirect(res, '/', { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` }); return 'revoke-all';
      case '/propose': {
        const id = form['action'] ?? '';
        const values: Record<string, string> = {};
        for (const [k, v] of Object.entries(form)) if (k.startsWith('f_')) values[k.slice(2)] = v;
        const built = d.settings.build(id, values);
        if (!built.ok) { send(res, 422, messagePage('Not proposed', built.error, c)); return 'propose-refused'; }
        // S37c/S46: the same console path as Discord; the card is the session user's own, tainted=false (typed by an admin, never the model).
        const r = await d.settings.propose({ userId: s.userId, tainted: false, via: 'dashboard' }, built);
        if (!r.ok) { send(res, 422, messagePage('Not proposed', r.error, c)); return 'propose-refused'; }
        redirect(res, '/cards');
        return 'propose';
      }
      case '/knowledge/review':
      case '/knowledge/card':
      case '/knowledge/reject':
      case '/knowledge/rollback':
      case '/knowledge/purge': {
        if (!d.knowledge) { send(res, 404, messagePage('Not found', 'No such page.', c)); return 'notfound'; }
        const num = (v: string | undefined) => (v !== undefined && /^\d{1,12}$/.test(v) ? Number(v) : null);
        const proposal = num(form['proposal']);
        const doc = num(form['doc']);
        let msg: string | null = null;
        if (path === '/knowledge/review') msg = proposal !== null && (await d.knowledge.review(s.userId, proposal)) ? null : 'That proposal cannot be reviewed.';
        else if (path === '/knowledge/reject') msg = proposal !== null && (await d.knowledge.reject(s.userId, proposal)) ? null : 'That proposal cannot be rejected.';
        else if (path === '/knowledge/card') {
          const r = proposal !== null && d.console.mintKnowledgeCard ? await d.console.mintKnowledgeCard(s.userId, proposal) : { ok: false as const, error: 'That proposal cannot get a card.' };
          msg = r.ok ? null : r.error;
        } else if (path === '/knowledge/purge') {
          const r = doc !== null ? await d.knowledge.purge(s.userId, doc) : { ok: false as const, error: 'Unknown document.' };
          msg = r.ok ? null : r.error;
        } else {
          const v = form['version'] ?? '';
          const to = v === 'default' ? null : num(v);
          const r = (v === 'default' || to !== null) && /^(heads|members)\/[a-z0-9-]{1,40}$/.test(form['ref'] ?? '') ? await d.knowledge.rollback(s.userId, form['ref']!, to) : { ok: false as const, error: 'Unknown prompt version.' };
          msg = r.ok ? null : r.error;
        }
        // Every outcome re-shows the page (a POST is never a navigation target): errors are fixed texts or code-written refusals.
        send(res, msg ? 409 : 200, knowledgePage(await d.knowledge.overview(), c, msg ?? undefined));
        return msg ? 'knowledge-refused' : 'knowledge-step';
      }
      case '/cards/apply': {
        const r = await d.console.applyFromDashboard(form['card'] ?? '', s.userId);
        send(res, r.ok ? 200 : 409, r.ok ? layout(r.title, html`<div class="card">${r.lines.map((l) => html`<div>${l}</div>`)}</div>`, c) : messagePage('Not applied', r.why, c));
        return 'apply';
      }
      case '/cards/cancel': {
        const ok = await d.console.cancelFromDashboard(form['card'] ?? '', s.userId);
        if (ok) redirect(res, '/cards'); else send(res, 409, messagePage('Not cancelled', 'That card cannot be cancelled.', c));
        return 'cancel';
      }
      case '/secrets/set':
      case '/secrets/clear': {
        if (!d.env) { send(res, 404, messagePage('Not found', 'No such page.', c)); return 'notfound'; }
        if (!d.auth.stepUpOk(s)) { send(res, 403, stepUpPage(c)); return 'stepup'; }
        const key = form['key'] ?? '';
        const value = form['value'];
        let r: Awaited<ReturnType<EnvEntry['set']>>;
        try {
          // E16/E17: every outcome is a 200 with the same page; nothing from the request is echoed or logged.
          r = path === '/secrets/set' ? (typeof value === 'string' ? await d.env.set(s.userId, key, value) : { ok: false, reason: 'refused' }) : await d.env.clear(s.userId, key);
        } catch {
          r = { ok: false, reason: 'refused' };
        }
        const text = r.ok ? 'Saved. A restart is needed before the app uses it.' : r.reason === 'rate' ? 'Too many secret changes. Try again later.' : 'Not saved: the key or value was refused.';
        send(res, 200, envPage(await d.env.status().catch(() => null), c, { ok: r.ok, text }));
        return r.ok ? 'secrets-set' : 'secrets-refused';
      }
      default: send(res, 404, messagePage('Not found', 'No such page.', c)); return 'notfound';
    }
  };

  const server: Server = createServer({ requireHostHeader: false, maxHeaderSize: 16 * 1024 }, (req, res) => {
    handle(req, res).then((tag) => {
      // Access log: method, path without the query, status. Never the query string (it holds a login token) or any header (Cookie).
      d.log.info({ method: req.method, path: (req.url ?? '').split('?')[0]?.slice(0, 80), status: res.statusCode, tag }, 'dashboard request');
    }).catch((err: unknown) => {
      d.log.error({ err: redactText(err instanceof Error ? err.name : 'error') }, 'dashboard request failed');
      if (!res.headersSent) send(res, 500, 'Something went wrong.', {}, 'text/plain'); else res.end();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 10_000;
  server.maxConnections = CONN_MAX;
  server.keepAliveTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(d.port, HOST, () => resolve());
  });
  const a = server.address() as AddressInfo;
  port = a.port;
  const bound = { host: a.address, port: a.port };
  return {
    address: () => bound,
    url: () => `http://${bound.host}:${bound.port}`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

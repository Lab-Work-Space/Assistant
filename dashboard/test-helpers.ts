import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { SettingsRegistry } from '../admin/settings.js';
import type { DashSession, DashboardStore } from '../db/repos/dashboard.js';
import { DashboardAuth } from './auth.js';
import { startDashboard, type DashboardData, type DashboardServer } from './server.js';
import type { DashboardKnowledge } from '../knowledge/dashboard.js';
import { createEnvEntry, type EnvEntry, type EnvEntryOptions } from './envEntry.js';

/** In-memory DashboardStore with the repo's semantics (the SQL itself is covered by dashboard.int.test.ts). */
export class MemStore implements DashboardStore {
  links = new Map<string, { userId: string; used: boolean; exp: number }>();
  sessions = new Map<string, { userId: string; created: number; last: number; checked: number }>();
  async issueLink(userId: string, h: string) {
    for (const l of this.links.values()) if (l.userId === userId) l.used = true;
    this.links.set(h, { userId, used: false, exp: Date.now() + 300_000 });
    return { ok: true as const };
  }
  async consumeLink(h: string) {
    const l = this.links.get(h);
    if (!l || l.used || l.exp < Date.now()) return null;
    l.used = true;
    return l.userId;
  }
  async createSession(h: string, userId: string) { this.sessions.set(h, { userId, created: Date.now(), last: Date.now(), checked: Date.now() }); }
  async touchSession(h: string): Promise<DashSession | null> {
    const s = this.sessions.get(h);
    if (!s) return null;
    s.last = Date.now();
    return { userId: s.userId, createdAt: new Date(s.created), roleCheckedAt: new Date(s.checked) };
  }
  async markRoleChecked(h: string) { const s = this.sessions.get(h); if (s) s.checked = Date.now(); }
  async revokeSession(h: string) { this.sessions.delete(h); }
  async revokeUser(userId: string) { let n = 0; for (const [k, s] of this.sessions) if (s.userId === userId) { this.sessions.delete(k); n++; } return n; }
  async purge() { return 0; }
}

export interface Resp { status: number; headers: Record<string, string | string[] | undefined>; body: string }

/** A raw request with exact control of the headers (fetch would refuse to send Host or Origin). */
export function http(port: number, o: { method?: string; path?: string; headers?: Record<string, string>; body?: string; noHost?: boolean }): Promise<Resp> {
  return new Promise((resolve, reject) => {
    const headers = { ...(o.noHost ? {} : { host: `127.0.0.1:${port}` }), ...o.headers };
    const req = request({ host: '127.0.0.1', port, method: o.method ?? 'GET', path: o.path ?? '/', headers, setHost: false }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    if (o.body !== undefined) req.write(o.body);
    req.end();
  });
}

/** Raw bytes on a TCP socket: for a duplicate or absent Host header that the http client would normalize. */
export function rawHttp(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(port, '127.0.0.1', () => s.write(text));
    let b = '';
    s.setEncoding('utf8');
    s.on('data', (c: string) => (b += c));
    s.on('end', () => resolve(b));
    s.on('error', reject);
    setTimeout(() => { s.destroy(); resolve(b); }, 1500).unref();
  });
}

export const ADMIN_USER = '900000000000000001';

export function fakeData(over: Partial<DashboardData> = {}): DashboardData {
  return {
    status: async () => ({ db: 'ok', clients: ['hq', 'praw'], halted: false, provider: 'ok', offDay: false }),
    readConfig: (keys) => keys.map((key) => ({ key, value: key === 'schedule.timezone' ? 'sk-ant-abcdefgh12345678' : 1 })),
    pendingCards: async () => [],
    audit: async () => [],
    channels: async () => [{ id: '700000000000000001', name: 'general', parentId: null, type: 0 }],
    lockedChannels: () => 2,
    ...over,
  };
}

export const MASTER = Buffer.alloc(32, 7).toString('base64');
export const BASE_ENV = `# local mode\nDATABASE_URL=postgres://u:p@127.0.0.1:5432/db\nCONFIG_MASTER_KEY=${MASTER}\nGUILD_ID=1565649426943442944\n`;
export const tok = (a = 'A', b = 'B', c = 'C') => `${a.repeat(24)}.${b.repeat(6)}.${c.repeat(27)}`;

/** A temp config dir (0700, real path) holding a 0600 env.local. Tests never touch ~/.config/assistant. */
export function envFixture(text = BASE_ENV) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'envfx-')));
  chmodSync(dir, 0o700);
  const file = join(dir, 'env.local');
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
  return { dir, file, adminFile: join(dir, 'env.admin'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function rig(o: { devjobs?: NonNullable<Parameters<typeof startDashboard>[0]['devjobs']>; knowledge?: DashboardKnowledge; mint?: (u: string, p: number) => Promise<{ ok: true; cardId: string } | { ok: false; error: string }>; isAdmin?: (u: string) => Promise<boolean>; data?: Partial<DashboardData>; proposals?: unknown[]; now?: () => number; env?: Partial<Pick<EnvEntryOptions, 'writer'>> & { text?: string } } = {}) {
  const store = new MemStore();
  const audits: Record<string, unknown>[] = [];
  const logs: unknown[] = [];
  let admin = true;
  const auth = new DashboardAuth({ store, audit: async (e) => void audits.push(e as never), isAdmin: o.isAdmin ?? (async () => admin), ...(o.now ? { now: o.now } : {}) });
  const fx = o.env ? envFixture(o.env.text) : null;
  const notices: string[] = [];
  const env: EnvEntry | undefined = fx ? createEnvEntry({ paths: { dir: fx.dir }, audit: async (e) => void audits.push(e as never), notify: async (t) => void notices.push(t), log: { error: (x) => void logs.push(x) }, ...(o.now ? { now: o.now } : {}), ...(o.env?.writer ? { writer: o.env.writer } : {}) }) : undefined;
  const settings = new SettingsRegistry();
  const proposals = o.proposals ?? [];
  settings.registerFamily('admin_op', { available: async () => null, propose: async (who, kind, raw) => { proposals.push({ who, kind, raw }); return { ok: true, text: 'ok', cardId: 'c'.repeat(32) }; } });
  const applied: unknown[] = [];
  const server: DashboardServer = await startDashboard({
    port: 0, auth, settings, data: fakeData(o.data), ...(env ? { env } : {}),
    ...(o.knowledge ? { knowledge: o.knowledge } : {}), ...(o.devjobs ? { devjobs: o.devjobs } : {}),
    console: { ...(o.mint ? { mintKnowledgeCard: o.mint } : {}), applyFromDashboard: async (c, u) => { applied.push([c, u]); return { ok: true, title: 'Change applied', lines: ['a: 1 -> 2'], outcome: 'applied' }; }, cancelFromDashboard: async () => true },
    log: { info: (x) => void logs.push(x), error: (x) => void logs.push(x) },
  });
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  /** Issues a link and logs in: returns the cookie and the csrf token read from the page. */
  async function login(user = ADMIN_USER) {
    const l = await auth.issueLink(user);
    if (!l.ok) throw new Error('rate');
    const r = await http(port, { method: 'POST', path: '/login', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: `t=${l.token}` });
    const cookie = String(r.headers['set-cookie'] ?? '').split(';')[0]!;
    const page = await http(port, { path: '/', headers: { cookie } });
    const csrf = /name="_csrf" value="([0-9a-f]{64})"/.exec(page.body)?.[1] ?? '';
    return { cookie, csrf, token: l.ok ? l.token : '', login: r };
  }
  const post = (path: string, fields: Record<string, string>, h: Record<string, string> = {}) =>
    http(port, { method: 'POST', path, headers: { origin, 'content-type': 'application/x-www-form-urlencoded', ...h }, body: new URLSearchParams(fields).toString() });
  return { store, audits, logs, auth, settings, server, port, origin, login, post, applied, proposals, fx, notices, setAdmin: (v: boolean) => { admin = v; }, close: async () => { await server.close(); fx?.cleanup(); } };
}

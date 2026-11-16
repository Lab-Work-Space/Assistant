import { constants as fsc } from 'node:fs';
import { lstat, open, readFile, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join, normalize, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { sameSecret } from './auth.js';

/**
 * Env entry writer (Gate 1 env-entry E1-E20). Imported ONLY by dashboard/boot.ts and this directory's tests (E20 is asserted by a test).
 * Values are write-only: nothing here returns, logs or throws a value. Every failure is a reason code.
 */

export type EnvGroup = 'Discord bots' | 'AI providers' | 'ClickUp' | 'Sheets' | 'GitHub' | 'Music';

const DEPTS = ['HQ', 'RND', 'SOFTWARE', 'IT', 'MARKETING', 'SALES', 'HR', 'FINANCE', 'OPS', 'PRAW'] as const;

const TOKEN_RE = /^[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{20,}$/;
const GEMINI_RE = /^(AIza[0-9A-Za-z_-]{35}|AQ\.[0-9A-Za-z_-]{20,})$/;
const ANTHROPIC_RE = /^sk-ant-[A-Za-z0-9_-]{20,}$/;
const CLICKUP_TOKEN_RE = /^pk_[0-9]+_[A-Z0-9]{32}$/;
const CLICKUP_LIST_RE = /^[a-z0-9]{1,32}$/;
const CLICKUP_TEAM_RE = /^(?:\d{1,20}|all)$/; // digits, or exactly the lower-case word all (OQ-A)
const GITHUB_APP_RE = /^[A-Za-z0-9]{1,40}$/;
const GITHUB_INST_RE = /^\d{1,20}$/;
const SHEETS_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;
const SHEETS_SECRET_RE = /^[A-Za-z0-9._~+=-]{16,200}$/;

/** E7: printable ASCII only, none of " ' \ # $ ` , no whitespace. Run on the raw body value. */
const VALUE_RE = /^[\x21\x25\x26\x28-\x5B\x5D-\x5F\x61-\x7E]{1,512}$/;
const KEY_RE = /^[A-Z0-9_]+$/;

interface KeyDef { group: EnvGroup; test: RegExp | 'pem-path' | 'cookies-path'; note?: string }

const def = (group: EnvGroup, test: KeyDef['test'], note?: string): KeyDef => (note ? { group, test, note } : { group, test });

/** E1: the closed allowlist. A test asserts it equals the spec list. */
export const ENV_KEYS: Readonly<Record<string, KeyDef>> = Object.freeze({
  ...Object.fromEntries(DEPTS.map((d) => [`BOT_TOKEN_${d}`, def('Discord bots', TOKEN_RE, 'Clearing a bot token disables that department after the restart.')])),
  GEMINI_API_KEY: def('AI providers', GEMINI_RE, 'Changes which provider and account the app uses after the restart.'),
  ANTHROPIC_API_KEY: def('AI providers', ANTHROPIC_RE, 'Changes which provider and account the app uses after the restart.'),
  CLICKUP_API_TOKEN: def('ClickUp', CLICKUP_TOKEN_RE),
  CLICKUP_LIST_ID: def('ClickUp', CLICKUP_LIST_RE, 'Clearing this while CLICKUP_TEAM_ID is set widens access: the bots then read and write (with approval) every project of that workspace, or of every workspace the token can see when it is all.'),
  CLICKUP_TEAM_ID: def('ClickUp', CLICKUP_TEAM_RE, 'Setting this and clearing CLICKUP_LIST_ID lets the bots read and write every ClickUp project of that workspace, or of every workspace the token can see when the value is all (every write still needs approval).'),
  GOOGLE_SHEETS_WEBAPP_URL: def('Sheets', SHEETS_URL_RE),
  GOOGLE_SHEETS_WEBAPP_SECRET: def('Sheets', SHEETS_SECRET_RE),
  GITHUB_APP_ID: def('GitHub', GITHUB_APP_RE),
  GITHUB_INSTALLATION_ID: def('GitHub', GITHUB_INST_RE),
  GITHUB_APP_PRIVATE_KEY_PATH: def('GitHub', 'pem-path', 'A path to a 0600 .pem file you own; the file is checked, never shown.'),
  YTDLP_COOKIES_FILE: def('Music', 'cookies-path', 'A path to a 0600 Netscape cookies file under ~/.config/assistant/cookies/; the file is checked, never shown.'),
});

export const ENV_KEY_NAMES: readonly string[] = Object.freeze(Object.keys(ENV_KEYS));
export const GROUPS: readonly EnvGroup[] = ['Discord bots', 'AI providers', 'ClickUp', 'Sheets', 'GitHub', 'Music'];
export const isEnvKey = (k: unknown): k is string => typeof k === 'string' && KEY_RE.test(k) && Object.hasOwn(ENV_KEYS, k);
export const keyNote = (k: string): string | undefined => ENV_KEYS[k]?.note;
export const keyGroup = (k: string): EnvGroup | undefined => ENV_KEYS[k]?.group;

/** Shape check only (E6, E7): no filesystem. Path keys get their file checks in the writer. */
export function validShape(key: string, value: string): boolean {
  if (!isEnvKey(key) || typeof value !== 'string' || !VALUE_RE.test(value)) return false;
  const t = ENV_KEYS[key]!.test;
  if (t === 'pem-path' || t === 'cookies-path') return value.startsWith('/') && normalize(value) === value && !value.split('/').includes('..');
  return t.test(value);
}

export type Reason = 'key' | 'value' | 'file' | 'conflict' | 'io';
export type WriteResult = { ok: true } | { ok: false; reason: Reason };

export interface EnvPaths {
  /** `~/.config/assistant` (injectable: tests never touch the real one). */
  dir: string;
  /** Defaults to `<dir>/env.local`. */
  envFile?: string;
  /** Defaults to `<dir>/env.admin`; read only, for the E5 comparison. */
  adminFile?: string;
}

const MODE_MASK = 0o777;
const uid = (): number => (typeof process.getuid === 'function' ? process.getuid() : -1);

/** asst_check_dir. */
async function dirOk(dir: string): Promise<boolean> {
  const s = await lstat(dir).catch(() => null);
  return !!s && !s.isSymbolicLink() && s.isDirectory() && s.uid === uid() && (s.mode & MODE_MASK) === 0o700;
}

/** The same Gate 1 L10 rule as dev.sh check_db_loopback. */
function dbLoopback(v: string): boolean {
  let host = v.slice(v.indexOf('://') + 3);
  host = host.split(/[/?#]/)[0]!;
  host = host.slice(host.lastIndexOf('@') + 1);
  host = host.startsWith('[') ? `${host.split(']')[0]}]` : host.split(':')[0]!;
  host = host.toLowerCase();
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return false;
  const q = v.includes('?') ? v.slice(v.indexOf('?') + 1).split('#')[0]! : '';
  for (const kv of q.split('&')) {
    if (!/^(host|hostaddr)=/.test(kv)) continue;
    const val = kv.slice(kv.indexOf('=') + 1);
    if (!val) return false;
    for (const h of val.split(',')) if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(h)) return false;
  }
  return true;
}

/** E13: scripts/dev.sh check() semantics on the final text. A test cross-checks this against the real script. */
export function devCheck(text: string): boolean {
  const forbidden = /^[ \t]*(export[ \t]+)?(BOT_TOKEN_ADMIN|ALLOW_LOCAL_PROVIDERS|ASSISTANT_SKIP_PROBE_PIN)[ \t]*=/m;
  if (forbidden.test(text)) return false;
  const last = (k: string): string | null => { let v: string | null = null; for (const l of text.split('\n')) if (l.startsWith(`${k}=`)) v = l.slice(k.length + 1); return v; };
  for (const k of ['DATABASE_URL', 'CONFIG_MASTER_KEY']) if (!new RegExp(`^${k}=.+`, 'm').test(text)) return false;
  if (!dbLoopback(last('DATABASE_URL') ?? '')) return false;
  const h = last('HEALTH_HOST');
  return h === null || h === '' || h === '127.0.0.1';
}

const lineDefines = (line: string, key: string): boolean => new RegExp(`^[ \\t]*(export[ \\t]+)?${key}[ \\t]*=`).test(line);

/** E9: drop every defining line, keep the rest byte for byte; the new line (if any) takes the place of the first one removed. */
export function rewrite(text: string, key: string, value: string | null): string {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const out: string[] = [];
  let at = -1;
  for (const l of lines) {
    if (lineDefines(l.replace(/\r?\n$/, ''), key)) { if (at < 0) at = out.length; continue; }
    out.push(l);
  }
  if (value !== null) {
    const nl = `${key}=${value}\n`;
    if (at >= 0) out.splice(at, 0, nl);
    else { if (out.length && !out[out.length - 1]!.endsWith('\n')) out[out.length - 1] += '\n'; out.push(nl); }
  }
  return out.join('');
}

/** E5/E8: other keys of old and new text must parse identically; the target key as asked. */
function roundTrips(oldText: string, newText: string, key: string, value: string | null): boolean {
  let a: Record<string, string | undefined>; let b: Record<string, string | undefined>;
  try { a = parseEnv(oldText); b = parseEnv(newText); } catch { return false; }
  if (value === null ? Object.hasOwn(b, key) : b[key] !== value) return false;
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  names.delete(key);
  for (const n of names) if (a[n] !== b[n]) return false;
  return true;
}

export class EnvWriter {
  private chain: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private readonly admin: string;
  private readonly lock: string;
  constructor(private readonly p: EnvPaths, private readonly now: () => number = Date.now) {
    this.file = p.envFile ?? join(p.dir, 'env.local');
    this.admin = p.adminFile ?? join(p.dir, 'env.admin');
    this.lock = `${this.file}.lock`;
  }

  /** E16: presence only, from a non-empty line. Values are parsed into a throwaway object and dropped; null when the file fails the E10 checks. */
  async status(): Promise<Record<string, boolean> | null> {
    const snap = await this.load();
    if (!snap) return null;
    const parsed = parseEnv(snap.text);
    const out: Record<string, boolean> = {};
    for (const k of ENV_KEY_NAMES) out[k] = typeof parsed[k] === 'string' && parsed[k] !== '';
    return out;
  }

  set(key: string, value: string): Promise<WriteResult> { return this.run(key, value); }
  clear(key: string): Promise<WriteResult> { return this.run(key, null); }

  /** E12: one in-process queue, then an advisory lockfile. */
  private run(key: string, value: string | null): Promise<WriteResult> {
    const next = this.chain.then(() => this.write(key, value).catch((): WriteResult => ({ ok: false, reason: 'io' })));
    this.chain = next;
    return next;
  }

  /** E10: directory, then file; the text is read through the opened descriptor and matched to the lstat (E11). */
  private async load(): Promise<{ text: string; dev: number; ino: number; mtimeMs: number; size: number } | null> {
    if (!(await dirOk(this.p.dir))) return null;
    const l = await lstat(this.file).catch(() => null);
    if (!l || l.isSymbolicLink() || !l.isFile() || l.uid !== uid() || (l.mode & MODE_MASK) !== 0o600 || l.nlink !== 1) return null;
    let fh: FileHandle | undefined;
    try {
      fh = await open(this.file, fsc.O_RDONLY | fsc.O_NOFOLLOW);
      const s = await fh.stat();
      if (s.dev !== l.dev || s.ino !== l.ino || s.size > 1024 * 1024) return null;
      return { text: await fh.readFile('utf8'), dev: s.dev, ino: s.ino, mtimeMs: s.mtimeMs, size: s.size };
    } catch { return null; } finally { await fh?.close().catch(() => undefined); }
  }

  private async acquire(): Promise<(() => Promise<void>) | null> {
    for (let i = 0; i < 2; i++) {
      try {
        const fh = await open(this.lock, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
        await fh.close();
        return () => unlink(this.lock).catch(() => undefined);
      } catch {
        const s = await lstat(this.lock).catch(() => null);
        if (s && this.now() - s.mtimeMs > 30_000) await unlink(this.lock).catch(() => undefined); // stale after a crash
        else return null;
      }
    }
    return null;
  }

  private async write(key: string, value: string | null): Promise<WriteResult> {
    if (!isEnvKey(key)) return { ok: false, reason: 'key' };
    if (value !== null && !(await this.valueOk(key, value))) return { ok: false, reason: 'value' };
    if (!(await dirOk(this.p.dir))) return { ok: false, reason: 'file' };
    const release = await this.acquire();
    if (!release) return { ok: false, reason: 'conflict' };
    let tmp: string | null = null;
    try {
      const snap = await this.load();
      if (!snap) return { ok: false, reason: 'file' }; // a missing file is refused, never created (E10)
      if (value !== null && (await this.tokenConflict(key, value, snap.text))) return { ok: false, reason: 'value' };
      const next = rewrite(snap.text, key, value);
      if (!roundTrips(snap.text, next, key, value) || !devCheck(next)) return { ok: false, reason: 'file' };
      tmp = join(this.p.dir, `.env.local.${randomBytes(8).toString('hex')}.tmp`);
      const fh = await open(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
      try { await fh.chmod(0o600); await fh.writeFile(next, 'utf8'); await fh.sync(); } finally { await fh.close(); }
      // Re-check right before rename (E10, E12): same file, same bytes' metadata, still safe.
      const again = await this.load();
      if (!again || again.ino !== snap.ino || again.dev !== snap.dev || again.mtimeMs !== snap.mtimeMs || again.size !== snap.size) return { ok: false, reason: 'conflict' };
      await rename(tmp, this.file);
      tmp = null;
      const dh = await open(this.p.dir, fsc.O_RDONLY).catch(() => null);
      await dh?.sync().catch(() => undefined);
      await dh?.close().catch(() => undefined);
      return { ok: true };
    } finally {
      if (tmp) await unlink(tmp).catch(() => undefined);
      await release();
    }
  }

  /** E5: not the executor's token, not another department's token. */
  private async tokenConflict(key: string, value: string, text: string): Promise<boolean> {
    if (!key.startsWith('BOT_TOKEN_')) return false;
    const adminText = await this.readAdmin();
    if (adminText === 'unsafe') return true;
    const adminTok = adminText === null ? undefined : parseEnv(adminText)['BOT_TOKEN_ADMIN'];
    if (adminTok && sameSecret(adminTok, value)) return true;
    // OD-1: with the executor under its own macOS user this uid cannot read env.admin; the installer leaves the SHA-256 of its token beside env.local.
    const digest = await this.readAdminDigest();
    if (digest === 'unsafe') return true;
    if (digest !== null && sameSecret(digest, createHash('sha256').update(value).digest('hex'))) return true;
    const cur = parseEnv(text);
    for (const [k, v] of Object.entries(cur)) if (k !== key && k.startsWith('BOT_TOKEN_') && v && sameSecret(v, value)) return true;
    return false;
  }

  /** Read only, and only for the comparison. 'absent' only on ENOENT; anything else unreadable or odd is 'unsafe' and the write is refused (G2E-02). */
  private async readAdmin(): Promise<string | null | 'unsafe'> {
    try {
      const l = await lstat(this.admin);
      if (l.isSymbolicLink() || !l.isFile() || l.size > 64 * 1024) return 'unsafe';
      return await readFile(this.admin, { encoding: 'utf8', flag: fsc.O_RDONLY | fsc.O_NOFOLLOW });
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unsafe';
    }
  }

  /** `<dir>/admin-token.sha256`: 64 hex characters. Absent = no digest (the file or env.admin comparison applies); anything odd is 'unsafe' and refuses the write. */
  private async readAdminDigest(): Promise<string | null | 'unsafe'> {
    try {
      const p = join(this.p.dir, 'admin-token.sha256');
      const l = await lstat(p);
      if (l.isSymbolicLink() || !l.isFile() || l.size > 200) return 'unsafe';
      const t = (await readFile(p, { encoding: 'utf8', flag: fsc.O_RDONLY | fsc.O_NOFOLLOW })).trim();
      return /^[0-9a-f]{64}$/.test(t) ? t : 'unsafe';
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unsafe';
    }
  }

  private async valueOk(key: string, value: string): Promise<boolean> {
    if (!validShape(key, value)) return false;
    const t = ENV_KEYS[key]!.test;
    if (t === 'pem-path') return this.pathOk(value, 16 * 1024, (head) => head.startsWith('-----BEGIN') && /PRIVATE KEY-----/.test(head), 'pem');
    if (t === 'cookies-path') return this.pathOk(value, 1024 * 1024, (head) => /^(# Netscape HTTP Cookie File|# HTTP Cookie File)$/m.test(head.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''), 'cookies');
    return true;
  }

  /** E3/E4: an absolute, plain, owned 0600 regular file whose first bytes look right. Contents are never returned. */
  private async pathOk(path: string, max: number, head: (s: string) => boolean, kind: 'pem' | 'cookies'): Promise<boolean> {
    try {
      const l = await lstat(path);
      if (l.isSymbolicLink() || !l.isFile() || l.uid !== uid() || (l.mode & MODE_MASK) !== 0o600 || l.size > max || l.size === 0) return false;
      if ((await realpath(path)) !== path) return false; // no symlinked directory on the way
      const protectedPaths = new Set([this.file, this.admin, join(this.p.dir, 'executor.sock'), this.lock]);
      if (protectedPaths.has(path)) return false;
      const dir = this.p.dir.endsWith(sep) ? this.p.dir : this.p.dir + sep;
      // G2E-01: cookies are always confined to <configDir>/cookies/. A PEM may live elsewhere, but inside the config dir only as *.pem.
      if (kind === 'cookies' && !path.startsWith(join(this.p.dir, 'cookies') + sep)) return false;
      if (kind === 'pem' && path.startsWith(dir) && !path.endsWith('.pem')) return false;
      const fh = await open(path, fsc.O_RDONLY | fsc.O_NOFOLLOW);
      try {
        const s = await fh.stat();
        if (s.ino !== l.ino || s.dev !== l.dev) return false;
        const buf = Buffer.alloc(Math.min(max, 4096));
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        const text = buf.subarray(0, bytesRead).toString('utf8');
        if (kind === 'cookies' && text.startsWith('-----BEGIN')) return false;
        return head(text);
      } finally { await fh.close(); }
    } catch { return false; }
  }
}

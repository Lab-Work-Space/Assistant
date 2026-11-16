import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, linkSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ENV_KEYS, ENV_KEY_NAMES, EnvWriter, devCheck, isEnvKey, rewrite, validShape } from './envfile.js';
import { BASE_ENV, envFixture, tok } from './test-helpers.js';

const SPEC_KEYS = [
  'BOT_TOKEN_HQ', 'BOT_TOKEN_RND', 'BOT_TOKEN_SOFTWARE', 'BOT_TOKEN_IT', 'BOT_TOKEN_MARKETING', 'BOT_TOKEN_SALES', 'BOT_TOKEN_HR', 'BOT_TOKEN_FINANCE', 'BOT_TOKEN_OPS', 'BOT_TOKEN_PRAW',
  'GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'CLICKUP_API_TOKEN', 'CLICKUP_LIST_ID', 'CLICKUP_TEAM_ID',
  'GOOGLE_SHEETS_WEBAPP_URL', 'GOOGLE_SHEETS_WEBAPP_SECRET', 'GITHUB_APP_ID', 'GITHUB_INSTALLATION_ID', 'GITHUB_APP_PRIVATE_KEY_PATH', 'YTDLP_COOKIES_FILE',
];
const FORBIDDEN = ['DATABASE_URL', 'LOCAL_DB_PASSWORD', 'CONFIG_MASTER_KEY', 'GUILD_ID', 'BOT_ADMIN_ROLE_ID', 'ALLOW_LOCAL_PROVIDERS', 'ASSISTANT_SKIP_PROBE_PIN', 'BOT_TOKEN_ADMIN', 'GITHUB_APP_PRIVATE_KEY',
  'LOG_LEVEL', 'HEALTH_PORT', 'HEALTH_HOST', 'CHROME_CDP_URL', 'CHROME_ACCESS_TOKEN', 'EXECUTOR_SOCKET', 'MEDIA_SOCKET', 'PRAW_WORKSPACE_DIR', 'NODE_OPTIONS', 'UV_THREADPOOL_SIZE', 'PATH', 'bot_token_hq', 'export BOT_TOKEN_HQ', ' BOT_TOKEN_HQ', '__proto__', 'constructor'];

const fixtures: ReturnType<typeof envFixture>[] = [];
const fx = (t?: string) => { const f = envFixture(t); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
const read = (f: string) => readFileSync(f, 'utf8');
const SHEETS = 'zqSENTINELzq7x9w2v';

describe('allowlist (E1)', () => {
  it('equals the spec list exactly, and nothing forbidden is in it', () => {
    expect([...ENV_KEY_NAMES].sort()).toEqual([...SPEC_KEYS].sort());
    for (const k of FORBIDDEN) expect(isEnvKey(k), k).toBe(false);
  });
  it('a forbidden or unknown key is refused by the writer with the same reason', async () => {
    const f = fx(); const w = new EnvWriter({ dir: f.dir });
    for (const k of ['DATABASE_URL', 'BOT_TOKEN_ADMIN', 'NOPE_KEY']) expect(await w.set(k, 'abc12345678901234567')).toEqual({ ok: false, reason: 'key' });
    expect(read(f.file)).toBe(BASE_ENV);
  });
});

describe('per-key validators (E2, E5, E6, E7)', () => {
  const good: Record<string, string> = {
    BOT_TOKEN_HQ: tok(), GEMINI_API_KEY: `AIza${'x'.repeat(35)}`, ANTHROPIC_API_KEY: `sk-ant-${'a'.repeat(30)}`,
    CLICKUP_API_TOKEN: `pk_12_${'A'.repeat(32)}`, CLICKUP_LIST_ID: 'abc123',
    GOOGLE_SHEETS_WEBAPP_URL: 'https://script.google.com/macros/s/AKfy_-1/exec', GOOGLE_SHEETS_WEBAPP_SECRET: SHEETS, GITHUB_APP_ID: 'Iv1abc', GITHUB_INSTALLATION_ID: '12345',
  };
  it('accepts a well formed value for each', () => { for (const [k, v] of Object.entries(good)) expect(validShape(k, v), k).toBe(true); });
  it('refuses bad shapes', () => {
    const bad: [string, string][] = [['BOT_TOKEN_HQ', 'short'], ['GEMINI_API_KEY', 'AIza'], ['ANTHROPIC_API_KEY', 'sk-ant-x'], 
      ['CLICKUP_LIST_ID', 'A B'], ['GOOGLE_SHEETS_WEBAPP_URL', 'https://evil.com/macros/s/x/exec'], ['GOOGLE_SHEETS_WEBAPP_URL', 'https://script.google.com.evil.com/macros/s/x/exec'],
      ['GITHUB_APP_ID', 'a b'], ['GITHUB_INSTALLATION_ID', 'abc'], ['GITHUB_APP_PRIVATE_KEY_PATH', 'relative/x.pem'], ['GITHUB_APP_PRIVATE_KEY_PATH', '/a/../b.pem'], ['YTDLP_COOKIES_FILE', '/a//b']];
    for (const [k, v] of bad) expect(validShape(k, v), `${k}=${v}`).toBe(false);
  });
  it('E7: CR LF NUL space quotes hash dollar backslash backtick and a trailing newline are all refused', () => {
    for (const c of ['\n', '\r', '\0', ' ', '"', "'", '#', '$', '\\', '`', '\t']) {
      expect(validShape('GOOGLE_SHEETS_WEBAPP_SECRET', `${SHEETS}${c}`), JSON.stringify(c)).toBe(false);
      expect(validShape('GOOGLE_SHEETS_WEBAPP_SECRET', `${c}${SHEETS}`), JSON.stringify(c)).toBe(false);
    }
    expect(validShape('GOOGLE_SHEETS_WEBAPP_SECRET', `${SHEETS}\n`)).toBe(false);
    expect(validShape('GOOGLE_SHEETS_WEBAPP_SECRET', 'a'.repeat(513))).toBe(false);
  });
  it('E5: a department token equal to the executor token or to another department token is refused', async () => {
    const f = fx(`${BASE_ENV}BOT_TOKEN_RND=${tok('R')}\n`);
    writeFileSync(f.adminFile, `BOT_TOKEN_ADMIN=${tok('Z')}\nDATABASE_URL=x\n`, { mode: 0o600 });
    const before = readFileSync(f.adminFile);
    const w = new EnvWriter({ dir: f.dir });
    expect(await w.set('BOT_TOKEN_HQ', tok('Z'))).toEqual({ ok: false, reason: 'value' });
    expect(await w.set('BOT_TOKEN_HQ', tok('R'))).toEqual({ ok: false, reason: 'value' });
    expect(await w.set('BOT_TOKEN_HQ', tok('H'))).toEqual({ ok: true });
    expect(readFileSync(f.adminFile).equals(before)).toBe(true); // env.admin is never written
  });
});

describe('file rewrite (E8-E13)', () => {
  it('sets, replaces and clears while preserving every other byte, and keeps mode 0600', async () => {
    const f = fx(`# keep me\n${BASE_ENV}  # indented comment\nHEALTH_PORT=9\n`);
    const w = new EnvWriter({ dir: f.dir });
    const orig = read(f.file);
    expect(await w.set('CLICKUP_LIST_ID', 'abc')).toEqual({ ok: true });
    expect(read(f.file)).toBe(`${orig}CLICKUP_LIST_ID=abc\n`);
    expect(await w.set('CLICKUP_LIST_ID', 'def')).toEqual({ ok: true });
    expect(read(f.file)).toBe(`${orig}CLICKUP_LIST_ID=def\n`);
    expect(statSync(f.file).mode & 0o777).toBe(0o600);
    expect(await w.clear('CLICKUP_LIST_ID')).toEqual({ ok: true });
    expect(read(f.file)).toBe(orig);
    expect(readdirSync(f.dir).sort()).toEqual(['env.local']); // no temp or lock left behind
  });
  it('E9: removes every definition in any form so a later duplicate cannot win', async () => {
    const f = fx(`${BASE_ENV}CLICKUP_LIST_ID=one\nexport CLICKUP_LIST_ID=two\n   CLICKUP_LIST_ID = three\nOTHER=1\nCLICKUP_LIST_ID=four`);
    const w = new EnvWriter({ dir: f.dir });
    expect(await w.set('CLICKUP_LIST_ID', 'new')).toEqual({ ok: true });
    const t = read(f.file);
    expect(t.match(/CLICKUP_LIST_ID/g)).toHaveLength(1);
    expect(t).toContain('CLICKUP_LIST_ID=new\nOTHER=1\n');
    expect(rewrite('A=1', 'B', 'x')).toBe('A=1\nB=x\n'); // a file without a final newline
  });
  it('E8: aborts when the write would change another key (a KEY-looking line inside a quoted multi-line value)', async () => {
    const f = fx(`${BASE_ENV}NOTE="line\nCLICKUP_LIST_ID=trap"\n`);
    const w = new EnvWriter({ dir: f.dir });
    const orig = read(f.file);
    expect(await w.clear('CLICKUP_LIST_ID')).toEqual({ ok: false, reason: 'file' });
    expect(read(f.file)).toBe(orig);
  });
  it('E10: refuses a missing file, a symlink target, wrong mode, a hard link, and a loose or symlinked directory', async () => {
    const a = fx(); const w = new EnvWriter({ dir: a.dir });
    chmodSync(a.file, 0o644); expect(await w.set('CLICKUP_LIST_ID', 'a')).toEqual({ ok: false, reason: 'file' }); chmodSync(a.file, 0o600);
    linkSync(a.file, join(a.dir, 'hard')); expect(await w.set('CLICKUP_LIST_ID', 'a')).toEqual({ ok: false, reason: 'file' });
    const b = fx(); writeFileSync(join(b.dir, 'real'), BASE_ENV, { mode: 0o600 });
    const sym = join(b.dir, 'env.local'); writeFileSync(sym, ''); (await import('node:fs')).unlinkSync(sym); symlinkSync(join(b.dir, 'real'), sym);
    expect(await new EnvWriter({ dir: b.dir }).set('CLICKUP_LIST_ID', 'a')).toEqual({ ok: false, reason: 'file' });
    expect(await new EnvWriter({ dir: join(b.dir, 'absent') }).set('CLICKUP_LIST_ID', 'a')).toEqual({ ok: false, reason: 'file' }); // a missing file is never created
    const c = fx(); chmodSync(c.dir, 0o755);
    expect(await new EnvWriter({ dir: c.dir }).set('CLICKUP_LIST_ID', 'a')).toEqual({ ok: false, reason: 'file' }); chmodSync(c.dir, 0o700);
    const d = fx(); const link = join(d.dir, 'lnk'); symlinkSync(d.dir, link);
    expect(await new EnvWriter({ dir: link }).set('CLICKUP_LIST_ID', 'a')).toEqual({ ok: false, reason: 'file' });
  });
  it('E13: an edit that would break the dev.sh checks is aborted and the file is untouched', async () => {
    const f = fx(`${BASE_ENV}ALLOW_LOCAL_PROVIDERS=1\n`);
    const orig = read(f.file);
    expect(await new EnvWriter({ dir: f.dir }).set('CLICKUP_LIST_ID', 'a')).toEqual({ ok: false, reason: 'file' });
    expect(read(f.file)).toBe(orig);
  });
  it('E13: devCheck agrees with scripts/dev.sh --check-only on the post-write file and on bad files', async () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const cases = [BASE_ENV, `${BASE_ENV}export BOT_TOKEN_ADMIN=x\n`, `${BASE_ENV}ALLOW_LOCAL_PROVIDERS = 1\n`, `${BASE_ENV}ASSISTANT_SKIP_PROBE_PIN=1\n`, BASE_ENV.replace('127.0.0.1', 'db.example.com'),
      BASE_ENV.replace('db\n', 'db?host=10.0.0.1\n'), `${BASE_ENV}HEALTH_HOST=0.0.0.0\n`, BASE_ENV.replace('CONFIG_MASTER_KEY=', 'CONFIG_MASTER_KEY_X='), 'DATABASE_URL=\n'];
    const f = fx();
    expect(await new EnvWriter({ dir: f.dir }).set('GITHUB_APP_ID', 'abc')).toEqual({ ok: true });
    cases.push(read(f.file));
    for (const text of cases) {
      const g = fx(text);
      let sh = true;
      try { execFileSync('bash', [join(root, 'scripts', 'dev.sh'), '--check-only', g.file], { stdio: 'pipe' }); } catch { sh = false; }
      expect(devCheck(text), text).toBe(sh);
    }
  });
  it('E12: concurrent writes serialize and both land', async () => {
    const f = fx(); const w = new EnvWriter({ dir: f.dir });
    const r = await Promise.all([w.set('CLICKUP_LIST_ID', 'aaa'), w.set('GITHUB_APP_ID', 'bbb'), w.set('GITHUB_INSTALLATION_ID', '12')]);
    expect(r.every((x) => x.ok)).toBe(true);
    expect(read(f.file)).toMatch(/CLICKUP_LIST_ID=aaa[\s\S]*GITHUB_APP_ID=bbb[\s\S]*GITHUB_INSTALLATION_ID=12/);
  });
  it('E12: a held lockfile refuses (conflict), a stale one is cleared', async () => {
    const f = fx(); let t = 1_000_000_000_000;
    const w = new EnvWriter({ dir: f.dir }, () => t);
    writeFileSync(`${f.file}.lock`, '', { mode: 0o600 });
    t = statSync(`${f.file}.lock`).mtimeMs + 5_000;
    expect(await w.set('CLICKUP_LIST_ID', 'a')).toEqual({ ok: false, reason: 'conflict' });
    t += 60_000;
    expect(await w.set('CLICKUP_LIST_ID', 'a')).toEqual({ ok: true });
  });
  it('E16: status is presence of a non-empty line only', async () => {
    const f = fx(`${BASE_ENV}CLICKUP_LIST_ID=abc\nCLICKUP_TEAM_ID=\n`);
    const s = (await new EnvWriter({ dir: f.dir }).status())!;
    expect(s['CLICKUP_LIST_ID']).toBe(true);
    expect(s['CLICKUP_TEAM_ID']).toBe(false);
    expect(s['GEMINI_API_KEY']).toBe(false);
    expect(Object.values(s).every((v) => typeof v === 'boolean')).toBe(true);
  });
});

describe('env.admin comparison (G2E-02)', () => {
  it('skips only when absent; a symlink, oversize file or unreadable path refuses the token write', async () => {
    const absent = fx(); expect(await new EnvWriter({ dir: absent.dir }).set('BOT_TOKEN_HQ', tok('H'))).toEqual({ ok: true });
    const sym = fx(); writeFileSync(join(sym.dir, 'real'), `BOT_TOKEN_ADMIN=${tok('Z')}\n`, { mode: 0o600 }); symlinkSync(join(sym.dir, 'real'), sym.adminFile);
    expect(await new EnvWriter({ dir: sym.dir }).set('BOT_TOKEN_HQ', tok('H'))).toEqual({ ok: false, reason: 'value' });
    const big = fx(); writeFileSync(big.adminFile, 'A=1\n'.repeat(20000), { mode: 0o600 });
    expect(await new EnvWriter({ dir: big.dir }).set('BOT_TOKEN_HQ', tok('H'))).toEqual({ ok: false, reason: 'value' });
    const dirAsFile = fx(); mkdirSync(dirAsFile.adminFile);
    expect(await new EnvWriter({ dir: dirAsFile.dir }).set('BOT_TOKEN_HQ', tok('H'))).toEqual({ ok: false, reason: 'value' });
    const nonToken = fx(); expect(await new EnvWriter({ dir: nonToken.dir }).set('CLICKUP_LIST_ID', 'abc')).toEqual({ ok: true }); // non-token keys unaffected
  });
});

describe('executor under its own macOS user (OD-1): the digest beside env.local', () => {
  const sha = (v: string) => createHash('sha256').update(v).digest('hex');
  it('refuses a department token equal to the executor token even though env.admin is not readable here', async () => {
    const f = fx();
    writeFileSync(join(f.dir, 'admin-token.sha256'), `${sha(tok('Z'))}\n`, { mode: 0o600 });
    expect(await new EnvWriter({ dir: f.dir }).set('BOT_TOKEN_HQ', tok('Z'))).toEqual({ ok: false, reason: 'value' });
    expect(await new EnvWriter({ dir: f.dir }).set('BOT_TOKEN_HQ', tok('H'))).toEqual({ ok: true });
  });
  it('a malformed or symlinked digest refuses token writes (fail closed); other keys are unaffected', async () => {
    const bad = fx(); writeFileSync(join(bad.dir, 'admin-token.sha256'), 'nothex', { mode: 0o600 });
    expect(await new EnvWriter({ dir: bad.dir }).set('BOT_TOKEN_HQ', tok('H'))).toEqual({ ok: false, reason: 'value' });
    expect(await new EnvWriter({ dir: bad.dir }).set('CLICKUP_LIST_ID', 'abc')).toEqual({ ok: true });
    const sym = fx(); writeFileSync(join(sym.dir, 'real'), sha(tok('Z')), { mode: 0o600 }); symlinkSync(join(sym.dir, 'real'), join(sym.dir, 'admin-token.sha256'));
    expect(await new EnvWriter({ dir: sym.dir }).set('BOT_TOKEN_HQ', tok('H'))).toEqual({ ok: false, reason: 'value' });
  });
});

describe('path keys (E3, E4)', () => {
  const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\n';
  const mk = (dir: string, name: string, body: string, mode = 0o600) => { const p = join(dir, name); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body, { mode }); chmodSync(p, mode); return p; };
  it('accepts a 0600 PEM outside the config dir, refuses wrong content, mode, symlink, env files and non-pem names inside it', async () => {
    const f = fx(); const o = fx(); const w = new EnvWriter({ dir: f.dir });
    expect(await w.set('GITHUB_APP_PRIVATE_KEY_PATH', mk(o.dir, 'app.pem', PEM))).toEqual({ ok: true });
    expect(await w.set('GITHUB_APP_PRIVATE_KEY_PATH', mk(o.dir, 'notpem.pem', 'hello'))).toEqual({ ok: false, reason: 'value' });
    expect(await w.set('GITHUB_APP_PRIVATE_KEY_PATH', mk(o.dir, 'loose.pem', PEM, 0o644))).toEqual({ ok: false, reason: 'value' });
    symlinkSync(join(o.dir, 'app.pem'), join(o.dir, 'lnk.pem'));
    expect(await w.set('GITHUB_APP_PRIVATE_KEY_PATH', join(o.dir, 'lnk.pem'))).toEqual({ ok: false, reason: 'value' });
    expect(await w.set('GITHUB_APP_PRIVATE_KEY_PATH', f.file)).toEqual({ ok: false, reason: 'value' });
    expect(await w.set('GITHUB_APP_PRIVATE_KEY_PATH', mk(f.dir, 'key.txt', PEM))).toEqual({ ok: false, reason: 'value' });
    expect(await w.set('GITHUB_APP_PRIVATE_KEY_PATH', mk(f.dir, 'ok.pem', PEM))).toEqual({ ok: true });
    expect(await w.set('GITHUB_APP_PRIVATE_KEY_PATH', mk(o.dir, 'big.pem', PEM + 'x'.repeat(17 * 1024)))).toEqual({ ok: false, reason: 'value' });
    expect(await w.set('GITHUB_APP_PRIVATE_KEY_PATH', join(o.dir, 'missing.pem'))).toEqual({ ok: false, reason: 'value' });
  });
  it('cookies: Netscape header required, not a PEM, only under cookies/ inside the config dir', async () => {
    const f = fx(); const o = fx(); const w = new EnvWriter({ dir: f.dir });
    const jar = '\n# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t0\tn\tv\n';
    expect(await w.set('YTDLP_COOKIES_FILE', mk(o.dir, 'bad.txt', 'nothing'))).toEqual({ ok: false, reason: 'value' });
    expect(await w.set('YTDLP_COOKIES_FILE', mk(o.dir, 'k.pem', PEM))).toEqual({ ok: false, reason: 'value' });
    expect(await w.set('YTDLP_COOKIES_FILE', mk(f.dir, 'c.txt', jar))).toEqual({ ok: false, reason: 'value' });
    expect(await w.set('YTDLP_COOKIES_FILE', mk(o.dir, 'outside.txt', jar))).toEqual({ ok: false, reason: 'value' }); // G2E-01: valid file outside cookies/ (o.dir is not the config dir)
    expect(await w.set('YTDLP_COOKIES_FILE', mk(f.dir, 'cookies/c.txt', jar))).toEqual({ ok: true });
  });
});


describe('CLICKUP-MULTI-1 CLICKUP_TEAM_ID accepts digits or exactly all (CM-C5 c)', () => {
  it('all and digits are accepted; ALL, All, blanks and other words are not', () => {
    for (const v of ['all', '9012345678', '1']) expect(validShape('CLICKUP_TEAM_ID', v), v).toBe(true);
    for (const v of ['ALL', 'All', 'aLL', 'everything', 'all ', ' all', '12a', '1'.repeat(21), '']) expect(validShape('CLICKUP_TEAM_ID', v), JSON.stringify(v)).toBe(false);
  });
  it('writes and clears all through the writer', async () => {
    const f = fx(); const w = new EnvWriter({ dir: f.dir });
    expect(await w.set('CLICKUP_TEAM_ID', 'all')).toEqual({ ok: true });
    expect(read(f.file)).toContain('CLICKUP_TEAM_ID=all\n');
    expect(await w.set('CLICKUP_TEAM_ID', 'ALL')).toEqual({ ok: false, reason: 'value' });
    expect(await w.clear('CLICKUP_TEAM_ID')).toEqual({ ok: true });
  });
  it('the CLICKUP_LIST_ID note says that clearing it while CLICKUP_TEAM_ID is set widens access; the TEAM note names all', () => {
    expect(ENV_KEYS['CLICKUP_LIST_ID']!.note).toMatch(/clearing this while CLICKUP_TEAM_ID is set widens access/i);
    expect(ENV_KEYS['CLICKUP_TEAM_ID']!.note).toMatch(/every workspace the token can see/);
  });
});

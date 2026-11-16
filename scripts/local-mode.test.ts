import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { argvDigest } from '../providers/claude-code-local/protocol.js';

const ROOT = resolve(import.meta.dirname, '..');
const SCRIPTS = ['scripts/set-tokens.sh', 'scripts/dev.sh', 'scripts/probe-local-cli.sh', 'scripts/lib/envfile.sh'];
const sh = (script: string, args: string[], opts: { input?: string; env?: Record<string, string> } = {}) =>
  spawnSync('/bin/bash', [join(ROOT, script), ...args], { input: opts.input ?? '', encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: mkHome(), ...opts.env }, cwd: ROOT, timeout: 60_000 });

const tmp: string[] = [];
const mk = () => {
  const d = mkdtempSync(join(tmpdir(), 'asst-local-'));
  tmp.push(d);
  return d;
};
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));
const mkHome = () => mk();
const mode = (p: string) => statSync(p).mode & 0o777;

const tokenFor = (n: number) => `${'A'.repeat(24)}.${'b'.repeat(6)}.${String(n).repeat(30).slice(0, 30)}`;

describe('script syntax under /bin/bash (3.2 on macOS)', () => {
  it.each(SCRIPTS)('%s passes bash -n', (s) => {
    const r = spawnSync('/bin/bash', ['-n', join(ROOT, s)], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});

describe('set-tokens.sh --local --dry-run', () => {
  const run = (target: string, input: string, args: string[] = []) => sh('scripts/set-tokens.sh', ['--local', '--dry-run', target, ...args], { input });

  it('writes a 0600 file in a 0700 dir with tokens, generated secrets and no ALLOW_LOCAL_PROVIDERS', () => {
    const dir = join(mk(), 'cfg');
    const file = join(dir, 'env.local');
    const input = [1, 2, 3].map(tokenFor).join('\n') + '\n';
    const r = run(file, input, ['HQ', 'RND', 'SOFTWARE']);
    expect(r.status, r.stderr).toBe(0);
    expect(mode(dir)).toBe(0o700);
    expect(mode(file)).toBe(0o600);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/ALLOW_LOCAL_PROVIDERS/);
    expect(text).toContain(`BOT_TOKEN_HQ=${tokenFor(1)}`);
    expect(text).toContain(`BOT_TOKEN_SOFTWARE=${tokenFor(3)}`);
    const pw = /^LOCAL_DB_PASSWORD=([0-9a-f]{48})$/m.exec(text)?.[1];
    expect(pw).toBeTruthy();
    expect(text).toContain(`DATABASE_URL=postgres://assistant:${pw}@127.0.0.1:54330/assistant`);
    const key = /^CONFIG_MASTER_KEY=(.+)$/m.exec(text)?.[1] ?? '';
    expect(Buffer.from(key, 'base64')).toHaveLength(32);
    expect(text).toMatch(/^BOT_ADMIN_ROLE_ID=\d+$/m);
    // secrets are never echoed
    for (const secret of [tokenFor(1), pw!, key]) expect(r.stdout + r.stderr).not.toContain(secret);
    expect(readdirNoTemp(dir)).toEqual(['env.local']);
  });

  const geminiKey = `AIza${'x'.repeat(35)}`;
  it('PRAW token and GEMINI_API_KEY are staged hidden; malformed key rejected; dry-run file lists names only', () => {
    const file = join(mk(), 'cfg', 'env.local');
    const r = run(file, `${tokenFor(7)}\n${geminiKey}\n`, ['PRAW']);
    expect(r.status, r.stderr).toBe(0);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain(`BOT_TOKEN_PRAW=${tokenFor(7)}`);
    expect(text).toContain(`GEMINI_API_KEY=${geminiKey}`);
    expect(r.stdout + r.stderr).not.toContain(geminiKey);
    expect(r.stdout + r.stderr).not.toContain(tokenFor(7));
    expect(r.stdout).toMatch(/^ {2}GEMINI_API_KEY$/m);
    expect(r.stdout).toMatch(/^ {2}BOT_TOKEN_PRAW$/m);
    expect(r.stderr).toContain('พราว');
    // malformed key: nothing written
    const bad = join(mk(), 'cfg', 'env.local');
    const rb = run(bad, `${tokenFor(7)}\nAIzaTooShort\n`, ['PRAW']);
    expect(rb.status).not.toBe(0);
    expect(existsSync(bad)).toBe(false);
    const rq = run(bad, `${tokenFor(7)}\nAQ.short\n`, ['PRAW']);
    expect(rq.status).not.toBe(0);
    expect(existsSync(bad)).toBe(false);
  });

  it('accepts the newer AQ. Gemini key format', () => {
    const file = join(mk(), 'cfg', 'env.local');
    const aq = `AQ.${'Ab_-9'.repeat(10)}`;
    const r = run(file, `${tokenFor(7)}\n${aq}\n`, ['PRAW']);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(file, 'utf8')).toContain(`GEMINI_API_KEY=${aq}`);
    expect(r.stdout + r.stderr).not.toContain(aq);
  });

  it('a second run keeps generated values, updates one key and skips on empty input', () => {
    const file = join(mk(), 'cfg', 'env.local');
    run(file, [1, 2].map(tokenFor).join('\n') + '\n', ['HQ', 'RND']);
    const before = readFileSync(file, 'utf8');
    const r = run(file, `${tokenFor(9)}\n\n`, ['HQ', 'RND']);
    expect(r.status, r.stderr).toBe(0);
    const after = readFileSync(file, 'utf8');
    expect(after).toContain(`BOT_TOKEN_HQ=${tokenFor(9)}`);
    expect(after).not.toContain(`BOT_TOKEN_HQ=${tokenFor(1)}`);
    expect(after).toContain(`BOT_TOKEN_RND=${tokenFor(2)}`);
    for (const k of ['CONFIG_MASTER_KEY', 'LOCAL_DB_PASSWORD', 'DATABASE_URL']) {
      expect(new RegExp(`^${k}=.*$`, 'm').exec(after)?.[0]).toBe(new RegExp(`^${k}=.*$`, 'm').exec(before)?.[0]);
    }
    expect(mode(file)).toBe(0o600);
  });

  it('DATABASE_URL present without LOCAL_DB_PASSWORD: derives the password from the URL, never a mismatching one', () => {
    const dir = join(mk(), 'cfg');
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, 'env.local');
    writeFileSync(file, 'DATABASE_URL=postgres://assistant:s3cretpw@127.0.0.1:54330/assistant\n', { mode: 0o600 });
    const r = run(file, `${tokenFor(1)}\n`, ['HQ']);
    expect(r.status, r.stderr).toBe(0);
    const after = readFileSync(file, 'utf8');
    expect(after).toMatch(/^LOCAL_DB_PASSWORD=s3cretpw$/m);
    expect(after).toMatch(/^DATABASE_URL=postgres:\/\/assistant:s3cretpw@127\.0\.0\.1:54330\/assistant$/m);
  });

  it('DATABASE_URL without a password and without LOCAL_DB_PASSWORD: refuses with a fixed instruction and writes nothing', () => {
    const dir = join(mk(), 'cfg');
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, 'env.local');
    const body = 'DATABASE_URL=postgres://127.0.0.1:54330/assistant\n';
    writeFileSync(file, body, { mode: 0o600 });
    const r = run(file, `${tokenFor(1)}\n`, ['HQ']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/LOCAL_DB_PASSWORD/);
    expect(readFileSync(file, 'utf8')).toBe(body);
  });

  it('strips an ALLOW_LOCAL_PROVIDERS line that someone put into the file', () => {
    const dir = join(mk(), 'cfg');
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, 'env.local');
    writeFileSync(file, 'ALLOW_LOCAL_PROVIDERS=1\nFOO=bar\n', { mode: 0o600 });
    const r = run(file, `${tokenFor(1)}\n`, ['HQ']);
    expect(r.status, r.stderr).toBe(0);
    const text = readFileSync(file, 'utf8');
    expect(text).not.toMatch(/ALLOW_LOCAL_PROVIDERS/);
    expect(text).toContain('FOO=bar');
  });

  it('rejects a malformed token and refuses an existing file with mode 0644', () => {
    const dir = join(mk(), 'cfg');
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, 'env.local');
    writeFileSync(file, 'X=1\n');
    chmodSync(file, 0o644);
    const r = run(file, `${tokenFor(1)}\n`, ['HQ']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/0600/);
    expect(readFileSync(file, 'utf8')).toBe('X=1\n');
  });

  it('set-tokens › CLICKUP keys staged hidden', () => {
    const file = join(mk(), 'cfg', 'env.local');
    const pk = `pk_12345678_${'A1'.repeat(16)}`;
    const r = run(file, `${pk}\n901800000001\n`, ['CLICKUP']);
    expect(r.status, r.stderr).toBe(0);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain(`CLICKUP_API_TOKEN=${pk}`);
    expect(text).toContain('CLICKUP_LIST_ID=901800000001');
    expect(text).not.toMatch(/BOT_TOKEN_/);
    expect(r.stdout + r.stderr).not.toContain(pk);
    expect(r.stdout).toMatch(/^ {2}CLICKUP_API_TOKEN$/m);
    // malformed token: nothing written
    const bad = join(mk(), 'cfg', 'env.local');
    const rb = run(bad, 'not-a-token\n901800000001\n', ['CLICKUP']);
    expect(rb.status).not.toBe(0);
    expect(existsSync(bad)).toBe(false);
  });

  it('set-tokens › CLICKUP workspace mode: empty list id asks CLICKUP_TEAM_ID and clears an old list id', () => {
    const file = join(mk(), 'cfg', 'env.local');
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, 'X=1\nCLICKUP_LIST_ID=oldlist1\n', { mode: 0o600 });
    const pk = `pk_12345678_${'A1'.repeat(16)}`;
    const r = run(file, `${pk}\n\n9012345678\n`, ['CLICKUP']);
    expect(r.status, r.stderr).toBe(0);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('CLICKUP_TEAM_ID=9012345678');
    expect(text).toMatch(/^CLICKUP_LIST_ID=$/m);
    expect(text).not.toContain('oldlist1');
    expect(text).toContain('X=1');
    // a non-numeric team id is refused and nothing is written
    const bad = join(mk(), 'cfg', 'env.local');
    const rb = run(bad, `${pk}\n\nabc\n`, ['CLICKUP']);
    expect(rb.status).not.toBe(0);
    expect(existsSync(bad)).toBe(false);
  });

  it('set-tokens › CLICKUP-MULTI-1: an empty list prompt then `all` stages the team id all and clears the list id; ALL is refused and nothing is written', () => {
    const file = join(mk(), 'cfg', 'env.local');
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, 'X=1\nCLICKUP_LIST_ID=oldlist1\n', { mode: 0o600 });
    const pk = `pk_12345678_${'A1'.repeat(16)}`;
    const r = run(file, `${pk}\n\nall\n`, ['CLICKUP']);
    expect(r.status, r.stderr).toBe(0);
    const text = readFileSync(file, 'utf8');
    expect(text).toMatch(/^CLICKUP_TEAM_ID=all$/m);
    expect(text).toMatch(/^CLICKUP_LIST_ID=$/m);
    expect(text).not.toContain('oldlist1');
    expect(r.stdout + r.stderr).not.toContain(pk);
    for (const bad of ['ALL', 'All', 'every']) {
      const f2 = join(mk(), 'cfg', 'env.local');
      const rb = run(f2, `${pk}\n\n${bad}\n`, ['CLICKUP']);
      expect(rb.status, bad).not.toBe(0);
      expect(existsSync(f2), bad).toBe(false);
    }
  });

  it('set-tokens › CM-C5: giving a list id clears a leftover CLICKUP_TEAM_ID (all) in the same write', () => {
    const file = join(mk(), 'cfg', 'env.local');
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, 'X=1\nCLICKUP_TEAM_ID=all\n', { mode: 0o600 });
    const pk = `pk_12345678_${'A1'.repeat(16)}`;
    const r = run(file, `${pk}\n901800000001\n`, ['CLICKUP']);
    expect(r.status, r.stderr).toBe(0);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('CLICKUP_LIST_ID=901800000001');
    expect(text).toMatch(/^CLICKUP_TEAM_ID=$/m); // staged empty
    expect(text).not.toMatch(/CLICKUP_TEAM_ID=all/);
    expect(text).toContain('X=1');
  });

  it('set-tokens › the VPS block asks the list first, clears the other key through lw env unset, and tracks what was really set (static check: it cannot be run without ssh)', () => {
    const src = readFileSync(join(ROOT, 'scripts/set-tokens.sh'), 'utf8');
    expect(src).toContain("CLICKUP_TEAM_RE='^([0-9]{1,20}|all)$'");
    expect(src).toMatch(/was_set CLICKUP_LIST_ID[\s\S]*lw env unset \$APP CLICKUP_TEAM_ID/);
    expect(src).toMatch(/was_set CLICKUP_TEAM_ID[\s\S]*lw env unset \$APP CLICKUP_LIST_ID/);
    expect(src).toContain('SET_KEYS[${#SET_KEYS[@]}]=$key');
    expect(src).not.toMatch(/nocasematch/);
  });

  it('set-tokens › GITHUB keys: ids staged, PEM by file path (0600, own file, not a symlink), never its content', () => {
    const d = mk();
    const pem = join(d, 'app.pem');
    writeFileSync(pem, '-----BEGIN PRIVATE KEY-----\nSECRETBODYSECRETBODY\n-----END PRIVATE KEY-----\n');
    chmodSync(pem, 0o600);
    const file = join(mk(), 'cfg', 'env.local');
    const r = run(file, `123456\n987654\n${pem}\n`, ['GITHUB']);
    expect(r.status, r.stderr).toBe(0);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('GITHUB_APP_ID=123456');
    expect(text).toContain('GITHUB_INSTALLATION_ID=987654');
    expect(text).toContain(`GITHUB_APP_PRIVATE_KEY_PATH=${pem}`);
    expect(text).not.toContain('SECRETBODY');
    expect(text).not.toMatch(/GITHUB_APP_PRIVATE_KEY=/);
    expect(r.stdout + r.stderr).not.toContain('SECRETBODY');
    expect(r.stdout).toMatch(/^ {2}GITHUB_APP_PRIVATE_KEY_PATH$/m);
    const ro = join(d, 'ro.pem');
    writeFileSync(ro, '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n');
    chmodSync(ro, 0o400);
    const rr = run(join(mk(), 'cfg', 'env.local'), `123456\n987654\n${ro}\n`, ['GITHUB']);
    expect(rr.status, rr.stderr).toBe(0); // 0400 is as safe as 0600 and the runtime accepts it
    const wide = join(d, 'wide.pem');
    writeFileSync(wide, '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n');
    chmodSync(wide, 0o644);
    const link = join(d, 'link.pem');
    symlinkSync(pem, link);
    const junk = join(d, 'junk.pem');
    writeFileSync(junk, 'not a key');
    chmodSync(junk, 0o600);
    for (const input of [`123456\n987654\n${wide}\n`, `123456\n987654\n${link}\n`, `123456\n987654\n${junk}\n`, `123456\n987654\n${join(d, 'missing.pem')}\n`, `a b\n987654\n${pem}\n`, `123456\nabc\n${pem}\n`, `123456\n987654\nrelative.pem\n`]) {
      const bad = join(mk(), 'cfg', 'env.local');
      const rb = run(bad, input, ['GITHUB']);
      expect(rb.status, input).not.toBe(0);
      expect(existsSync(bad)).toBe(false);
      expect(rb.stdout + rb.stderr).not.toContain('SECRETBODY');
    }
  });

  it('--dry-run without --local is an error', () => {
    const r = sh('scripts/set-tokens.sh', ['--dry-run', join(mk(), 'x')]);
    expect(r.status).not.toBe(0);
  });
});

function readdirNoTemp(dir: string): string[] {
  return spawnSync('ls', ['-A', dir], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
}

describe('dev.sh env file checks (--check-only)', () => {
  const good = () => {
    const dir = join(mk(), 'cfg');
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, 'env.local');
    writeFileSync(file, 'DATABASE_URL=postgres://u:p@127.0.0.1:54330/x\nCONFIG_MASTER_KEY=abc\n', { mode: 0o600 });
    return { dir, file };
  };
  const check = (file: string) => sh('scripts/dev.sh', ['--check-only', file]);

  it('accepts a 0600 regular file in a 0700 dir owned by the user', () => {
    expect(check(good().file).status).toBe(0);
  });
  it('refuses mode 0640 and 0644', () => {
    for (const m of [0o640, 0o644, 0o604]) {
      const { file } = good();
      chmodSync(file, m);
      const r = check(file);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/0600/);
    }
  });
  it('refuses a directory that is not 0700', () => {
    const { dir, file } = good();
    chmodSync(dir, 0o755);
    const r = check(file);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/0700/);
    chmodSync(dir, 0o700);
  });
  it('refuses a symlinked file', () => {
    const { dir, file } = good();
    const link = join(dir, 'link.local');
    symlinkSync(file, link);
    const r = check(link);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/symlink/);
  });
  it('refuses a symlinked directory', () => {
    const { dir, file } = good();
    const linkDir = join(mk(), 'linkdir');
    symlinkSync(dir, linkDir);
    expect(check(join(linkDir, 'env.local')).status).not.toBe(0);
    expect(existsSync(file)).toBe(true);
  });
  it('refuses a file or directory owned by someone else (root-owned /private/etc/hosts)', () => {
    const r = check('/private/etc/hosts');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/owner|owned/);
  });
  it('refuses a missing file and a file that defines ALLOW_LOCAL_PROVIDERS', () => {
    const { dir, file } = good();
    expect(check(join(dir, 'nope')).status).not.toBe(0);
    writeFileSync(file, 'export ALLOW_LOCAL_PROVIDERS=1\nDATABASE_URL=x\nCONFIG_MASTER_KEY=y\n');
    const r = check(file);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/ALLOW_LOCAL_PROVIDERS/);
  });
  it('refuses a non-loopback DATABASE_URL or HEALTH_HOST (L10), accepts loopback ones', () => {
    const { file } = good();
    const w = (extra: string) => writeFileSync(file, `DATABASE_URL=postgres://a:b@127.0.0.1:54330/x\nCONFIG_MASTER_KEY=y\n${extra}`);
    w('');
    expect(check(file).status).toBe(0);
    for (const ok of ['HEALTH_HOST=127.0.0.1']) { w(`${ok}\n`); expect(check(file).status, ok).toBe(0); }
    for (const bad of ['HEALTH_HOST=localhost', 'HEALTH_HOST=::1']) { w(`${bad}\n`); expect(check(file).status, bad).not.toBe(0); }
    w('HEALTH_HOST=0.0.0.0\n');
    let r = check(file);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/HEALTH_HOST/);
    writeFileSync(file, 'DATABASE_URL=postgres://a:b@10.0.0.5:5432/x\nCONFIG_MASTER_KEY=y\n');
    r = check(file);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/DATABASE_URL/);
    expect(r.stderr).not.toContain('10.0.0.5');
    for (const q of ['?host=10.0.0.5', '?hostaddr=10.0.0.5', '?host=/tmp/s', '?sslmode=disable&host=db.example.com']) {
      writeFileSync(file, `DATABASE_URL=postgres://a:b@127.0.0.1/x${q}\nCONFIG_MASTER_KEY=y\n`);
      expect(check(file).status, q).not.toBe(0);
    }
    writeFileSync(file, 'DATABASE_URL=postgres://a:b@127.0.0.1/x?host=localhost\nCONFIG_MASTER_KEY=y\n');
    expect(check(file).status).toBe(0);
  });
  it('refuses a file without DATABASE_URL or CONFIG_MASTER_KEY', () => {
    const { file } = good();
    writeFileSync(file, 'BOT_TOKEN_HQ=x\n');
    const r = check(file);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/set-tokens/);
  });
});

describe('dev.sh launches the child with a clean environment (R-L10 follow-up)', () => {
  it('an exported DATABASE_URL / ANTHROPIC_API_KEY in the parent shell never reaches the child; env-file values win', () => {
    const home = mk();
    const cfg = join(home, '.config', 'assistant');
    mkdirSync(cfg, { recursive: true, mode: 0o700 });
    writeFileSync(join(cfg, 'env.local'), 'DATABASE_URL=postgres://a:b@127.0.0.1:54330/filevalue\nCONFIG_MASTER_KEY=filekey\n', { mode: 0o600 });
    const bin = join(home, 'bin');
    mkdirSync(bin);
    const dump = join(home, 'child-env.json');
    writeFileSync(join(bin, 'npm'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    // fake node: same args, but runs the real node on a dump script instead of dist/main.js (so --env-file semantics are real)
    writeFileSync(join(bin, 'node'), `#!/bin/bash\nexec "${process.execPath}" "\${@:1:$#-1}" -e 'require("fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env))'\n`, { mode: 0o755 });
    const run = (extra: Record<string, string>) => {
      rmSync(dump, { force: true });
      const r = sh('scripts/dev.sh', [], { env: { HOME: home, PATH: `${bin}:${process.env.PATH}`, USER: 'tester', DATABASE_URL: 'postgres://evil@10.0.0.9/x', ANTHROPIC_API_KEY: 'sk-leak', NODE_OPTIONS: '--no-warnings', ...extra } });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(readFileSync(dump, 'utf8')) as Record<string, string>;
    };
    const env = run({});
    expect(env.DATABASE_URL).toBe('postgres://a:b@127.0.0.1:54330/filevalue');
    expect(env.CONFIG_MASTER_KEY).toBe('filekey');
    expect(env.ALLOW_LOCAL_PROVIDERS).toBe('1');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.ASSISTANT_SKIP_PROBE_PIN).toBeUndefined();
    expect(env.HOME).toBe(home);
    expect(run({ ASSISTANT_SKIP_PROBE_PIN: '1' }).ASSISTANT_SKIP_PROBE_PIN).toBe('1');
    expect(env.ASSISTANT_LOCAL_PROVIDER_OFF).toBeUndefined();
    // LOCAL-OFF-1: the marker file next to env.local turns only the local provider off (process env of the child, local mode stays on);
    // an exported ASSISTANT_LOCAL_PROVIDER_OFF in the parent shell is not enough and not needed.
    expect(run({ ASSISTANT_LOCAL_PROVIDER_OFF: '1' }).ASSISTANT_LOCAL_PROVIDER_OFF).toBeUndefined();
    writeFileSync(join(cfg, 'local-provider-off'), '');
    const off = run({});
    expect(off.ASSISTANT_LOCAL_PROVIDER_OFF).toBe('1');
    expect(off.ALLOW_LOCAL_PROVIDERS).toBe('1');
    const r = sh('scripts/dev.sh', [], { env: { HOME: home, PATH: `${bin}:${process.env.PATH}`, USER: 'tester' } });
    expect(r.stderr).toMatch(/local provider is off by the owner/);
    expect(r.stderr).not.toMatch(/probe has not passed/);
  });
});

describe('the separate executor LW Admin: env.admin, set-tokens ADMIN and dev.sh (Gate 1 S2, S6)', () => {
  const ADMIN_TOKEN = `${'Q'.repeat(24)}.${'w'.repeat(6)}.${'7'.repeat(30)}`;
  const LOCAL = 'DATABASE_URL=postgres://assistant:pw123@127.0.0.1:54330/assistant\nCONFIG_MASTER_KEY=abc\nBOT_ADMIN_ROLE_ID=1566025466274512988\nBOT_TOKEN_HQ=hqtoken\n';
  const cfgWith = (local = LOCAL) => {
    const dir = join(mk(), 'cfg');
    mkdirSync(dir, { mode: 0o700 });
    writeFileSync(join(dir, 'env.local'), local, { mode: 0o600 });
    return dir;
  };
  const setAdmin = (dir: string, input: string, args: string[] = ['ADMIN']) => sh('scripts/set-tokens.sh', ['--local', '--dry-run', join(dir, 'env.local'), ...args], { input });

  it('set-tokens ADMIN writes a 0600 env.admin with exactly the token, the loopback database url and the role id; env.local is not touched; nothing is echoed', () => {
    const dir = cfgWith();
    const before = readFileSync(join(dir, 'env.local'), 'utf8');
    const r = setAdmin(dir, `${ADMIN_TOKEN}\n`);
    expect(r.status, r.stderr).toBe(0);
    expect(mode(join(dir, 'env.admin'))).toBe(0o600);
    expect(readFileSync(join(dir, 'env.admin'), 'utf8')).toBe(`BOT_TOKEN_ADMIN=${ADMIN_TOKEN}\nDATABASE_URL=postgres://assistant:pw123@127.0.0.1:54330/assistant\nBOT_ADMIN_ROLE_ID=1566025466274512988\n`);
    expect(readFileSync(join(dir, 'env.local'), 'utf8')).toBe(before);
    expect(readFileSync(join(dir, 'env.local'), 'utf8')).not.toContain(ADMIN_TOKEN);
    expect(r.stdout + r.stderr).not.toContain(ADMIN_TOKEN);
    expect(readdirNoTemp(dir).sort()).toEqual(['env.admin', 'env.local']);
  });
  it('an empty answer changes nothing; a malformed token is rejected; env.local must exist first; ADMIN is never mixed with other names', () => {
    const dir = cfgWith();
    expect(setAdmin(dir, '\n').status).toBe(0);
    expect(existsSync(join(dir, 'env.admin'))).toBe(false);
    const bad = setAdmin(dir, 'not-a-token\n');
    expect(bad.status).not.toBe(0);
    expect(existsSync(join(dir, 'env.admin'))).toBe(false);
    const empty = join(mk(), 'cfg');
    mkdirSync(empty, { mode: 0o700 });
    expect(setAdmin(empty, `${ADMIN_TOKEN}\n`).status).not.toBe(0);
    const mixed = setAdmin(dir, `${ADMIN_TOKEN}\n`, ['ADMIN', 'HQ']);
    expect(mixed.status).not.toBe(0);
    expect(mixed.stderr).toMatch(/on its own/);
    expect(existsSync(join(dir, 'env.admin'))).toBe(false);
  });
  it('a full run never asks for ADMIN, and VPS mode refuses ADMIN before any ssh', () => {
    const dir = join(mk(), 'cfg');
    const full = sh('scripts/set-tokens.sh', ['--local', '--dry-run', join(dir, 'env.local')], { input: '\n'.repeat(40) });
    expect(full.stdout + full.stderr).not.toMatch(/LW Admin|BOT_TOKEN_ADMIN/);
    const vps = sh('scripts/set-tokens.sh', ['ADMIN'], { input: `${ADMIN_TOKEN}\n` });
    expect(vps.status).not.toBe(0);
    expect(vps.stderr).toMatch(/local mode only/);
    expect(vps.stdout + vps.stderr).not.toContain(ADMIN_TOKEN);
  });
  it('dev.sh refuses an env.local that holds BOT_TOKEN_ADMIN (the main application must never get it)', () => {
    const dir = cfgWith(`${LOCAL}BOT_TOKEN_ADMIN=${ADMIN_TOKEN}\n`);
    const r = sh('scripts/dev.sh', ['--check-only', join(dir, 'env.local')]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/env\.admin/);
    expect(r.stderr).not.toContain(ADMIN_TOKEN);
  });
  describe('env.admin checks (--check-admin-only)', () => {
    const adminFile = (text: string, fileMode = 0o600) => {
      const dir = join(mk(), 'cfg');
      mkdirSync(dir, { mode: 0o700 });
      const f = join(dir, 'env.admin');
      writeFileSync(f, text, { mode: fileMode });
      return f;
    };
    const GOOD = `BOT_TOKEN_ADMIN=${ADMIN_TOKEN}\nDATABASE_URL=postgres://u:p@127.0.0.1:54330/x\nBOT_ADMIN_ROLE_ID=1566025466274512988\n`;
    const check = (f: string) => sh('scripts/dev.sh', ['--check-admin-only', f]);
    it('accepts the three keys; refuses mode 0644, a symlink, other keys (a second bot token, an API key, the master key), a missing token or a non-loopback database', () => {
      expect(check(adminFile(GOOD)).status).toBe(0);
      expect(check(adminFile(GOOD, 0o644)).status).not.toBe(0);
      for (const extra of ['BOT_TOKEN_HQ=x', 'ANTHROPIC_API_KEY=x', 'CONFIG_MASTER_KEY=x', 'GEMINI_API_KEY=x']) {
        const r = check(adminFile(`${GOOD}${extra}\n`));
        expect(r.status, extra).not.toBe(0);
        expect(r.stderr).toMatch(/may only define/);
      }
      expect(check(adminFile(GOOD.replace(/BOT_TOKEN_ADMIN=.*\n/, ''))).status).not.toBe(0);
      expect(check(adminFile(GOOD.replace('127.0.0.1', '10.0.0.9'))).status).not.toBe(0);
      expect(check(adminFile(GOOD.replace(/BOT_ADMIN_ROLE_ID=.*\n/, ''))).status).not.toBe(0);
      const f = adminFile(GOOD);
      const link = join(f, '..', 'link');
      symlinkSync(f, link);
      expect(check(link).status).not.toBe(0);
    });
  });
  describe('dev.sh starts the executor alongside the app, each with its own environment', () => {
    const setup = (withAdmin: boolean) => {
      const home = mk();
      const cfg = join(home, '.config', 'assistant');
      mkdirSync(cfg, { recursive: true, mode: 0o700 });
      writeFileSync(join(cfg, 'env.local'), `${LOCAL}ANTHROPIC_API_KEY=sk-main-only\n`, { mode: 0o600 });
      if (withAdmin) writeFileSync(join(cfg, 'env.admin'), `BOT_TOKEN_ADMIN=${ADMIN_TOKEN}\nDATABASE_URL=postgres://u:p@127.0.0.1:54330/x\nBOT_ADMIN_ROLE_ID=1566025466274512988\n`, { mode: 0o600 });
      const bin = join(home, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'npm'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
      // fake node: dumps the process env under a name taken from the script it was asked to run (dist/main.js, dist/executor/main.js)
      writeFileSync(join(bin, 'node'), `#!/bin/bash\nlast="\${@: -1}"\nname=$(basename "$(dirname "$last")")-$(basename "$last")\nif [ "$name" = dist-main.js ] && [ -e "$HOME/.config/assistant/env.admin" ]; then for _ in $(seq 100); do [ -e "${home}/executor-main.js.json" ] && break; sleep 0.1; done; fi # the app waits for the executor dump; dev.sh stops the executor when the app exits\nexec "${process.execPath}" "\${@:1:$#-1}" -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(process.env))' "${home}/$name.json"\n`, { mode: 0o755 });
      const r = sh('scripts/dev.sh', [], { env: { HOME: home, PATH: `${bin}:${process.env.PATH}`, USER: 'tester' } });
      const read = (n: string) => (existsSync(join(home, n)) ? (JSON.parse(readFileSync(join(home, n), 'utf8')) as Record<string, string>) : null);
      return { r, app: read('dist-main.js.json'), exec: read('executor-main.js.json'), home };
    };
    it('the executor child gets its token and database only; the app child never sees BOT_TOKEN_ADMIN and gets the socket path', () => {
      const x = setup(true);
      expect(x.r.status, x.r.stderr).toBe(0);
      expect(x.exec).not.toBeNull();
      expect(x.exec!.BOT_TOKEN_ADMIN).toBe(ADMIN_TOKEN);
      expect(x.exec!.DATABASE_URL).toBe('postgres://u:p@127.0.0.1:54330/x');
      expect(x.exec!.EXECUTOR_SOCKET).toBe(join(x.home, '.config', 'assistant', 'executor.sock'));
      for (const k of ['ANTHROPIC_API_KEY', 'CONFIG_MASTER_KEY', 'BOT_TOKEN_HQ', 'ALLOW_LOCAL_PROVIDERS']) expect(x.exec![k], k).toBeUndefined();
      expect(x.app!.BOT_TOKEN_ADMIN).toBeUndefined();
      expect(x.app!.EXECUTOR_SOCKET).toBe(x.exec!.EXECUTOR_SOCKET);
      expect(x.app!.BOT_TOKEN_HQ).toBe('hqtoken');
      expect(JSON.stringify(x.app)).not.toContain(ADMIN_TOKEN);
      expect(x.r.stdout + x.r.stderr).not.toContain(ADMIN_TOKEN);
    });
    it('without env.admin only the app starts, with no socket, and says so', () => {
      const x = setup(false);
      expect(x.r.status, x.r.stderr).toBe(0);
      expect(x.exec).toBeNull();
      expect(x.app!.EXECUTOR_SOCKET).toBeUndefined();
      expect(x.r.stderr).toMatch(/executor is not started/);
    });
    it('a bad env.admin stops everything before the app starts', () => {
      const home = mk();
      const cfg = join(home, '.config', 'assistant');
      mkdirSync(cfg, { recursive: true, mode: 0o700 });
      writeFileSync(join(cfg, 'env.local'), LOCAL, { mode: 0o600 });
      writeFileSync(join(cfg, 'env.admin'), `BOT_TOKEN_ADMIN=${ADMIN_TOKEN}\nBOT_TOKEN_HQ=x\n`, { mode: 0o600 });
      const bin = join(home, 'bin');
      mkdirSync(bin);
      writeFileSync(join(bin, 'npm'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
      writeFileSync(join(bin, 'node'), '#!/bin/bash\ntouch "$HOME/started"\n', { mode: 0o755 });
      const r = sh('scripts/dev.sh', [], { env: { HOME: home, PATH: `${bin}:${process.env.PATH}` } });
      expect(r.status).not.toBe(0);
      expect(existsSync(join(home, 'started'))).toBe(false);
    });
  });
});

describe('docker-compose.local.yml', () => {
  const docker = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
  const cfg = (env: Record<string, string>) =>
    spawnSync('docker', ['compose', '-f', join(ROOT, 'docker-compose.local.yml'), 'config'], { encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ...env } }); // real HOME only so docker finds its compose plugin; `compose config` writes nothing

  it.skipIf(!docker)('validates, binds loopback 54330 only, uses a named volume and takes the password from the environment', () => {
    const r = cfg({ LOCAL_DB_PASSWORD: 'sentinel-pw-123' });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/postgres:17/);
    expect(r.stdout).toMatch(/host_ip: 127\.0\.0\.1/);
    expect(r.stdout).toMatch(/published: "54330"/);
    expect(r.stdout).toMatch(/type: volume/);
    expect(r.stdout).toMatch(/^name: assistant-local$/m);
    expect(r.stdout).toMatch(/name: assistant_local_pgdata/);
    expect(r.stdout).toContain('sentinel-pw-123');
  });
  it.skipIf(!docker)('has no default password: config fails when LOCAL_DB_PASSWORD is unset', () => {
    expect(cfg({}).status).not.toBe(0);
  });
  it('commits no password literal', () => {
    expect(readFileSync(join(ROOT, 'docker-compose.local.yml'), 'utf8')).toMatch(/\$\{LOCAL_DB_PASSWORD:\?/);
  });
});

describe('probe-local-cli.sh with a fake claude (HOME is always a temp dir)', () => {
  let home: string;
  let bin: string;
  const claudeMd = '# my rules\nbe nice\n';
  const settings = '{\n  "model": "x"\n}\n';
  const cfgDir = () => join(home, '.config', 'assistant');

  // The probe imports the BUILT provider (dist). Never the live dist: the provider is compiled from the current source into a scratch root together with a
  // copy of scripts/ and a node_modules link, and the probe runs from there. (STREAM-1: the probe parses stream-json with the provider's own parser.)
  let PROBE_ROOT: string;
  beforeAll(() => {
    PROBE_ROOT = mk();
    cpSync(join(ROOT, 'scripts'), join(PROBE_ROOT, 'scripts'), { recursive: true });
    copyFileSync(join(ROOT, 'package.json'), join(PROBE_ROOT, 'package.json'));
    symlinkSync(join(ROOT, 'node_modules'), join(PROBE_ROOT, 'node_modules'));
    const b = spawnSync('npx', ['tsc', '-p', 'tsconfig.build.json', '--outDir', join(PROBE_ROOT, 'dist')], { cwd: ROOT, encoding: 'utf8' });
    if (b.status !== 0) throw new Error(`scratch build failed: ${b.stdout}${b.stderr}`);
  }, 180_000);

  const fake = (body: string) => {
    home = mk();
    bin = join(home, 'bin');
    mkdirSync(bin);
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), claudeMd);
    writeFileSync(join(home, '.claude', 'settings.json'), settings);
    installFake(body);
    chmodSync(home, 0o755);
  };
  const installFake = (body: string) => {
    writeFileSync(join(bin, 'claude'), `#!/bin/bash\n[ "$1" = "--version" ] && { echo "9.9.9 (Fake)"; exit 0; }\n${body}\n`, { mode: 0o755 });
    chmodSync(bin, 0o755);
  };
  const penv = () => ({ HOME: home, PATH: `${bin}:${process.env.PATH}`, USER: 'tester', LANG: 'en_US.UTF-8' });
  const probe = (args: string[] = []) => spawnSync('/bin/bash', [join(PROBE_ROOT, 'scripts/probe-local-cli.sh'), '--yes', '--skip-build', ...args], { input: '', encoding: 'utf8', env: penv(), cwd: ROOT, timeout: 60_000 });
  const lsClaude = () => spawnSync('ls', ['-A', join(home, '.claude')], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).sort();
  const untouched = () => {
    expect(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe(claudeMd);
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toBe(settings);
    expect(existsSync(join(cfgDir(), 'probe-backup'))).toBe(false);
    expect(existsSync(join(cfgDir(), 'probe.lock'))).toBe(false);
    expect(lsClaude()).toEqual(['CLAUDE.md', 'settings.json']);
  };
  // stream-json like the real CLI 2.1.319: an init event (only the structured-output tool, no MCP server, built-in agents/plugins), deltas, then the result event
  const INIT = (over: object = {}) => JSON.stringify({ type: 'system', subtype: 'init', tools: ['StructuredOutput'], mcp_servers: [], skills: [], slash_commands: [], agents: ['claude', 'Explore'], plugins: [{ name: 'cc-plugin-privacy', path: 'builtin' }], ...over });
  const RESULT = '{"type":"result","is_error":false,"result":"","structured_output":{"text":"I have no tools and see no extra instructions."},"usage":{"input_tokens":3,"output_tokens":4}}';
  const CLEAN = `cat >/dev/null\necho '${INIT()}'\necho '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":""}}}'\necho '${RESULT}'`;

  it('passes on a clean CLI, prints version and field names, pins the version (0600 probe-ok in a 0700 dir), restores everything', () => {
    fake(CLEAN);
    const r = probe();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/9\.9\.9/);
    expect(r.stdout).toMatch(/structured_output/);
    expect(r.stdout).toMatch(/subscription/i);
    expect(r.stdout).toMatch(/close (all )?other Claude Code sessions/i);
    const pin = join(cfgDir(), 'probe-ok');
    const pinText = readFileSync(pin, 'utf8');
    expect(pinText).toMatch(/^version=9\.9\.9 \(Fake\)$/m);
    const claudeFile = join(bin, 'claude');
    expect(pinText).toContain(`realpath=${realpathSync(claudeFile)}\n`);
    expect(pinText).toContain(`sha256=${createHash('sha256').update(readFileSync(claudeFile)).digest('hex')}\n`);
    expect(pinText).toContain(`argv_sha256=${argvDigest()}\n`);
    expect(mode(pin)).toBe(0o600);
    expect(mode(cfgDir())).toBe(0o700);
    untouched();
  });

  it('S17: the check prints event types and field names only, never values, and notes that deltas reached the parser', () => {
    fake(`cat >/dev/null\necho '${INIT()}'\necho '{"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"StructuredOutput"}}}'\necho '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"VALUE-MARKER-XYZ"}}}'\necho '${RESULT}'`);
    const r = probe();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/Event types in order.*system\/init.*stream_event\/content_block_delta:input_json_delta.*result/);
    expect(r.stdout).toMatch(/input_json_delta events forwarded to the sink: yes/);
    expect(r.stdout + r.stderr).not.toMatch(/VALUE-MARKER-XYZ|I have no tools/);
  });

  it.each([
    ['no init event', (res: string) => `echo '${res}'`, /NO system\/init EVENT/],
    ['a tool other than the structured-output tool', (res: string) => `echo '${INIT({ tools: ['StructuredOutput', 'Bash'] })}'\necho '${res}'`, /INIT EVENT SHOWS/],
    ['an MCP server', (res: string) => `echo '${INIT({ mcp_servers: [{ name: 'x' }] })}'\necho '${res}'`, /INIT EVENT SHOWS/],
    ['a probe-planted skill name', (res: string) => `echo '${INIT({ skills: ['assistant-probe-canary'] })}'\necho '${res}'`, /INIT EVENT SHOWS/],
    ['a probe-planted agent name', (res: string) => `echo '${INIT({ agents: ['claude', 'assistant-probe-canary'] })}'\necho '${res}'`, /INIT EVENT SHOWS/],
    ['a probe-planted command name', (res: string) => `echo '${INIT({ slash_commands: ['assistant-probe-canary'] })}'\necho '${res}'`, /INIT EVENT SHOWS/],
    ['a probe-planted plugin name', (res: string) => `echo '${INIT({ plugins: [{ name: 'assistant-probe-canary' }] })}'\necho '${res}'`, /INIT EVENT SHOWS/],
  ])('S17: fails closed on %s and writes no pin', (_n, body, msg) => {
    fake(`cat >/dev/null\n${body(RESULT)}`);
    const r = probe();
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(msg);
    expect(existsSync(join(cfgDir(), 'probe-ok'))).toBe(false);
    untouched();
  });

  it('S17: the old single-object json output (no stream-json events) is no longer accepted', () => {
    fake(`cat >/dev/null\necho '${RESULT}'`);
    const r = probe();
    expect(r.status).not.toBe(0);
    expect(existsSync(join(cfgDir(), 'probe-ok'))).toBe(false);
  });

  it('fails and still restores when the CLI leaks the CLAUDE.md canary', () => {
    fake(`cat >/dev/null\ncan=$(grep -h -o 'secret word is [A-Za-z0-9-]*' "$HOME/.claude/CLAUDE.md" | head -1)\nprintf '{"is_error":false,"structured_output":{"text":"I see: %s"}}' "$can"`);
    const r = probe();
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/LEAK.*CLAUDE_MD|CLAUDE_MD.*LEAK/s);
    expect(existsSync(join(cfgDir(), 'probe-ok'))).toBe(false);
    untouched();
  });

  it('fails when a tool ran (marker file created)', () => {
    fake(`m=$(tr ',' '\\n' | grep -o '/[^" ]*tool-marker' | head -1)\n[ -n "$m" ] && touch "$m"\necho '{"is_error":false,"structured_output":{"text":"done"}}'`);
    const r = probe();
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/tool/i);
    untouched();
  });

  it('fails when the web was reached (local URL in the prompt was fetched)', () => {
    fake(`u=$(tr ',' '\\n' | grep -o 'http://127.0.0.1:[0-9]*/[A-Za-z0-9-]*' | head -1)\n[ -n "$u" ] && curl -s -m 5 "$u" >/dev/null\necho '{"is_error":false,"structured_output":{"text":"done"}}'`);
    const r = probe();
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/web|fetch|network/i);
    untouched();
  });

  it('fails when the CLI wrote a session transcript (*.jsonl) and keeps that file', () => {
    fake(`cat >/dev/null\nmkdir -p "$HOME/.claude/projects/zzz"\necho '{}' > "$HOME/.claude/projects/zzz/s.jsonl"\n${CLEAN}`);
    const r = probe();
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/jsonl|transcript/i);
    expect(existsSync(join(home, '.claude', 'projects', 'zzz', 's.jsonl'))).toBe(true);
  });

  it('prints no CLI stderr or output text, only the exit code', () => {
    fake(`cat >/dev/null\necho OWNER-SECRET-STDERR >&2\necho OWNER-SECRET-STDOUT\nexit 3`);
    const r = probe();
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).not.toMatch(/OWNER-SECRET/);
    expect(r.stdout + r.stderr).toMatch(/exit code: 3/i);
    untouched();
  });

  it('runs extra variants only behind --also-safe-mode / --also-restricted', () => {
    fake(`echo "$*" >>"$HOME/argv.log"\n${CLEAN}`);
    expect(probe().status).toBe(0);
    expect(readFileSync(join(home, 'argv.log'), 'utf8').trim().split('\n')).toHaveLength(1);
    rmSync(join(home, 'argv.log'));
    const r = probe(['--also-safe-mode', '--also-restricted']);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const lines = readFileSync(join(home, 'argv.log'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(3);
    // the provider argv carries --safe-mode itself since CLI 2.1.319 (memory canary), so every variant has it
    expect(lines.filter((l) => l.includes('--safe-mode'))).toHaveLength(3);
    expect(lines.filter((l) => l.includes('--restricted'))).toHaveLength(1);
    untouched();
  });

  it('restores when interrupted mid-run (SIGTERM to the script)', () => {
    fake('cat >/dev/null\nsleep 20');
    const r = spawnSync('/bin/bash', ['-c', `${join(PROBE_ROOT, 'scripts/probe-local-cli.sh')} --yes --skip-build & p=$!; sleep 4; kill -TERM $p; wait $p`], { encoding: 'utf8', cwd: ROOT, env: penv() });
    expect(r.status).not.toBe(0);
    untouched();
  }, 30_000);

  it('restores when the child has already exited and the signal arrives (errexit must not skip restore)', () => {
    fake('cat >/dev/null\nkill -TERM $PPID\nexit 0');
    const r = probe();
    expect(r.status).not.toBe(0);
    untouched();
  });

  it('keeps an owner edit made to settings.json and CLAUDE.md during the run', () => {
    fake(`cat >/dev/null
node -e 'const fs=require("fs");const p=process.env.HOME+"/.claude/settings.json";const s=JSON.parse(fs.readFileSync(p,"utf8"));s.theme="dark";fs.writeFileSync(p,JSON.stringify(s,null,2)+"\\n")'
printf 'my new rule\\n' >>"$HOME/.claude/CLAUDE.md"
${CLEAN}`);
    const r = probe();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'))).toEqual({ model: 'x', theme: 'dark' });
    const md = readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8');
    expect(md).toContain('be nice');
    expect(md).toContain('my new rule');
    expect(md).not.toMatch(/CANARY/);
    expect(existsSync(join(cfgDir(), 'probe-backup'))).toBe(false);
    expect(lsClaude()).toEqual(['CLAUDE.md', 'settings.json']);
  });

  it('after a hard kill, the next run recovers and keeps everything created or edited afterwards', () => {
    fake('touch "$HOME/claude-started"\ncat >/dev/null\nsleep 30');
    spawnSync('/bin/bash', ['-c', `${join(PROBE_ROOT, 'scripts/probe-local-cli.sh')} --yes --skip-build >/dev/null 2>&1 & p=$!; for i in $(seq 1 100); do [ -e "$HOME/claude-started" ] && break; sleep 0.1; done; kill -9 $p; wait $p 2>/dev/null; pkill -f "$HOME/bin/claude" 2>/dev/null; true`], { encoding: 'utf8', cwd: ROOT, env: penv() });
    expect(existsSync(join(cfgDir(), 'probe-backup'))).toBe(true); // the crash left state behind
    // the owner keeps working: new skill, a later CLAUDE.md line, a new settings key (probe hook still inside)
    mkdirSync(join(home, '.claude', 'skills', 'mine'), { recursive: true });
    writeFileSync(join(home, '.claude', 'skills', 'mine', 'SKILL.md'), 'mine\n');
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8') + 'later rule\n');
    const st = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    st.theme = 'dark';
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(st, null, 2) + '\n');
    installFake(CLEAN);
    const r = probe();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readFileSync(join(home, '.claude', 'skills', 'mine', 'SKILL.md'), 'utf8')).toBe('mine\n');
    const md = readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8');
    expect(md).toContain('be nice');
    expect(md).toContain('later rule');
    expect(md).not.toMatch(/CANARY/);
    expect(JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'))).toEqual({ model: 'x', theme: 'dark' });
    expect(lsClaude()).toEqual(['CLAUDE.md', 'settings.json', 'skills']);
    expect(spawnSync('ls', ['-A', join(home, '.claude', 'skills')], { encoding: 'utf8' }).stdout.trim()).toBe('mine');
    expect(existsSync(join(cfgDir(), 'probe.lock'))).toBe(false);
  }, 40_000);

  const seedPin = () => {
    mkdirSync(cfgDir(), { recursive: true, mode: 0o700 });
    chmodSync(cfgDir(), 0o700);
    writeFileSync(join(cfgDir(), 'probe-ok'), 'version=9.9.9 (Fake)\n', { mode: 0o600 });
  };

  it('a failing probe removes an existing matching probe-ok (fail closed)', () => {
    fake(`cat >/dev/null\ncan=$(grep -h -o 'secret word is [A-Za-z0-9-]*' "$HOME/.claude/CLAUDE.md" | head -1)\nprintf '{"is_error":false,"structured_output":{"text":"I see: %s"}}' "$can"`);
    seedPin();
    const r = probe();
    expect(r.status).not.toBe(0);
    expect(existsSync(join(cfgDir(), 'probe-ok'))).toBe(false);
    untouched();
  });

  it('a startup failure after crash recovery is not a PASS (errexit survives recovery) and leaves no pin', () => {
    fake(CLEAN);
    seedPin();
    // trivial leftover backup so that recovery runs and succeeds; then planting fails on an invalid settings.json
    mkdirSync(join(cfgDir(), 'probe-backup'), { recursive: true, mode: 0o700 });
    writeFileSync(join(cfgDir(), 'probe-backup', 'runid'), 'deadbeef0000\n');
    writeFileSync(join(cfgDir(), 'probe-backup', 'created.list'), '');
    writeFileSync(join(home, '.claude', 'settings.json'), '{ not json');
    const r = probe();
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toMatch(/PASS/);
    expect(existsSync(join(cfgDir(), 'probe-ok'))).toBe(false);
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toBe('{ not json');
    expect(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe(claudeMd);
  });

  it('a restore failure at exit after a PASS removes probe-ok, prints FAIL and exits non-zero', () => {
    // the CLI itself corrupts settings.json while it runs, so the exit-time restore cannot unplant the hook
    fake(`cat >/dev/null\nprintf '{ "hooks": broken' >"$HOME/.claude/settings.json"\n${CLEAN.split('\n').slice(1).join('\n')}`);
    const r = probe();
    expect(r.stdout).toMatch(/variant default: PASS/);
    expect(r.status).not.toBe(0);
    expect(existsSync(join(cfgDir(), 'probe-ok'))).toBe(false);
    expect(r.stdout + r.stderr).toMatch(/FAIL: .*restore/i);
    expect(existsSync(join(cfgDir(), 'probe-backup', 'runid'))).toBe(true);
  });

  it('when the hook cannot be removed, the backup is kept, a fixed instruction is printed and the exit is non-zero', () => {
    fake(CLEAN);
    const bk = join(cfgDir(), 'probe-backup');
    mkdirSync(bk, { recursive: true, mode: 0o700 });
    writeFileSync(join(bk, 'runid'), 'deadbeef0000\n');
    writeFileSync(join(bk, 'created.list'), '');
    writeFileSync(join(bk, 'settings.planted'), '{"planted":true}\n');
    writeFileSync(join(home, '.claude', 'settings.json'), '{ "hooks": broken');
    const r = probe();
    expect(r.status).not.toBe(0);
    expect(existsSync(join(bk, 'runid'))).toBe(true);
    expect(r.stdout + r.stderr).toMatch(/could not remove all of its canary text/);
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toBe('{ "hooks": broken');
    expect(existsSync(join(cfgDir(), 'probe-ok'))).toBe(false);
  });

  it('refuses to start when settings.json still holds a probe hook (no backup) and changes nothing', () => {
    fake(CLEAN);
    const withHook = JSON.stringify({ model: 'x', hooks: { SessionStart: [{ hooks: [{ type: 'command', command: ': ASSISTANT_PROBE_RUN_abc123; true' }] }] } });
    writeFileSync(join(home, '.claude', 'settings.json'), withHook);
    const r = probe();
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/ASSISTANT_PROBE_RUN_/);
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toBe(withHook);
    expect(existsSync(join(cfgDir(), 'probe-backup'))).toBe(false);
  });

  it('cutting the CLAUDE.md block after an owner edit leaves no extra blank lines (repeatable)', () => {
    fake(`cat >/dev/null\nprintf 'edit\\n' >>"$HOME/.claude/CLAUDE.md"\n${CLEAN}`);
    for (let i = 0; i < 2; i++) expect(probe().status).toBe(0);
    expect(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe(`${claudeMd}edit\nedit\n`.replace('edit\nedit\n', 'edit\nedit\n'));
  });

  it('refuses a concurrent run (live lock) and touches nothing', () => {
    fake(CLEAN);
    mkdirSync(join(cfgDir(), 'probe.lock'), { recursive: true, mode: 0o700 });
    writeFileSync(join(cfgDir(), 'probe.lock', 'pid'), String(process.pid));
    const r = probe();
    expect(r.status).not.toBe(0);
    expect(r.stdout + r.stderr).toMatch(/already running/i);
    expect(existsSync(join(cfgDir(), 'probe-backup'))).toBe(false);
    expect(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toBe(claudeMd);
  });

  it('refuses to run without a claude on PATH', () => {
    fake('exit 0');
    rmSync(join(bin, "claude"));
    const r = spawnSync('/bin/bash', [join(PROBE_ROOT, 'scripts/probe-local-cli.sh'), '--yes', '--skip-build'], { encoding: 'utf8', cwd: ROOT, env: { HOME: home, PATH: '/usr/bin:/bin', USER: 'tester' } });
    expect(r.status).not.toBe(0);
    untouched();
  });
});

describe('dev.sh media branch (Gate 1 LM3, LM8, LM9; static)', () => {
  const src = readFileSync(join(ROOT, 'scripts/dev.sh'), 'utf8');
  const start = src.indexOf('if [ "${1:-}" = media ]');
  const branch = src.slice(start, src.indexOf('\nENVF=$(asst_env_file)'));
  const run = src.slice(src.indexOf('\nENVF=$(asst_env_file)'));

  it('sits before the env file is read, next to the chrome branch, and never mentions the env file', () => {
    expect(start).toBeGreaterThan(src.indexOf('if [ "${1:-}" = chrome ]'));
    expect(branch).not.toMatch(/asst_env_file|ENVF|--env-file|env\.local/);
  });

  it('LM3: mints the token like chrome, passes it by env -i only, and re-minting restarts the host relay first', () => {
    expect(branch).toContain('od -An -tx1 -N24 /dev/urandom');
    expect(branch).toMatch(/nohup env -i PATH="\$PATH" HOME="\$HOME" MEDIA_RELAY_TOKEN="\$MEDIA_RELAY_TOKEN" node dist\/media\/relay-host\.js/);
    expect(branch.indexOf('media_stop_relay  #')).toBeLessThan(branch.indexOf('docker compose -f "$MF" up'));
    expect(branch.indexOf('docker compose -f "$MF" up')).toBeLessThan(branch.indexOf('nohup env -i'));
    expect(branch).not.toMatch(/>\s*"?\$MPID"?[^\n]*MEDIA_RELAY_TOKEN|echo "?\$MEDIA_RELAY_TOKEN/);
    expect(run).not.toMatch(/MEDIA_RELAY_TOKEN/); // the app child never gets it
  });

  it('LM8: down kills the pid only when its command line is relay-host.js; the pid file is 0600 in the checked 0700 directory', () => {
    expect(branch).toMatch(/ps -p "\$pid" -o command=/);
    expect(branch).toContain('*dist/media/relay-host.js*)');
    expect(branch).toContain('umask 077');
    expect(branch).toContain('asst_check_dir "$MDIR"');
  });

  it('LM8: the app child gets MEDIA_SOCKET only when the socket and its directory pass the checks', () => {
    expect(run).toMatch(/-S "\$MEDIA_DIR\/media\.sock" \] && \[ ! -L .*_asst_uid .*asst_check_dir "\$MEDIA_DIR"[^\n]*; then\n\s+CHILD_ENV\[\$\{#CHILD_ENV\[@\]\}\]="MEDIA_SOCKET=/);
  });

  it('LM9: builds with the legacy builder when the image is missing or its hash label differs', () => {
    expect(branch).toContain('DOCKER_BUILDKIT=0 docker build -f deploy/Dockerfile -t "$MIMG" --label "lw.media.build-sha256=$WANT"');
    expect(branch).toContain('[ "$HAVE" != "$WANT" ]');
  });

  it('an unknown action prints usage and exits 2 without touching HOME', () => {
    const r = sh('scripts/dev.sh', ['media', 'bogus']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('usage: dev.sh media up|down');
  });

  it('package.json has the two scripts', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts;
    expect(pkg['local:media']).toBe('bash scripts/dev.sh media up');
    expect(pkg['local:media:down']).toBe('bash scripts/dev.sh media down');
  });
});

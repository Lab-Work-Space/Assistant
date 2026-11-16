import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/** OD-1 installer, exercised in dry mode (LWADMIN_DRY=1: no root, no dscl, no launchctl; files land under LWADMIN_ROOT). */
const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts/executor-service.sh');
const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));
const mode = (p: string) => statSync(p).mode & 0o777;
const HOSTKEY = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'B'.repeat(43)}`;

function world() {
  const root = mkdtempSync(join(tmpdir(), 'lwa-'));
  tmp.push(root);
  const src = join(root, 'src');
  mkdirSync(join(src, 'dist/executor'), { recursive: true });
  writeFileSync(join(src, 'dist/executor/main.js'), '// main');
  mkdirSync(join(src, 'node_modules/x'), { recursive: true });
  writeFileSync(join(src, 'node_modules/x/index.js'), '1');
  writeFileSync(join(src, 'package.json'), '{}');
  const home = join(root, 'ownerhome');
  const asst = join(home, '.config/assistant');
  mkdirSync(asst, { recursive: true });
  writeFileSync(join(asst, 'env.admin'), `BOT_TOKEN_ADMIN=${'A'.repeat(24)}.${'b'.repeat(6)}.${'c'.repeat(30)}\nDATABASE_URL=postgres://owner:pw@127.0.0.1:5432/db\nBOT_ADMIN_ROLE_ID=123456789012345678\nGUILD_ID=1565649426943442944\n`);
  writeFileSync(join(asst, '.lwadmin-db-url'), 'DATABASE_URL=postgres://lw_executor:secretpw@127.0.0.1:5432/db\n');
  writeFileSync(join(asst, 'executor.sock'), 'stale');
  const env = { PATH: process.env.PATH!, LWADMIN_DRY: '1', LWADMIN_ROOT: join(root, 'fs'), LWADMIN_SRC: src, LWADMIN_OWNER: 'owner', LWADMIN_OWNER_HOME: home, HOME: home };
  const run = (args: string[], input = '') => spawnSync('/bin/bash', [SCRIPT, ...args], { input, encoding: 'utf8', env, timeout: 60_000 });
  return { root, fs: join(root, 'fs'), asst, home, run };
}

describe('executor-service.sh closure report (G2SC-07) and import (G2SC-02)', () => {
  it('fails closed: a previous install exists, the commit cannot be read, so nothing is installed', () => {
    const w = world();
    mkdirSync(join(w.fs, 'usr/local/lib/lwadmin'), { recursive: true });
    writeFileSync(join(w.fs, 'usr/local/lib/lwadmin/installed-commit'), `${'a'.repeat(40)}\n`);
    const r = w.run(['install', '--node', '/bin/sh']);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/closure report cannot run/);
    expect(existsSync(join(w.fs, 'usr/local/lib/lwadmin/dist'))).toBe(false);
  });
  it('G2SC-12 export: never overwrites; a planted symlink or an existing file fails and its target is untouched; root does not chmod', () => {
    const w = world();
    const priv = join(w.fs, 'var/lwadmin/private');
    mkdirSync(priv, { recursive: true });
    const code = join(w.root, 'code');
    mkdirSync(code, { recursive: true });
    const git = (...a: string[]) => spawnSync('git', a, { encoding: 'utf8', env: { PATH: process.env.PATH!, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a' } });
    git('init', '-q', '--bare', '-b', 'main', join(code, 'repo.git'));
    const work = join(w.root, 'work');
    git('init', '-q', '-b', 'main', work);
    writeFileSync(join(work, 'f'), '1');
    git('-C', work, 'add', '.'); git('-C', work, 'commit', '-q', '-m', 'one'); git('-C', work, 'push', '-q', join(code, 'repo.git'), 'main:main');
    writeFileSync(join(priv, 'env.admin'), `LW_CODE_ROOT=${code}\n`);
    // a symlink planted at the owner-chosen path points at a file that must not change
    const victim = join(w.root, 'victim');
    writeFileSync(victim, 'precious');
    const link = join(w.root, 'out.bundle');
    symlinkSync(victim, link);
    const bad = w.run(['export', '--out', link]);
    expect(bad.status).not.toBe(0);
    expect(readFileSync(victim, 'utf8')).toBe('precious');
    const dangling = join(w.root, 'dangling.bundle');
    symlinkSync(join(w.root, 'nowhere'), dangling);
    expect(w.run(['export', '--out', dangling]).status).not.toBe(0);
    expect(existsSync(join(w.root, 'nowhere'))).toBe(false);
    const fresh = join(w.root, 'fresh.bundle');
    const ok = w.run(['export', '--out', fresh]);
    expect(ok.status, ok.stderr).toBe(0);
    expect(readFileSync(fresh).subarray(0, 24).toString()).toContain('git bundle');
    expect(w.run(['export', '--out', fresh]).status).not.toBe(0); // no clobber
    expect(readFileSync(SCRIPT, 'utf8')).not.toMatch(/chmod 644 "\$out"/);
  });
  it('release needs the code settings in env.admin', () => {
    const w = world();
    const r = w.run(['release']);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/must be set in/);
  });
  it('import needs a bundle and refuses without LW_CODE_ROOT', () => {
    const w = world();
    expect(w.run(['import']).status).not.toBe(0);
    writeFileSync(join(w.root, 'b.bundle'), 'x');
    const r = w.run(['import', '--bundle', join(w.root, 'b.bundle')]);
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/LW_CODE_ROOT is not set/);
  });
});

describe('executor-service.sh', () => {
  it('passes bash -n under /bin/bash (3.2 on macOS)', () => {
    const r = spawnSync('/bin/bash', ['-n', SCRIPT], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it('refuses to run without root outside dry mode, and refuses an unknown command', () => {
    const r = spawnSync('/bin/bash', [SCRIPT, 'install'], { encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: '/tmp' } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/sudo|owner/);
    expect(spawnSync('/bin/bash', [SCRIPT, 'frobnicate'], { encoding: 'utf8' }).status).toBe(64);
  });

  it('install: modes, ownership plan, plist, env.admin from the old file + the lw_executor URL, key line, old file removed', () => {
    const w = world();
    const r = w.run(['install', '--node', '/bin/sh', '--host-key-file', writeHost(w.root)]);
    expect(r.status, r.stderr + r.stdout).toBe(0);
    const priv = join(w.fs, 'var/lwadmin/private');
    expect(mode(join(w.fs, 'var/lwadmin'))).toBe(0o711);
    expect(mode(priv)).toBe(0o700);
    expect(mode(join(priv, 'env.admin'))).toBe(0o600);
    expect(mode(join(priv, 'deploy/id_ed25519'))).toBe(0o600);
    expect(mode(join(priv, 'deploy/known_hosts'))).toBe(0o600);
    expect(mode(join(w.fs, 'var/lwadmin/run'))).toBe(0o750);
    const env = readFileSync(join(priv, 'env.admin'), 'utf8');
    expect(env).toContain('BOT_TOKEN_ADMIN=');
    expect(env).toContain('DATABASE_URL=postgres://lw_executor:secretpw@');
    expect(env).not.toContain('owner:pw');
    expect(env.split('\n').filter(Boolean).map((l) => l.split('=')[0])).toEqual(['BOT_TOKEN_ADMIN', 'BOT_ADMIN_ROLE_ID', 'GUILD_ID', 'DATABASE_URL']);
    expect(existsSync(join(w.asst, 'env.admin'))).toBe(false); // the owner's uid no longer holds the token
    expect(existsSync(join(w.asst, '.lwadmin-db-url'))).toBe(false);
    expect(existsSync(join(w.asst, 'executor.sock'))).toBe(false);
    expect(readFileSync(join(w.asst, 'admin-token.sha256'), 'utf8')).toMatch(/^[0-9a-f]{64}\n$/);
    expect(readFileSync(join(priv, 'deploy/known_hosts'), 'utf8')).toBe(`[72.60.196.53]:2223 ${HOSTKEY}\n`);
    const plist = readFileSync(join(w.fs, 'Library/LaunchDaemons/net.labworkspace.lwadmin.plist'), 'utf8');
    for (const s of ['<string>_lwadmin</string>', '<string>_lwadmin_ipc</string>', '/usr/local/lib/lwadmin/dist/executor/main.js', '--env-file=/var/lwadmin/private/env.admin', 'EXECUTOR_SOCKET_SHARED', '/var/lwadmin/run/executor.sock', 'LW_DEPLOY_SSH_KEY_PATH', '<key>KeepAlive</key><true/>']) expect(plist).toContain(s);
    expect(plist).not.toContain('BOT_TOKEN');
    expect(plist).not.toMatch(/\/Users\//);
    expect(r.stdout).toMatch(/restrict,expiry-time="\d{8}",command="\/usr\/local\/bin\/lw-assistant-relay" ssh-ed25519 \S+ assistant-deploy-\d{8}/);
    expect(existsSync(join(w.fs, 'usr/local/lib/lwadmin/dist/executor/main.js'))).toBe(true);
  });

  it('install refuses the owner\'s own database role, a missing token and a missing build', () => {
    const w = world();
    writeFileSync(join(w.asst, '.lwadmin-db-url'), 'DATABASE_URL=postgres://owner:pw@127.0.0.1:5432/db\n');
    const r = w.run(['install', '--node', '/bin/sh']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/lw_executor/);
    expect(existsSync(join(w.fs, 'var/lwadmin/private/env.admin'))).toBe(false);
    const w2 = world();
    rmSync(join(w2.asst, 'env.admin'));
    expect(w2.run(['install', '--node', '/bin/sh']).stderr).toMatch(/set-tokens/);
    const w3 = world();
    rmSync(join(w3.root, 'src/dist'), { recursive: true });
    expect(w3.run(['install', '--node', '/bin/sh']).stderr).toMatch(/npm run build/);
  });

  it('creates the identity before it checks that the service user can run node (the check needs the user)', () => {
    const t = readFileSync(SCRIPT, 'utf8');
    const install = t.slice(t.indexOf('cmd_install() {'));
    expect(install.indexOf('ensure_identity "$owner"')).toBeGreaterThan(0);
    expect(install.indexOf('ensure_identity "$owner"')).toBeLessThan(install.indexOf('node=$(pick_node'));
    const w = world();
    const r = w.run(['install', '--node', '/bin/sh']);
    expect(r.stdout.indexOf('create group _lwadmin_ipc')).toBeGreaterThanOrEqual(0);
  });
  it('refuses a node inside a home directory and a malformed host key', () => {
    const w = world();
    mkdirSync(join(w.root, 'x'));
    expect(w.run(['install', '--node', '/Users/someone/node']).stderr).toMatch(/not|inside|found/);
    const bad = join(w.root, 'bad.pub');
    writeFileSync(bad, 'ssh-rsa AAAA nope\n');
    const r = w.run(['install', '--node', '/bin/sh', '--host-key-file', bad]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/host key line/);
  });

  it('install twice keeps the key and env.admin (idempotent); rotate-key replaces the key and prints a new line', () => {
    const w = world();
    expect(w.run(['install', '--node', '/bin/sh']).status).toBe(0);
    const key = readFileSync(join(w.fs, 'var/lwadmin/private/deploy/id_ed25519'), 'utf8');
    const env = readFileSync(join(w.fs, 'var/lwadmin/private/env.admin'), 'utf8');
    expect(w.run(['install', '--node', '/bin/sh']).status).toBe(0);
    expect(readFileSync(join(w.fs, 'var/lwadmin/private/deploy/id_ed25519'), 'utf8')).toBe(key);
    expect(readFileSync(join(w.fs, 'var/lwadmin/private/env.admin'), 'utf8')).toBe(env);
    const r = w.run(['rotate-key']);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(join(w.fs, 'var/lwadmin/private/deploy/id_ed25519'), 'utf8')).not.toBe(key);
    expect(r.stdout).toMatch(/restrict,expiry-time=/);
  });

  it('uninstall removes the job and the code; --purge also the data', () => {
    const w = world();
    w.run(['install', '--node', '/bin/sh']);
    expect(w.run(['uninstall']).status).toBe(0);
    expect(existsSync(join(w.fs, 'Library/LaunchDaemons/net.labworkspace.lwadmin.plist'))).toBe(false);
    expect(existsSync(join(w.fs, 'usr/local/lib/lwadmin'))).toBe(false);
    expect(existsSync(join(w.fs, 'var/lwadmin/private/env.admin'))).toBe(true);
    expect(w.run(['uninstall', '--purge']).status).toBe(0);
    expect(existsSync(join(w.fs, 'var/lwadmin'))).toBe(false);
  });

  it('status prints modes without needing root', () => {
    const w = world();
    w.run(['install', '--node', '/bin/sh']);
    const r = w.run(['status']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/env.admin: mode 600/);
    expect(r.stdout).toMatch(/id_ed25519: mode 600/);
  });
});

describe('the rest of the tooling follows the job (OD-1)', () => {
  it('set-tokens ADMIN refuses while the launchd job is installed and points at the sudo command', () => {
    const home = mkdtempSync(join(tmpdir(), 'lwh-'));
    tmp.push(home);
    const r = spawnSync('/bin/bash', [join(ROOT, 'scripts/set-tokens.sh'), '--local', 'ADMIN'], { encoding: 'utf8', input: '', env: { PATH: process.env.PATH!, HOME: home, LWADMIN_PLIST: '/bin/sh' } });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/sudo bash scripts\/executor-service\.sh set-token/);
  });
  it('dev.sh starts no executor when the job is installed: the guard sits before the dev executor block and execs the app only', () => {
    const t = readFileSync(join(ROOT, 'scripts/dev.sh'), 'utf8');
    const guard = t.indexOf('if [ -e "$LWADMIN_PLIST" ]; then');
    const devStart = t.indexOf('node --env-file="$ADMINF" dist/executor/main.js');
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(devStart);
    const block = t.slice(guard, t.indexOf('fi', guard));
    expect(block).toContain('EXECUTOR_SOCKET=');
    expect(block).toContain('exec env -i');
    expect(block).not.toContain('executor/main.js');
  });
});

function writeHost(dir: string): string {
  const f = join(dir, 'host.pub');
  writeFileSync(f, `${HOSTKEY}\n`);
  chmodSync(f, 0o600);
  return f;
}

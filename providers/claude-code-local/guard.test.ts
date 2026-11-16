import { describe, expect, it } from 'vitest';
import { argvDigest } from './protocol.js';
import { envFilesOf, inContainer, localOffByOwner, localProviderAllowed, type GuardEnv, type GuardExec, type GuardFs } from './guard.js';

const HOME = '/Users/owner';
const CLAUDE = '/Users/owner/.local/bin/claude';
const PIN = '/Users/owner/.config/assistant/probe-ok';
const VERSION = '2.1.314 (Claude Code)';
const SHA = 'a'.repeat(64);
const pinText = (o: { version?: string; realpath?: string; sha256?: string; argv?: string | null } = {}) =>
  `version=${o.version ?? VERSION}\nrealpath=${o.realpath ?? CLAUDE}\nsha256=${o.sha256 ?? SHA}\n${o.argv === null ? '' : `argv_sha256=${o.argv ?? argvDigest()}\n`}checked=2026-10-31T00:00:00Z\n`;

const env = (over: Partial<GuardEnv> = {}, vars: Record<string, string | undefined> = {}): GuardEnv => ({
  vars: { ALLOW_LOCAL_PROVIDERS: '1', PATH: '/usr/bin:/Users/owner/.local/bin', HOME, ...vars },
  platform: 'darwin',
  execArgv: [],
  home: HOME,
  ...over,
});

/** In-memory fs: `files` holds readable text files, `exes` the executable paths. */
function fakeFs(o: { files?: Record<string, string>; exes?: string[]; unsafe?: boolean; unreadable?: string[]; pinNotOwnerOnly?: boolean; noPin?: boolean; sha?: string; realpath?: string } = {}): GuardFs {
  const files: Record<string, string> = { ...(o.noPin ? {} : { [PIN]: pinText() }), ...(o.files ?? {}) };
  const exes = new Set(o.exes ?? [CLAUDE]);
  return {
    exists: (p) => Object.hasOwn(files, p) || exes.has(p),
    readFile: (p) => {
      if (o.unreadable?.includes(p)) throw new Error('EACCES');
      return Object.hasOwn(files, p) ? files[p]! : null;
    },
    isExecutable: (p) => exes.has(p),
    isOwnerOnlyFile: (p) => Object.hasOwn(files, p) && !o.pinNotOwnerOnly,
    resolveClaude: (p) => {
      if (o.unsafe) throw new Error('claude-code-local: claude binary is group- or world-writable');
      return o.realpath ?? p;
    },
    sha256: async () => o.sha ?? SHA,
  };
}

function fakeExec(code: number | null = 0, stdout = `${VERSION}\n`) {
  const calls: { file: string; args: string[]; env: Record<string, string> }[] = [];
  const exec: GuardExec = async (file, args, e) => {
    calls.push({ file, args, env: e });
    return { code, stdout };
  };
  return { exec, calls };
}

const refused = async (p: Promise<{ ok: boolean }>) => {
  const r = await p;
  expect(r.ok).toBe(false);
  return r as { ok: false; reason: string };
};

describe('localProviderAllowed (spec §4.4, Gate 1 L9)', () => {
  it('allows on the owner Mac: flag from the process env, darwin, no container, claude --version exits 0', async () => {
    const x = fakeExec(0);
    const r = await localProviderAllowed(env({}, { ANTHROPIC_API_KEY: 'sk-secret', DISCORD_TOKEN: 't' }), fakeFs(), x.exec);
    expect(r).toEqual({ ok: true, claudePath: CLAUDE });
    expect(x.calls).toEqual([{ file: CLAUDE, args: ['--version'], env: { PATH: '/usr/bin:/Users/owner/.local/bin', HOME } }]);
  });

  it('guard refuses on linux / container / missing flag / missing cli', async () => {
    const x = fakeExec(0);
    expect((await refused(localProviderAllowed(env({ platform: 'linux' }), fakeFs(), x.exec))).reason).toMatch(/darwin/);
    expect((await refused(localProviderAllowed(env(), fakeFs({ files: { '/.dockerenv': '' } }), x.exec))).reason).toMatch(/container/);
    for (const cg of ['12:pids:/docker/abc', '0::/system.slice/containerd.service', '1:name=systemd:/kubepods/x'])
      expect((await refused(localProviderAllowed(env(), fakeFs({ files: { '/proc/1/cgroup': cg } }), x.exec))).reason).toMatch(/container/);
    for (const v of [undefined, '', '0', 'true', ' 1'])
      expect((await refused(localProviderAllowed(env({}, { ALLOW_LOCAL_PROVIDERS: v }), fakeFs(), x.exec))).reason).toMatch(/ALLOW_LOCAL_PROVIDERS/);
    expect((await refused(localProviderAllowed(env(), fakeFs({ exes: [] }), x.exec))).reason).toMatch(/not found/);
    expect(x.calls).toEqual([]); // nothing is executed before every static check passed
    expect((await refused(localProviderAllowed(env(), fakeFs(), fakeExec(1).exec))).reason).toMatch(/--version/);
    expect((await refused(localProviderAllowed(env(), fakeFs(), fakeExec(null).exec))).reason).toMatch(/--version/);
    const throwing: GuardExec = async () => { throw new Error('spawn ENOENT secret-path'); };
    const r = await refused(localProviderAllowed(env(), fakeFs(), throwing));
    expect(r.reason).toMatch(/--version/);
    expect(r.reason).not.toContain('secret-path');
  });

  it('inContainer › the guard\'s container cases, unchanged (R5): .dockerenv, a container cgroup, an unreadable cgroup; null otherwise', () => {
    expect(inContainer(fakeFs({ files: { '/.dockerenv': '' } }))).toBe('running in a container');
    for (const cg of ['12:pids:/docker/abc', '0::/system.slice/containerd.service', '1:name=systemd:/kubepods/x', '0::/machine.slice/libpod-1', '1:lxc'])
      expect(inContainer(fakeFs({ files: { '/proc/1/cgroup': cg } }))).toBe('running in a container');
    expect(inContainer(fakeFs({ unreadable: ['/proc/1/cgroup'] }))).toBe('running in a container (cgroup unreadable)');
    expect(inContainer(fakeFs())).toBeNull(); // the owner Mac: no /.dockerenv, no /proc/1/cgroup
    expect(inContainer(fakeFs({ files: { '/proc/1/cgroup': '0::/user.slice' } }))).toBeNull();
  });

  it('/proc/1/cgroup present without a container runtime is fine', async () => {
    const r = await localProviderAllowed(env(), fakeFs({ files: { '/proc/1/cgroup': '0::/user.slice' } }), fakeExec(0).exec);
    expect(r.ok).toBe(true);
  });

  it('a writable claude path is refused before it runs', async () => {
    const x = fakeExec(0);
    expect((await refused(localProviderAllowed(env(), fakeFs({ unsafe: true }), x.exec))).reason).toMatch(/unsafe/);
    expect(x.calls).toEqual([]);
  });

  it('PATH lookup takes the first executable claude in an absolute PATH entry', async () => {
    const first = '/opt/homebrew/bin/claude';
    const r = await localProviderAllowed(
      env({}, { PATH: 'relative/bin::/opt/homebrew/bin:/Users/owner/.local/bin' }),
      fakeFs({ exes: [first, CLAUDE, 'relative/bin/claude'], files: { [PIN]: pinText({ realpath: first }) } }),
      fakeExec(0).exec,
    );
    expect(r).toEqual({ ok: true, claudePath: first });
  });

  it('flag also defined in a loaded env file is refused (only the process env may set it)', async () => {
    const file = '/Users/owner/.config/assistant/env.local';
    for (const line of ['ALLOW_LOCAL_PROVIDERS=1', 'export ALLOW_LOCAL_PROVIDERS=1', '  ALLOW_LOCAL_PROVIDERS = "1"'])
      expect((await refused(localProviderAllowed(env(), fakeFs({ files: { [file]: `DATABASE_URL=x\n${line}\n` } }), fakeExec(0).exec))).reason).toMatch(/env file/);
    // A file passed with --env-file counts too; a comment does not define it.
    const other = '/tmp/x.env';
    expect((await refused(localProviderAllowed(env({ execArgv: [`--env-file=${other}`] }), fakeFs({ files: { [other]: 'ALLOW_LOCAL_PROVIDERS=1' } }), fakeExec(0).exec))).ok).toBe(false);
    expect((await localProviderAllowed(env(), fakeFs({ files: { [file]: '# ALLOW_LOCAL_PROVIDERS=1\nX_ALLOW_LOCAL_PROVIDERS=1\n' } }), fakeExec(0).exec)).ok).toBe(true);
    // An env file that exists but cannot be read fails closed.
    expect((await refused(localProviderAllowed(env(), fakeFs({ unreadable: [file] }), fakeExec(0).exec))).reason).toMatch(/env file/);
  });

  it('envFilesOf lists the L10 env file and every --env-file / --env-file-if-exists argument', () => {
    expect(envFilesOf(['--env-file=/a.env', '--env-file', '/b.env', '--env-file-if-exists=/c.env', '--inspect'], HOME)).toEqual([
      '/Users/owner/.config/assistant/env.local', '/a.env', '/b.env', '/c.env',
    ]);
  });
});

describe('owner switch ASSISTANT_LOCAL_PROVIDER_OFF (LOCAL-OFF-1)', () => {
  it('is refused with a fixed reason, NO code (no incident), and spawns nothing', async () => {
    const x = fakeExec();
    const r = await localProviderAllowed(env({}, { ASSISTANT_LOCAL_PROVIDER_OFF: '1' }), fakeFs(), x.exec);
    expect(r).toEqual({ ok: false, reason: 'the local provider is turned off by the owner' });
    expect(x.calls).toHaveLength(0);
  });
  it('only the exact value 1 counts; localOffByOwner reads the process env', () => {
    expect(localOffByOwner(env({}, { ASSISTANT_LOCAL_PROVIDER_OFF: '1' }))).toBe(true);
    for (const v of ['0', 'true', '', undefined]) expect(localOffByOwner(env({}, { ASSISTANT_LOCAL_PROVIDER_OFF: v }))).toBe(false);
  });
  it('without the owner switch the guard is unchanged (allowed)', async () => {
    expect((await localProviderAllowed(env(), fakeFs(), fakeExec().exec)).ok).toBe(true);
  });
});

describe('probe pin (R-L9) binds the claude binary identity (VPS-free VULN-L-002)', () => {
  const REAL = '/Users/owner/.local/share/claude/versions/2.1.314/claude';
  it('all of version, realpath and sha256 match → allowed', async () => {
    const r = await localProviderAllowed(env(), fakeFs({ realpath: REAL, files: { [PIN]: pinText({ realpath: REAL }) } }), fakeExec(0).exec);
    expect(r).toEqual({ ok: true, claudePath: REAL });
  });
  it('realpath mismatch (another claude printing the same version) → absent', async () => {
    const r = await refused(localProviderAllowed(env(), fakeFs({ realpath: '/tmp/evil/claude' }), fakeExec(0).exec));
    expect(r.reason).toMatch(/probe/);
    expect(r.reason).not.toContain('evil');
  });
  it('sha256 mismatch (binary replaced in place) → absent', async () => {
    expect((await refused(localProviderAllowed(env(), fakeFs({ sha: 'b'.repeat(64) }), fakeExec(0).exec))).reason).toMatch(/probe/);
  });
  it('old-format pin (version only) → absent with a fixed re-run reason', async () => {
    const r = await refused(localProviderAllowed(env(), fakeFs({ files: { [PIN]: `version=${VERSION}\nchecked=x\n` } }), fakeExec(0).exec));
    expect(r.reason).toBe('the probe pin is in an old format; run: bash scripts/probe-local-cli.sh --yes');
  });
  it('S16: a pin without argv_sha256 (written before STREAM-1) is refused and tells the owner the exact command', async () => {
    const r = await refused(localProviderAllowed(env(), fakeFs({ files: { [PIN]: pinText({ argv: null }) } }), fakeExec(0).exec));
    expect(r.reason).toContain('bash scripts/probe-local-cli.sh --yes');
    expect(r.reason).toMatch(/old format/);
  });
  it('S16: a pin whose argv_sha256 differs (buildArgs changed since the probe) is refused with the exact command', async () => {
    for (const bad of ['b'.repeat(64), 'zz', argvDigest().slice(1)]) {
      const r = await refused(localProviderAllowed(env(), fakeFs({ files: { [PIN]: pinText({ argv: bad }) } }), fakeExec(0).exec));
      expect(r.reason).toContain('bash scripts/probe-local-cli.sh --yes');
    }
  });
  it('S16: the current argvDigest (any case) is accepted', async () => {
    const r = await localProviderAllowed(env(), fakeFs({ files: { [PIN]: pinText({ argv: argvDigest().toUpperCase() }) } }), fakeExec(0).exec);
    expect(r.ok).toBe(true);
  });
  it('S16: every pin failure message names the re-probe command', async () => {
    const cases = [fakeFs({ noPin: true }), fakeFs({ sha: 'b'.repeat(64) }), fakeFs({ files: { [PIN]: 'checked=x\n' } }), fakeFs({ pinNotOwnerOnly: true })];
    for (const fs of cases) expect((await refused(localProviderAllowed(env(), fs, fakeExec(0).exec))).reason).toContain('bash scripts/probe-local-cli.sh --yes');
    expect((await refused(localProviderAllowed(env(), fakeFs(), fakeExec(0, '2.2.0 (Claude Code)\n').exec))).reason).toContain('bash scripts/probe-local-cli.sh --yes');
  });
  it('an unreadable binary (hash fails) → absent, without leaking the error', async () => {
    const fs = fakeFs();
    fs.sha256 = async () => { throw new Error('EACCES /secret'); };
    const r = await refused(localProviderAllowed(env(), fs, fakeExec(0).exec));
    expect(r.reason).toMatch(/probe/);
    expect(r.reason).not.toContain('secret');
  });
  it('ASSISTANT_SKIP_PROBE_PIN=1 still bypasses the identity check', async () => {
    const r = await localProviderAllowed(env({}, { ASSISTANT_SKIP_PROBE_PIN: '1' }), fakeFs({ sha: 'c'.repeat(64) }), fakeExec(0).exec);
    expect(r.ok).toBe(true);
  });
});

describe('probe pin (R-L9)', () => {
  it('version mismatch → provider absent', async () => {
    const r = await refused(localProviderAllowed(env(), fakeFs(), fakeExec(0, '2.2.0 (Claude Code)\n').exec));
    expect(r.reason).toMatch(/probe/);
    expect(r.reason).not.toContain('2.2.0');
  });
  it('missing probe-ok → absent', async () => {
    expect((await refused(localProviderAllowed(env(), fakeFs({ noPin: true }), fakeExec(0).exec))).reason).toMatch(/probe/);
  });
  it('probe-ok that is not owner-only (mode/owner/symlink) → absent', async () => {
    expect((await refused(localProviderAllowed(env(), fakeFs({ pinNotOwnerOnly: true }), fakeExec(0).exec))).reason).toMatch(/probe/);
  });
  it('probe-ok without a version line → absent', async () => {
    expect((await refused(localProviderAllowed(env(), fakeFs({ files: { [PIN]: 'checked=x\n' } }), fakeExec(0).exec))).reason).toMatch(/probe/);
  });
  it('override ASSISTANT_SKIP_PROBE_PIN=1 from the process env: allowed with a warning, even without probe-ok', async () => {
    const r = await localProviderAllowed(env({}, { ASSISTANT_SKIP_PROBE_PIN: '1' }), fakeFs({ noPin: true }), fakeExec(0, '9.9.9\n').exec);
    expect(r.ok).toBe(true);
    expect((r as { warnings?: string[] }).warnings?.join(' ')).toMatch(/ASSISTANT_SKIP_PROBE_PIN/);
  });
  it('override does not work when an env file defines it', async () => {
    const file = '/Users/owner/.config/assistant/env.local';
    const r = await refused(localProviderAllowed(env({}, { ASSISTANT_SKIP_PROBE_PIN: '1' }), fakeFs({ noPin: true, files: { [file]: 'ASSISTANT_SKIP_PROBE_PIN=1\n' } }), fakeExec(0).exec));
    expect(r.reason).toMatch(/ASSISTANT_SKIP_PROBE_PIN/);
    for (const v of ['0', 'true', ' 1', '']) expect((await localProviderAllowed(env({}, { ASSISTANT_SKIP_PROBE_PIN: v }), fakeFs({ noPin: true }), fakeExec(0).exec)).ok).toBe(false);
  });
});

describe('loopback only (L10)', () => {
  it('DATABASE_URL host 10.0.0.5 refused', async () => {
    const r = await refused(localProviderAllowed(env({}, { DATABASE_URL: 'postgres://assistant:pw@10.0.0.5:5432/assistant' }), fakeFs(), fakeExec(0).exec));
    expect(r.reason).toMatch(/DATABASE_URL/);
    expect(r.reason).not.toContain('10.0.0.5');
    expect(r.reason).not.toContain('pw');
  });
  it('DATABASE_URL: 127.0.0.1, localhost and [::1] allowed; unparsable and empty host refused', async () => {
    for (const u of ['postgres://a:b@127.0.0.1:54330/x', 'postgres://a:b@localhost/x', 'postgres://a:b@[::1]:1/x'])
      expect((await localProviderAllowed(env({}, { DATABASE_URL: u }), fakeFs(), fakeExec(0).exec)).ok).toBe(true);
    for (const u of ['not a url', 'postgres:///x', 'postgres://a:b@db.example.com/x', 'postgres://a:b@127.0.0.1.evil.com/x'])
      expect((await localProviderAllowed(env({}, { DATABASE_URL: u }), fakeFs(), fakeExec(0).exec)).ok).toBe(false);
  });
  it('DATABASE_URL ?host= / ?hostaddr= overriding to a non-loopback host or a socket path is refused', async () => {
    for (const q of ['?host=10.0.0.5', '?hostaddr=10.0.0.5', '?host=/tmp/pgsock', '?host=localhost,10.0.0.5', '?sslmode=disable&host=db.example.com'])
      expect((await localProviderAllowed(env({}, { DATABASE_URL: `postgres://a:b@127.0.0.1/x${q}` }), fakeFs(), fakeExec(0).exec)).ok, q).toBe(false);
    expect((await localProviderAllowed(env({}, { DATABASE_URL: 'postgres://a:b@127.0.0.1/x?host=localhost&sslmode=disable' }), fakeFs(), fakeExec(0).exec)).ok).toBe(true);
    expect((await localProviderAllowed(env({}, { PGHOST: '10.0.0.5' }), fakeFs(), fakeExec(0).exec)).ok).toBe(false);
  });
  it('HEALTH_HOST 0.0.0.0 refused; only 127.0.0.1 allowed; unset allowed', async () => {
    expect((await refused(localProviderAllowed(env({}, { HEALTH_HOST: '0.0.0.0' }), fakeFs(), fakeExec(0).exec))).reason).toMatch(/HEALTH_HOST/);
    expect((await localProviderAllowed(env({}, { HEALTH_HOST: '127.0.0.1' }), fakeFs(), fakeExec(0).exec)).ok).toBe(true);
    // core/env.ts accepts only an IPv4 address, so only that loopback value is allowed here
    for (const h of ['localhost', '::1', '127.0.0.2'])
      expect((await localProviderAllowed(env({}, { HEALTH_HOST: h }), fakeFs(), fakeExec(0).exec)).ok, h).toBe(false);
  });
});

describe('nodeGuardFs.isOwnerOnlyFile on real files', () => {
  it('accepts 0600 in 0700; refuses 0644, 0755 dir, symlink and missing', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, symlinkSync, mkdirSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { nodeGuardFs } = await import('./guard.js');
    const root = mkdtempSync(join(tmpdir(), 'guard-fs-'));
    try {
      const dir = join(root, 'cfg');
      mkdirSync(dir, { mode: 0o700 });
      const f = join(dir, 'probe-ok');
      writeFileSync(f, 'version=1\n', { mode: 0o600 });
      expect(nodeGuardFs.isOwnerOnlyFile(f)).toBe(true);
      chmodSync(f, 0o644);
      expect(nodeGuardFs.isOwnerOnlyFile(f)).toBe(false);
      chmodSync(f, 0o600);
      chmodSync(dir, 0o755);
      expect(nodeGuardFs.isOwnerOnlyFile(f)).toBe(false);
      chmodSync(dir, 0o700);
      const link = join(dir, 'link');
      symlinkSync(f, link);
      expect(nodeGuardFs.isOwnerOnlyFile(link)).toBe(false);
      expect(nodeGuardFs.isOwnerOnlyFile(join(dir, 'nope'))).toBe(false);
      expect(nodeGuardFs.isOwnerOnlyFile('/private/etc/hosts')).toBe(false); // root-owned
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

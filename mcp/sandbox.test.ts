import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { McpError } from './errors.js';
import { StuckLatch, buildMcpArgv, checkImage, realMcpSpawner, withSandbox, SANDBOX_NAME, type SandboxDeps } from './sandbox.js';
import { FakeMcpDocker, fixtureSpawner } from './test-helpers.js';

const IMG = `sha256:${'c'.repeat(64)}`;
const NAME = 'mcp-srv-abcdef01';
const code = async (p: Promise<unknown>): Promise<string | undefined> => { try { await p; } catch (e) { return e instanceof McpError ? e.code : `other:${String(e)}`; } return undefined; };

describe('MCP-AC09 / MC-C2 / MC-C3 / MC-C16: the argv golden (spec 3.5 as amended)', () => {
  it('matches exactly: the spec argv plus --no-healthcheck, --hostname mcp, --cgroupns=private and --ulimit nofile=256:256', () => {
    expect(buildMcpArgv({ name: NAME, slug: 'srv', image: IMG, command: ['node', '/app/s.js'], env: { MODE: 'fast', LEVEL: '3' } })).toEqual([
      'run', '-i', '--init', '--pull=never', '--log-driver=none', '--no-healthcheck', '--ulimit', 'core=0', '--ulimit', 'nofile=256:256',
      '--name', NAME, '--label', 'mcp=1', '--label', 'mcp.server=srv', '--hostname', 'mcp', '--user', '65534:65534', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--cgroupns=private',
      '--pids-limit', '64', '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=64m', '--network', 'none', '--ipc', 'none',
      '-e', 'LEVEL=3', '-e', 'MODE=fast', IMG, 'node', '/app/s.js',
    ]);
  });
  it('no -v, --mount, --privileged, --entrypoint, --env-file, --volume or --device flag; the only --security-opt is no-new-privileges; no seccomp=unconfined', () => {
    const a = buildMcpArgv({ name: NAME, slug: 'srv', image: IMG, command: [], env: {} });
    for (const bad of ['-v', '--mount', '--privileged', '--entrypoint', '--env-file', '--volume', '--device', '--cap-add', '--pid', '--userns', '--network=host']) expect(a.includes(bad), bad).toBe(false);
    expect(a.filter((x) => x.startsWith('--security-opt'))).toEqual(['--security-opt=no-new-privileges']);
    expect(a.join(' ')).not.toMatch(/unconfined|seccomp/);
    expect(a[a.indexOf('--network') + 1]).toBe('none');
    expect(a[a.indexOf('--user') + 1]).toBe('65534:65534');
  });
  it('MC-C16: a command item that looks like a flag lands after the image id; -e is always K=V; the argv is built from validated parts only', () => {
    const a = buildMcpArgv({ name: NAME, slug: 'srv', image: IMG, command: ['--privileged', '-v', '/:/x'], env: { A: '1' } });
    expect(a.indexOf('--privileged')).toBeGreaterThan(a.indexOf(IMG));
    expect(a.slice(a.indexOf(IMG))).toEqual([IMG, '--privileged', '-v', '/:/x']);
    for (const [i, x] of a.entries()) if (x === '-e') expect(a[i + 1]).toMatch(/^[A-Z][A-Z0-9_]*=/);
    const bad = [
      { name: 'x', slug: 'srv', image: IMG }, { name: NAME, slug: 'srv', image: 'alpine' }, { name: NAME, slug: 'other', image: IMG }, { name: 'mcp-srv-ABCDEF01', slug: 'srv', image: IMG }, { name: NAME, slug: 'Srv', image: IMG },
    ];
    for (const b of bad) expect(() => buildMcpArgv({ ...b, command: [], env: {} })).toThrow();
    expect(() => buildMcpArgv({ name: NAME, slug: 'srv', image: IMG, command: ['a b'], env: {} })).toThrow();
    expect(() => buildMcpArgv({ name: NAME, slug: 'srv', image: IMG, command: [], env: { PATH: 'x' } })).toThrow();
    expect(() => buildMcpArgv({ name: NAME, slug: 'srv', image: IMG, command: [], env: { A: 'x y' } })).toThrow();
    expect(SANDBOX_NAME.test(NAME)).toBe(true);
  });
});

describe('MCP-AC09: the real spawner', () => {
  it('spawns `docker` with an argv array, shell:false, three pipes and an env of only PATH, HOME and DOCKER_HOST', async () => {
    const calls: unknown[][] = [];
    vi.resetModules();
    vi.doMock('node:child_process', async (orig) => ({ ...(await orig<typeof import('node:child_process')>()), spawn: (...a: unknown[]) => { calls.push(a); throw new Error('stop'); } }));
    const prev = { H: process.env.DOCKER_HOST, X: process.env.SECRET_SHOULD_NOT_LEAK };
    process.env.DOCKER_HOST = 'unix:///x.sock';
    process.env.SECRET_SHOULD_NOT_LEAK = 'v';
    try {
      const m = await import('./sandbox.js');
      expect(() => m.realMcpSpawner()(['run', 'x'])).toThrow('stop');
    } finally {
      if (prev.H === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = prev.H;
      delete process.env.SECRET_SHOULD_NOT_LEAK;
      vi.doUnmock('node:child_process');
      vi.resetModules();
    }
    expect(calls).toHaveLength(1);
    const [cmd, argv, opts] = calls[0] as [string, string[], { shell: boolean; env: Record<string, string>; stdio: string[] }];
    expect(cmd).toBe('docker');
    expect(argv).toEqual(['run', 'x']);
    expect(opts.shell).toBe(false);
    expect(opts.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(Object.keys(opts.env).sort()).toEqual(['DOCKER_HOST', 'HOME', 'PATH']);
    expect(realMcpSpawner).toBeTypeOf('function');
  });
  it('sandbox.ts never uses a shell or exec of a string', () => {
    const src = readFileSync(new URL('./sandbox.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/shell:\s*true|execSync|spawnSync|execFile/);
    expect(src.match(/from 'node:child_process'/g)).toHaveLength(1);
    expect(src).toMatch(/import \{ spawn \} from 'node:child_process'/);
    expect(src).toMatch(/shell: false/);
  });
});

const deps = (over: Partial<SandboxDeps> = {}, env: Record<string, string> = {}): { d: SandboxDeps; docker: FakeMcpDocker; sp: ReturnType<typeof fixtureSpawner> } => {
  const docker = new FakeMcpDocker();
  const sp = fixtureSpawner(env);
  return { d: { docker, spawn: sp, isHalted: () => false, latch: new StuckLatch(), newSuffix: () => 'abcdef01', haltPollMs: 15, clientGraceMs: 40, hardTimeoutMs: 5000, ...over }, docker, sp };
};
const cfg = { slug: 'srv', imageId: IMG, command: [] as string[], env: {}, timeoutMs: 5000 };

describe('MCP-AC10: the sandbox lifecycle', () => {
  it('runs the session, closes stdin in finally, inspects, removes with rm -f -v and verifies the name is gone', async () => {
    const { d, docker, sp } = deps();
    const r = await withSandbox(d, cfg, async (rpc) => { await rpc.handshake(); return rpc.listTools(); });
    expect((r as unknown[]).length).toBe(2);
    expect(sp.log.ended).toBeGreaterThanOrEqual(1);
    expect(sp.log.argv[0]![sp.log.argv[0]!.indexOf('--name') + 1]).toBe(NAME);
    expect(docker.execs.map((e) => e.slice(0, 3).join(' '))).toEqual(['inspect --format {{.State.OOMKilled}} {{.State.ExitCode}} {{.State.StartedAt}}', 'rm -f -v', 'ps -a --filter']);
    expect(docker.execs.find((e) => e[0] === 'rm')).toEqual(['rm', '-f', '-v', NAME]);
    expect(docker.removed).toEqual([NAME]);
  });
  it('stdin is closed in finally also when the session throws', async () => {
    const { d, sp } = deps();
    expect(await code(withSandbox(d, cfg, async () => { throw new McpError('E_PROTOCOL'); }))).toBe('E_PROTOCOL');
    expect(sp.log.ended).toBeGreaterThanOrEqual(1);
  });
  it('a removal that cannot be verified is E_STUCK, sets the latch (every later call is refused before a spawn) and reports once', async () => {
    const { d, docker, sp } = deps({}, {});
    let stuck = 0;
    d.onStuck = () => { stuck++; };
    docker.stuck.add(NAME);
    expect(await code(withSandbox(d, cfg, async () => 1))).toBe('E_STUCK');
    expect(d.latch.stuck).toBe(true);
    expect(stuck).toBe(1);
    const spawned = sp.log.spawned;
    expect(await code(withSandbox(d, cfg, async () => 1))).toBe('E_STUCK');
    expect(sp.log.spawned).toBe(spawned);
    expect(stuck).toBe(1);
  });
  it('a timeout gives E_TIMEOUT with verified removal', async () => {
    const { d, docker } = deps({ hardTimeoutMs: 120 }, { MCP_SCENARIO: 'hang' });
    expect(await code(withSandbox(d, cfg, async (rpc) => { await rpc.handshake(); return rpc.callTool('echo', {}, 60_000); }))).toBe('E_TIMEOUT');
    expect(docker.removed).toContain(NAME);
    expect(docker.execs.filter((e) => e[0] === 'rm').length).toBeGreaterThanOrEqual(2); // the kill at the deadline, then the verified removal
  });
  it('a halt while the container runs gives E_HALTED with verified removal; a halt before the start spawns nothing', async () => {
    let halted = false;
    const { d, docker, sp } = deps({ isHalted: () => halted }, { MCP_SCENARIO: 'hang' });
    setTimeout(() => { halted = true; }, 60);
    expect(await code(withSandbox(d, cfg, async (rpc) => { await rpc.handshake(); return rpc.callTool('echo', {}, 60_000); }))).toBe('E_HALTED');
    expect(docker.removed).toContain(NAME);
    const spawned = sp.log.spawned;
    expect(await code(withSandbox(d, cfg, async () => 1))).toBe('E_HALTED');
    expect(sp.log.spawned).toBe(spawned);
  });
  it('an OOM-killed container is E_OOM; an exit before the answer is E_EXIT', async () => {
    const a = deps({}, { MCP_SCENARIO: 'exitcall' });
    a.docker.oom = true;
    expect(await code(withSandbox(a.d, cfg, async (rpc) => { await rpc.handshake(); return rpc.callTool('echo', {}, 5000); }))).toBe('E_OOM');
    const b = deps({}, { MCP_SCENARIO: 'exitcall' });
    expect(await code(withSandbox(b.d, cfg, async (rpc) => { await rpc.handshake(); return rpc.callTool('echo', {}, 5000); }))).toBe('E_EXIT');
  });
  it('a spawn failure (a throw, a process that never started, docker exit 125) is E_SPAWN', async () => {
    const a = deps({ spawn: () => { throw new Error('ENOENT'); } });
    expect(await code(withSandbox(a.d, cfg, async () => 1))).toBe('E_SPAWN');
    const b = deps({}, { MCP_SCENARIO: 'exitcall' });
    b.docker.started = false;
    expect(await code(withSandbox(b.d, cfg, async (rpc) => { await rpc.handshake(); return rpc.callTool('echo', {}, 5000); }))).toBe('E_SPAWN');
  });
  it('a protocol violation kills the container through onFatal and the code survives', async () => {
    const { d, sp } = deps({}, { MCP_SCENARIO: 'nonjson' });
    expect(await code(withSandbox(d, cfg, async (rpc) => rpc.handshake()))).toBe('E_PROTOCOL');
    expect(sp.log.killed).toBeGreaterThanOrEqual(1);
  });
});

describe('MC-C2: image checks', () => {
  it('checkImage needs the same id and an empty Config.Volumes (null or {}); anything else, a failing docker or a missing docker is false', async () => {
    const d = new FakeMcpDocker();
    expect(await checkImage(d, IMG)).toBe(true);
    expect(d.execs.map((e) => e.join(' '))).toEqual([`image inspect --format {{.Id}} ${IMG}`, `image inspect --format {{json .Config.Volumes}} ${IMG}`]);
    d.volumes = '{}';
    expect(await checkImage(d, IMG)).toBe(true);
    for (const v of ['{"/data":{}}', '{"/x":{}}', 'garbage', '']) { d.volumes = v; expect(await checkImage(d, IMG), v).toBe(false); }
    d.volumes = 'null';
    d.imageId = `sha256:${'d'.repeat(64)}`;
    expect(await checkImage(d, IMG)).toBe(false);
    d.missing = true;
    expect(await checkImage(d, IMG)).toBe(false);
  });
});

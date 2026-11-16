import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { McpRepo } from '../db/repos/mcp.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import type { ToolContext, ToolPlugin } from '../tools/types.js';
import { acquireDockerTestLock, releaseDockerTestLock } from '../workspaces/docker-test-lock.js';
import { realDockerCli, removeVerified } from '../workspaces/runner.js';
import { McpAdmin } from './admin.js';
import { McpError, MCP_TEXT } from './errors.js';
import { McpHost } from './host.js';
import { CONFIG_NOTICE, quarantineConfig } from './quarantine.js';
import type { McpProc, McpSpawner } from './rpc.js';
import { SANDBOX_NAME, StuckLatch, buildMcpArgv, checkImage, realMcpSpawner, withSandbox } from './sandbox.js';
import { Slots } from './slots.js';
import { buildSnapshot, configSha256 } from './snapshot.js';
import { QUARANTINE_NOTICE, createMcpToolFactory } from './tool.js';

/**
 * R6 MCP-1 BE3, MCP-AC27 / MC-C2 / MC-C15 / MC-C19 with the REAL Docker daemon: the repo's own fixture server (tests/fixtures/mcp/echo-server.mjs) built into a local image by
 * docker/mcp/fixture.Dockerfile (docker build --pull=false on the node:22-alpine base that is already on the host; nothing is pulled or run from outside the repo), the real
 * add -> approve -> call path through McpAdmin, McpHost and the tool adapter on the real sandbox argv, on the test Postgres. Skipped (visibly) when Docker or the base is absent.
 * Every container carries label mcp=1 and is removed by the sandbox; the images are removed by the ids this file built (and only those that did not exist before).
 */
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIG = join(ROOT_DIR, 'db', 'migrations');
const DOCKERFILE = join(ROOT_DIR, 'docker', 'mcp', 'fixture.Dockerfile');
const sh = (args: string[], input?: string): string | null => {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000, stdio: ['pipe', 'pipe', 'ignore'], ...(input !== undefined ? { input } : {}) }).trim();
  } catch {
    return null;
  }
};
const BASE = /^FROM (\S+)/m.exec(readFileSync(DOCKERFILE, 'utf8'))?.[1] ?? '';
const ready = sh(['version', '--format', '{{.Server.Version}}']) !== null && BASE !== '' && sh(['image', 'inspect', '--format', '{{.Id}}', BASE]) !== null;
const WHY = 'skipped: Docker is unreachable or the local node:22-alpine base of docker/mcp/fixture.Dockerfile is not on this host (nothing is pulled)';

const ADMIN = '900000000000000001';
const BY = { kind: 'admin', userId: ADMIN } as const;
const BUILD = ['build', '--pull=false', '--provenance=false', '--sbom=false'];
const idsBefore = new Set<string>();
const built: string[] = [];
let FIX = '';
let VOL = '';
let tmp = '';
let db: TestDb;
let repo: McpRepo;

const listIds = (): string[] => (sh(['image', 'ls', '-q', '--no-trunc']) ?? '').split('\n').filter(Boolean);
function build(args: string[]): string {
  const iid = join(tmp, `iid-${built.length}`);
  const out = sh([...BUILD, '--iidfile', iid, ...args]);
  if (out === null) throw new Error('docker build failed');
  const id = sh(['image', 'inspect', '--format', '{{.Id}}', readFileSync(iid, 'utf8').trim()]);
  if (!id) throw new Error('built image not found');
  built.push(id);
  return id;
}
const leftovers = (): string[] => (sh(['ps', '-a', '-q', '--filter', 'label=mcp=1']) ?? 'unknown').split('\n').filter(Boolean);
const danglingVolumes = (): number => (sh(['volume', 'ls', '-q', '--filter', 'dangling=true']) ?? '').split('\n').filter(Boolean).length;

beforeAll(async () => {
  if (!ready) return;
  await acquireDockerTestLock();
  tmp = mkdtempSync(join(tmpdir(), 'mcp-docker-'));
  for (const i of listIds()) idsBefore.add(i);
  FIX = build(['-f', DOCKERFILE, join(ROOT_DIR, 'tests', 'fixtures', 'mcp')]);
  VOL = build(['-f', join(ROOT_DIR, 'docker', 'mcp', 'fixture-volume.Dockerfile'), join(ROOT_DIR, 'tests', 'fixtures', 'mcp')]);
  db = await freshDb();
  await migrate(db.pool, MIG, 'up');
  repo = new McpRepo(db.pool);
}, 300_000);
afterAll(async () => {
  if (!ready) return;
  try {
    for (const c of leftovers()) sh(['rm', '-f', '-v', c]); // only reached when a test failed half way; the tests assert none is left
    for (const id of [...new Set(built)].reverse()) if (!idsBefore.has(id)) sh(['image', 'rm', id]);
    await db?.close();
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    releaseDockerTestLock();
  }
}, 120_000);
beforeEach(async () => {
  if (!ready) return;
  for (const t of ['approvals', 'mcp_call_counts', 'mcp_server_depts', 'mcp_servers', 'audit_log', 'tasks']) await db.pool.query(`DELETE FROM ${t}`);
});

function stack() {
  const docker = realDockerCli();
  const rec: { argv: string[][]; stdin: string[] } = { argv: [], stdin: [] };
  const real = realMcpSpawner();
  const spawn: McpSpawner = (argv) => {
    rec.argv.push([...argv]);
    const p = real(argv);
    const w = p.stdin.write.bind(p.stdin) as (d: string) => unknown;
    (p.stdin as { write: (d: string) => unknown }).write = (d: string) => { rec.stdin.push(d); return w(d); };
    return p;
  };
  const notices: string[] = [];
  const logs: unknown[] = [];
  const sandbox = { docker, spawn, isHalted: () => false, latch: new StuckLatch() };
  const audit = async (e: { action: string; outcome?: string | null; actor: string; tool?: string | null; taskId?: string | null }) => {
    await db.pool.query('INSERT INTO audit_log (actor, action, task_id, tool, outcome) VALUES ($1,$2,$3,$4,$5)', [e.actor, e.action, e.taskId ?? null, e.tool ?? null, e.outcome ?? null]);
  };
  const deps = { repo, sandbox, slots: new Slots(), enabled: () => true, halted: () => false, tz: () => 'Asia/Bangkok', caps: () => ({ tree: 40, day: 200 }), audit, secrets: () => [], notify: async (t: string) => void notices.push(t), log: { error: (x: unknown) => logs.push(x) } };
  const host: McpHost = new McpHost({ onConfigChanged: (row) => quarantineConfig({ repo, notify: deps.notify, log: { error: (x: unknown) => logs.push(x) } }, row), repo, makeTool: (s, t) => createMcpToolFactory({ ...deps, host })(s, t), secrets: () => [], incident: () => undefined, log: { error: (x: unknown) => logs.push(x) } });
  const admin = new McpAdmin({ repo, docker, sandbox, host, halted: () => false, deptExists: (d) => d === 'software', audit, secrets: () => [], log: { error: (x: unknown) => logs.push(x) } });
  const ctx = (): ToolContext => ({ actor: { kind: 'head', dept: 'software' }, task: { id: 'task-1', rootId: '00000000-0000-4000-8000-000000000001' }, direct: false, tainted: () => false }) as never;
  const tool = (n: string) => host.get(n) as ToolPlugin<Record<string, unknown>>;
  const calls = (): number => rec.stdin.filter((l) => l.includes('"tools/call"')).length;
  return { docker, rec, notices, logs, sandbox, host, admin, ctx, tool, calls };
}
type Stack = ReturnType<typeof stack>;

/** add -> approve with the token from the show view; returns the slug's tool names. */
async function install(s: Stack, slug: string, o: { image?: string; env?: string; timeout?: number } = {}): Promise<void> {
  const added = await s.admin.add({ slug, image: o.image ?? FIX, departments: 'software', title: 'Fixture', class: 'read', ...(o.env ? { env: o.env } : {}), ...(o.timeout ? { timeout: o.timeout } : {}) }, BY);
  if (!added.ok) throw new Error(`add refused ${added.code}`);
  const ok = await s.admin.approve({ slug, token: added.view.config12 }, BY);
  if (!ok.ok) throw new Error(`approve refused ${ok.code}`);
}

describe.skipIf(!ready)(`MCP Docker acceptance (real daemon, fixture image) ${ready ? '' : WHY}`, () => {
  it('the built image: an exact id, no VOLUME, the fixture as entrypoint (MC-C2 precondition)', async () => {
    expect(FIX).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await checkImage(realDockerCli(), FIX)).toBe(true);
    expect(sh(['image', 'inspect', '--format', '{{json .Config.Volumes}}', FIX])).toBe('null');
  }, 60_000);

  it('MCP-AC27: add -> approve -> call through the real sandbox argv; the container is gone, no volume is left, the counts and audit rows are written', async () => {
    const s = stack();
    const vols = danglingVolumes();
    await install(s, 'fx');
    expect(s.host.names()).toEqual(['mcp_r_fx_add_numbers', 'mcp_r_fx_echo']);
    const p = s.tool('mcp_r_fx_echo');
    expect(await p.precheck!({ text: 'hello' }, s.ctx())).toBeNull();
    s.rec.argv.length = 0;
    expect(await p.run({ text: 'hello' }, s.ctx())).toEqual({ content: 'echo:hello' });
    expect(await s.tool('mcp_r_fx_add_numbers').run({ a: 2, b: 3 }, s.ctx())).toEqual({ content: '5' });
    // the argv of the call is exactly the one buildMcpArgv makes from the stored row (spec 3.5, MC-C2, MC-C3): only the random name differs
    const argv = s.rec.argv[0]!;
    const name = argv[argv.indexOf('--name') + 1]!;
    expect(name).toMatch(SANDBOX_NAME);
    expect(argv).toEqual(buildMcpArgv({ name, slug: 'fx', image: FIX, command: [], env: {} }));
    expect(argv).toEqual(expect.arrayContaining(['--network', 'none', '--read-only', '--cap-drop=ALL', '--pull=never', '--no-healthcheck']));
    expect(leftovers()).toEqual([]);
    expect(danglingVolumes()).toBeLessThanOrEqual(vols);
    const counts = (await db.pool.query<{ scope: string; used: number }>('SELECT scope, used FROM mcp_call_counts ORDER BY scope')).rows;
    expect(counts.map((c) => [c.scope, c.used])).toEqual([['day', 2], ['server_day', 2], ['tree', 2]]);
    const acts = (await db.pool.query<{ action: string; outcome: string }>("SELECT action, outcome FROM audit_log WHERE action LIKE 'mcp.%' ORDER BY id")).rows;
    expect(acts.map((a) => `${a.action} ${a.outcome.split(' ')[0]}`)).toEqual(['mcp.add pending', 'mcp.approve active', 'mcp.call start', 'mcp.call.end ok', 'mcp.call start', 'mcp.call.end ok']);
    expect(s.logs).toEqual([]);
  }, 120_000);

  it('MC-C15 / MCP-AC27: no network, the fixture connect to 1.1.1.1:53 fails', async () => {
    const s = stack();
    await install(s, 'netp', { env: 'MCP_TOOLS=net' });
    const r = await s.tool('mcp_r_netp_netprobe').run({}, s.ctx());
    expect(r).toMatchObject({ content: expect.stringMatching(/^blocked:/) });
    expect((r as { content: string }).content).not.toContain('connected');
    expect(leftovers()).toEqual([]);
  }, 120_000);

  it('MC-C15: docker inspect of a running sandbox container shows the pinned settings; a missing image id is exit 125 / E_SPAWN with no pull', async () => {
    const name = 'mcp-fxinspect-0a1b2c3d';
    const argv = buildMcpArgv({ name, slug: 'fxinspect', image: FIX, command: [], env: {} });
    const proc: McpProc = realMcpSpawner()(argv);
    try {
      const deadline = Date.now() + 30_000;
      while (sh(['inspect', '-f', '{{.State.Running}}', name]) !== 'true') {
        if (Date.now() > deadline) throw new Error('the fixture container did not start');
        await new Promise((r) => setTimeout(r, 200));
      }
      const j = (JSON.parse(sh(['inspect', name]) ?? '[]') as Record<string, any>[])[0]!;
      expect(j.HostConfig.Privileged).toBe(false);
      expect(j.HostConfig.ReadonlyRootfs).toBe(true);
      expect(j.HostConfig.NetworkMode).toBe('none');
      expect(j.HostConfig.IpcMode).toBe('none');
      expect(j.HostConfig.CgroupnsMode).toBe('private');
      expect(j.HostConfig.UsernsMode).toBe('');
      expect(j.HostConfig.SecurityOpt).toEqual(['no-new-privileges']);
      expect(j.HostConfig.CapDrop).toEqual(['ALL']);
      expect(j.Mounts).toEqual([]);
      expect(j.Config.User).toBe('65534:65534');
      expect(j.Config.Labels).toMatchObject({ mcp: '1', 'mcp.server': 'fxinspect' });
      // containerd image store: .Image is the same digest that `image inspect {{.Id}}` returns and that is stored as image_id
      expect(j.Image).toBe(FIX);
      expect(j.HostConfig.Memory).toBe(512 * 1024 * 1024);
      expect(j.HostConfig.PidsLimit).toBe(64);
    } finally {
      proc.kill();
      expect(await removeVerified(realDockerCli(), name, { volumes: true })).toBe(true);
    }
    const missing = `sha256:${'0'.repeat(63)}1`;
    const s = stack();
    const err = await withSandbox(s.sandbox, { slug: 'nope', imageId: missing, command: [], env: {}, timeoutMs: 5000 }, async (rpc) => rpc.handshake()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpError);
    expect((err as McpError).code).toBe('E_SPAWN');
    expect(sh(['image', 'inspect', '--format', '{{.Id}}', missing])).toBeNull(); // nothing was pulled or created
    expect(leftovers()).toEqual([]);
  }, 120_000);

  it('MC-C2: an image with a VOLUME is refused at add (E_IMAGE) before any container runs', async () => {
    const s = stack();
    expect(sh(['image', 'inspect', '--format', '{{json .Config.Volumes}}', VOL])).toContain('/data');
    const r = await s.admin.add({ slug: 'vol', image: VOL, departments: 'software', title: 'Vol' }, BY);
    expect(r).toMatchObject({ ok: false, code: 'E_IMAGE' });
    expect(s.rec.argv).toEqual([]);
    expect(await repo.get('vol')).toBeNull();
    expect(leftovers()).toEqual([]);
  }, 60_000);

  it('MCP-AC27 quarantine: the stored snapshot and hash are edited in the database; the live tool list no longer matches, so no tools/call is sent, the row is quarantined and the notice is posted', async () => {
    const s = stack();
    await install(s, 'qfx');
    const row = (await repo.get('qfx'))!;
    const tampered = [...row.snapshot, { name: 'extra', description: 'new', inputSchema: { type: 'object' } }];
    const b = buildSnapshot(tampered, { slug: 'qfx', toolClass: 'read' });
    // the attacker also re-pins (a database owner could): only then does the live-versus-stored snapshot check still matter
    const pin = configSha256({ ...row, snapshotSha256: b.sha256 });
    await db.pool.query('UPDATE mcp_servers SET snapshot = $2::jsonb, snapshot_sha256 = $3, approved_config_sha256 = $4 WHERE slug = $1', ['qfx', JSON.stringify(b.raw), b.sha256, pin]);
    await s.host.refresh();
    expect(s.host.names()).toContain('mcp_r_qfx_extra'); // the host believes the edited row
    const before = s.calls();
    const r = await s.tool('mcp_r_qfx_echo').run({ text: 'x' }, s.ctx());
    expect(r).toEqual({ content: MCP_TEXT.E_CHANGED, isError: true });
    expect(s.calls()).toBe(before);
    expect(s.calls()).toBe(0);
    expect(await repo.get('qfx')).toMatchObject({ status: 'quarantined', quarantineReason: 'snapshot_changed' });
    expect(s.host.names()).toEqual([]);
    expect(s.notices).toEqual([QUARANTINE_NOTICE('qfx')]);
    expect(leftovers()).toEqual([]);
  }, 120_000);

  it.each([
    ['image_id', "UPDATE mcp_servers SET image_id = 'sha256:' || repeat('d', 64) WHERE slug = $1"],
    ['command', "UPDATE mcp_servers SET command = '[\"--evil\"]'::jsonb WHERE slug = $1"],
    ['env', "UPDATE mcp_servers SET env = '{\"A\":\"b\"}'::jsonb WHERE slug = $1"],
    ['tool_class', "UPDATE mcp_servers SET tool_class = 'write' WHERE slug = $1"],
    ['a grant row', "INSERT INTO mcp_server_depts (server_id, dept_id, granted_by) SELECT id, 'hq', '900000000000000001' FROM mcp_servers WHERE slug = $1"],
  ])('047: %s edited in the database after the approval: not loaded, quarantined (config_changed), and no container is ever started (real daemon)', async (_n, sql) => {
    const s = stack();
    await install(s, 'pfx');
    const p = s.tool('mcp_r_pfx_echo');
    await db.pool.query(sql, ['pfx']);
    s.rec.argv.length = 0;
    expect(await p.precheck!({ text: 'x' }, s.ctx())).toEqual({ refuse: MCP_TEXT.E_CONFIG }); // the per-call check, before any host refresh
    expect(await repo.get('pfx')).toMatchObject({ status: 'quarantined', quarantineReason: 'config_changed' });
    expect(s.notices).toEqual([CONFIG_NOTICE('pfx')]);
    expect(s.host.names()).toEqual([]);
    expect(await s.host.load()).toEqual({ loaded: 0, failed: [] });
    expect(s.rec.argv).toEqual([]);
    expect(s.calls()).toBe(0);
    expect(leftovers()).toEqual([]);
  }, 120_000);

  it('MC-C1: editing only snapshot_sha256 drops the server at the next refresh (fail closed): the old tool answers E_GONE and no container starts', async () => {
    const s = stack();
    await install(s, 'hfx');
    const p = s.tool('mcp_r_hfx_echo');
    await db.pool.query("UPDATE mcp_servers SET snapshot_sha256 = $2 WHERE slug = $1", ['hfx', 'f'.repeat(64)]);
    await s.host.refresh();
    expect(s.host.names()).toEqual([]);
    s.rec.argv.length = 0;
    expect(await p.precheck!({ text: 'x' }, s.ctx())).toEqual({ refuse: MCP_TEXT.E_GONE });
    expect(s.rec.argv).toEqual([]);
    expect(leftovers()).toEqual([]);
  }, 120_000);

  it('timeout: a server that never answers tools/call is E_TIMEOUT after timeout_ms, and the container is removed and verified gone', async () => {
    const s = stack();
    await install(s, 'slow', { env: 'MCP_SCENARIO=hang', timeout: 5 });
    const t0 = Date.now();
    expect(await s.tool('mcp_r_slow_echo').run({ text: 'x' }, s.ctx())).toEqual({ content: MCP_TEXT.E_TIMEOUT, isError: true });
    expect(Date.now() - t0).toBeLessThan(40_000);
    expect(leftovers()).toEqual([]);
    expect(s.sandbox.latch.stuck).toBe(false);
  }, 120_000);

  it('OOM: a server that allocates past 512 MB is E_OOM, and the container (with its volumes) is removed', async () => {
    const s = stack();
    const vols = danglingVolumes();
    await install(s, 'hog', { env: 'MCP_SCENARIO=oom', timeout: 30 });
    expect(await s.tool('mcp_r_hog_echo').run({ text: 'x' }, s.ctx())).toEqual({ content: MCP_TEXT.E_OOM, isError: true });
    expect(leftovers()).toEqual([]);
    expect(danglingVolumes()).toBeLessThanOrEqual(vols);
    expect(s.sandbox.latch.stuck).toBe(false);
  }, 180_000);
});

// Visible reason in the report when the suite cannot run (registered only then, so a run with Docker shows no skip).
if (!ready) describe.skip(`MCP Docker acceptance ${WHY}`, () => { it('needs Docker and the local base image', () => undefined); });

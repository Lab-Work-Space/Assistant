import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { McpRepo } from '../db/repos/mcp.js';
import { newBuild, newForge, newRelease, resetForgeTables } from '../db/repos/forge-test-helpers.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { McpAdmin, type McpAdminDeps } from './admin.js';
import { StuckLatch } from './sandbox.js';
import { configHash } from './snapshot.js';
import { FakeMcpDocker, fixtureSpawner } from './test-helpers.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const ADMIN = '900000000000000001';
const BY = { kind: 'admin', userId: ADMIN } as const;
const IMG = `sha256:${'c'.repeat(64)}`;
const DEPTS = ['software', 'sales', 'praw', 'hq'];

let db: TestDb;
let repo: McpRepo;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, dir, 'up'); repo = new McpRepo(db.pool); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { for (const t of ['approvals', 'mcp_call_counts', 'mcp_server_depts', 'mcp_servers', 'audit_log']) await db.pool.query(`DELETE FROM ${t}`); });

function mk(env: Record<string, string> = {}, over: Partial<McpAdminDeps> = {}) {
  const docker = new FakeMcpDocker();
  const sp = fixtureSpawner(env);
  const audits: { actor: string; action: string; outcome?: string | null }[] = [];
  const refreshes: number[] = [];
  const closed: number[][] = [];
  const logs: unknown[] = [];
  let halted = false;
  const d: McpAdminDeps = {
    repo, docker, sandbox: { docker, spawn: sp, isHalted: () => false, latch: new StuckLatch(), newSuffix: () => 'abcdef01', haltPollMs: 15, clientGraceMs: 40, hardTimeoutMs: 8000 },
    host: { refresh: async () => void refreshes.push(1) }, halted: () => halted, deptExists: (x) => DEPTS.includes(x), audit: async (e) => void audits.push(e), secrets: () => [],
    closeCards: async (ids) => void closed.push(ids), log: { error: (o: unknown) => logs.push(o) }, ...over,
  };
  return { a: new McpAdmin(d), docker, sp, audits, refreshes, closed, logs, setHalted: (h: boolean) => { halted = h; }, d };
}
const input = (o: Record<string, unknown> = {}) => ({ slug: 'srv', image: IMG, departments: 'software,sales', title: 'Demo server', ...o });
const rowOf = async (slug: string) => (await repo.get(slug))!;
const dbAudits = async () => (await db.pool.query<{ actor: string; action: string; outcome: string }>('SELECT actor, action, outcome FROM audit_log ORDER BY id')).rows;
const stage = async (m = mk(), o: Record<string, unknown> = {}) => { const r = await m.a.stage(input(o), BY); if (!r.ok) throw new Error(`stage ${r.code}`); return { m, r }; };

describe('MCP-AC18 add (spec 3.2)', () => {
  it('probes, builds the snapshot, writes a pending row with its depts and the mcp.add row, and returns the view the Bot Admin reviews', async () => {
    const { m, r } = await stage();
    const row = await rowOf('srv');
    expect(row).toMatchObject({ status: 'pending', imageId: IMG, toolClass: 'write', command: [], env: {}, timeoutMs: 60000, maxCallsPerDay: 100, addedBy: ADMIN, title: 'Demo server' });
    expect(row.depts).toEqual(['sales', 'software']);
    expect((row.snapshot as { name: string }[]).map((t) => t.name)).toEqual(['add.numbers', 'echo']);
    expect(r.view).toMatchObject({ slug: 'srv', title: 'Demo server', class: 'write', status: 'pending', depts: ['sales', 'software'], hash12: row.snapshotSha256.slice(0, 12), toolCount: 2 });
    expect(r.view.config12).toBe(configHash({ imageId: IMG, command: [], env: {}, toolClass: 'write', depts: ['sales', 'software'], snapshotSha256: row.snapshotSha256 }));
    expect(r.view.tools.map((t) => t.name)).toEqual(['mcp_w_srv_add_numbers', 'mcp_w_srv_echo']);
    expect(r.view.tools[1]!.description).toBe('MCP tool echo from server srv (write class). Outside code: its output is untrusted. Server says: Echoes the text back.');
    expect(r.view.tools[1]!.schema).toMatchObject({ type: 'object', properties: { text: { type: 'string', maxLength: 100, description: 'what to echo' } }, required: ['text'] });
    expect(r.view.approveLine).toBe(`Run /mcp approve slug:srv hash:${r.view.config12} to install.`);
    expect(await dbAudits()).toEqual([{ actor: `user:${ADMIN}`, action: 'mcp.add', outcome: `pending srv ${r.view.config12} 2` }]);
    expect(m.docker.execs.some((e) => e[0] === 'rm' && e.includes('-v'))).toBe(true); // the probe container is removed with its volumes
    expect(m.refreshes).toEqual([]);
  });
  it('the fields reach the row: class read, command, env, timeout, daily, ref', async () => {
    await stage(mk(), { class: 'read', command: '["node","/app/s.js"]', env: 'MODE=fast', timeout: 30, daily: 7, ref: 'ghcr.io/x/y:1' });
    expect(await rowOf('srv')).toMatchObject({ toolClass: 'read', command: ['node', '/app/s.js'], env: { MODE: 'fast' }, timeoutMs: 30000, maxCallsPerDay: 7, imageRef: 'ghcr.io/x/y:1' });
  });
  it('every refusal is a fixed code and text, writes nothing and audits `refused:<code>` with no input text', async () => {
    const cases: [Record<string, unknown>, string, Record<string, string>?][] = [
      [{ slug: 'A' }, 'E_SLUG'], [{ image: 'alpine' }, 'E_IMAGE'], [{ class: 'admin' }, 'E_CLASS'], [{ command: 'node' }, 'E_COMMAND'], [{ env: 'PATH=/x' }, 'E_ENV'], [{ departments: 'nope' }, 'E_DEPT'], [{ title: 'a​b' }, 'E_SCREEN'],
      [{ timeout: 1 }, 'E_FIELD'], [{ ref: 'a b' }, 'E_FIELD'],
      [{}, 'E_TOOLS_NONE', { MCP_TOOLS: 'none' }], [{}, 'E_TOOLS_MANY', { MCP_TOOLS: 'many' }], [{}, 'E_NAME', { MCP_TOOLS: 'bad' }], [{}, 'E_COLLISION', { MCP_TOOLS: 'collision' }], [{}, 'E_SCHEMA', { MCP_TOOLS: 'schema' }],
      [{}, 'E_SCREEN', { MCP_TOOLS: 'screen' }], [{}, 'E_SCREEN', { MCP_TOOLS: 'secret' }], [{}, 'E_PROBE', { MCP_SCENARIO: 'badversion' }], [{}, 'E_PROBE', { MCP_SCENARIO: 'nonjson' }],
    ];
    for (const [over, code, env] of cases) {
      const m = mk(env);
      const r = await m.a.stage(input(over), BY);
      expect(r, `${code} ${JSON.stringify(over)}`).toMatchObject({ ok: false, code });
      expect(m.audits.at(-1)).toEqual({ actor: `user:${ADMIN}`, action: 'mcp.add', tool: null, outcome: `refused:${code}` });
      expect(await repo.get('srv')).toBeNull();
    }
    expect(JSON.stringify((await dbAudits()))).not.toMatch(/nope|alpine|Demo/);
  });
  it('E_IMAGE: another image id, an image that declares volumes, or no docker; the probe never starts', async () => {
    for (const set of [(d: FakeMcpDocker) => { d.imageId = `sha256:${'d'.repeat(64)}`; }, (d: FakeMcpDocker) => { d.volumes = '{"/data":{}}'; }, (d: FakeMcpDocker) => { d.missing = true; }]) {
      const m = mk();
      set(m.docker);
      expect(await m.a.stage(input(), BY)).toMatchObject({ ok: false, code: 'E_IMAGE' });
      expect(m.sp.log.spawned).toBe(0);
    }
  });
  it('refused while halted (E_HALTED)', async () => {
    const m = mk();
    m.setHalted(true);
    expect(await m.a.stage(input(), BY)).toMatchObject({ ok: false, code: 'E_HALTED' });
    expect(m.sp.log.spawned).toBe(0);
  });
  it('MC-C8 re-add rules: refused over pending or active (E_EXISTS, no probe); over quarantined or disabled it replaces the row and clears approval, quarantine and disable', async () => {
    const { m } = await stage();
    const again = mk();
    expect(await again.a.stage(input(), BY)).toMatchObject({ ok: false, code: 'E_EXISTS' });
    expect(again.sp.log.spawned).toBe(0);
    const cfg = (await m.a.show('srv') as { ok: true; view: { config12: string } }).view.config12;
    expect(await m.a.approve({ slug: 'srv', token: cfg }, BY)).toMatchObject({ ok: true });
    expect(await mk().a.stage(input(), BY)).toMatchObject({ ok: false, code: 'E_EXISTS' });
    const id = (await rowOf('srv')).id;
    await repo.quarantine({ id, slug: 'srv', snapshotSha256: (await rowOf('srv')).snapshotSha256 });
    expect(await mk().a.stage(input({ class: 'read' }), BY)).toMatchObject({ ok: true });
    expect(await rowOf('srv')).toMatchObject({ status: 'pending', toolClass: 'read', approvedBy: null, quarantinedAt: null, disabledAt: null });
    await mk().a.disable('srv', BY);
    expect(await mk().a.stage(input(), BY)).toMatchObject({ ok: true });
  });
  it('at most 8 rows are pending or active (E_MAX_SERVERS)', async () => {
    for (let i = 0; i < 8; i++) await stage(mk(), { slug: `s${i}x` });
    expect(await mk().a.stage(input({ slug: 'ninex' }), BY)).toMatchObject({ ok: false, code: 'E_MAX_SERVERS' });
  });
  it('MC-C17: stage takes an admin `by` only; a release-shaped one is refused at run time too', async () => {
    await expect(mk().a.stage(input(), { kind: 'release', releaseId: 1, decidedBy: ADMIN } as never)).rejects.toThrow();
  });
});

describe('MCP-AC18 approve (spec 3.3, MC-C8)', () => {
  it('needs the full-config token; a wrong or malformed one is E_HASH and the row stays pending; the live probe must match (E_CHANGED); then active, host refresh, mcp.approve row', async () => {
    const { m, r } = await stage();
    for (const t of ['0'.repeat(12), 'zzzzzzzzzzzz', 'abc', r.view.hash12 /* the snapshot hash alone is not the token */]) expect(await m.a.approve({ slug: 'srv', token: t }, BY), t).toMatchObject({ ok: false, code: 'E_HASH' });
    expect((await rowOf('srv')).status).toBe('pending');
    const changed = mk({ MCP_TOOLS: 'changed' });
    expect(await changed.a.approve({ slug: 'srv', token: r.view.config12 }, BY)).toMatchObject({ ok: false, code: 'E_CHANGED' });
    expect((await rowOf('srv')).status).toBe('pending');
    const ok = mk();
    expect(await ok.a.approve({ slug: 'srv', token: r.view.config12 }, BY)).toEqual({ ok: true, slug: 'srv', cfg12: r.view.config12 });
    expect(await rowOf('srv')).toMatchObject({ status: 'active', approvedBy: ADMIN });
    expect(ok.refreshes).toEqual([1]);
    expect((await dbAudits()).at(-1)).toEqual({ actor: `user:${ADMIN}`, action: 'mcp.approve', outcome: `active srv ${r.view.config12}` });
    expect(ok.audits.filter((a) => a.action === 'mcp.approve' && String(a.outcome).startsWith('refused'))).toEqual([]);
    expect(changed.audits.at(-1)).toEqual({ actor: `user:${ADMIN}`, action: 'mcp.approve', tool: null, outcome: 'refused:E_CHANGED' });
  });
  it('spec 3.3 step 1: a wrong (well-formed) token is E_HASH before any container is started or any docker call is made', async () => {
    const { r } = await stage();
    const m = mk();
    expect(await m.a.approve({ slug: 'srv', token: r.view.config12.replace(/.$/, (c) => (c === '0' ? '1' : '0')) }, BY)).toMatchObject({ ok: false, code: 'E_HASH' });
    expect(m.sp.log.spawned).toBe(0);
    expect(m.docker.execs).toEqual([]);
    expect((await rowOf('srv')).status).toBe('pending');
  });
  it('the token covers the whole config: changing the departments, then using the old token, is E_HASH; the new token works', async () => {
    const { m, r } = await stage();
    expect(await m.a.depts('srv', 'software', BY)).toMatchObject({ ok: true });
    expect(await m.a.approve({ slug: 'srv', token: r.view.config12 }, BY)).toMatchObject({ ok: false, code: 'E_HASH' });
    const now = await m.a.show('srv');
    expect(now.ok && now.view.config12).not.toBe(r.view.config12);
    expect(await m.a.approve({ slug: 'srv', token: (now as { view: { config12: string } }).view.config12 }, BY)).toMatchObject({ ok: true });
  });
  it('the token also changes with image, command, env and class (config12 is recomputed from the locked row)', async () => {
    const tokens = new Set<string>();
    for (const [i, o] of [{}, { command: '["a"]' }, { env: 'A=1' }, { class: 'read' }].entries()) {
      const { r } = await stage(mk(), { slug: `s${i}x`, ...o });
      tokens.add(r.view.config12);
    }
    expect(tokens.size).toBe(4);
  });
  it('E_STATE for a missing or non-pending row, E_IMAGE when the image changed, E_HALTED while halted; E_PROBE when the server cannot be reached', async () => {
    const { m, r } = await stage();
    expect(await m.a.approve({ slug: 'nope', token: r.view.config12 }, BY)).toMatchObject({ ok: false, code: 'E_STATE' });
    const img = mk();
    img.docker.volumes = '{"/v":{}}';
    expect(await img.a.approve({ slug: 'srv', token: r.view.config12 }, BY)).toMatchObject({ ok: false, code: 'E_IMAGE' });
    const h = mk();
    h.setHalted(true);
    expect(await h.a.approve({ slug: 'srv', token: r.view.config12 }, BY)).toMatchObject({ ok: false, code: 'E_HALTED' });
    const dead = mk({ MCP_SCENARIO: 'nonjson' });
    expect(await dead.a.approve({ slug: 'srv', token: r.view.config12 }, BY)).toMatchObject({ ok: false, code: 'E_PROBE' });
    expect(await m.a.approve({ slug: 'srv', token: r.view.config12 }, BY)).toMatchObject({ ok: true });
    expect(await m.a.approve({ slug: 'srv', token: r.view.config12 }, BY)).toMatchObject({ ok: false, code: 'E_STATE' });
  });
  it('the ninth active server cannot be approved even when a row got around stage (E_MAX_SERVERS)', async () => {
    for (let i = 0; i < 8; i++) {
      const { m, r } = await stage(mk(), { slug: `s${i}x` });
      await m.a.approve({ slug: `s${i}x`, token: r.view.config12 }, BY);
    }
    const snap = (await rowOf('s0x')).snapshot;
    await db.pool.query("INSERT INTO mcp_servers (slug, title, image_id, tool_class, snapshot, snapshot_sha256, added_by) SELECT 'nine', 't', image_id, 'write', snapshot, snapshot_sha256, added_by FROM mcp_servers WHERE slug = 's0x'");
    await db.pool.query("INSERT INTO mcp_server_depts (server_id, dept_id, granted_by) SELECT id, 'software', $1 FROM mcp_servers WHERE slug = 'nine'", [ADMIN]);
    const row = await rowOf('nine');
    const token = configHash({ imageId: row.imageId, command: row.command, env: row.env, toolClass: row.toolClass, depts: row.depts, snapshotSha256: row.snapshotSha256 });
    expect(snap.length).toBe(2);
    expect(await mk().a.approve({ slug: 'nine', token }, BY)).toMatchObject({ ok: false, code: 'E_MAX_SERVERS' });
  });
});

describe('MCP-AC18 test, disable, depts, list, show', () => {
  it('test: ok or mismatch with an audit row and no state change; halted refused; a dead server is E_PROBE', async () => {
    const { m } = await stage();
    expect(await m.a.test('srv', BY)).toEqual({ ok: true, result: 'ok' });
    const ch = mk({ MCP_TOOLS: 'changed' });
    expect(await ch.a.test('srv', BY)).toEqual({ ok: true, result: 'mismatch' });
    expect(ch.audits.at(-1)).toMatchObject({ action: 'mcp.test', outcome: 'srv mismatch' });
    expect((await rowOf('srv')).status).toBe('pending');
    expect(await mk({ MCP_SCENARIO: 'nonjson' }).a.test('srv', BY)).toMatchObject({ ok: false, code: 'E_PROBE' });
    expect(await mk().a.test('zz', BY)).toMatchObject({ ok: false, code: 'E_STATE' });
    const h = mk();
    h.setHalted(true);
    expect(await h.a.test('srv', BY)).toMatchObject({ ok: false, code: 'E_HALTED' });
  });
  it('disable is allowed while halted, refreshes the host live, hands the expired approval ids to the card closer, and audits', async () => {
    const { m, r } = await stage();
    await m.a.approve({ slug: 'srv', token: r.view.config12 }, BY);
    await db.pool.query("INSERT INTO departments (id, name) VALUES ('hq','hq') ON CONFLICT DO NOTHING");
    await db.pool.query("INSERT INTO tasks (id, title, dept_id, owner, requester, root_id, origin, tainted) VALUES ('t1','t','hq','{}','{}','t1','chat',false)");
    const ap = (await db.pool.query<{ id: number }>("INSERT INTO approvals (task_id, reason, est_cost_usd, requested_by, kind, tool_name, tool_input, input_sha256) VALUES ('t1','r',0,'head:praw','tool','mcp_w_srv_echo','{}'::jsonb,'x') RETURNING id")).rows[0]!.id;
    const d = mk();
    d.setHalted(true);
    expect(await d.a.disable('srv', BY)).toEqual({ ok: true });
    expect(d.refreshes).toEqual([1]);
    expect(d.closed).toEqual([[ap]]);
    expect((await db.pool.query<{ status: string }>('SELECT status FROM approvals WHERE id = $1', [ap])).rows[0]!.status).toBe('expired');
    expect((await dbAudits()).at(-1)).toEqual({ actor: `user:${ADMIN}`, action: 'mcp.disable', outcome: 'srv' });
    expect(await d.a.disable('srv', BY)).toMatchObject({ ok: false, code: 'E_STATE' });
  });
  it('depts: refused while halted, validated, replaces the grants, refreshes the host, audits mcp.depts', async () => {
    const { m } = await stage();
    const h = mk();
    h.setHalted(true);
    expect(await h.a.depts('srv', 'hq', BY)).toMatchObject({ ok: false, code: 'E_HALTED' });
    expect(await m.a.depts('srv', 'nope', BY)).toMatchObject({ ok: false, code: 'E_DEPT' });
    expect(await m.a.depts('zz', 'hq', BY)).toMatchObject({ ok: false, code: 'E_STATE' });
    const d = mk();
    expect(await d.a.depts('srv', 'hq,praw', BY)).toEqual({ ok: true });
    expect((await rowOf('srv')).depts).toEqual(['hq', 'praw']);
    expect(d.refreshes).toEqual([1]);
    expect((await dbAudits()).at(-1)).toEqual({ actor: `user:${ADMIN}`, action: 'mcp.depts', outcome: 'srv 2' });
  });
  it('list and show render from the stored snapshot through the same model view; show of an unknown slug is E_STATE; list holds no snapshot', async () => {
    const { m, r } = await stage();
    const l = await m.a.list();
    expect(l).toEqual([{ slug: 'srv', title: 'Demo server', class: 'write', status: 'pending', depts: ['sales', 'software'], tools: 2, hash12: r.view.hash12 }]);
    const s = await m.a.show('srv');
    expect(s).toMatchObject({ ok: true });
    expect(s.ok && s.view.tools).toEqual(r.view.tools);
    expect(await m.a.show('zz')).toMatchObject({ ok: false, code: 'E_STATE' });
  });
  it('logs only error names; a repository failure on stage is E_INTERNAL', async () => {
    const m = mk({}, { repo: { ...repo, get: async () => null, stage: async () => { throw new Error('db password=hunter2'); } } as never });
    expect(await m.a.stage(input(), BY)).toMatchObject({ ok: false, code: 'E_INTERNAL' });
    expect(JSON.stringify(m.logs)).not.toContain('hunter2');
  });
});

describe('G2-MCP-02: the seccomp precondition (MC-C3) holds on every admin path that spawns the sandbox', () => {
  const BAD = ['["name=seccomp,profile=unconfined"]', '["name=cgroupns"]', 'not json', ''];
  const guarded = (info: string) => {
    const m = mk();
    let spawns = 0;
    const inner = m.d.sandbox.spawn;
    m.d.sandbox.spawn = (argv) => { spawns++; return inner(argv); };
    m.docker.info = info;
    return { m, spawns: () => spawns };
  };
  it.each(BAD)('add, approve and test refuse with E_SECCOMP and spawn nothing (info %j)', async (info) => {
    const { m: ok, r } = await stage();
    expect(ok.docker.execs.length).toBeGreaterThan(0);
    const g = guarded(info);
    expect(await g.m.a.stage(input({ slug: 'other' }), BY)).toMatchObject({ ok: false, code: 'E_SECCOMP' });
    expect(await g.m.a.approve({ slug: 'srv', token: r.view.config12 }, BY)).toMatchObject({ ok: false, code: 'E_SECCOMP' });
    expect(await g.m.a.test('srv', BY)).toMatchObject({ ok: false, code: 'E_SECCOMP' });
    expect(g.spawns()).toBe(0);
    expect(g.m.docker.execs.some((e) => e[0] === 'run')).toBe(false);
    expect((await rowOf('srv')).status).toBe('pending');
    expect(await repo.get('other')).toBeNull();
    expect(g.m.audits.map((a) => a.outcome)).toEqual(['refused:E_SECCOMP', 'refused:E_SECCOMP', 'srv E_SECCOMP']);
  });
  it('a throwing docker port is a refusal too, and a good seccomp answer still probes', async () => {
    const g = guarded('["name=seccomp,profile=builtin"]');
    expect(await g.m.a.stage(input(), BY)).toMatchObject({ ok: true });
    expect(g.spawns()).toBe(1);
    const t = mk();
    const exec = t.docker.exec.bind(t.docker);
    t.d.docker = { exec: (a: readonly string[]) => { if (a[0] === 'info') throw new Error('boom'); return exec(a); } };
    t.d.sandbox.docker = t.d.docker;
    expect(await new McpAdmin(t.d).test('srv', BY)).toMatchObject({ ok: false, code: 'E_SECCOMP' });
  });
});

describe('G2-MCP-06: the host refresh names the slug on approve and on a successful test of an active server', () => {
  it('approve refreshes with its slug; test ok on an ACTIVE server refreshes with its slug; a pending or mismatching test does not', async () => {
    const calls: (string | undefined)[] = [];
    const host = { refresh: async (s?: string) => void calls.push(s) };
    const { m, r } = await stage(mk({}, { host }));
    expect(await m.a.test('srv', BY)).toEqual({ ok: true, result: 'ok' });
    expect(calls).toEqual([]);
    expect(await m.a.approve({ slug: 'srv', token: r.view.config12 }, BY)).toMatchObject({ ok: true });
    expect(calls).toEqual(['srv']);
    expect(await m.a.test('srv', BY)).toEqual({ ok: true, result: 'ok' });
    expect(calls).toEqual(['srv', 'srv']);
    const ch = mk({ MCP_TOOLS: 'changed' }, { host });
    expect(await ch.a.test('srv', BY)).toEqual({ ok: true, result: 'mismatch' });
    expect(calls).toEqual(['srv', 'srv']);
  });
});

describe('R7 BE1: McpAdmin.stageRelease (PF-C9, FG-AC08)', () => {
  beforeEach(async () => { await resetForgeTables(db.pool); });
  const RBY = (releaseId: number) => ({ kind: 'release', releaseId, decidedBy: ADMIN }) as const;
  const rin = (releaseId: number, o: Record<string, unknown> = {}) => ({ slug: 'hello', image: IMG, departments: 'software', title: 'Hello', ref: `forge:release-${releaseId}`, ...o });
  async function ready(o: { build?: Partial<Parameters<typeof newBuild>[1]> } = {}) {
    const f = await newForge(db.pool);
    const rel = await newRelease(db.pool, { forgeId: f.forgeId, projectId: f.projectId });
    const b = await newBuild(db.pool, { forgeId: f.forgeId, releaseId: rel, status: 'building', imageId: IMG, ...o.build });
    return { f, rel, b };
  }
  it('stages a pending write-class row with the hard-coded command, env, timeout and daily, source release, and the system:forge audit; returns the narrow shape', async () => {
    const { rel } = await ready();
    const m = mk();
    const r = await m.a.stageRelease(rin(rel), RBY(rel));
    expect(r).toMatchObject({ ok: true, slug: 'hello', toolCount: 2 });
    const row = await rowOf('hello');
    expect(row).toMatchObject({ status: 'pending', toolClass: 'write', command: [], env: {}, timeoutMs: 60000, maxCallsPerDay: 100, source: 'release', releaseId: rel, addedBy: ADMIN, depts: ['software'], imageRef: `forge:release-${rel}` });
    expect(r.ok && r.config12).toBe(configHash({ imageId: IMG, command: [], env: {}, toolClass: 'write', depts: ['software'], snapshotSha256: row.snapshotSha256 }));
    expect(Object.keys(r).sort()).toEqual(['config12', 'ok', 'slug', 'toolCount']);
    expect((await dbAudits()).at(-1)).toEqual({ actor: 'system:forge', action: 'mcp.add', outcome: `pending hello ${r.ok ? r.config12 : ''} 2 release:#${rel}` });
  });
  it('the input type carries no class, command, env, timeout or daily (PF-C9), and extra fields at run time change nothing', async () => {
    const { rel } = await ready();
    // @ts-expect-error class is not part of the input
    const a: Parameters<McpAdmin['stageRelease']>[0] = { slug: 'hello', image: IMG, departments: 'software', title: 't', ref: 'r', class: 'read' };
    // @ts-expect-error command is not part of the input
    const b: Parameters<McpAdmin['stageRelease']>[0] = { slug: 'hello', image: IMG, departments: 'software', title: 't', ref: 'r', command: '["x"]' };
    // @ts-expect-error env is not part of the input
    const c: Parameters<McpAdmin['stageRelease']>[0] = { slug: 'hello', image: IMG, departments: 'software', title: 't', ref: 'r', env: 'A=b' };
    // @ts-expect-error timeout and daily are not part of the input
    const d: Parameters<McpAdmin['stageRelease']>[0] = { slug: 'hello', image: IMG, departments: 'software', title: 't', ref: 'r', timeout: 5, daily: 1 };
    void [a, b, c, d];
    const r = await mk().a.stageRelease(rin(rel, { class: 'read', command: '["node","x"]', env: 'A=b', timeout: 5, daily: 1 }) as never, RBY(rel));
    expect(r.ok).toBe(true);
    expect(await rowOf('hello')).toMatchObject({ toolClass: 'write', command: [], env: {}, timeoutMs: 60000, maxCallsPerDay: 100 });
  });
  it('actor shapes: stage takes only an admin by, stageRelease only a release by with a positive integer release id and a snowflake decider', async () => {
    const { rel } = await ready();
    await expect(mk().a.stage(input(), RBY(rel) as never)).rejects.toThrow();
    await expect(mk().a.stageRelease(rin(rel), BY as never)).rejects.toThrow();
    for (const bad of [{ kind: 'release', releaseId: 0, decidedBy: ADMIN }, { kind: 'release', releaseId: 1.5, decidedBy: ADMIN }, { kind: 'release', releaseId: -1, decidedBy: ADMIN }, { kind: 'release', releaseId: rel, decidedBy: 'x' }, { kind: 'release', releaseId: rel }, null, undefined]) {
      await expect(mk().a.stageRelease(rin(rel), bad as never)).rejects.toThrow();
    }
    expect(await repo.get('hello')).toBeNull();
    // add() is an alias of stage() and is admin only too
    await expect(mk().a.add(input(), RBY(rel) as never)).rejects.toThrow();
  });
  it('E_STATE (system:forge audit, nothing spawned) without a released release, a building build, a matching slug, image or decider', async () => {
    const cases: [string, () => Promise<{ rel: number; by?: Record<string, unknown>; over?: Record<string, unknown> }>][] = [
      ['unknown release', async () => ({ rel: 4242 })],
      ['build not building', async () => ({ rel: (await ready({ build: { status: 'queued', imageId: null } })).rel })],
      ['other slug', async () => { const r = await ready(); return { rel: r.rel, over: { slug: 'other' } }; }],
      ['other image', async () => { const r = await ready({ build: { imageId: `sha256:${'9'.repeat(64)}` } }); return { rel: r.rel }; }],
      ['other decider', async () => { const r = await ready(); return { rel: r.rel, by: { kind: 'release', releaseId: r.rel, decidedBy: '900000000000000002' } }; }],
      ['other department', async () => { const r = await ready(); return { rel: r.rel, over: { departments: 'sales' } }; }],
    ];
    for (const [name, mkc] of cases) {
      await resetForgeTables(db.pool);
      const c = await mkc();
      const m = mk();
      let spawns = 0;
      const inner = m.d.sandbox.spawn;
      m.d.sandbox.spawn = (argv) => { spawns++; return inner(argv); };
      const r = await m.a.stageRelease(rin(c.rel, c.over), (c.by ?? RBY(c.rel)) as never);
      expect(r, name).toEqual({ ok: false, code: 'E_STATE' });
      expect(spawns, name).toBe(0);
      expect(m.docker.execs.some((e) => e[0] === 'run'), name).toBe(false);
      expect(m.audits.at(-1), name).toEqual({ actor: 'system:forge', action: 'mcp.add', tool: null, outcome: 'refused:E_STATE' });
      expect(await repo.get('hello'), name).toBeNull();
    }
  });
  it('seccomp is checked before the probe: a bad answer is E_SECCOMP and nothing is spawned', async () => {
    const { rel } = await ready();
    const m = mk();
    let spawns = 0;
    const inner = m.d.sandbox.spawn;
    m.d.sandbox.spawn = (argv) => { spawns++; return inner(argv); };
    m.docker.info = '["name=seccomp,profile=unconfined"]';
    expect(await m.a.stageRelease(rin(rel), RBY(rel))).toEqual({ ok: false, code: 'E_SECCOMP' });
    expect(spawns).toBe(0);
  });
  it('E_HALTED while halted; the other refusals map to their McpAdmin codes (probe, tools, image)', async () => {
    const { rel } = await ready();
    const h = mk();
    h.setHalted(true);
    expect(await h.a.stageRelease(rin(rel), RBY(rel))).toEqual({ ok: false, code: 'E_HALTED' });
    expect(await mk({ MCP_TOOLS: 'none' }).a.stageRelease(rin(rel), RBY(rel))).toEqual({ ok: false, code: 'E_TOOLS_NONE' });
    expect(await mk({ MCP_SCENARIO: 'badversion' }).a.stageRelease(rin(rel), RBY(rel))).toEqual({ ok: false, code: 'E_PROBE' });
    const g = mk();
    g.docker.imageId = `sha256:${'d'.repeat(64)}`;
    expect(await g.a.stageRelease(rin(rel), RBY(rel))).toEqual({ ok: false, code: 'E_IMAGE' });
  });
  it('a slug that is already pending is E_EXISTS', async () => {
    const { rel } = await ready();
    expect((await mk().a.stageRelease(rin(rel), RBY(rel))).ok).toBe(true);
    expect(await mk().a.stageRelease(rin(rel), RBY(rel))).toEqual({ ok: false, code: 'E_EXISTS' });
  });
});

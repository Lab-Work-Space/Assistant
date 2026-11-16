import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../../app.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { FakeMcpDocker, fixtureSpawner } from '../../mcp/test-helpers.js';
import { McpRepo } from '../../db/repos/mcp.js';
import { handleInteraction } from '../../discord/index.js';
import { buildSnapshot, configSha256 } from '../../mcp/snapshot.js';
import { interaction } from '../../discord/commands/test-helpers.js';
import { boot, migrateUp, resetDb } from './helpers.js';

/** R6 MCP-1 BE2 (spec 5.14, MCP-AC17, MCP-AC23): the app boot. With `mcp.enabled` off nothing touches Docker and nothing changes. */
let db: TestDb;
let app: App | null = null;
beforeAll(async () => {
  db = await freshDb();
  await migrateUp(db.pool);
});
afterEach(async () => {
  await app?.stop();
  app = null;
  await resetDb(db.pool);
});
afterAll(async () => { await db.close(); });

const bootRows = async (): Promise<string[]> => (await db.pool.query("SELECT outcome FROM audit_log WHERE action = 'mcp.boot' ORDER BY id")).rows.map((r: { outcome: string }) => r.outcome);
const on = (): Promise<unknown> => db.pool.query("INSERT INTO config (key, value) VALUES ('mcp.enabled', 'true')");

describe('app boot and the mcp.enabled switch', () => {
  it('off (the default): no Docker call at all, no mcp.boot row, no external tool, and the app is up', async () => {
    const docker = new FakeMcpDocker();
    const t = await boot(db.pool, { mcp: { docker, spawn: fixtureSpawner() } });
    app = t.app;
    expect(docker.execs).toEqual([]);
    expect(await bootRows()).toEqual([]);
    expect(t.app.services.healthUrl()).not.toBeNull();
    expect(t.app.services.mcp.booted()).toBe(false);
    expect(t.app.services.mcp.names()).toEqual([]);
  });
  it('on at start: boots in the background (version, info, ps, sweep), audits `ok 0`', async () => {
    await on();
    const docker = new FakeMcpDocker();
    const t = await boot(db.pool, { mcp: { docker, spawn: fixtureSpawner() } });
    app = t.app;
    await vi.waitFor(async () => expect(await bootRows()).toEqual(['ok 0']), { timeout: 5000 });
    expect(docker.execs.map((a) => a[0])).toEqual(expect.arrayContaining(['version', 'info', 'ps']));
    expect(t.app.services.mcp.booted()).toBe(true);
  });
  it('on at start with Docker missing: the app still starts and the boot leaves MCP off with a fixed reason', async () => {
    await on();
    const docker = new FakeMcpDocker();
    docker.missing = true;
    const t = await boot(db.pool, { mcp: { docker, spawn: fixtureSpawner() } });
    app = t.app;
    await vi.waitFor(async () => expect(await bootRows()).toEqual(['off:docker']), { timeout: 5000 });
    expect(t.app.services.healthUrl()).not.toBeNull();
    expect(t.app.services.mcp.booted()).toBe(false);
  });
  it('turned on at run time with /settings: the boot runs then (no restart needed); turning it off again does not boot twice', async () => {
    const docker = new FakeMcpDocker();
    const t = await boot(db.pool, { mcp: { docker, spawn: fixtureSpawner() } });
    app = t.app;
    expect(docker.execs).toEqual([]);
    await t.app.services.cfg.set('mcp.enabled', true, 'test');
    await vi.waitFor(async () => expect(await bootRows()).toEqual(['ok 0']), { timeout: 5000 });
    await t.app.services.cfg.set('mcp.enabled', false, 'test');
    await t.app.services.cfg.set('mcp.enabled', true, 'test');
    await new Promise((r) => setTimeout(r, 100));
    expect(await bootRows()).toEqual(['ok 0']);
  });
});

describe('047: the app wiring quarantines a row edited behind its approval at boot', () => {
  const IMG = `sha256:${'c'.repeat(64)}`;
  const ADM = '900000000000000001';
  async function approvedRow() {
    const RAW = [{ name: 'echo', description: 'Echoes.', inputSchema: { type: 'object' } }];
    const b = buildSnapshot(RAW, { slug: 'srv', toolClass: 'read' });
    const r = new McpRepo(db.pool);
    const st = await r.stage({ slug: 'srv', title: 't', imageId: IMG, imageRef: 'x:1', command: [], env: {}, toolClass: 'read', timeoutMs: 60000, maxCallsPerDay: 100, snapshot: b.raw, snapshotSha256: b.sha256, depts: ['hq'], by: ADM, cfg12: 'abcdef012345' });
    if (!st.ok) throw new Error('stage');
    await r.activate({ slug: 'srv', snapshotSha256: b.sha256, check: () => 'abcdef012345', fullHash: configSha256, by: ADM });
  }
  it('an intact approved row loads (control)', async () => {
    await db.pool.query("INSERT INTO departments (id, name) VALUES ('hq','hq') ON CONFLICT DO NOTHING");
    await approvedRow();
    await on();
    const t = await boot(db.pool, { mcp: { docker: new FakeMcpDocker(), spawn: fixtureSpawner() } });
    app = t.app;
    await vi.waitFor(async () => expect(await bootRows()).toEqual(['ok 1']), { timeout: 5000 });
    expect(t.app.services.mcp.names()).toEqual(['mcp_r_srv_echo']);
  });
  it('a row whose command was edited in the database: not loaded, quarantined (config_changed), one audit row, nothing spawned', async () => {
    await db.pool.query("INSERT INTO departments (id, name) VALUES ('hq','hq') ON CONFLICT DO NOTHING");
    await approvedRow();
    await db.pool.query('UPDATE mcp_servers SET command = \'["--evil"]\'::jsonb WHERE slug = \'srv\'');
    await on();
    const sp = fixtureSpawner();
    const t = await boot(db.pool, { mcp: { docker: new FakeMcpDocker(), spawn: sp } });
    app = t.app;
    await vi.waitFor(async () => expect(await bootRows()).toEqual(['ok 0']), { timeout: 5000 });
    expect(t.app.services.mcp.names()).toEqual([]);
    expect((await db.pool.query('SELECT status, quarantine_reason FROM mcp_servers')).rows).toEqual([{ status: 'quarantined', quarantine_reason: 'config_changed' }]);
    expect((await db.pool.query("SELECT outcome FROM audit_log WHERE action = 'mcp.quarantine'")).rows).toEqual([{ outcome: 'srv config_changed' }]);
    expect(sp.log.spawned).toBe(0);
  });
});

describe('R6 BE3: a click on a stale approval card of an MCP tool fails closed (MC-C8)', () => {
  const IMG = `sha256:${'c'.repeat(64)}`;
  const SHA = 'a'.repeat(64);
  const STALE = 'This approval was already decided.';
  async function setup(leave: (r: McpRepo, id: number) => Promise<unknown>) {
    const sp = fixtureSpawner();
    const t = await boot(db.pool, { mcp: { docker: new FakeMcpDocker(), spawn: sp } });
    app = t.app;
    const r = new McpRepo(db.pool);
    const st = await r.stage({ slug: 'srv', title: 't', imageId: IMG, imageRef: 'x:1', command: [], env: {}, toolClass: 'write', timeoutMs: 60000, maxCallsPerDay: 100, snapshot: [{ name: 'echo', inputSchema: { type: 'object' } }], snapshotSha256: SHA, depts: ['software'], by: '900000000000000001', cfg12: 'abcdef012345' });
    if (!st.ok) throw new Error('stage');
    await r.activate({ slug: 'srv', snapshotSha256: SHA, check: () => 'abcdef012345', fullHash: configSha256, by: '900000000000000001' });
    await db.pool.query("INSERT INTO departments (id, name) VALUES ('hq','hq') ON CONFLICT DO NOTHING");
    await db.pool.query("INSERT INTO tasks (id, title, dept_id, owner, requester, root_id, origin, tainted) VALUES ('t1','t','hq','{}','{}','t1','chat',false)");
    const ap = (await db.pool.query<{ id: number }>("INSERT INTO approvals (task_id, reason, est_cost_usd, requested_by, kind, tool_name, tool_input, input_sha256) VALUES ('t1','r',0,'head:praw','tool','mcp_w_srv_echo','{\"text\":\"x\"}'::jsonb,'x') RETURNING id")).rows[0]!.id;
    await db.pool.query("UPDATE tasks SET status = 'awaiting_approval', awaiting_approval_id = $1 WHERE id = 't1'", [ap]);
    await leave(r, st.id);
    return { t, sp, ap };
  }
  const click = async (t: Awaited<ReturnType<typeof setup>>['t'], ap: number, action: 'approve' | 'reject') => {
    const reply = await handleInteraction(interaction({ kind: 'button', customId: `approval:${ap}:${action}`, userId: 'admin1' }), t.app.services.commands);
    await t.app.services.scheduler.idle();
    return reply;
  };
  const noCall = async (sp: ReturnType<typeof fixtureSpawner>) => {
    expect(sp.log.spawned).toBe(0);
    expect(sp.log.stdin.filter((l) => l.includes('tools/call'))).toEqual([]);
    expect((await db.pool.query('SELECT 1 FROM mcp_call_counts')).rowCount).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM audit_log WHERE action LIKE 'mcp.call%'")).rowCount).toBe(0);
  };
  it.each([
    ['quarantined', (r: McpRepo, id: number) => r.quarantine({ id, slug: 'srv', snapshotSha256: SHA })],
    ['disabled', (r: McpRepo) => r.disable('srv', '900000000000000001')],
  ])('after the server is %s: the open card expired, its task left awaiting_approval, and Approve and Reject both answer the fixed text with no call', async (_n, leave) => {
    const { t, sp, ap } = await setup(leave);
    expect((await db.pool.query<{ status: string }>('SELECT status FROM approvals WHERE id = $1', [ap])).rows[0]!.status).toBe('expired');
    expect((await db.pool.query<{ status: string }>("SELECT status FROM tasks WHERE id = 't1'")).rows[0]!.status).toBe('cancelled');
    for (const a of ['approve', 'reject'] as const) expect(JSON.stringify(await click(t, ap, a))).toContain(STALE);
    await noCall(sp);
  });
  it('an expired approval row (the hourly sweep) answers the same; and the status stays expired', async () => {
    const { t, sp, ap } = await setup(async () => undefined);
    await db.pool.query("UPDATE mcp_servers SET status = 'disabled', disabled_by = '900000000000000001', disabled_at = now(), approved_config_sha256 = NULL, approved_by = NULL, approved_at = NULL WHERE slug = 'srv'");
    await db.pool.query("UPDATE approvals SET status = 'expired', decided_at = now() WHERE id = $1", [ap]);
    expect(JSON.stringify(await click(t, ap, 'approve'))).toContain(STALE);
    expect((await db.pool.query<{ status: string }>('SELECT status FROM approvals WHERE id = $1', [ap])).rows[0]!.status).toBe('expired');
    await noCall(sp);
  });
});

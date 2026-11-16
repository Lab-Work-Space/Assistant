import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { McpRepo } from '../db/repos/mcp.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import type { ToolContext, ToolPlugin } from '../tools/types.js';
import { McpAdmin } from './admin.js';
import { MCP_TEXT } from './errors.js';
import { McpHost } from './host.js';
import { StuckLatch } from './sandbox.js';
import { CONFIG_NOTICE, quarantineConfig } from './quarantine.js';
import { Slots } from './slots.js';
import { configSha256 } from './snapshot.js';
import { FakeMcpDocker, fixtureSpawner } from './test-helpers.js';
import { QUARANTINE_NOTICE, createMcpToolFactory } from './tool.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const ADMIN = '900000000000000001';
const BY = { kind: 'admin', userId: ADMIN } as const;
const IMG = `sha256:${'c'.repeat(64)}`;
const ROOT = '00000000-0000-4000-8000-000000000001';

let db: TestDb;
let repo: McpRepo;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, dir, 'up'); repo = new McpRepo(db.pool); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { for (const t of ['approvals', 'mcp_call_counts', 'mcp_server_depts', 'mcp_servers', 'audit_log', 'tasks']) await db.pool.query(`DELETE FROM ${t}`); });

function stack(env: Record<string, string> = {}) {
  const docker = new FakeMcpDocker();
  const sp = fixtureSpawner(env);
  const notices: string[] = [];
  const audits: { action: string; outcome?: string | null }[] = [];
  const sandbox = { docker, spawn: sp, isHalted: () => false, latch: new StuckLatch(), newSuffix: () => 'abcdef01', haltPollMs: 15, clientGraceMs: 40, hardTimeoutMs: 8000 };
  const audit = async (e: { action: string; outcome?: string | null; actor: string; tool?: string | null; taskId?: string | null }) => {
    audits.push(e);
    await db.pool.query('INSERT INTO audit_log (actor, action, task_id, tool, outcome) VALUES ($1,$2,$3,$4,$5)', [e.actor, e.action, e.taskId ?? null, e.tool ?? null, e.outcome ?? null]);
  };
  const deps = { repo, sandbox, slots: new Slots({ waitMs: 200 }), enabled: () => true, halted: () => false, tz: () => 'Asia/Bangkok', caps: () => ({ tree: 40, day: 200 }), audit, secrets: () => [], notify: async (t: string) => void notices.push(t), log: { error() {} } };
  const host = new McpHost({ onConfigChanged: (row) => quarantineConfig({ repo, notify: deps.notify, log: { error() {} } }, row), repo, makeTool: (s, t) => createMcpToolFactory({ ...deps, host })(s, t), secrets: () => [], incident: () => undefined, log: { error() {} } });
  const admin = new McpAdmin({ repo, docker, sandbox, host, halted: () => false, deptExists: (d) => ['software', 'sales'].includes(d), audit, secrets: () => [], log: { error() {} } });
  const ctx = (): ToolContext => ({ actor: { kind: 'head', dept: 'software' }, task: { id: 'task-1', rootId: ROOT }, direct: false, tainted: () => false }) as never;
  return { docker, sp, notices, audits, host, admin, ctx };
}

describe('MCP-AC18 / AC27 (fixture): add, approve, call, snapshot change, quarantine, in one real database', () => {
  it('the whole path: a granted department calls the approved tool; a changed tool list quarantines, drops the tools, expires the card and posts one notice', async () => {
    const s = stack();
    const added = await s.admin.add({ slug: 'srv', image: IMG, departments: 'software', title: 'Demo', class: 'write' }, BY);
    expect(added.ok).toBe(true);
    expect(await s.host.load()).toEqual({ loaded: 0, failed: [] }); // pending: not callable
    const token = (added as { view: { config12: string } }).view.config12;
    expect(await s.admin.approve({ slug: 'srv', token }, BY)).toMatchObject({ ok: true });
    expect([...s.host.names()]).toEqual(['mcp_w_srv_add_numbers', 'mcp_w_srv_echo']);
    expect(s.host.mcpFor('software')).toEqual(['mcp_w_srv_add_numbers', 'mcp_w_srv_echo']);
    expect(s.host.mcpFor('sales')).toEqual([]);
    const p = s.host.get('mcp_w_srv_echo') as ToolPlugin<{ text: string }>;
    const input = { text: 'hello' };
    expect(await p.precheck!(input, s.ctx())).toBeNull();
    expect(await p.run(input, s.ctx())).toEqual({ content: 'echo:hello' });
    const counts = (await db.pool.query<{ scope: string; scope_key: string; used: number }>('SELECT scope, scope_key, used FROM mcp_call_counts ORDER BY scope')).rows;
    expect(counts.map((c) => [c.scope, c.used])).toEqual([['day', 1], ['server_day', 1], ['tree', 1]]);
    expect(counts.find((c) => c.scope === 'tree')!.scope_key).toBe(ROOT);
    // an open write card for this server, then the server changes its tool list
    await db.pool.query("INSERT INTO departments (id, name) VALUES ('hq','hq') ON CONFLICT DO NOTHING");
    await db.pool.query("INSERT INTO tasks (id, title, dept_id, owner, requester, root_id, origin, tainted) VALUES ('t1','t','hq','{}','{}','t1','chat',false)");
    const ap = (await db.pool.query<{ id: number }>("INSERT INTO approvals (task_id, reason, est_cost_usd, requested_by, kind, tool_name, tool_input, input_sha256) VALUES ('t1','r',0,'head:praw','tool','mcp_w_srv_echo','{}'::jsonb,'x') RETURNING id")).rows[0]!.id;
    const changed = stack({ MCP_TOOLS: 'changed' });
    await changed.host.load();
    const q = changed.host.get('mcp_w_srv_echo') as ToolPlugin<{ text: string }>;
    const res = await q.run({ text: 'x' }, changed.ctx());
    expect(res).toEqual({ content: MCP_TEXT.E_CHANGED, isError: true });
    expect(changed.sp.log.stdin.map((l) => (JSON.parse(l) as { method?: string }).method)).not.toContain('tools/call');
    expect((await repo.get('srv'))).toMatchObject({ status: 'quarantined', quarantineReason: 'snapshot_changed' });
    expect(changed.host.names()).toEqual([]);
    expect(changed.notices).toEqual([QUARANTINE_NOTICE('srv')]);
    expect((await db.pool.query<{ status: string }>('SELECT status FROM approvals WHERE id = $1', [ap])).rows[0]!.status).toBe('expired');
    const rows = (await db.pool.query<{ actor: string; action: string; outcome: string }>("SELECT actor, action, outcome FROM audit_log WHERE action LIKE 'mcp.%' ORDER BY id")).rows;
    expect(rows.map((r) => `${r.actor.startsWith('user:') ? 'user' : r.actor} ${r.action} ${r.outcome.split(' ')[0]}`)).toEqual([
      'user mcp.add pending', 'user mcp.approve active', 'head:software mcp.call start', 'head:software mcp.call.end ok', 'head:software mcp.call start', 'system:mcp mcp.quarantine srv', 'head:software mcp.call.end E_CHANGED',
    ]);
  });
  it('a quarantined server is not callable after a refresh: precheck says E_GONE for the old plugin', async () => {
    const s = stack();
    const added = await s.admin.add({ slug: 'srv', image: IMG, departments: 'software', title: 'Demo' }, BY);
    await s.admin.approve({ slug: 'srv', token: (added as { view: { config12: string } }).view.config12 }, BY);
    const p = s.host.get('mcp_w_srv_echo') as ToolPlugin<{ text: string }>;
    await s.admin.disable('srv', BY);
    expect(await p.precheck!({ text: 'x' }, s.ctx())).toEqual({ refuse: MCP_TEXT.E_GONE });
  });
});

describe('047: a direct database edit of an approved row never loads (fixture, one real database)', () => {
  const OTHER = `sha256:${'d'.repeat(64)}`;
  const edits: [string, string, unknown[]][] = [
    ['image_id', 'UPDATE mcp_servers SET image_id = $2 WHERE slug = $1', [OTHER]],
    ['command', "UPDATE mcp_servers SET command = '[\"--evil\"]'::jsonb WHERE slug = $1", []],
    ['env', "UPDATE mcp_servers SET env = '{\"A\":\"b\"}'::jsonb WHERE slug = $1", []],
    ['tool_class', "UPDATE mcp_servers SET tool_class = 'read' WHERE slug = $1", []],
    ['a grant row (insert)', "INSERT INTO mcp_server_depts (server_id, dept_id, granted_by) SELECT id, 'sales', '900000000000000001' FROM mcp_servers WHERE slug = $1", []],
    ['a grant row (delete)', 'DELETE FROM mcp_server_depts WHERE server_id = (SELECT id FROM mcp_servers WHERE slug = $1)', []],
  ];
  async function approved(s: ReturnType<typeof stack>, cls: 'read' | 'write' = 'write') {
    const added = await s.admin.add({ slug: 'srv', image: IMG, departments: 'software', title: 'Demo', class: cls }, BY);
    const token = (added as { view: { config12: string } }).view.config12;
    expect(await s.admin.approve({ slug: 'srv', token }, BY)).toMatchObject({ ok: true });
  }
  const spawned = (s: ReturnType<typeof stack>) => s.docker.execs.filter((a) => a[0] === 'run' || a[0] === 'create' || a[0] === 'start').length + s.sp.log.stdin.length;
  it.each(edits)('%s: the next load does not load it, quarantines it (config_changed), audits once, posts one notice, spawns nothing', async (_n, sql, params) => {
    const s = stack();
    await approved(s);
    const base = spawned(s);
    await db.pool.query(sql, ['srv', ...params]);
    expect(await s.host.load()).toEqual({ loaded: 0, failed: ['srv'] });
    expect(s.host.names()).toEqual([]);
    expect(await repo.get('srv')).toMatchObject({ status: 'quarantined', quarantineReason: 'config_changed' });
    expect((await db.pool.query("SELECT actor, outcome FROM audit_log WHERE action = 'mcp.quarantine'")).rows).toEqual([{ actor: 'system:mcp', outcome: 'srv config_changed' }]);
    expect(s.notices).toEqual([CONFIG_NOTICE('srv')]);
    expect(spawned(s)).toBe(base);
    expect(await s.host.load()).toEqual({ loaded: 0, failed: [] }); // quarantined now: not active, nothing more to do
    expect(s.notices).toHaveLength(1);
  });
  it.each(edits)('%s: a plugin loaded before the edit is refused E_CONFIG on its next call, nothing spawned', async (_n, sql, params) => {
    const s = stack();
    await approved(s);
    const p = s.host.get('mcp_w_srv_echo') as ToolPlugin<{ text: string }>;
    const base = spawned(s);
    await db.pool.query(sql, ['srv', ...params]);
    expect(await p.precheck!({ text: 'x' }, s.ctx())).toEqual({ refuse: MCP_TEXT.E_CONFIG });
    expect(await p.run({ text: 'x' }, s.ctx())).toEqual({ content: MCP_TEXT.E_GONE, isError: true }); // the refresh in precheck already dropped it from the host
    expect(await repo.get('srv')).toMatchObject({ status: 'quarantined', quarantineReason: 'config_changed' });
    expect(spawned(s)).toBe(base);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM mcp_call_counts')).rows[0]!.n).toBe(0);
  });
  it('/mcp depts keeps a legitimate row loaded with a rewritten pin, and refuses a row edited behind the approval', async () => {
    const s = stack();
    await approved(s);
    expect(await s.admin.depts('srv', 'software,sales', BY)).toEqual({ ok: true });
    const row = (await repo.get('srv'))!;
    expect(row.approvedConfigSha256).toBe(configSha256(row));
    expect(s.host.mcpFor('sales')).toEqual(['mcp_w_srv_add_numbers', 'mcp_w_srv_echo']);
    const p = s.host.get('mcp_w_srv_echo') as ToolPlugin<{ text: string }>;
    expect(await p.precheck!({ text: 'x' }, s.ctx())).toBeNull();
    await db.pool.query('UPDATE mcp_servers SET image_id = $2 WHERE slug = $1', ['srv', OTHER]);
    expect(await s.admin.depts('srv', 'software', BY)).toMatchObject({ ok: false, code: 'E_STATE' });
    expect((await repo.get('srv'))!.depts).toEqual(['sales', 'software']);
    expect(await s.host.load()).toEqual({ loaded: 0, failed: ['srv'] });
  });
});


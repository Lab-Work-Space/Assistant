import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { z } from 'zod';
import { approvedToolContext } from '../../agents/loop/loop.js';
import { setup } from '../../agents/loop/loop-fixture.js';
import { AutopilotService } from '../../governance/autopilot.js';
import { createToolPolicy } from '../../tools/policy.js';
import { ToolRegistry } from '../../tools/registry.js';
import type { ToolPlugin } from '../../tools/types.js';
import { DepartmentRepo, ProjectRepo, TaskRepo } from './index.js';

/** R6 MCP-1 BE2 (MC-C1): a project_tools or tree_tools row naming an mcp_ tool, planted by SQL, is never read back, and the repo inserts refuse the name. */
let db: TestDb;
let tasks: TaskRepo;
let repo: ProjectRepo;
const hq: ActorRef = { kind: 'head', dept: 'hq' };
const ADMIN = '123456789012345678';
const R = 'mcp_r_ab_x';
const W = 'mcp_w_ab_y';

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'), 'up');
  await new DepartmentRepo(db.pool).upsert({ id: 'hq', name: 'HQ', categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
  tasks = new TaskRepo(db.pool);
});
beforeEach(async () => {
  repo = new ProjectRepo(db.pool, { cfg: new FakeConfig({ 'autopilot.scope': 'company' } as never), halt: { isHalted: () => false } });
  for (const t of ['tree_tools', 'project_tools', 'projects', 'task_grants', 'web_grants', 'ot_requests', 'approvals', 'audit_log', 'budget_days']) await db.pool.query(`DELETE FROM ${t}`);
  await db.pool.query('UPDATE tasks SET parent_id = NULL');
  await db.pool.query('DELETE FROM tasks');
});
afterAll(async () => { await db.close(); });

const root = () => tasks.create({ title: 'r', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: '1' }, origin: 'chat', status: 'todo' });
const startProject = async () => {
  const r = await repo.create({ title: 'P', goal: 'g', deadline: '2099-01-01', maxLocalCalls: 100, maxUsd: 5, proposer: 'head:hq', tainted: false, adopt: [] });
  if (!r.ok) throw new Error(`create ${r.code}`);
  const d = await repo.decide({ token: r.project.token, by: ADMIN });
  if (!d.ok) throw new Error(`decide ${d.code}`);
  return d;
};

describe('MC-C1: project tools', () => {
  it('rows planted by SQL are filtered from toolsFor and toolsForTask; plain rows stay', async () => {
    const d = await startProject();
    await db.pool.query('INSERT INTO project_tools (project_id, dept_id, tool, task_id) VALUES ($1,$2,$3,$4),($1,$2,$5,$4),($1,$2,$6,$4)', [d.project.id, 'hq', R, d.root.id, W, 'web_search']);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM project_tools')).rows[0].n).toBe(3);
    expect(await repo.toolsFor(d.project.id, 'hq')).toEqual(['web_search']);
    expect(await repo.toolsForTask(d.root.id, 'hq')).toEqual(['web_search']);
  });
  it('grantTool refuses an mcp_ name and writes nothing', async () => {
    const d = await startProject();
    expect(await repo.grantTool({ projectId: d.project.id, deptId: 'hq', tool: R, taskId: d.root.id })).toEqual({ ok: false, code: 'mcp' });
    expect((await db.pool.query('SELECT count(*)::int AS n FROM project_tools')).rows[0].n).toBe(0);
    expect(await repo.grantTool({ projectId: d.project.id, deptId: 'hq', tool: 'web_search', taskId: d.root.id })).toEqual({ ok: true });
  });
});

describe('MC-C1: tree tools', () => {
  it('rows planted by SQL are filtered from treeToolsFor; grantTreeTool refuses the name', async () => {
    const r = await root();
    await db.pool.query('INSERT INTO tree_tools (root_task_id, dept_id, tool, task_id) VALUES ($1,$2,$3,$4),($1,$2,$5,$4),($1,$2,$6,$4)', [r.id, 'hq', R, r.id, W, 'read_file']);
    expect(await repo.treeToolsFor(r.id, 'hq')).toEqual(['read_file']);
    expect(await repo.grantTreeTool({ taskId: r.id, deptId: 'hq', tool: 'mcp_r_cd_z' })).toEqual({ ok: false, code: 'mcp' });
    expect((await db.pool.query("SELECT count(*)::int AS n FROM tree_tools WHERE tool = 'mcp_r_cd_z'")).rows[0].n).toBe(0);
  });
});

describe('MC-C1 chain: real rows, host holding the tool, switch on, department not granted', () => {
  it('SQL-planted project and tree rows never reach the allowlist: toolsForTask is empty and a replayed approved call is refused as not allowed', async () => {
    const d = await startProject();
    await db.pool.query('INSERT INTO project_tools (project_id, dept_id, tool, task_id) VALUES ($1,$2,$3,$4)', [d.project.id, 'hq', R, d.root.id]);
    await db.pool.query('INSERT INTO tree_tools (root_task_id, dept_id, tool, task_id) VALUES ($1,$2,$3,$4)', [d.root.id, 'hq', R, d.root.id]);
    const cfg = new FakeConfig({ 'autopilot.scope': 'company' } as never);
    const svc = new AutopilotService({ cfg, halted: () => false, secrets: [], exhausted: async () => true, log: { error: () => undefined }, repo, org: { persona: () => null }, describe: () => ({ kind: 'read' }) });
    const granted = await svc.toolsForTask(d.root.id, hq);
    expect(granted).toEqual([]);
    expect(await svc.toolsFor(d.project.id, hq)).toEqual([]);
    expect(await svc.treeToolsFor(d.root.id, hq)).toEqual([]);

    const plug: ToolPlugin<Record<string, unknown>> = { name: R, description: 'ext', inputSchema: z.object({ q: z.string() }).strict(), requiresApproval: () => false, kind: 'read', untrustedOutput: true, untrustedSource: 'mcp', run: async () => { throw new Error('ran'); } };
    const s = await setup({});
    const reg = new ToolRegistry({ halt: s.deps.halt, external: { get: (n) => (n === R ? plug : undefined), names: () => [R] } });
    s.deps.org.setToolPolicy(createToolPolicy(s.cfg, () => reg.names(), () => [], (n) => reg.kindOf(n), () => [], () => true));
    const task = (await tasks.get(d.root.id))!;
    const res = await reg.runApproved(R, { q: 'x' }, approvedToolContext(hq, task, s.deps, granted));
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/not allowed/);
    expect(reg.specsFor(s.deps.org.toolsFor(hq))).toEqual([]);
  });
});

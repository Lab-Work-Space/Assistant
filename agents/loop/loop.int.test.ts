import { mkdtempSync, rmSync } from 'node:fs';
import { TaskRuns } from '../tasks/task-runs.js';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Org, seed, type ActorRef } from '../../company/index.js';
import { ChannelMapRepo, DepartmentRepo, DeptNoteRepo, PersonaRepo, TaskRepo } from '../../db/index.js';
import { migrate } from '../../db/migrate.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { Approvals, Budget, Halt, Limits } from '../../governance/index.js';
import { ConfigStore } from '../../config/store.js';
import { insertGrant, WebGrantRepo } from '../../db/repos/web-grants.js';
import { fakeResolver, fakeTransport } from '../../tests/fakes/net.js';
import { fetchPageTool } from '../../tools/plugins/web/fetchPage.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { createClaudeCodeLocalProvider, FakeProvider, ProviderRegistry, type FakeTurn } from '../../providers/index.js';
import { installFakeClaude } from '../../tests/fakes/claudeCli.js';
import { builtinTools } from '../../tools/builtin/index.js';
import { ToolRegistry } from '../../tools/registry.js';
import { runAgent, type AgentDeps } from './loop.js';
import { CTO, SA, auditSpy, humanMsg, newBus, prompts, promptsWithTool } from '../test-helpers.js';

let db: TestDb;
let org: Org;
let tasks: TaskRepo;

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations'), 'up');
  const repos = { departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) };
  await seed(repos, prompts);
  org = await Org.load(repos, prompts);
  tasks = new TaskRepo(db.pool);
});
beforeEach(async () => {
  await db.pool.query('DELETE FROM web_grants');
  await db.pool.query('DELETE FROM approvals');
  await db.pool.query('DELETE FROM budget_days');
  await db.pool.query('DELETE FROM dept_notes');
  await db.pool.query('DELETE FROM tasks');
});
afterAll(async () => {
  await db.close();
});

/** Real Budget, Approvals, Limits, Halt and repos; only the provider is scripted. */
function mk(script: FakeTurn[], cfgInit: ConstructorParameters<typeof FakeConfig>[0] = {}) {
  const cfg = new FakeConfig({ 'budget.botDailyUsd': 100, 'budget.companyDailyUsd': 100, ...cfgInit });
  const bus = newBus();
  const events: { name: string; payload: unknown }[] = [];
  for (const name of ['approval.requested', 'governance.paused', 'task.created'] as const) bus.on(name, (p) => void events.push({ name, payload: p }));
  const halt = new Halt(cfg, tasks, bus);
  const approvals = new Approvals(db.pool, tasks, cfg, bus, halt, async () => undefined);
  const budget = new Budget(db.pool, cfg, bus, () => new Date(), { taskCap: (id, c) => approvals.treeCap(id, c) });
  const provider = new FakeProvider(script, 'claude');
  const providers = new ProviderRegistry();
  providers.register(provider);
  const tools = new ToolRegistry({ halt });
  for (const t of builtinTools()) tools.register(t);
  const deps: AgentDeps = {
    org, prompts, overrides: { getActive: async () => null }, providers, cfg, budget, approvals, tasks,
    notes: new DeptNoteRepo(db.pool), tools, bus, audit: auditSpy().audit, limits: new Limits(cfg, tasks), halt, taskRuns: new TaskRuns(),
  };
  return { deps, provider, events };
}

const rootOf = (owner: ActorRef) => tasks.create({ title: 'Root', description: 'goal', deptId: 'software', owner, requester: { kind: 'human', userId: '42' }, origin: 'chat' });
const route = (actor: ActorRef) => ({ actor, reason: 'mention' as const });
const respond = { name: 'respond', input: { type: 'chat', body: 'ok' } };

describe('runAgent with real governance', () => {
  it('create_task with estCostUsd 2 goes awaiting_approval', async () => {
    const s = mk([
      { toolUses: [{ name: 'create_task', input: { title: 'Big', description: 'Large job', assignee: SA, estCostUsd: 2 } }], usage: { inputTokens: 100, outputTokens: 10 } },
      { toolUses: [respond] },
    ]);
    const root = await rootOf(CTO);
    await runAgent({ route: route(CTO), task: root, history: [] }, s.deps);
    const child = (await db.pool.query<{ id: string }>('SELECT id FROM tasks WHERE parent_id = $1', [root.id])).rows[0]!;
    expect((await tasks.get(child.id))!).toMatchObject({ status: 'awaiting_approval', depth: 1, owner: SA, requester: CTO });
    const a = await db.pool.query('SELECT task_id, status, kind, est_cost_usd FROM approvals');
    expect(a.rows).toEqual([{ task_id: child.id, status: 'pending', kind: 'estimate', est_cost_usd: 2 }]);
    expect(s.events.map((e) => e.name)).toEqual(['approval.requested', 'task.created']);
    expect((await tasks.get(root.id))!.status).toBe('doing');
  });

  it('task budget over tree cap requests approval and makes no provider call', async () => {
    const s = mk([{ text: 'never' }], { 'budget.taskUsd': 0.000001 });
    const root = await rootOf(CTO);
    const child = await tasks.create({ title: 'c', deptId: 'software', owner: SA, requester: CTO, origin: 'delegated', parentId: root.id });
    const out = await runAgent({ route: route(SA), task: child, history: [] }, s.deps);
    expect(out.stopped).toBe('budget');
    expect(s.provider.calls).toHaveLength(0);
    expect((await tasks.get(child.id))!.status).toBe('awaiting_approval');
    const a = await db.pool.query('SELECT task_id, status, kind FROM approvals');
    expect(a.rows).toEqual([{ task_id: child.id, status: 'pending', kind: 'tree_cap' }]);
    const reserved = await db.pool.query('SELECT coalesce(sum(reserved_usd), 0)::float AS r FROM budget_days');
    expect(reserved.rows[0].r).toBe(0);
  });

  it('stops with budget when reserve fails and posts nothing to provider', async () => {
    const s = mk([{ text: 'never' }], { 'budget.botDailyUsd': 0 });
    const out = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    expect(out).toMatchObject({ stopped: 'budget', turns: 0 });
    expect(s.provider.calls).toHaveLength(0);
    expect(s.events).toContainEqual({ name: 'governance.paused', payload: expect.objectContaining({ scope: 'bot' }) });
  });

  it('settled spend lands once on the root and the reservation is cleared', async () => {
    const s = mk([{ toolUses: [respond], usage: { inputTokens: 1000, outputTokens: 100 } }]);
    const root = await rootOf(CTO);
    const out = await runAgent({ route: route(CTO), task: root, history: [] }, s.deps);
    expect(out.costUsd).toBeCloseTo(0.003, 9);
    expect((await tasks.get(root.id))!).toMatchObject({ turnsUsed: 1, costUsd: 0.003 });
    const rows = await db.pool.query<{ scope: string; reserved_usd: number; spent_usd: number }>('SELECT scope, reserved_usd, spent_usd FROM budget_days ORDER BY scope');
    expect(rows.rows.map((r) => [r.scope, r.reserved_usd, r.spent_usd])).toEqual([['bot', 0, 0.003], ['company', 0, 0.003], ['dept', 0, 0.003], ['task', 0, 0.003]]);
  });

  it('SPEND-1 S11: a failing rollup makes the settle throw: nothing is booked, the reservation stays held and the loop stops on the meter', async () => {
    const s = mk([{ toolUses: [respond], usage: { inputTokens: 1000, outputTokens: 100 } }]);
    const root = await rootOf(CTO);
    await db.pool.query("CREATE FUNCTION spend_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'rollup refused'; END $$");
    await db.pool.query('CREATE TRIGGER spend_fail_t BEFORE INSERT ON spend_days FOR EACH ROW EXECUTE FUNCTION spend_fail()');
    try {
      const out = await runAgent({ route: route(CTO), task: root, history: [] }, s.deps);
      expect(out.stopped).toBe('budget');
      expect(JSON.stringify(out)).toContain('Stopped after the last model call');
      const rows = await db.pool.query<{ scope: string; reserved_usd: number; spent_usd: number }>('SELECT scope, reserved_usd, spent_usd FROM budget_days ORDER BY scope');
      expect(rows.rows.map((r) => r.spent_usd)).toEqual([0, 0, 0, 0]); // budget_days unchanged
      expect(rows.rows.every((r) => r.reserved_usd > 0)).toBe(true); // the hold stays (conservative)
      expect((await tasks.get(root.id))!.costUsd).toBe(0); // tasks.cost_usd unchanged
    } finally {
      await db.pool.query('DROP TRIGGER spend_fail_t ON spend_days');
      await db.pool.query('DROP FUNCTION spend_fail()');
    }
  });

  it('fake claude emits tool_calls for a tool outside actor meta → registry denied, not run', async () => {
    // SA's meta tools are [update_task, respond]; the model asks for create_task anyway.
    const dir = mkdtempSync(join(tmpdir(), 'ccl-int-'));
    try {
      const fake = installFakeClaude(dir);
      fake.scenario({ mode: 'payload', payload: { tool_calls: [{ name: 'create_task', input: { title: 'Sneaky', description: 'x', assignee: SA } }] } });
      const local = 'local/claude-sonnet-5-5';
      // Real selection and metering: provider.default is local, the persona's API model maps to its local id, and
      // the local call needs no pricing entry (it is counted, Gate 1 L8).
      const s = mk([], { 'provider.default': { provider: 'claude-code-local', model: 'local/claude-sonnet-5-5' } });
      const spy = auditSpy();
      s.deps.audit = spy.audit;
      const provider = createClaudeCodeLocalProvider({ claudePath: fake.path, timeoutMs: 10_000, concurrency: 1, audit: spy.audit });
      const providers = new ProviderRegistry();
      providers.register(provider);
      s.deps.providers = providers;
      const root = await rootOf(SA);
      await runAgent({ route: route(SA), task: root, history: [] }, s.deps);
      expect(fake.starts()).toHaveLength(1);
      expect(fake.starts()[0]!.system).not.toContain('"name":"create_task"');
      expect((await db.pool.query('SELECT id FROM tasks WHERE parent_id = $1', [root.id])).rows).toEqual([]);
      expect(spy.entries.filter((e) => e.tool === 'create_task')).toEqual([]);
      expect(spy.entries).toContainEqual(expect.objectContaining({ provider: 'claude-code-local', outcome: 'unknown_tool' }));
      expect(spy.entries).toContainEqual(expect.objectContaining({ action: 'llm.call', provider: 'claude-code-local', model: local }));
      expect(JSON.stringify(spy.entries.filter((e) => e.outcome === 'unknown_tool'))).not.toContain('create_task');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


// WEBGRANT-1 (W-C3): a running loop on a tainted task, across a psql-style halt (a second ConfigStore writes `halted`) and a resume.
describe('runAgent with a task web grant across a halt', () => {
  const PRAW: ActorRef = CTO;
  const WEB_PROMPTS = promptsWithTool('heads/software', 'fetch_page');
  const stores: ConfigStore[] = [];
  afterAll(async () => { await Promise.all(stores.map((x) => x.close())); });
  const until = async (f: () => boolean | Promise<boolean>) => {
    const t0 = Date.now();
    while (!(await f()) && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 15));
    expect(await f()).toBe(true);
  };

  it('a granted tainted loop fetches without a card; after a config halt and a resume the same loop gets a card, not a fetch', async () => {
    const a = await ConfigStore.open(db.pool, newBus());
    const b = await ConfigStore.open(db.pool, newBus());
    stores.push(a, b);
    await a.set('budget.botDailyUsd', 100, 't');
    await a.set('budget.companyDailyUsd', 100, 't');
    const bus = newBus();
    const halt = new Halt(a, tasks, bus);
    const webGrants = new WebGrantRepo(db.pool, { gate: () => (halt.isHalted() ? 'halted' : null) });
    halt.onHalted(async () => void (await webGrants.revokeAll('halt')));
    const approvals = new Approvals(db.pool, tasks, a, bus, halt, async () => undefined);
    const budget = new Budget(db.pool, a, bus, () => new Date(), { taskCap: (id, c) => approvals.treeCap(id, c) });
    const transport = fakeTransport({ 'https://example.com/one': { body: '<p>one</p>' }, 'https://example.com/two': { body: '<p>two</p>' } });
    const resolver = fakeResolver({ 'example.com': ['93.184.215.14'] });
    const tools = new ToolRegistry({ halt });
    tools.register(fetchPageTool({ resolver, transport, extraPorts: () => [] }));
    for (const t of builtinTools()) tools.register(t);
    const mkDeps = (script: FakeTurn[]): AgentDeps => {
      const providers = new ProviderRegistry();
      providers.register(new FakeProvider(script, 'claude'));
      return {
        org: webOrg, prompts: WEB_PROMPTS, overrides: { getActive: async () => null }, providers, cfg: a, budget, approvals, tasks, notes: new DeptNoteRepo(db.pool), tools, bus,
        audit: auditSpy().audit, limits: new Limits(a, tasks), halt, taskRuns: new TaskRuns(), webGrants: { consume: (r) => webGrants.consume(r) },
      };
    };
    const webOrg = await Org.load({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, WEB_PROMPTS);
    const root = await tasks.create({ title: 'Research', description: 'read the web', deptId: 'software', owner: PRAW, requester: { kind: 'human', userId: '42' }, origin: 'chat' });
    await tasks.update(root.id, { tainted: true }); // the run starts tainted (G2-04), like a resumed run
    const appr = await db.pool.query<{ id: number }>(
      `INSERT INTO approvals (task_id, reason, est_cost_usd, requested_by, kind, tool_name, tool_input, input_sha256, status) VALUES ($1,'r',0,'head:software','tool','fetch_page','{"url":"https://example.com/zero"}'::jsonb,'x','approved') RETURNING id`, [root.id]);
    await insertGrant(db.pool, { rootId: root.id, approvalId: appr.rows[0]!.id, grantedBy: '123456789012345678', requestedBy: 'head:software', maxFetches: 20, maxHosts: 5, maxUrlChars: 4000, hours: 4 });

    // 1. the loop fetches a url it has not seen, with the grant, and files no card
    const fresh1 = (await tasks.get(root.id))!;
    const o1 = await runAgent({ route: route(PRAW), task: fresh1, history: [] }, mkDeps([{ toolUses: [{ name: 'fetch_page', input: { url: 'https://example.com/one' } }] }, { toolUses: [respond] }]));
    expect(o1.stopped).toBeUndefined();
    expect(transport.requests.map((r) => r.url.href)).toEqual(['https://example.com/one']);
    expect((await db.pool.query("SELECT id FROM approvals WHERE status = 'pending'")).rows).toEqual([]);
    expect((await db.pool.query('SELECT used FROM web_grants')).rows).toEqual([{ used: 1 }]);

    // 2. psql-style halt (another store writes the row): the grant is revoked by the config watcher path, and a halted loop makes no call
    await b.set('halted', true, 'psql');
    await until(async () => (await db.pool.query('SELECT revoked_at FROM web_grants')).rows[0].revoked_at !== null);
    expect((await db.pool.query('SELECT revoke_reason FROM web_grants')).rows).toEqual([{ revoke_reason: 'halt' }]);
    const halted = await runAgent({ route: route(PRAW), task: (await tasks.get(root.id))!, history: [] }, mkDeps([{ toolUses: [{ name: 'fetch_page', input: { url: 'https://example.com/two' } }] }]));
    expect(halted.stopped).toBe('halted');

    // 3. resume (write false): the same kind of loop now gets a card for a new url and nothing is fetched
    await b.set('halted', false, 'psql');
    await until(() => !halt.isHalted());
    const task2 = (await tasks.get(root.id))!;
    await tasks.update(root.id, { status: 'todo', blockedReason: null } as never).catch(() => undefined);
    await runAgent({ route: route(PRAW), task: (await tasks.get(root.id)) ?? task2, history: [] }, mkDeps([{ toolUses: [{ name: 'fetch_page', input: { url: 'https://example.com/two' } }] }, { toolUses: [respond] }]));
    expect(transport.requests.map((r) => r.url.href)).toEqual(['https://example.com/one']);
    const pending = await db.pool.query<{ tool_name: string; reason: string }>("SELECT tool_name, reason FROM approvals WHERE status = 'pending'");
    expect(pending.rows).toHaveLength(1);
    expect(pending.rows[0]!.tool_name).toBe('fetch_page');
    expect(pending.rows[0]!.reason).toContain('web grant not applied: revoked');
    expect((await db.pool.query('SELECT used FROM web_grants')).rows).toEqual([{ used: 1 }]);
  });
});

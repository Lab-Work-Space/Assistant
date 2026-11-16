import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TaskRuns } from '../../agents/tasks/task-runs.js';
import { newBus, auditSpy, prompts } from '../../agents/test-helpers.js';
import { runAgent, type AgentDeps } from '../../agents/loop/loop.js';
import type { App } from '../../app.js';
import { Org, PRAW_DEFAULT_MODEL, seed } from '../../company/index.js';
import { CONFIG_DEFAULTS } from '../../config/defaults.js';
import { encryptSecret } from '../../config/secrets.js';
import { ChannelMapRepo, DepartmentRepo, DeptNoteRepo, PersonaRepo, ProviderKeyRepo, TaskRepo } from '../../db/index.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { usageCmd } from '../../discord/commands/usage.js';
import { cmd } from '../../discord/commands/test-helpers.js';
import { Approvals, Budget, Halt, Limits } from '../../governance/index.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeProvider, ProviderRegistry } from '../../providers/index.js';
import { ToolRegistry } from '../../tools/registry.js';
import { builtinTools } from '../../tools/builtin/index.js';
import { boot, humanMsg, mentionOf, migrateUp, resetDb, testEnv } from './helpers.js';

let db: TestDb;
let app: App | null = null;
const FAKE_KEY = 'AIzaFAKE-not-a-real-key-0123456789abcd';
const refused = async () => ({ ok: false as const, reason: 'ALLOW_LOCAL_PROVIDERS is not 1' });

beforeAll(async () => {
  db = await freshDb();
  await migrateUp(db.pool);
});
beforeEach(() => resetDb(db.pool));
afterEach(async () => {
  await app?.stop();
  app = null;
});
afterAll(async () => {
  await db.close();
});

describe('gemini registration at boot', () => {
  it('app › boot registers gemini from env key', async () => {
    app = (await boot(db.pool, { localGuard: refused, env: { geminiApiKey: FAKE_KEY }, depts: ['hq', 'praw'], start: false })).app;
    expect(app.services.providers.has('gemini')).toBe(true);
  });

  it('app › boot registers gemini from the stored key', async () => {
    await new ProviderKeyRepo(db.pool).upsert({ provider: 'gemini', ...encryptSecret(FAKE_KEY, testEnv().configMasterKey, 'gemini') });
    app = (await boot(db.pool, { localGuard: refused, depts: ['hq', 'praw'], start: false })).app;
    expect(app.services.providers.has('gemini')).toBe(true);
    expect(app.services.secrets).toContain(FAKE_KEY); // the decrypted stored key is masked everywhere from now on (P24)
  });

  it('a stored key that cannot be decrypted never fails the boot', async () => {
    await new ProviderKeyRepo(db.pool).upsert({ provider: 'gemini', ...encryptSecret(FAKE_KEY, testEnv().configMasterKey, 'other-aad') });
    app = (await boot(db.pool, { localGuard: refused, depts: ['hq', 'praw'], start: false })).app;
    expect(app.services.providers.has('gemini')).toBe(false);
  });

  it('app › no key → gemini not registered, boot ok, bot praw runs nothing with a clear alert', async () => {
    const claude = new FakeProvider([{ text: 'never' }], 'claude');
    const booted = await boot(db.pool, { provider: claude, depts: ['hq', 'praw'] });
    app = booted.app;
    expect(app.services.providers.has('gemini')).toBe(false);
    await app.services.scheduler.onMessage(humanMsg(`${mentionOf('praw')} hi`, { mentionedHeads: ['praw'] }));
    await app.services.scheduler.idle();
    expect(claude.calls).toHaveLength(0);
    const alert = booted.port.posts.find((p) => p.payload.title === 'Unavailable');
    expect(alert?.payload.body ?? JSON.stringify(alert?.payload)).toContain('not available');
  });
});

describe('gemini metering', () => {
  it('int › a Gemini call is metered: audit row llm.call provider gemini, cost = price × tokens, shown by /usage', async () => {
    const repos = { departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) };
    await seed(repos, prompts);
    const org = await Org.load(repos, prompts);
    const cfg = new FakeConfig({ 'budget.botDailyUsd': 100, 'budget.companyDailyUsd': 100 });
    const bus = newBus();
    const tasks = new TaskRepo(db.pool);
    const halt = new Halt(cfg, tasks, bus);
    const approvals = new Approvals(db.pool, tasks, cfg, bus, halt, async () => undefined);
    const budget = new Budget(db.pool, cfg, bus, () => new Date(), { taskCap: (id, c) => approvals.treeCap(id, c) });
    const provider = new FakeProvider([{ toolUses: [{ name: 'respond', input: { type: 'chat', body: 'ok' } }], usage: { inputTokens: 2000, outputTokens: 500 } }], 'gemini');
    const providers = new ProviderRegistry();
    providers.register(provider);
    const tools = new ToolRegistry({ halt });
    for (const t of builtinTools()) tools.register(t);
    const spy = auditSpy();
    const deps: AgentDeps = {
      org, prompts, overrides: { getActive: async () => null }, providers, cfg, budget, approvals, tasks,
      notes: new DeptNoteRepo(db.pool), tools, bus, audit: spy.audit, limits: new Limits(cfg, tasks), halt, taskRuns: new TaskRuns(),
    };
    const praw = org.dept('praw')!;
    expect(praw).toMatchObject({ provider: 'gemini', model: PRAW_DEFAULT_MODEL });
    const root = await tasks.create({ title: 'R', description: 'g', deptId: 'praw', owner: { kind: 'head', dept: 'praw' }, requester: { kind: 'human', userId: '42' }, origin: 'chat' });
    await runAgent({ route: { actor: { kind: 'head', dept: 'praw' }, reason: 'mention' }, task: root, history: [] }, deps);
    const p = CONFIG_DEFAULTS.pricing[PRAW_DEFAULT_MODEL]!;
    const expected = (2000 * p.inPerMTok + 500 * p.outPerMTok) / 1e6;
    const call = spy.entries.find((e) => e.action === 'llm.call')!;
    expect(call).toMatchObject({ provider: 'gemini', model: PRAW_DEFAULT_MODEL, tokensIn: 2000, tokensOut: 500 });
    expect(call.costUsd).toBeCloseTo(expected, 9);
    const r = await usageCmd(cmd('usage', null), { budget, now: () => new Date() } as never);
    expect(JSON.stringify((r as { embeds?: unknown } | null)?.embeds)).toContain(`$${expected.toFixed(4)} spent`);
  });
});

import { describe, expect, it } from 'vitest';
import { IncidentReporter } from '../core/incidents.js';
import { toolGroupsDigest, startupAlerts, type StartDeps } from '../app-start.js';
import { ProviderError } from '../providers/types.js';
import { ToolRegistry } from '../tools/registry.js';
import { FakeDiscordPort } from '../tests/fakes/discordPort.js';
import { callProvider, type CallDeps } from './call/call.js';
import { Scheduler } from './scheduler/scheduler.js';
import type { AgentDeps, AgentOutcome } from './loop/loop.js';
import { Limits } from '../governance/limits.js';
import { FakeConfig } from '../governance/test-helpers.js';
import { MemTasks, newBus, noApprovedTools, quiet, seededOrg, CTO } from './test-helpers.js';

const BOT_LOG = '1566454343820124352';
function reporter() {
  const port = new FakeDiscordPort();
  const logs: unknown[] = [];
  const r = new IncidentReporter({ port, channelId: BOT_LOG, log: { error: (o) => logs.push(o) } });
  return { port, r, logs, posts: () => port.posts.filter((p) => p.target.channelId === BOT_LOG) };
}

describe('BOTLOG-1 wiring', () => {
  it('provider error: exactly one plain #bot-log post with dept, task, where, cause, hint, id; prompt text withheld', async () => {
    const t = reporter();
    const err = Object.assign(new Error('prompt quoted: SECRET-PROMPT token=abcdef123456'), { name: 'APIError', status: 529 });
    const deps: CallDeps = {
      budget: { reserve: async () => ({ ok: true, reservationId: 'r1' }), settle: async () => undefined, release: async () => undefined, costOf: () => 0 } as never,
      halt: { track: () => () => undefined }, audit: async () => undefined, incidents: t.r,
    };
    const prov = { id: 'anthropic', async *chat() { throw err; } };
    const req = { model: 'm', system: 's', messages: [], tools: [], maxTokens: 1 };
    for (let i = 0; i < 3; i++) await callProvider(req, prov as never, { kind: 'head', dept: 'software' }, { id: '1a2b3c4d-zzzz', title: 'Fix login' } as never, deps);
    await t.r.idle();
    expect(t.posts()).toHaveLength(1); // repeats suppressed
    const p = t.posts()[0]!.payload;
    expect(p.origin).toBeUndefined(); // plain content, not a governance card
    expect(p.type).toBe('alert');
    expect(p.body).toContain('bot: software · task #1a2b3c4d "Fix login"');
    expect(p.body).toContain('where: provider anthropic · llm.call');
    expect(p.body).toContain('error: APIError status=529');
    expect(p.body).toMatch(/fix: Provider side error/);
    expect(p.body).toMatch(/grep incident=[0-9a-f]{8}/);
    expect(JSON.stringify(p)).not.toMatch(/SECRET|abcdef123456/);
  });

  it('local ProviderError: message and sanitised diag shown', async () => {
    const t = reporter();
    const deps: CallDeps = {
      budget: { reserve: async () => ({ ok: true, reservationId: 'r1' }), settle: async () => undefined, release: async () => undefined, costOf: () => 0 } as never,
      halt: { track: () => () => undefined }, audit: async () => undefined, incidents: t.r,
    };
    const err = new ProviderError('claude-code-local: CLI exited with code 2', { retryable: false, diag: 'exit:2 stderr /Users/pakawat.tan/x' });
    await callProvider({ model: 'm', system: 's', messages: [], tools: [], maxTokens: 1 }, { id: 'claude-code-local', async *chat() { throw err; } } as never, { kind: 'head', dept: 'hq' }, null, deps);
    await t.r.idle();
    const body = t.posts()[0]!.payload.body;
    expect(body).toContain('CLI exited with code 2 [exit:2 stderr ~/x]');
    expect(body).not.toContain('pakawat');
  });

  it('scheduler task failure: a throwing owner run is reported once with task id and title', async () => {
    const t = reporter();
    const cfg = new FakeConfig();
    const tasks = new MemTasks() as MemTasks & { findByThread(id: string): Promise<null> };
    tasks.findByThread = async () => null;
    const port = new FakeDiscordPort();
    const s = new Scheduler({
      agent: {} as AgentDeps, approvedTools: noApprovedTools, port, org: await seededOrg(), tasks, limits: new Limits(cfg, tasks), halt: { isHalted: () => false }, cfg, bus: newBus(), log: quiet, incidents: t.r,
      run: async (): Promise<AgentOutcome> => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }); },
    });
    s.attach();
    const task = await tasks.create({ title: 'Prepare report', description: 'd', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: 'u1' }, parentId: null } as never);
    await s.onTaskReady(task.id);
    await s.idle();
    await t.r.idle();
    expect(t.posts()).toHaveLength(1);
    const body = t.posts()[0]!.payload.body;
    expect(body).toContain(`task #${task.id.slice(0, 8)} "Prepare report"`);
    expect(body).toContain('where: scheduler · task run');
    expect(body).toContain('npm run local:db');
  });

  it('G2BL-05: a run failure never waits on a database lookup (a hanging tasks.get cannot delay the rethrow)', async () => {
    const t = reporter();
    const cfg = new FakeConfig();
    const tasks = new MemTasks() as MemTasks & { findByThread(id: string): Promise<null> };
    tasks.findByThread = async () => null;
    const s = new Scheduler({
      agent: {} as AgentDeps, approvedTools: noApprovedTools, port: new FakeDiscordPort(), org: await seededOrg(), tasks, limits: new Limits(cfg, tasks), halt: { isHalted: () => false }, cfg, bus: newBus(), log: quiet, incidents: t.r,
      run: async (): Promise<AgentOutcome> => { throw new Error('boom'); },
    });
    s.attach();
    const task = await tasks.create({ title: 'Hang check', description: 'd', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: 'u1' }, parentId: null } as never);
    const real = tasks.get.bind(tasks);
    let gets = 0;
    tasks.get = ((id: string) => (++gets > 2 ? new Promise(() => undefined) : real(id))) as never; // later lookups never resolve
    await s.onTaskReady(task.id);
    await s.idle();
    await t.r.idle();
    expect(t.posts()).toHaveLength(1);
    expect(t.posts()[0]!.payload.body).toContain('"Hang check"');
  });

  it('dropped bot reply (Discord post failure): reported with the permission hint and channel', async () => {
    const t = reporter();
    const cfg = new FakeConfig();
    const tasks = new MemTasks() as MemTasks & { findByThread(id: string): Promise<null> };
    tasks.findByThread = async () => null;
    const port = new FakeDiscordPort();
    port.failPost = Object.assign(new Error('Missing Permissions'), { name: 'DiscordAPIError', code: 50013 });
    const s = new Scheduler({
      agent: {} as AgentDeps, approvedTools: noApprovedTools, port, org: await seededOrg(), tasks, limits: new Limits(cfg, tasks), halt: { isHalted: () => false }, cfg, bus: newBus(), log: quiet, incidents: t.r,
      run: async (): Promise<AgentOutcome> => ({ payload: { type: 'chat', body: 'hello' }, costUsd: 0, turns: 1 }),
    });
    s.attach();
    const task = await tasks.create({ title: 'Say hi', description: 'd', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: 'u1' }, parentId: null } as never);
    await s.onTaskReady(task.id);
    await s.idle();
    await t.r.idle();
    const posts = t.posts();
    expect(posts.length).toBeGreaterThanOrEqual(1);
    expect(posts[0]!.payload.body).toContain('where: discord · post (bot reply dropped)');
    expect(posts[0]!.payload.body).toMatch(/Send Messages/);
  });

  it('tool that throws: reported with the tool name; refusals and validation errors are not', async () => {
    const t = reporter();
    const reg = new ToolRegistry({ halt: { isHalted: () => false }, incidents: t.r });
    const { z } = await import('zod');
    reg.register({ name: 'boom', description: 'd', inputSchema: z.object({}), kind: 'read', requiresApproval: () => false, run: async () => { throw new Error('exploded at /Users/pakawat.tan/a'); } } as never);
    const ctx = { actor: { kind: 'head', dept: 'software' }, task: { id: 'abcdef012345', title: 'T' }, audit: async () => undefined, org: { toolsFor: () => ['boom'] }, run: { tainted: () => false } } as never;
    const bad = await reg.run('boom', { extra: 1 }, ctx);
    expect(bad.isError).toBe(true);
    await reg.run('boom', {}, ctx);
    await t.r.idle();
    expect(t.posts()).toHaveLength(1);
    expect(t.posts()[0]!.payload.body).toContain('where: tool boom · run');
    expect(t.posts()[0]!.payload.body).not.toContain('pakawat');
  });
});

describe('BOTLOG-1 boot: tool groups', () => {
  const base = (over: Partial<StartDeps> & { stored?: { digest: string | null } }) => {
    const t = reporter();
    const stored = over.stored ?? { digest: null as string | null };
    const bootNotes = { bootNoteChanged: async (_k: string, d: string) => { const ch = stored.digest !== d; stored.digest = d; return ch; } };
    return { t, bootNotes, stored };
  };
  it('digest is order independent and reason sensitive', () => {
    expect(toolGroupsDigest([{ id: 'a', why: 'x' }, { id: 'b', why: 'y' }])).toBe(toolGroupsDigest([{ id: 'b', why: 'y' }, { id: 'a', why: 'x' }]));
    expect(toolGroupsDigest([{ id: 'a', why: 'x' }])).not.toBe(toolGroupsDigest([{ id: 'a', why: 'z' }]));
  });
  it('posts only when the disabled set changes; unchanged boots post nothing about tool groups; an error group posts every boot', async () => {
    const { t, bootNotes } = base({});
    const groups = [{ id: 'clickup', why: 'CLICKUP_API_TOKEN not set' }];
    const boot = async (toolGroups: { id: string; why: string; error?: true }[]) => {
      const before = t.posts().length;
      await bootOnce(t, bootNotes, toolGroups);
      return t.posts().length - before;
    };
    expect(await boot(groups)).toBe(1); // first boot: changed
    expect(await boot(groups)).toBe(0); // unchanged
    expect(await boot(groups)).toBe(0);
    expect(await boot([...groups, { id: 'github', why: 'GITHUB_APP_ID not set' }])).toBe(1); // changed
    const err = [{ id: 'docs', why: 'renderer check failed', error: true as const }];
    expect(await boot(err)).toBe(1);
    expect(await boot(err)).toBe(1); // a group off because of an error is reported on every boot, whatever the digest says
    expect(t.posts().every((p) => p.payload.origin === undefined)).toBe(true);
  });
  it('an error group is reported even though the digest is unchanged (new process = new dedupe window)', async () => {
    const { t, bootNotes } = base({});
    const err = [{ id: 'docs', why: 'renderer check failed', error: true as const }];
    await bootOnce(t, bootNotes, err);
    const t2 = reporter();
    await bootOnce(t2, bootNotes, err);
    expect(t2.posts()).toHaveLength(1);
    expect(t2.posts()[0]!.payload.body).toContain('A group is off because a check FAILED');
  });
});

describe('WS-BE4 local provider refusal alert', () => {
  async function boot(t0: ReturnType<typeof reporter>, over: { ready: boolean; current: string; localRefused?: StartDeps['localRefused'] }, times = 1) {
    const noop = () => undefined;
    const r = new IncidentReporter({ port: t0.port, channelId: BOT_LOG, log: { error: noop } });
    const d = { env: { botTokens: {} }, log: { warn: noop } as never, org: { dept: () => undefined }, incidents: r,
      provider: { ready: () => over.ready, current: () => over.current }, ...(over.localRefused ? { localRefused: over.localRefused } : {}) } as unknown as StartDeps;
    for (let i = 0; i < times; i++) await startupAlerts(d, { online: [], failed: [], disabled: [] } as never);
    await r.idle();
  }
  it('posts one fixed-text alert and writes one audit row, even when run twice', async () => {
    const t = reporter();
    let rows = 0;
    await boot(t, { ready: false, current: 'claude-code-local', localRefused: { code: 'pin_mismatch', audit: async () => { rows++; } } }, 2);
    expect(rows).toBe(1);
    expect(t.posts()).toHaveLength(1);
    const body = String(t.posts()[0]!.payload.body);
    expect(body).toContain('pin_mismatch');
    expect(body).toContain('bash scripts/probe-local-cli.sh --yes');
    expect(body).toContain('restart the app');
    expect(body).toContain('No agent runs until this is fixed');
    expect(body).not.toMatch(/\d+\.\d+\.\d+|\/Users|\/home/);
  });
  it('omits the no-agent line when another provider keeps the app running', async () => {
    const t = reporter();
    await boot(t, { ready: true, current: 'claude', localRefused: { code: 'argv_changed', audit: async () => undefined } });
    expect(t.posts()).toHaveLength(1);
    expect(String(t.posts()[0]!.payload.body)).not.toContain('No agent runs');
  });
  it('no alert and no audit when the guard did not refuse', async () => {
    const t = reporter();
    await boot(t, { ready: true, current: 'claude-code-local' });
    expect(t.posts()).toHaveLength(0);
  });
});

async function bootOnce(t0: ReturnType<typeof reporter>, bootNotes: StartDeps['bootNotes'], toolGroups: { id: string; why: string; error?: true }[]) {
  const noop = () => undefined;
  const t = { ...t0, r: new IncidentReporter({ port: t0.port, channelId: BOT_LOG, log: { error: noop } }) }; // a boot is a new process: a fresh reporter
  const d = {
    env: { botTokens: {} }, log: { warn: noop } as never, org: { dept: () => undefined }, incidents: t.r, bootNotes, toolGroups,
    provider: { ready: () => true, current: () => 'x' },
  } as unknown as StartDeps;
  await startupAlerts(d, { online: [], failed: [], disabled: [] } as never);
  await t.r.idle();
}

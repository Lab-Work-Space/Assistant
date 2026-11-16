import { describe, expect, it, vi } from 'vitest';
import { CTO, MemNotes, MemTasks, auditSpy, newBus, seededOrg, runCtxBase } from '../../agents/test-helpers.js';
import { CONFIG_DEFAULTS } from '../../config/defaults.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { Limits } from '../../governance/limits.js';
import { createToolPolicy, DEPT_ONLY } from '../policy.js';
import { classOf } from '../manifest/catalog.js';
import { ToolRegistry } from '../registry.js';
import type { AutopilotPort, ToolContext } from '../types.js';
import { RELEASE_TOOL_NAMES, ReleaseRequestInput, releaseToolDeps, releaseTools } from './releases.js';

const TASK_ROOT = 'abcdef01-2222-2222-2222-222222222222';
const INPUT = { slug: 'my-app', title: 'My app', summary: 'A small app.' };

type Request = (a: unknown, r: unknown, i: unknown) => Promise<unknown>;
const okRequest = (): Request => vi.fn(async () => ({ ok: true as const, id: 7, text: 'Release request #7 sent.' }));

async function rig(request: Request = okRequest(), opts: { autopilot?: AutopilotPort; approverOn?: boolean; halted?: () => boolean } = {}) {
  const reg = new ToolRegistry({ halt: { isHalted: opts.halted ?? (() => false) }, autopilot: true });
  for (const t of releaseTools({ releases: { request } as never })) reg.register(t as never);
  const tasks = new MemTasks();
  const spy = auditSpy();
  const needsApproval = vi.fn(() => false);
  const approvalRequest = vi.fn(async () => ({ id: 5 }) as never);
  const org = await seededOrg();
  const task = await tasks.create({ title: 'x', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
  const c = {
    actor: CTO, task: { ...task, rootId: TASK_ROOT }, ...runCtxBase(), org: Object.assign(Object.create(org) as object, { toolsFor: () => ['release_request'] }) as never, tasks,
    approvals: { needsApproval, request: approvalRequest }, limits: new Limits(new FakeConfig(), tasks), bus: newBus(), notes: new MemNotes(), audit: spy.audit,
    ...(opts.autopilot ? { autopilot: opts.autopilot } : {}),
  } as unknown as ToolContext;
  return { reg, c, request, needsApproval, approvalRequest, spy };
}

describe('the release_request plugin (spec 5.4)', () => {
  const [tool] = releaseTools({ releases: { request: okRequest() } as never }) as unknown as { name: string; kind?: string; requiresApproval: () => unknown; description: string; inputSchema: typeof ReleaseRequestInput }[];
  it('is named release_request, has no kind and never asks for approval; the description is the fixed text', () => {
    expect(RELEASE_TOOL_NAMES).toEqual(['release_request']);
    expect(releaseTools({ releases: { request: okRequest() } as never })).toHaveLength(1);
    expect(tool!.name).toBe('release_request');
    expect(tool!.kind).toBeUndefined();
    expect(tool!.requiresApproval()).toBe(false);
    expect(tool!.description).toBe(
      'Ask a Bot Admin to release a finished deliverable from a project workspace: give the workspace slug, a short title and a summary (at most 600 characters). Code zips the workspace now, pins those exact bytes, attaches the last recorded ws_run results and posts one card in #setting. Nothing is released until a Bot Admin approves; then the zip is posted in this task thread. Only inside a task you own. Never say it is released before you are told. Use target install_plugin inside a forge project to have code build and stage an MCP plugin from the workspace (a Bot Admin still installs it).');
  });
  it('the schema is strict: slug shape, title 1-100, summary 1-600, target handoff or install_plugin, no extra keys', () => {
    expect(ReleaseRequestInput.safeParse(INPUT).success).toBe(true);
    expect(ReleaseRequestInput.safeParse({ ...INPUT, target: 'handoff' }).success).toBe(true);
    expect(ReleaseRequestInput.safeParse({ ...INPUT, target: 'install_plugin' }).success).toBe(true);
    for (const bad of [{ ...INPUT, target: 'github' }, { ...INPUT, target: 'install_mcp' }, { ...INPUT, target: 'INSTALL_PLUGIN' }, { ...INPUT, extra: 1 }, { ...INPUT, slug: 'A_b' }, { ...INPUT, slug: 'a%' }, { ...INPUT, title: '' }, { ...INPUT, title: 'x'.repeat(101) }, { ...INPUT, summary: '' }, { ...INPUT, summary: 'x'.repeat(601) }, { ...INPUT, title: '   ' }]) {
      expect(ReleaseRequestInput.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
  });
  it('run passes the code-derived run facts (never tool input) and returns the service text or a tool error', async () => {
    const request = vi.fn(async () => ({ ok: true as const, id: 7, text: 'Release request #7 sent.' }));
    const r = await rig(request as never);
    const res = await r.reg.run('release_request', INPUT, r.c);
    expect(res).toEqual({ content: 'Release request #7 sent.' });
    expect(request).toHaveBeenCalledTimes(1);
    const [actor, run, input] = request.mock.calls[0] as unknown as [unknown, Record<string, unknown>, unknown];
    expect(actor).toEqual(CTO);
    expect(run).toMatchObject({ tainted: false, task: { id: r.c.task!.id, rootId: TASK_ROOT, tainted: false }, ownsTask: true });
    expect(input).toEqual(INPUT);
    const refused = await rig(vi.fn(async () => ({ ok: false as const, code: 'off', error: 'Releases are switched off.' })) as never);
    expect(await refused.reg.run('release_request', INPUT, refused.c)).toEqual({ content: 'Releases are switched off.', isError: true });
  });
  it('a service that throws is a fixed tool error (no message leaks)', async () => {
    const r = await rig(vi.fn(async () => { throw new Error('SECRET-DETAIL'); }) as never);
    const res = await r.reg.run('release_request', INPUT, r.c);
    expect(res).toMatchObject({ isError: true });
    expect(res.content).not.toContain('SECRET-DETAIL');
  });
  it('ownsTask is false when the task is another actor\'s', async () => {
    const request = vi.fn(async () => ({ ok: true as const, id: 7, text: 't' }));
    const r = await rig(request as never);
    await r.reg.run('release_request', INPUT, { ...r.c, task: { ...r.c.task!, owner: { kind: 'head', dept: 'rnd' } } } as ToolContext);
    expect((request.mock.calls[0] as unknown as unknown[])[1]).toMatchObject({ ownsTask: false });
  });
});

describe('RL-C1(c): the tool is handed a closure that exposes only `request`', () => {
  it('Object.keys(releaseToolDeps(service).releases) is exactly [request]; the service\'s other methods are unreachable at run time', async () => {
    const service = { request: okRequest(), decide: vi.fn(), reject: vi.fn(), sweep: vi.fn(), recover: vi.fn(), list: vi.fn(), show: vi.fn(), bootTime: vi.fn() };
    const dep = releaseToolDeps(service as never);
    expect(Object.keys(dep.releases)).toEqual(['request']);
    expect(Object.getOwnPropertyNames(dep.releases)).toEqual(['request']);
    expect(Object.getPrototypeOf(dep.releases)).toBe(Object.prototype);
    for (const m of ['decide', 'reject', 'sweep', 'recover', 'list', 'show', 'bootTime']) expect((dep.releases as Record<string, unknown>)[m]).toBeUndefined();
    await dep.releases.request(CTO as never, {} as never, INPUT);
    expect(service.request).toHaveBeenCalledTimes(1);
    for (const m of ['decide', 'reject', 'sweep', 'recover', 'list', 'show', 'bootTime']) expect((service as unknown as Record<string, ReturnType<typeof vi.fn>>)[m]).not.toHaveBeenCalled();
  });
  it('the request closure keeps the arguments in order and does not read `this`', async () => {
    const calls: unknown[][] = [];
    const service = { request: async function (this: unknown, ...a: unknown[]) { calls.push([this === service, ...a]); return { ok: true as const, id: 1, text: 't' }; } };
    const dep = releaseToolDeps(service as never);
    await dep.releases.request('a' as never, 'r' as never, 'i' as never);
    expect(calls).toEqual([[true, 'a', 'r', 'i']]);
  });
});

describe('RL-C2: a release request never creates an approvals row and autopilot never decides it', () => {
  const company: AutopilotPort = {
    projectOf: async () => ({ id: 1, rootTaskId: 'r', deadline: '2026-12-31' }), decide: vi.fn(async () => ({ kind: 'run' as const })), companyOn: () => true, inCompany: async () => true,
  };
  const project: AutopilotPort = { projectOf: async () => ({ id: 1, rootTaskId: 'r', deadline: '2026-12-31' }), decide: vi.fn(async () => ({ kind: 'run' as const })), companyOn: () => false, inCompany: async () => false };
  for (const [name, port] of [['project autopilot', project], ['company autopilot', company], ['no autopilot', undefined]] as const) {
    it(`${name}: the closure ran once, zero approvals rows, needsApproval and request never called, autopilot.decide never called`, async () => {
      const decide = vi.fn(async () => ({ kind: 'run' as const }));
      const p = port ? { ...port, decide } : undefined;
      const request = vi.fn(async () => ({ ok: true as const, id: 7, text: 'sent' }));
      const r = await rig(request as never, p ? { autopilot: p } : {});
      const res = await r.reg.run('release_request', INPUT, r.c);
      expect(res).toEqual({ content: 'sent' });
      expect(request).toHaveBeenCalledTimes(1); // not vacuous: an early refusal would also show zero rows
      expect(r.approvalRequest).not.toHaveBeenCalled();
      expect(r.needsApproval).not.toHaveBeenCalled();
      expect(decide).not.toHaveBeenCalled();
    });
  }
  it('with the AI approver on (needsApproval would be true for every tool): still no approvals row, because the tool is kindless and requiresApproval is false', async () => {
    const request = vi.fn(async () => ({ ok: true as const, id: 7, text: 'sent' }));
    const r = await rig(request as never);
    r.c.approvals.needsApproval = vi.fn(() => true) as never;
    const res = await r.reg.run('release_request', INPUT, r.c);
    expect(res).toEqual({ content: 'sent' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(r.approvalRequest).not.toHaveBeenCalled();
  });
  it('the registry kind of the tool is undefined (a kind would raise a central approval card)', async () => {
    const r = await rig();
    expect(r.reg.kindOf('release_request')).toBeUndefined();
  });
});

describe('the manifest and the department limit (RL-C7)', () => {
  it('the manifest entry: kindless, sensitive false, dept-only software, always card, cost or lasting', () => {
    expect(classOf('release_request')).toMatchObject({ group: 'builtin', kind: null, sensitive: false, approval: 'central', deptOnly: 'software', treeGrant: false, autopilot: 'always_card', aiReview: 'cost_or_lasting' });
  });
  it('DEPT_ONLY maps release_request to software', () => {
    expect(DEPT_ONLY.release_request).toBe('software');
  });
  it("Praw's \"*\" never expands to release_request, and no other department gets it from byDept; software does", () => {
    const REGISTERED = ['create_task', 'respond', 'web_search', 'release_request'];
    const stored = Object.fromEntries(['hq', 'rnd', 'sales', 'praw', 'software', 'it', 'ops'].map((d) => [d, ['web_search', 'release_request']]));
    const p = createToolPolicy(new FakeConfig({ 'tools.byDept': stored }), () => REGISTERED, () => ['create_task', 'respond', 'release_request']);
    expect(p.effective('praw', ['*'])).not.toContain('release_request');
    for (const d of ['hq', 'rnd', 'sales', 'it', 'ops']) expect(p.effective(d, ['respond', 'release_request']), d).not.toContain('release_request');
    expect(p.effective('software', ['respond', 'release_request'])).toContain('release_request');
    const defaults = CONFIG_DEFAULTS['tools.byDept'] as Record<string, string[]>;
    for (const d of Object.keys(defaults)) expect(defaults[d]!.includes('release_request'), d).toBe(false);
  });
});

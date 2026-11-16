import { describe, expect, it, vi } from 'vitest';
import { auditSpy } from '../../../agents/test-helpers.js';
import { FakeConfig } from '../../../governance/test-helpers.js';
import { toGeminiSchema } from '../../../providers/gemini/convert.js';
import { createHttpClient } from '../../../services/http.js';
import { workspaceFetch, ws, type WsState } from '../../../tests/fakes/clickup-workspace.js';
import { webRig } from '../web/test-helpers.js';
import type { PluginDeps } from '../deps.js';
import { createClickUpClient, E, TeamError } from './client.js';
import { clickupGroup } from './index.js';
import { allRig, teamB, teamsOf, bare as mbare, TEAM_B } from './multi-helpers.js';

const B = 'https://api.clickup.com/api/v2';
const TEAM = '9001';

function rig(over: Partial<WsState> = {}, o: { teamId?: string; now?: () => number; sleep?: (ms: number) => Promise<void> } = {}) {
  const state = ws(over);
  const f = workspaceFetch(state);
  const client = createClickUpClient({ http: createHttpClient({ fetch: f }), token: state.token, teamId: o.teamId ?? TEAM, ...(o.now ? { now: o.now } : {}), ...(o.sleep ? { sleep: o.sleep } : {}) });
  const g = clickupGroup({ clickup: client, cfg: new FakeConfig(), log: { warn: vi.fn() }, clock: Date.now } as unknown as PluginDeps);
  if ('disabled' in g) throw new Error(g.disabled);
  return { state, f, client, g };
}
const paths = (f: { requests: { method: string; url: string }[] }) => f.requests.map((r) => `${r.method} ${r.url.replace(B, '').split('?')[0]}`);
const bare = (s: string) => s.replace(/<\/?untrusted-[0-9a-f]+[^>]*>/g, '').trim();
const READS = ['clickup_list_projects', 'clickup_search_tasks', 'clickup_list_open_tasks', 'clickup_get_task_detail', 'clickup_list_comments', 'clickup_list_members', 'clickup_analyze_project'];

describe('C3 mode and team resolution (workspace)', () => {
  it('a team id that GET /team does not return gives E_TEAM for every call and no request reaches /team/{T}', async () => {
    const { f, client, g } = rig({ teams: [{ id: '1234', name: 'Other' }] });
    await expect(client.scope.team()).rejects.toBeInstanceOf(TeamError);
    await expect(client.scope.team()).rejects.toMatchObject({ reason: 'mismatch', message: E.TEAM });
    const { reg, c } = await webRig(g.tools);
    const r = await reg.run('clickup_list_projects', {}, c);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('workspace is not set up');
    for (const q of f.requests) expect(q.url).not.toContain(`/team/${TEAM}`);
    expect(paths(f)).toEqual(['GET /team']); // failure is retried at most once a minute: one request in all
  });

  it('two teams with CLICKUP_TEAM_ID naming one: that one is used (never the first)', async () => {
    const { client } = rig({ teams: [{ id: '5555', name: 'First' }, { id: TEAM, name: 'Mine' }] });
    expect(await client.scope.team()).toBe(TEAM);
  });

  it('a failed GET /team is not cached for good: retried after 60 s, not before', async () => {
    let t = 1_000_000;
    const { state, f, client } = rig({ teamsFail: true }, { now: () => t });
    await expect(client.scope.team()).rejects.toMatchObject({ reason: 'unavailable' });
    state.teamsFail = false;
    await expect(client.scope.team()).rejects.toBeInstanceOf(TeamError);
    expect(paths(f)).toEqual(['GET /team']);
    t += 61_000;
    expect(await client.scope.team()).toBe(TEAM);
  });

  it('the success is cached for the process life', async () => {
    const { f, client } = rig();
    await client.scope.team();
    await client.scope.team();
    expect(paths(f)).toEqual(['GET /team']);
  });

  it('a client needs a list id or a team id', () => {
    expect(() => createClickUpClient({ http: createHttpClient(), token: 'pk_1_X' })).toThrow();
  });
});

describe('workspace tool set', () => {
  it('registers the reads and the eight writes, and NOT delete; every read is untrusted output; schemas convert for Gemini', () => {
    const { g } = rig();
    expect(g.tools.filter((t) => t.kind === 'read').map((t) => t.name)).toEqual(READS);
    expect(g.tools.map((t) => t.name)).not.toContain('clickup_delete_task');
    expect(g.tools.filter((t) => t.kind === 'write').map((t) => t.name)).toEqual(['clickup_create_task', 'clickup_update_task', 'clickup_update_status', 'clickup_assign_task', 'clickup_add_comment', 'clickup_create_space', 'clickup_create_folder', 'clickup_create_list']); // CLICKUP-HIER-1 adds the last three
    for (const t of g.tools) {
      expect(() => toGeminiSchema(t.inputSchema as never), t.name).not.toThrow();
      if (t.kind === 'read') {
        expect(t.untrustedOutput, t.name).toBe(true);
        expect(t.untrustedSource).toBe('clickup');
      }
    }
  });

  it('the client itself refuses delete in workspace mode', async () => {
    const { client } = rig();
    await expect(client.deleteTask('a1')).rejects.toThrow(/workspace mode/);
  });

  it('read tool descriptions do not claim "only the configured project" in workspace mode', () => {
    const { g } = rig();
    for (const t of g.tools) expect(t.description, t.name).not.toMatch(/configured (clickup )?project|only the configured/i);
  });
});

describe('reads', () => {
  it('list_projects shows Space / Folder / List with ids for the workspace spaces only (never the foreign space)', async () => {
    const { g } = rig();
    const { reg, c } = await webRig(g.tools);
    const r = await reg.run('clickup_list_projects', {}, c);
    expect(r.isError, r.content).toBeFalsy();
    expect(r.content).toContain('Engineering / Backend / Sprint (id: 7001)');
    expect(r.content).toContain('Engineering / Backlog (id: 7002)');
    expect(r.content).toContain('Marketing / Campaigns (id: 7003)');
    expect(r.content).not.toContain('Foreign');
    expect(c.tainted()).toBe(true);
  });

  it('an empty workspace names the create tools as the next step when the actor has them, and only then', async () => {
    const { g } = rig({ spaces: [], lists: [], tasks: [] });
    const { reg, c } = await webRig(g.tools);
    const r = await reg.run('clickup_list_projects', {}, c);
    expect(r.isError, r.content).toBeFalsy();
    expect(bare(r.content)).toMatch(/^The workspace has no lists\. Create one: clickup_create_space .*clickup_create_list/);
    const readOnly = { ...c, org: Object.assign(Object.create(Object.getPrototypeOf(c.org)), c.org, { toolsFor: () => READS }) };
    const r2 = await reg.run('clickup_list_projects', {}, readOnly);
    expect(bare(r2.content)).toBe('The workspace has no lists.');
  });

  it('all-workspaces mode: an empty token names the create tools too', async () => {
    const { g } = allRig({ spaces: [], lists: [], tasks: [], more: [] });
    const { reg, c } = await webRig(g.tools);
    const r = await reg.run('clickup_list_projects', {}, c);
    expect(bare(r.content)).toMatch(/^No lists found\. Create one: clickup_create_space .*clickup_create_list/);
  });

  it('hierarchy caps at 20 spaces with a truncated note', async () => {
    const spaces = Array.from({ length: 25 }, (_, i) => ({ id: String(600 + i), name: `S${i}` }));
    const lists = spaces.map((s, i) => ({ id: String(8000 + i), name: `L${i}`, spaceId: s.id }));
    const { f, g } = rig({ spaces, lists, tasks: [] });
    const { reg, c } = await webRig(g.tools);
    const r = await reg.run('clickup_list_projects', {}, c);
    expect(r.content).toMatch(/truncated/);
    expect(r.content).toContain('L19');
    expect(r.content).not.toContain('(id: 8020)');
    expect(f.requests.filter((q) => /\/space\/\d+\/(folder|list)/.test(q.url)).length).toBe(40);
  });

  it('list_open_tasks needs a list: empty or "all" gives E_NEED_LIST; by id and by exact name work', async () => {
    const { g } = rig();
    const { reg, c } = await webRig(g.tools);
    for (const p of [undefined, '', 'all']) {
      const r = await reg.run('clickup_list_open_tasks', p === undefined ? {} : { project: p }, c);
      expect(r.isError).toBe(true);
      expect(r.content).toContain('name a list by id or exact name');
    }
    const byId = await reg.run('clickup_list_open_tasks', { project: '7001' }, c);
    expect(byId.content).toContain('Write spec');
    expect(byId.content).not.toContain('Ship it');
    const byName = await reg.run('clickup_list_open_tasks', { project: 'backlog' }, c);
    expect(byName.content).toContain('Ship it');
  });

  it('two lists with the same name give E_AMBIG_LIST', async () => {
    const { state, g } = rig();
    state.lists.push({ id: '7004', name: 'Sprint', spaceId: '502' });
    const { reg, c } = await webRig(g.tools);
    const r = await reg.run('clickup_list_open_tasks', { project: 'Sprint' }, c);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('several lists have that name');
    expect((await reg.run('clickup_list_open_tasks', { project: '7004' }, c)).isError).toBeFalsy();
  });

  it('members, analyze work per list and need the list', async () => {
    const { g } = rig();
    const { reg, c } = await webRig(g.tools);
    expect((await reg.run('clickup_list_members', {}, c)).content).toContain('name a list');
    expect((await reg.run('clickup_list_members', { project: '7001' }, c)).content).toContain('alice');
    expect((await reg.run('clickup_analyze_project', {}, c)).content).toContain('name a list');
    expect((await reg.run('clickup_analyze_project', { project: 'Sprint' }, c)).content).toMatch(/total: 1 tasks|Total: 1 tasks/i);
  });

  it('get_task_detail shows the list and the statuses its list allows (the only place a vendor status name is shown for writes, C4), whitelisted fields only', async () => {
    const { g } = rig();
    const { reg, c } = await webRig(g.tools);
    const r = await reg.run('clickup_get_task_detail', { task_id: 'a1' }, c);
    expect(r.isError, r.content).toBeFalsy();
    expect(r.content).toContain('Statuses of this list: to do, in progress, complete');
    expect(r.content).toContain('Engineering / Backend / Sprint');
    expect(r.content).toContain('Spec body');
    for (const secret of ['secret-inbox', 'creator@x.test', 'watcher@x.test', 'cfvalue', 'https://x/att']) expect(r.content).not.toContain(secret);
  });
});

describe('C-c / C8 scope: a fetch that succeeds is not proof of scope (IDOR)', () => {
  it('a task or list of another workspace gets the same refusal as a missing one, comments are never fetched', async () => {
    const { f, g } = rig();
    const { reg, c } = await webRig(g.tools);
    const foreign = await reg.run('clickup_get_task_detail', { task_id: 'z9' }, c);
    const missing = await reg.run('clickup_get_task_detail', { task_id: 'nope1' }, c);
    expect(foreign.isError).toBe(true);
    expect(bare(foreign.content)).toBe(bare(missing.content));
    expect(foreign.content).toContain('that task is not in this workspace');
    expect(foreign.content).not.toContain('OTHER WORKSPACE');
    const com = await reg.run('clickup_list_comments', { task_id: 'z9' }, c);
    expect(bare(com.content)).toBe(bare(missing.content));
    expect(paths(f).filter((p) => p.endsWith('/comment'))).toEqual([]);
    const fl = await reg.run('clickup_list_open_tasks', { project: '7999' }, c);
    const ml = await reg.run('clickup_list_open_tasks', { project: '123456' }, c);
    expect(bare(fl.content).replace('7999', 'X')).toBe(bare(ml.content).replace('123456', 'X'));
    expect(fl.content).toContain('that list is not in this workspace');
    expect(paths(f).filter((p) => p.includes('/list/7999/task'))).toEqual([]);
  });

  it('a task whose team_id is not T is refused even in a known space', async () => {
    const { state, g } = rig();
    state.tasks.push({ id: 'q7', name: 'odd', listId: '7001', spaceId: '501', teamId: '4242' });
    const { reg, c } = await webRig(g.tools);
    expect((await reg.run('clickup_get_task_detail', { task_id: 'q7' }, c)).content).toContain('not in this workspace');
  });
});

describe('C6 forced S(T) refreshes are limited', () => {
  it('20 probes of out-of-scope tasks cause at most 1 space request in 60 s', async () => {
    let t = 5_000_000;
    const { f, client } = rig({}, { now: () => t });
    for (let i = 0; i < 20; i++) await expect(client.getTask('z9')).rejects.toThrow(/not in this workspace/);
    expect(paths(f).filter((p) => p === `GET /team/${TEAM}/space`)).toHaveLength(1);
    t += 61_000; // a later probe may refresh once more
    await expect(client.getTask('z9')).rejects.toThrow();
    expect(paths(f).filter((p) => p === `GET /team/${TEAM}/space`)).toHaveLength(2);
  });

  it('a space created after the cache was built is found by the one allowed refresh', async () => {
    let t = 5_000_000;
    const { state, client } = rig({}, { now: () => t });
    await client.getTask('a1');
    state.spaces.push({ id: '503', name: 'New' });
    state.lists.push({ id: '7010', name: 'Fresh', spaceId: '503' });
    t += 61_000;
    expect((await client.listInScope('7010')).name).toBe('Fresh');
  });
});

describe('search (j) and C8', () => {
  it('sends no text parameter, filters on our side, never renders description, inbound_address or emails', async () => {
    const { f, g } = rig();
    const { reg, c } = await webRig(g.tools);
    const r = await reg.run('clickup_search_tasks', { query: 'SPEC', include_done: true, updated_within_days: 7 }, c);
    expect(r.isError, r.content).toBeFalsy();
    expect(r.content).toContain('Write spec (id: a1, status: in progress, list: Sprint, assignees: alice)');
    expect(r.content).not.toContain('Ship it');
    for (const secret of ['Spec body', 'secret-inbox', 'creator@x.test', 'watcher@x.test', 'cfvalue', 'alice@x.test']) expect(r.content).not.toContain(secret);
    const q = f.requests.find((x) => x.url.includes(`/team/${TEAM}/task`))!;
    const u = new URL(q.url);
    for (const k of ['query', 'search', 'name', 'text', 'q']) expect(u.searchParams.has(k)).toBe(false);
    expect(u.searchParams.get('order_by')).toBe('updated');
    expect(u.searchParams.get('subtasks')).toBe('true');
    expect(u.searchParams.get('include_closed')).toBe('true');
    expect(u.searchParams.get('date_updated_gt')).toMatch(/^\d+$/);
  });

  it('three pages at most (300 tasks) with a note; shows 20 lines', async () => {
    const tasks = Array.from({ length: 450 }, (_, i) => ({ id: `t${i}`, name: `Task ${i}`, listId: '7001', spaceId: '501', date_updated: String(i) }));
    const { f, g } = rig({ tasks });
    const { reg, c } = await webRig(g.tools);
    const r = await reg.run('clickup_search_tasks', {}, c);
    expect(f.requests.filter((x) => x.url.includes(`/team/${TEAM}/task`))).toHaveLength(3);
    expect(r.content).toMatch(/stopped at 300/);
    expect(r.content).toMatch(/showing the first 20/);
    expect(r.content.match(/^- Task /gm)).toHaveLength(20);
  });

  it('filters by list, space, status and exact assignee; an unknown assignee is an error', async () => {
    const { f, g } = rig();
    const { reg, c } = await webRig(g.tools);
    const byList = await reg.run('clickup_search_tasks', { list_id: '7002' }, c);
    expect(byList.content).toContain('Ship it');
    expect(byList.content).not.toContain('Write spec');
    expect(new URL(f.requests.find((x) => x.url.includes('/task?'))!.url).searchParams.getAll('list_ids[]')).toEqual(['7002']);
    const bySpace = await reg.run('clickup_search_tasks', { space_id: '502' }, c);
    expect(bySpace.content).toContain('Launch plan');
    expect(bySpace.content).not.toContain('Write spec');
    const who = await reg.run('clickup_search_tasks', { assignee: 'ALICE@x.test' }, c);
    expect(f.requests.some((x) => new URL(x.url).searchParams.getAll('assignees[]').join() === '1')).toBe(true);
    expect(who.isError).toBeFalsy();
    const bad = await reg.run('clickup_search_tasks', { assignee: 'ali' }, c);
    expect(bad.isError).toBe(true);
    expect(bad.content).toContain('no workspace member has exactly');
    const foreignList = await reg.run('clickup_search_tasks', { list_id: '7999' }, c);
    expect(foreignList.content).toContain('that list is not in this workspace');
    expect((await reg.run('clickup_search_tasks', { space_id: '999' }, c)).content).toContain('not in this workspace');
  });

  it('C8: a vendor that ignores list_ids[]/space_ids[] still shows nothing from a foreign space or an unrequested list', async () => {
    const { g } = rig({ ignoreTeamFilters: true });
    const { reg, c } = await webRig(g.tools);
    const all = await reg.run('clickup_search_tasks', {}, c);
    expect(all.content).not.toContain('Foreign secret');
    const one = await reg.run('clickup_search_tasks', { list_id: '7001' }, c);
    expect(one.content).toContain('Write spec');
    expect(one.content).not.toContain('Ship it');
    expect(one.content).not.toContain('Launch plan');
    const sp = await reg.run('clickup_search_tasks', { space_id: '501' }, c);
    expect(sp.content).not.toContain('Launch plan');
  });

  it('input is bounded by zod (query 100, days 1..365)', async () => {
    const { g } = rig();
    const t = g.tools.find((x) => x.name === 'clickup_search_tasks')!;
    expect(t.inputSchema.safeParse({ query: 'x'.repeat(101) }).success).toBe(false);
    expect(t.inputSchema.safeParse({ updated_within_days: 0 }).success).toBe(false);
    expect(t.inputSchema.safeParse({ updated_within_days: 366 }).success).toBe(false);
    expect(t.inputSchema.safeParse({ list_id: '../x' }).success).toBe(false);
  });
});

describe('(k) rate limiter: one bucket, 80/min, E_BUSY, 60 s pause after a 429', () => {
  it('after HTTP 429 no request is made for 60 s (the existing 429 text is kept)', async () => {
    let t = 10_000_000;
    const sleep = vi.fn(async (ms: number) => void (t += ms));
    const { state, f, client } = rig({}, { now: () => t, sleep });
    await client.scope.team();
    state.tooManyRequests = true;
    await expect(client.listInScope('7001')).rejects.toThrow(/rate limit reached/);
    const seen = f.requests.length;
    state.tooManyRequests = false;
    await expect(client.listInScope('7001')).rejects.toThrow(E.BUSY);
    t += 30_000;
    await expect(client.listInScope('7001')).rejects.toThrow(E.BUSY);
    expect(f.requests.length).toBe(seen); // not one request while paused
    t += 31_000;
    expect((await client.listInScope('7001')).id).toBe('7001');
  });

  it('the bucket holds 80 requests; the 81st waits for a token, and a longer wait than 5 s is E_BUSY', async () => {
    let t = 20_000_000;
    const sleep = vi.fn(async (ms: number) => void (t += ms));
    const { client } = rig({}, { now: () => t, sleep });
    await client.scope.team(); // 1
    for (let i = 0; i < 79; i++) await client.getTask('a1').catch(() => undefined); // each does >1 request; the bucket drains quickly
    // by now the bucket is empty and some calls waited; no call ever waited more than 5 s or threw E_BUSY unexpectedly
    for (const [ms] of sleep.mock.calls) expect(ms).toBeLessThanOrEqual(5000);
  });

  it('with a tiny refill window the wait over 5 s is refused', async () => {
    const t = 30_000_000;
    const sleep = vi.fn(async () => undefined);
    const { client } = rig({}, { now: () => t, sleep }); // the clock never moves: no refill
    let busy = 0;
    for (let i = 0; i < 120; i++) await client.getTask('a1').catch((e: Error) => { if (e.message === E.BUSY) busy++; });
    expect(busy).toBeGreaterThan(0);
  });
});

describe('(m) the token, team id, space ids and list id never reach results, audit or errors', () => {
  it('no secret or workspace id in any tool result, audit row or error text, even when the vendor leaks them', async () => {
    const state = ws();
    const f = workspaceFetch(state);
    const leaky = (async (u: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof u === 'string' ? u : u instanceof URL ? u.href : u.url;
      if (url.includes('/task/a1/comment')) return new Response(JSON.stringify({ err: `bad ${new Headers(init?.headers).get('authorization')}` }), { status: 500 });
      return f(u, init);
    }) as typeof fetch;
    const client = createClickUpClient({ http: createHttpClient({ fetch: leaky }), token: state.token, teamId: TEAM });
    const g = clickupGroup({ clickup: client, cfg: new FakeConfig(), log: { warn: vi.fn() }, clock: Date.now } as unknown as PluginDeps);
    if ('disabled' in g) throw new Error('off');
    const spy = auditSpy();
    const { reg, c } = await webRig(g.tools, { audit: spy.audit });
    const out: string[] = [];
    const calls: [string, unknown][] = [
      ['clickup_list_projects', {}], ['clickup_search_tasks', { query: 'x' }], ['clickup_list_open_tasks', { project: '7001' }], ['clickup_get_task_detail', { task_id: 'a1' }], ['clickup_get_task_detail', { task_id: 'z9' }],
      ['clickup_list_comments', { task_id: 'a1' }], ['clickup_list_comments', { task_id: 'z9' }], ['clickup_list_members', { project: '7001' }], ['clickup_analyze_project', { project: '7001' }], ['clickup_list_open_tasks', { project: '7999' }],
    ];
    for (const [n, i] of calls) out.push((await reg.run(n, i, c)).content);
    out.push(JSON.stringify(spy.entries));
    for (const bad of [() => client.getTask('z9'), () => client.listComments('a1'), () => client.listInScope('7999')]) out.push(await bad().then(() => '', (e: Error) => `${e.name} ${e.message} ${JSON.stringify(e)} ${e.stack}`));
    const all = out.join('\n');
    expect(all).not.toContain(state.token);
    expect(all).not.toContain('pk_');
    // the team id and the ids of the spaces never appear in an error or audit (the tool output may show list ids by design, the hierarchy shows no space ids)
    const errsAndAudit = [JSON.stringify(spy.entries), ...out.filter((x) => /not in this workspace|not set up|failed|rejected/.test(x))].join('\n');
    for (const id of [TEAM, '501', '502', '999']) expect(errsAndAudit, id).not.toMatch(new RegExp(`(?<![0-9a-z])${id}(?![0-9a-z])`));
  });
});


describe('CLICKUP-MULTI-1 all-workspaces reads', () => {
  const run = async (g: { tools: Parameters<typeof webRig>[0] }, name: string, input: Record<string, unknown>) => {
    const { reg, c } = await webRig(g.tools);
    const r = await reg.run(name, input, c);
    return { ...r, text: mbare(r.content) };
  };
  const teamTaskReqs = (f: { requests: { url: string }[] }) => f.requests.filter((q) => /\/team\/\d+\/task/.test(q.url));
  const spaces20 = Array.from({ length: 20 }, (_, i) => ({ id: `s${i}`, name: `S${i}` }));

  describe('list_projects', () => {
    it('lists Workspace / Space / Folder / List with each list id, workspaces ordered by name, no team id anywhere', async () => {
      const { g } = allRig();
      const r = await run(g, 'clickup_list_projects', {});
      expect(r.isError).toBeFalsy();
      const lines = r.text.split('\n').filter((l) => l.startsWith('- '));
      expect(lines[0]).toBe('- Acme / Ops / Roadmap (id: 8001)');
      expect(lines).toContain('- Core / Engineering / Backend / Sprint (id: 7001)');
      expect(r.text).not.toContain('9001');
      expect(r.text).not.toContain(TEAM_B);
    });
    it('the workspace input is exact (case-insensitive): one workspace in full; no hit is E_NO_TEAM, two hits E_AMBIG_TEAM', async () => {
      const { g } = allRig();
      expect((await run(g, 'clickup_list_projects', { workspace: 'aCmE' })).text).toBe('- Acme / Ops / Roadmap (id: 8001)');
      expect((await run(g, 'clickup_list_projects', { workspace: 'Nope' })).text).toBe(E.NO_TEAM);
      const twin = allRig({ teamName: 'Acme' });
      expect((await run(twin.g, 'clickup_list_projects', { workspace: 'acme' })).text).toBe(E.AMBIG_TEAM);
    });
    it('the workspace input is not offered in numeric mode, and is refused with invisible characters or more than 100', async () => {
      const numeric = rig().g.tools.find((t) => t.name === 'clickup_list_projects')!;
      expect(Object.keys((numeric.inputSchema as unknown as { shape: object }).shape)).toEqual([]);
      const { g } = allRig();
      expect((await run(g, 'clickup_list_projects', { workspace: 'Ac\u200bme' })).isError).toBe(true);
      expect((await run(g, 'clickup_list_projects', { workspace: 'x'.repeat(101) })).isError).toBe(true);
    });
    it('the cap of 20 spaces is global across workspaces (at most 40 GETs); naming a workspace reads it in full', async () => {
      const big = allRig({ more: [teamB({ name: 'AAA', spaces: spaces20, lists: spaces20.map((s) => ({ id: `l${s.id}`, name: `L${s.id}`, spaceId: s.id })), tasks: [] })] });
      const all = await run(big.g, 'clickup_list_projects', {});
      expect(all.text).toContain('- AAA / S0 / Ls0 (id: ls0)');
      expect(all.text).not.toContain('Core /'); // Core lies beyond the 20 spaces AAA used
      expect(all.text).toContain('name a workspace to see more');
      expect(big.f.requests.filter((q) => /\/space\/[^/]+\/(folder|list)/.test(q.url)).length).toBeLessThanOrEqual(40);
      const core = await run(big.g, 'clickup_list_projects', { workspace: 'Core' });
      expect(core.text).toContain('- Core / Engineering / Backend / Sprint (id: 7001)');
      expect(core.text).not.toContain('name a workspace');
    });
  });

  describe('CM-C2 a name never resolves across a truncated or multi-team hierarchy by guess', () => {
    const setup = () => allRig({
      teamName: 'Acme', spaces: [{ id: '501', name: 'Engineering' }], tasks: [],
      lists: [{ id: '7001', name: 'Sprint', spaceId: '501', statuses: ['to do'] }, { id: '7010', name: 'Roadmap', spaceId: '501', statuses: ['to do'] }],
      more: [teamB({ name: 'AAA', spaces: spaces20, tasks: [], lists: [{ id: 'aaaroad', name: 'Roadmap', spaceId: 's0', statuses: ['to do'] }, ...spaces20.slice(1).map((s) => ({ id: `l${s.id}`, name: `L${s.id}`, spaceId: s.id }))] })],
    });
    it('AAA fills the cap and holds "Roadmap", Acme beyond the cap also holds "Roadmap": resolveList refuses and never returns the id of AAA', async () => {
      const { client, g } = setup();
      await expect(client.resolveList('Roadmap')).rejects.toMatchObject({ message: E.LIST_NAME_TRUNCATED });
      const r = await run(g, 'clickup_list_open_tasks', { project: 'Roadmap' });
      expect(r.isError).toBe(true);
      expect(r.text).toBe(E.LIST_NAME_TRUNCATED);
      expect(r.text).not.toContain('aaaroad');
    });
    it('an id still resolves; a name that is not an id and has no visible hit refuses too (the real list may lie beyond the cap)', async () => {
      const { client } = setup();
      expect(await client.resolveList('aaaroad')).toBe('aaaroad');
      await expect(client.resolveList('Some list')).rejects.toMatchObject({ message: E.LIST_NAME_TRUNCATED });
    });
    it('G2CM-02 a team whose space GET failed with no last good spaces is unknown, not empty: a name with one hit elsewhere refuses', async () => {
      const { client } = allRig({
        teamName: 'Acme', spaces: [{ id: '501', name: 'E' }], tasks: [], lists: [{ id: '7010', name: 'Roadmap', spaceId: '501' }],
        more: [teamB({ name: 'Other', spaceFail: 503 } as never)],
      });
      await expect(client.resolveList('Roadmap')).rejects.toMatchObject({ message: E.LIST_NAME_TRUNCATED });
      expect(await client.resolveList('7010')).toBe('7010');
    });
    it('without truncation: two hits are E_AMBIG_LIST, one hit resolves', async () => {
      const { client } = allRig({ teamName: 'Core', spaces: [{ id: '501', name: 'E' }], tasks: [], lists: [{ id: '7001', name: 'Roadmap', spaceId: '501' }, { id: '7002', name: 'Unique', spaceId: '501' }] });
      await expect(client.resolveList('roadmap')).rejects.toMatchObject({ message: E.AMBIG_LIST });
      expect(await client.resolveList('unique')).toBe('7002');
    });
  });

  describe('scope of tasks and lists', () => {
    it('a task in team A whose team_id says B is refused; so is a list of team A under a task of team B', async () => {
      const { state, client } = allRig();
      state.tasks.find((t) => t.id === 'a1')!.teamId = TEAM_B; // space of Core, team_id of Acme
      await expect(client.getTask('a1')).rejects.toMatchObject({ message: E.SCOPE_TASK });
      state.tasks.push({ id: 'x1', name: 'Crossed', listId: '7001', spaceId: '601', status: { status: 'to do', type: 'open' } }); // space of Acme, list of Core
      await expect(client.describeTask('x1')).rejects.toMatchObject({ message: E.SCOPE_TASK });
      expect((await client.describeTask('b1')).list.id).toBe('8001');
    });
    it('another workspace the token sees is in scope; a workspace-foreign space is not (same texts as before)', async () => {
      const { client } = allRig();
      expect((await client.getTask('b1')).id).toBe('b1');
      await expect(client.getTask('z9')).rejects.toMatchObject({ message: E.SCOPE_TASK });
      await expect(client.listInScope('7999')).rejects.toMatchObject({ message: E.SCOPE_LIST });
    });
    it('a space id that two workspaces both list is dropped (fail closed)', async () => {
      const { client } = allRig({ more: [teamB({ spaces: [{ id: '501', name: 'Dup' }, { id: '601', name: 'Ops' }] })] });
      await expect(client.getTask('a1')).rejects.toMatchObject({ message: E.SCOPE_TASK });
      expect((await client.getTask('b1')).id).toBe('b1');
    });
    it('C6: 20 misses force at most ONE refresh a minute across the process (GET /team plus a space GET each: at most 11 requests)', async () => {
      let t = 1_000_000;
      const { f, client } = allRig({}, { now: () => t });
      await client.scope.teamsReady();
      t += 61_000;
      const before = f.requests.length;
      for (let i = 0; i < 20; i++) await expect(client.getTask('z9')).rejects.toMatchObject({ message: E.SCOPE_TASK });
      const refreshes = f.requests.slice(before).filter((q) => /\/team(\/\d+\/space)?$/.test(q.url.split('?')[0]!));
      expect(refreshes.filter((q) => q.url.endsWith('/team'))).toHaveLength(1);
      expect(refreshes.length).toBeLessThanOrEqual(11);
    });
  });

  describe('search', () => {
    it('unfiltered: one page per workspace, merged by date_updated descending, at most 10 requests', async () => {
      const { g, f } = allRig({ more: [teamB(), ...teamsOf(10).slice(0, 8)] }); // Core plus 9 more = 10 workspaces
      const r = await run(g, 'clickup_search_tasks', {});
      expect(r.isError).toBeFalsy();
      expect(teamTaskReqs(f)).toHaveLength(10);
      const ids = [...r.text.matchAll(/\(id: ([a-z0-9]+),/g)].map((m) => m[1]);
      expect(ids.slice(0, 3)).toEqual(['k9107', 'k9106', 'k9105']); // newest first across workspaces
    });
    it('the truncation note names the number of workspaces; narrowing to a workspace allows 3 pages', async () => {
      const a = allRig({ pageSize: 1 });
      const r = await run(a.g, 'clickup_search_tasks', {});
      expect(r.text).toContain('(searched 2 workspaces, first page each; narrow with workspace, list, space, status or assignee)');
      expect(teamTaskReqs(a.f)).toHaveLength(2);
      const n = allRig({ pageSize: 1 });
      await run(n.g, 'clickup_search_tasks', { workspace: 'Core' });
      expect(teamTaskReqs(n.f)).toHaveLength(3);
      expect(teamTaskReqs(n.f).every((q) => q.url.includes('/team/9001/task'))).toBe(true);
    });
    it('list_id and space_id give the workspace; disagreeing narrowings are E_SCOPE_LIST; a workspace name that agrees is fine', async () => {
      const { g, f } = allRig();
      const byList = await run(g, 'clickup_search_tasks', { list_id: '8001' });
      expect(byList.text).toContain('b1');
      expect(teamTaskReqs(f).every((q) => q.url.includes(`/team/${TEAM_B}/task`))).toBe(true);
      expect((await run(g, 'clickup_search_tasks', { list_id: '7001', space_id: '601' })).text).toBe(E.SCOPE_LIST);
      expect((await run(g, 'clickup_search_tasks', { list_id: '7001', workspace: 'Acme' })).text).toBe(E.SCOPE_LIST);
      expect((await run(g, 'clickup_search_tasks', { space_id: '601', workspace: 'acme' })).text).toContain('b1');
      expect((await run(g, 'clickup_search_tasks', { workspace: 'Nobody' })).text).toBe(E.NO_TEAM);
      expect((await run(allRig({ teamName: 'Acme' }).g, 'clickup_search_tasks', { workspace: 'ACME' })).text).toBe(E.AMBIG_TEAM);
    });
    it('C8: a vendor that answers every team with every task is re-filtered per team: nothing twice, nothing out of scope', async () => {
      const { g } = allRig({ leakAll: true });
      const r = await run(g, 'clickup_search_tasks', {});
      const ids = [...r.text.matchAll(/\(id: ([a-z0-9]+),/g)].map((m) => m[1]);
      expect([...ids].sort()).toEqual(['a1', 'b1', 'b2', 'c3']);
      expect(r.text).not.toContain('Foreign secret');
    });
    it('assignee: exact over the members of the workspaces searched, one match required', async () => {
      const same = allRig(); // alice is user 1 in both workspaces: one id
      expect((await run(same.g, 'clickup_search_tasks', { assignee: 'alice' })).isError).toBeFalsy();
      const dup = allRig({ more: [teamB({ members: [{ id: 50, username: 'alice' }] })] }); // another person named alice in Acme
      expect((await run(dup.g, 'clickup_search_tasks', { assignee: 'alice' })).text).toBe(E.ASSIGNEE);
      expect((await run(dup.g, 'clickup_search_tasks', { assignee: 'alice', workspace: 'Acme' })).isError).toBeFalsy();
      expect((await run(dup.g, 'clickup_search_tasks', { assignee: 'alice', workspace: 'Core' })).isError).toBeFalsy();
    });
  });
});

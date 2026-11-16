import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../../../core/env.js';
import { createHttpClient } from '../../../services/http.js';
import { workspaceFetch, ws } from '../../../tests/fakes/clickup-workspace.js';
import { webRig } from '../web/test-helpers.js';
import { createClickUpClient, E, workspaceLabelText, workspaceNameKey, type TeamsEvent } from './client.js';
import { allRig, bare, paths, teamB, teamsOf, TEAM_B } from './multi-helpers.js';
import { runCtxBase } from '../../../agents/test-helpers.js';

/**
 * CLICKUP-MULTI-1 tester probes (stage 6), independent of the developer's tests: look-alike names, team ids in every output,
 * `all` as a path id, cold-start concurrency, odd vendor answers, env strictness.
 */
const TEAM_IDS = ['9001', TEAM_B];

describe('probe: look-alike workspace names (CM-C1 key)', () => {
  const same: [string, string][] = [
    ['Acme', 'ACME'], ['Acme', ' acme  '], ['Acme', 'Ａｃｍｅ'], ['Straße', 'STRASSE'], ['Café', 'Café'], ['Acme', 'Acme '],
    ['Acme', '​Acme'], ['Acme', 'Acme​'], ['Kelvin', 'Kelvin'], ['AC  ME', 'ac me'], ['Σίσυφος', 'ΣΊΣΥΦΟΣ'], ['ﬁle', 'FILE'], ['Acme', 'Acme'],
  ];
  it.each(same)('%j and %j are one workspace name', (a, b) => expect(workspaceNameKey(a)).toBe(workspaceNameKey(b)));
  const diff: [string, string][] = [['Acme', 'Acme 2'], ['Acme', 'Acne'], ['Acme', 'Ac me'], ['Acme', 'Acme Holdings']];
  it.each(diff)('%j and %j stay distinct', (a, b) => expect(workspaceNameKey(a)).not.toBe(workspaceNameKey(b)));
  it('an empty or invisible-only name is "?" and collides with another one', () => {
    expect(workspaceNameKey('')).toBe(workspaceNameKey('​‍'));
    expect(workspaceNameKey('?')).toBe(workspaceNameKey(''));
  });
  it('a fullwidth twin of a workspace is refused for writes and ambiguous for the workspace input; reads still work', async () => {
    const { g, f } = allRig({ teamName: 'Acme', more: [teamB({ name: 'Ａｃｍｅ' })] });
    const { reg, c, approvals } = await webRig(g.tools, { ...runCtxBase(), direct: true } as never);
    const w = await reg.run('clickup_add_comment', { task_id: 'b1', text: 'x' }, c);
    expect(w.content).toBe(E.NAME_COLLISION);
    expect(approvals.request).not.toHaveBeenCalled();
    const r = await reg.run('clickup_list_projects', { workspace: 'acme' }, c);
    expect(bare(r.content)).toBe(E.AMBIG_TEAM);
    expect(bare((await reg.run('clickup_get_task_detail', { task_id: 'b1' }, c)).content)).toContain('Name: Plan Q1');
    expect(paths(f).some((p) => p.startsWith('POST') || p.startsWith('PUT'))).toBe(false);
  });
});

describe('probe: team ids never reach any output, error, event or log', () => {
  it('every tool, every refusal, the logger and the events are free of team ids', async () => {
    const { g, f, log, events } = allRig({
      teamName: 'Core',
      tasks: [
        { id: 'a1', name: 'Write spec', listId: '7001', spaceId: '501', status: { status: 'to do', type: 'open' }, assignees: [{ id: 1, username: 'alice', email: 'a@x.test' }], description: 'd', date_updated: '1000', extra: { url: 'https://app.clickup.com/t/9001/CUSTOM-1' } },
        { id: 'mism', name: 'Mismatch', listId: '7001', spaceId: '501', teamId: TEAM_B, status: { status: 'to do', type: 'open' }, date_updated: '5' }, // task of space 501 that says it belongs to team B
      ],
    });
    const { reg, c } = await webRig(g.tools, { ...runCtxBase(), direct: true } as never);
    const outs: string[] = [];
    const call = async (n: string, i: Record<string, unknown>) => void outs.push(bare((await reg.run(n, i, c)).content));
    await call('clickup_list_projects', {});
    await call('clickup_list_projects', { workspace: 'Core' });
    await call('clickup_list_projects', { workspace: 'Nope' });
    await call('clickup_search_tasks', {});
    await call('clickup_search_tasks', { workspace: 'Acme', query: 'Plan' });
    await call('clickup_search_tasks', { list_id: '8001', space_id: '501' }); // disagreeing
    await call('clickup_search_tasks', { assignee: 'alice' });
    await call('clickup_list_open_tasks', { project: 'Sprint' });
    await call('clickup_list_open_tasks', { project: '8001' });
    await call('clickup_get_task_detail', { task_id: 'a1' });
    await call('clickup_get_task_detail', { task_id: 'mism' });
    await call('clickup_get_task_detail', { task_id: 'b1' });
    await call('clickup_get_task_detail', { task_id: 'nope' });
    await call('clickup_list_comments', { task_id: 'a1' });
    await call('clickup_list_members', { project: '8001' });
    await call('clickup_analyze_project', { project: '8001' });
    await call('clickup_add_comment', { task_id: 'b1', text: 'x' });
    await call('clickup_update_status', { task_id: 'b1', status: 'bogus' });
    await call('clickup_create_task', { list_id: '8001', name: 'n', in_workspace: 'forged' });
    const blob = JSON.stringify([outs, log.warn.mock.calls, events]);
    for (const id of TEAM_IDS) expect(blob, `team id ${id}`).not.toContain(id);
    expect(f.requests.length).toBeGreaterThan(10);
  });
  it('a failed refresh logs a status code only (no url, no team id)', async () => {
    const { client, state, log } = allRig({ more: [teamB({ spaceFail: 503 } as never)] });
    await client.scope.teamsReady();
    void state;
    expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(/90\d\d/);
  });
});

describe('probe: the sentinel `all` is never a path segment', () => {
  it('"all" as project, list_id, space_id, workspace, task_id, watch list never produces /team/all or /team/<non-digits>', async () => {
    const { g, f } = allRig();
    const { reg, c } = await webRig(g.tools, { ...runCtxBase(), direct: true } as never);
    const inputs: [string, Record<string, unknown>][] = [
      ['clickup_list_projects', { workspace: 'all' }], ['clickup_search_tasks', { workspace: 'all' }], ['clickup_search_tasks', { list_id: 'all' }],
      ['clickup_search_tasks', { space_id: 'all' }], ['clickup_list_open_tasks', { project: 'all' }], ['clickup_list_members', { project: 'all' }],
      ['clickup_analyze_project', { project: 'all' }], ['clickup_get_task_detail', { task_id: 'all' }], ['clickup_list_comments', { task_id: 'all' }],
      ['clickup_add_comment', { task_id: 'all', text: 'x' }], ['clickup_create_task', { list_id: 'all', name: 'n' }], ['clickup_update_status', { task_id: 'all', status: 's' }],
    ];
    for (const [n, i] of inputs) await reg.run(n, i, c);
    for (const p of paths(f)) {
      const m = /\/team\/([^/]+)/.exec(p);
      if (m) expect(m[1], p).toMatch(/^\d{1,20}$/);
    }
    expect(f.requests.some((r) => r.url.includes('/team/all'))).toBe(false);
  });
  it('the client refuses to be built with the sentinel as an id and lets nothing in between through', () => {
    const http = createHttpClient({ fetch: workspaceFetch(ws()) });
    const tok = 'pk_1_X';
    expect(() => createClickUpClient({ http, token: tok, teamId: 'all' })).toThrow();
    expect(() => createClickUpClient({ http, token: tok, teamId: '12/34' })).toThrow();
    expect(() => createClickUpClient({ http, token: tok, teamId: '9001', allTeams: true })).toThrow();
    expect(() => createClickUpClient({ http, token: tok, allTeams: true })).not.toThrow();
  });
});

describe('probe: cold start and odd vendor answers', () => {
  it('six concurrent cold calls share ONE GET /team and one space GET per team', async () => {
    const { g, f } = allRig();
    const { reg, c } = await webRig(g.tools, { ...runCtxBase(), direct: true } as never);
    await Promise.all(['a1', 'b1', 'a1', 'b1', 'a1', 'b1'].map((id) => reg.run('clickup_get_task_detail', { task_id: id }, c)));
    const p = paths(f);
    expect(p.filter((x) => x === 'GET /team')).toHaveLength(1);
    expect(p.filter((x) => /^GET \/team\/\d+\/space$/.test(x))).toHaveLength(2);
  });
  it('GET /team answering a non-array or odd entries never throws a raw TypeError and never invents a team', async () => {
    for (const body of [{ teams: 'x' }, { teams: [{ id: 9001, name: 'num' }] }, {}]) {
      const state = ws({ teamName: 'Core' });
      const real = workspaceFetch(state);
      const f = (async (u: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = typeof u === 'string' ? u : u instanceof URL ? u.href : u.url;
        if (url.endsWith('/team')) return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
        return real(u, init);
      }) as typeof fetch;
      const client = createClickUpClient({ http: createHttpClient({ fetch: f }), token: state.token, allTeams: true });
      await expect(client.scope.teamsReady(), JSON.stringify(body)).rejects.toMatchObject({ message: E.TEAMS });
    }
  });
  // TST-01 (fixed): a 200 answer of JSON null is a transport failure (E.TEAMS / keep the last good set), never a raw TypeError.
  it('TST-01 GET /team answering JSON null at boot is E.TEAMS, not a raw TypeError', async () => {
    const state = ws({ teamName: 'Core' });
    const f = (async () => new Response('null', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const client = createClickUpClient({ http: createHttpClient({ fetch: f }), token: state.token, allTeams: true });
    await expect(client.scope.teamsReady()).rejects.toMatchObject({ message: E.TEAMS });
  });
  it('TST-01 a null entry inside teams is dropped like any unusable entry (E.TEAMS, not a raw TypeError)', async () => {
    const state = ws({ teamName: 'Core' });
    const f = (async () => new Response('{"teams":[null]}', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const client = createClickUpClient({ http: createHttpClient({ fetch: f }), token: state.token, allTeams: true });
    await expect(client.scope.teamsReady()).rejects.toMatchObject({ message: E.TEAMS });
  });
  it('TST-01 a refresh whose GET /team answers JSON null AFTER a good set keeps serving or refuses with a fixed text (never a raw error)', async () => {
    let t = 1_000_000;
    const state = ws({ teamName: 'Core', more: [teamB()] });
    const real = workspaceFetch(state);
    let bad = false;
    const f = (async (u: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof u === 'string' ? u : u instanceof URL ? u.href : u.url;
      if (bad && url.endsWith('/team')) return new Response('null', { status: 200, headers: { 'content-type': 'application/json' } });
      return real(u, init);
    }) as typeof fetch;
    const client = createClickUpClient({ http: createHttpClient({ fetch: f }), token: state.token, allTeams: true, now: () => t });
    expect(await client.scope.teamsReady()).toBe(2);
    bad = true;
    t += 11 * 60_000;
    const r = await client.describeTask('b1').then(() => 'ok', (e: unknown) => (e instanceof Error ? e.message : 'non-error'));
    expect(['ok', E.TEAMS]).toContain(r);
  });
  it('403 on GET /team is authoritative like 401', async () => {
    let t = 1_000_000;
    const { client, state } = allRig({}, { now: () => t });
    expect(await client.scope.teamsReady()).toBe(2);
    state.teamsFail = 403;
    t += 11 * 60_000;
    await expect(client.describeTask('b1')).rejects.toMatchObject({ message: E.TEAMS });
    state.teamsFail = false;
    t += 61_000;
    expect(await client.scope.teamsReady()).toBe(2);
  });
  it('10 workspaces boot with one GET /team and 10 space GETs (11 requests), 11 refuse without a space GET', async () => {
    const ten = allRig({ more: teamsOf(10) });
    // teamsOf(10) adds 9 beside Core: 10 in all
    expect(await ten.client.scope.teamsReady()).toBe(10);
    expect(paths(ten.f)).toHaveLength(11);
    const eleven = allRig({ more: teamsOf(11) });
    await expect(eleven.client.scope.teamsReady()).rejects.toMatchObject({ reason: 'too_many' });
    expect(paths(eleven.f)).toEqual(['GET /team']);
  });
  it('a retried teamsReady inside 60 s after a boot failure makes no request', async () => {
    const { client, f, state } = allRig({ teamsFail: 503 });
    await expect(client.scope.teamsReady()).rejects.toMatchObject({ reason: 'unavailable' });
    await expect(client.scope.teamsReady()).rejects.toMatchObject({ reason: 'unavailable' });
    expect(paths(f)).toEqual(['GET /team']);
    void state;
  });
});

describe('probe: events', () => {
  it('a team that leaves and one that joins at the same count is exactly one event; an unchanged refresh is none', async () => {
    let t = 1_000_000;
    const { client, state, events } = allRig({}, { now: () => t });
    await client.scope.teamsReady();
    t += 11 * 60_000;
    await client.scope.teamsReady();
    expect(events).toEqual([]);
    state.more = [teamB({ id: '9003', name: 'Zed', spaces: [{ id: '603', name: 'Z' }], lists: [], tasks: [] })];
    t += 11 * 60_000;
    await client.scope.teamsReady();
    expect(events as TeamsEvent[]).toEqual([{ kind: 'changed', before: 2, after: 2, added: 1, removed: 1 }]);
  });
});

describe('probe: env strictness', () => {
  const base = { DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x', CONFIG_MASTER_KEY: Buffer.alloc(32).toString('base64'), BOT_TOKEN_HQ: 'x'.repeat(30), BOT_ADMIN_ROLE_ID: '123456789012345678' } as NodeJS.ProcessEnv;
  const tok = { ...base, CLICKUP_API_TOKEN: 'pk_1_X' };
  it('fullwidth, 21-digit, padded-with-inner-space and shell-ish values are refused without echoing the value', () => {
    for (const bad of ['ａｌｌ', '1'.repeat(21), 'a ll', 'all;', 'all\nx', '0x10', '-1', 'null']) {
      let msg = '';
      try { loadEnv({ ...tok, CLICKUP_TEAM_ID: bad }); } catch (e) { msg = (e as Error).message; }
      expect(msg, JSON.stringify(bad)).toMatch(/CLICKUP_TEAM_ID/);
      expect(msg, JSON.stringify(bad)).not.toContain(bad.trim());
    }
  });
  it('numeric mode keeps today\'s shape; an empty value is "unset"', () => {
    expect(loadEnv({ ...tok, CLICKUP_TEAM_ID: '9012' }).clickup).toEqual({ apiToken: 'pk_1_X', teamId: '9012' });
    expect(loadEnv({ ...tok, CLICKUP_TEAM_ID: '  ' }).clickup).toBeUndefined();
  });
});

describe('probe: workspace label', () => {
  it('is at most 40 units for any name and differs for the same name under two team ids', () => {
    const long = 'Ж'.repeat(200);
    expect(workspaceLabelText('9001', long).length).toBeLessThanOrEqual(40);
    expect(workspaceLabelText('9001', 'Acme')).not.toBe(workspaceLabelText('9002', 'Acme'));
    expect(workspaceLabelText('9001', '😀'.repeat(50)).length).toBeLessThanOrEqual(40);
    expect(vi.isMockFunction(workspaceLabelText)).toBe(false);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { FakeConfig } from '../../../governance/test-helpers.js';
import { createHttpClient } from '../../../services/http.js';
import { FakeDiscordPort } from '../../../tests/fakes/discordPort.js';
import { workspaceFetch, ws, type WsState } from '../../../tests/fakes/clickup-workspace.js';
import { webRig } from '../web/test-helpers.js';
import type { PluginDeps } from '../deps.js';
import { createClickUpClient, E } from './client.js';
import { clickupGroup } from './index.js';
import { ClickUpPoller } from './poller.js';
import { memSeen } from './test-helpers.js';
import { teamB, TEAM_B } from './multi-helpers.js';

const NOW = Date.parse('2026-11-01T10:00:00Z');

/** memSeen with per-list baselines (the real repo keys them by fingerprint = list id). */
function seenByList() {
  const base = memSeen();
  const baselines = new Map<string, Date>();
  const inner = base.claim.bind(base);
  return Object.assign(base, {
    baselines,
    async claim(t: string, kind: string, f: string, at = new Date()) {
      if (kind === 'baseline') baselines.set(f, at);
      return inner(t, kind, f, at);
    },
    async baselineAt(listId?: string) { return baselines.get(listId ?? '1') ?? null; },
  });
}

function rig(over: Partial<WsState> = {}, watched: string[] = ['7001']) {
  const state = ws(over);
  const f = workspaceFetch(state);
  let now = NOW;
  const client = createClickUpClient({ http: createHttpClient({ fetch: f }), token: state.token, teamId: '9001', now: () => now, sleep: async (ms) => void (now += ms) });
  const port = new FakeDiscordPort();
  const seen = seenByList();
  const list = [...watched];
  const poller = new ClickUpPoller({
    client, seen: seen as never, port, channel: async () => '1569000000000000001', intervalSec: () => 120, canRun: () => true, clock: () => now,
    log: { warn: vi.fn(), error: vi.fn() }, watched: () => list,
  });
  return { state, f, client, port, seen, poller, list, advance: (ms: number) => void (now += ms) };
}
const teamTaskCalls = (f: { requests: { url: string }[] }) => f.requests.filter((q) => /\/team\/9001\/task/.test(q.url));

describe('(l) workspace poller', () => {
  it('an empty allowlist polls nothing: no request at all', async () => {
    const r = rig({}, []);
    await r.poller.tick();
    await r.poller.tick();
    expect(r.f.requests).toEqual([]);
    expect(r.port.posts).toHaveLength(0);
  });

  it('a newly watched list is baselined silently (nothing posted), then a new task in it is announced', async () => {
    const r = rig();
    await r.poller.tick();
    expect(r.port.posts).toHaveLength(0);
    expect(r.seen.baselines.has('7001')).toBe(true);
    r.state.tasks.push({ id: 'n1', name: 'Fresh task', listId: '7001', spaceId: '501', status: { status: 'to do', type: 'open' }, date_updated: String(NOW + 1000) });
    r.advance(120_000);
    await r.poller.tick();
    expect(r.port.posts).toHaveLength(1);
    expect(r.port.posts[0]!.payload.body).toContain('new task **Fresh task**');
  });

  it('adding a second list later baselines only that list silently while the first keeps announcing', async () => {
    const r = rig();
    await r.poller.tick(); // baseline of 7001
    r.list.push('7003'); // the owner watches Campaigns (it has "Launch plan" already)
    r.state.tasks.push({ id: 'n1', name: 'Fresh task', listId: '7001', spaceId: '501', date_updated: String(NOW + 1000) });
    r.advance(120_000);
    await r.poller.tick();
    const bodies = r.port.posts.map((p) => p.payload.body).join('\n');
    expect(bodies).toContain('Fresh task');
    expect(bodies).not.toContain('Launch plan'); // silent baseline of the new list
    expect(r.seen.baselines.has('7003')).toBe(true);
    r.advance(120_000);
    r.state.tasks.push({ id: 'n2', name: 'Another campaign', listId: '7003', spaceId: '502', date_updated: String(NOW + 200_000) });
    await r.poller.tick();
    expect(r.port.posts.map((p) => p.payload.body).join('\n')).toContain('Another campaign');
  });

  it('C8: a task from an unwatched list or a foreign space produces no notice even when the vendor ignores list_ids[]', async () => {
    const r = rig({ ignoreTeamFilters: true });
    await r.poller.tick(); // baseline
    r.state.tasks.push(
      { id: 'u1', name: 'Unwatched list task', listId: '7002', spaceId: '501', date_updated: String(NOW + 1000) },
      { id: 'u2', name: 'Foreign space task', listId: '7999', spaceId: '999', date_updated: String(NOW + 1000) },
      { id: 'w1', name: 'Watched list task', listId: '7001', spaceId: '501', date_updated: String(NOW + 1000) },
    );
    r.advance(120_000);
    await r.poller.tick();
    const bodies = r.port.posts.map((p) => p.payload.body).join('\n');
    expect(bodies).toContain('Watched list task');
    expect(bodies).not.toContain('Unwatched list task');
    expect(bodies).not.toContain('Foreign space task');
  });

  it('requests list_ids[] of the watched lists only and stays within 5 pages', async () => {
    const r = rig({ pageSize: 1, tasks: Array.from({ length: 12 }, (_, i) => ({ id: `t${i}`, name: `T${i}`, listId: '7001', spaceId: '501', date_updated: String(i) })) }, ['7001', '7003']);
    await r.poller.tick();
    const calls = teamTaskCalls(r.f);
    expect(calls.length).toBeLessThanOrEqual(5);
    for (const c of calls) expect(new URL(c.url).searchParams.getAll('list_ids[]').sort()).toEqual(['7001', '7003']);
  });
});

describe('(k) the limiter is shared by the tools and the poller', () => {
  it('after a 429 seen by a tool call, the poller makes no request for 60 s (and backs off quietly)', async () => {
    const state = ws();
    const f = workspaceFetch(state);
    let now = NOW;
    const client = createClickUpClient({ http: createHttpClient({ fetch: f }), token: state.token, teamId: '9001', now: () => now, sleep: async (ms) => void (now += ms) });
    const g = clickupGroup({ clickup: client, cfg: new FakeConfig(), log: { warn: vi.fn() }, clock: () => now } as unknown as PluginDeps);
    if ('disabled' in g) throw new Error('off');
    const port = new FakeDiscordPort();
    const audits: { action: string; outcome?: string | null }[] = [];
    const poller = new ClickUpPoller({
      client, seen: seenByList() as never, port, channel: async () => '1569000000000000001', intervalSec: () => 30, canRun: () => true, clock: () => now,
      log: { warn: vi.fn(), error: vi.fn() }, watched: () => ['7001'], audit: async (e) => void audits.push(e),
    });
    await client.scope.team();
    state.tooManyRequests = true;
    const { reg, c } = await webRig(g.tools);
    expect((await reg.run('clickup_search_tasks', {}, c)).content).toContain('rate limit');
    const before = f.requests.length;
    state.tooManyRequests = false;
    await poller.tick();
    expect(f.requests.length).toBe(before); // the poller waited for the shared pause
    expect(audits.some((a) => a.action === 'clickup.poll.fail' && a.outcome === E.BUSY)).toBe(true);
    now += 61_000 + 30_000 * 2;
    await poller.tick();
    expect(f.requests.length).toBeGreaterThan(before);
  });
});

describe('C11 / re-watching: remove then add baselines silently again', () => {
  it('a list unwatched and watched again later does not announce its old tasks as new', async () => {
    const r = rig();
    await r.poller.tick(); // 7001 baselined
    r.list.length = 0; // /clickup watch remove: the config no longer names it ...
    r.seen.baselines.delete('7001'); // ... and the command forgets the baseline row (ClickUpSeenRepo.forgetBaseline)
    r.advance(40 * 24 * 3600_000); // the old rows would be pruned after 30 days in the real table
    for (const k of [...r.seen.rows]) if (!k.startsWith('*|')) r.seen.rows.delete(k);
    r.list.push('7001'); // /clickup watch add
    r.advance(120_000);
    await r.poller.tick();
    expect(r.port.posts).toHaveLength(0); // "Write spec" is old news, not a new task
    expect(r.seen.baselines.has('7001')).toBe(true);
  });
});


describe('CLICKUP-MULTI-1 the poller in all-workspaces mode', () => {
  type Tk = { id: string; name: string; listId: string; spaceId: string; date_updated?: string };
  /** `n` extra workspaces, each with one space, one list and `tasks` tasks (updated at NOW). Ids: team 92xx, space 62xx, list lxx. */
  const teamsWith = (n: number, tasks: number) => Array.from({ length: n }, (_, i) => ({
    id: `${9200 + i}`, name: `W${i}`, spaces: [{ id: `${6200 + i}`, name: `S${i}` }], lists: [{ id: `l${i}`, name: `L${i}`, spaceId: `${6200 + i}` }],
    tasks: Array.from({ length: tasks }, (_, k): Tk => ({ id: `w${i}t${k}`, name: `Task ${i}.${k}`, listId: `l${i}`, spaceId: `${6200 + i}`, date_updated: String(NOW) })),
  }));
  function allPoller(over: Partial<WsState> = {}, watched: string[] = ['7001', '8001'], failTeam?: () => string | undefined) {
    const state = ws({ teamName: 'Core', more: [teamB()], ...over });
    const base = workspaceFetch(state);
    const f = (async (u: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof u === 'string' ? u : u instanceof URL ? u.href : u.url;
      const bad = failTeam?.();
      if (bad && url.includes(`/team/${bad}/task`)) { base.requests.push({ method: 'GET', url, headers: {}, body: null }); return new Response('{}', { status: 500 }); }
      return base(u, init);
    }) as typeof fetch & { requests: typeof base.requests };
    f.requests = base.requests;
    let now = NOW;
    const client = createClickUpClient({ http: createHttpClient({ fetch: f }), token: state.token, allTeams: true, now: () => now, sleep: async (ms) => void (now += ms) });
    const port = new FakeDiscordPort();
    const seen = seenByList();
    const audits: { action: string; outcome?: string | null }[] = [];
    const log = { warn: vi.fn(), error: vi.fn() };
    const list = [...watched];
    const poller = new ClickUpPoller({
      client, seen: seen as never, port, channel: async () => '1569000000000000001', intervalSec: () => 120, canRun: () => true, clock: () => now,
      log, watched: () => list, audit: async (e) => void audits.push(e),
    });
    return { state, f, client, port, seen, poller, list, audits, log, advance: (ms: number) => void (now += ms) };
  }
  const teamReqs = (f: { requests: { url: string }[] }, id?: string) => f.requests.filter((q) => (id ? new RegExp(`/team/${id}/task`) : /\/team\/\d+\/task/).test(q.url));

  it('two workspaces: each watched list is baselined silently, then a new task of the second workspace is announced; one team request each per tick', async () => {
    const r = allPoller();
    await r.poller.tick();
    expect(r.port.posts).toHaveLength(0);
    expect([...r.seen.baselines.keys()].sort()).toEqual(['7001', '8001']);
    expect(teamReqs(r.f, '9001')).toHaveLength(1);
    expect(teamReqs(r.f, TEAM_B)).toHaveLength(1);
    r.state.more![0]!.tasks.push({ id: 'bn1', name: 'Acme news', listId: '8001', spaceId: '601', status: { status: 'to do', type: 'open' }, date_updated: String(NOW + 1000) });
    r.advance(120_000);
    await r.poller.tick();
    expect(r.port.posts).toHaveLength(1);
    expect(r.port.posts[0]!.payload.body).toContain('new task **Acme news**');
    expect(r.port.posts[0]!.payload.body).toContain('https://app.clickup.com/t/bn1');
    expect(JSON.stringify(r.port.posts)).not.toContain(TEAM_B);
  });

  it('a watched list that is out of scope is skipped, never baselined, and alerted once with a count only; the others carry on', async () => {
    const r = allPoller({}, ['7001', '7999']); // 7999 is in a space of no workspace of the token
    await r.poller.tick();
    expect([...r.seen.baselines.keys()]).toEqual(['7001']);
    expect(r.f.requests.some((q) => /\/list\/7999\/task/.test(q.url))).toBe(false);
    await r.poller.tick();
    const out = r.audits.filter((a) => a.action === 'clickup.poll.watch_out_of_scope');
    expect(out).toHaveLength(1);
    expect(out[0]!.outcome).toBe('1 watched list(s) are no longer in the ClickUp scope');
    expect(JSON.stringify(r.audits)).not.toMatch(/7999|9001/);
    // every list out of scope: nothing to read, nothing thrown, nothing baselined
    const none = allPoller({}, ['7999']);
    await none.poller.tick();
    expect(none.seen.baselines.size).toBe(0);
    expect(none.log.error).not.toHaveBeenCalled();
  });

  it('a list that leaves scope after its baseline and comes back is not flooded by a stale baseline of an empty read', async () => {
    const r = allPoller({}, ['7001', '8001']);
    await r.poller.tick();
    const b = r.state.more![0]!;
    const saved = b.spaces.slice();
    b.spaces.length = 0; // the workspace lost the space: 8001 is out of scope
    r.advance(11 * 60_000);
    await r.poller.tick();
    expect(r.port.posts).toHaveLength(0);
    b.spaces.push(...saved);
    r.advance(11 * 60_000);
    await r.poller.tick();
    expect(r.port.posts).toHaveLength(0); // the old tasks are old news
  });

  it('page split: min(5, max(1, floor(10 / k))) pages per workspace that has watched lists', async () => {
    const mainTasks = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, name: `M${i}`, listId: '7001', spaceId: '501', date_updated: String(NOW) }));
    // k workspaces with watched lists; the token sees at most 10, so k = 10 is nine extra workspaces plus Core
    const mk = (k: number) => allPoller({ pageSize: 1, tasks: mainTasks, more: teamsWith(k === 10 ? 9 : k, 10) }, [...Array.from({ length: k === 10 ? 9 : k }, (_, i) => `l${i}`), ...(k === 10 ? ['7001'] : [])]);
    for (const [k, pages] of [[1, 5], [2, 5], [3, 3], [10, 1]] as const) {
      const r = mk(k);
      await r.poller.tick();
      const ids = [...Array.from({ length: k === 10 ? 9 : k }, (_, i) => `${9200 + i}`), ...(k === 10 ? ['9001'] : [])];
      expect(ids).toHaveLength(k);
      for (const id of ids) expect(teamReqs(r.f, id), `k=${k}`).toHaveLength(pages);
    }
  });

  it('a workspace that fails makes the whole call throw and the tick backs off (existing behaviour); recovery resumes', async () => {
    let failing: string | undefined = TEAM_B;
    const r = allPoller({}, ['7001', '8001'], () => failing);
    await r.poller.tick();
    expect(r.port.posts).toHaveLength(0);
    expect(r.audits.some((a) => a.action === 'clickup.poll.fail')).toBe(true);
    expect(r.seen.baselines.size).toBe(0);
    const n = r.f.requests.length;
    await r.poller.tick(); // inside the backoff: no request
    expect(r.f.requests.length).toBe(n);
    failing = undefined;
    r.advance(30 * 60_000);
    await r.poller.tick();
    expect(r.seen.baselines.size).toBe(2);
  });

  it('CM-C8: with 10 workspaces and 20 comment checks one warm tick stays at or under 40 requests: the scoped task is reused, no second GET /task', async () => {
    const r = allPoller({ tasks: [], teams: [], more: [] });
    // ten workspaces of two tasks each (20 tasks updated now), the main one empty
    r.state.teams = undefined;
    r.state.more = teamsWith(9, 2);
    r.state.spaces = [{ id: '501', name: 'E' }];
    r.state.lists = [{ id: '7001', name: 'Sprint', spaceId: '501' }];
    r.state.tasks = Array.from({ length: 2 }, (_, k) => ({ id: `m${k}`, name: `M${k}`, listId: '7001', spaceId: '501', date_updated: String(NOW) }));
    r.list.splice(0, r.list.length, '7001', ...Array.from({ length: 9 }, (_, i) => `l${i}`));
    await r.poller.tick(); // cold: scope, list lookups, silent baselines
    r.advance(120_000);
    const before = r.f.requests.length;
    for (const t of [...r.state.tasks, ...r.state.more!.flatMap((m) => m.tasks)]) t.date_updated = String(NOW + 120_000);
    await r.poller.tick();
    const tick = r.f.requests.slice(before);
    const comments = tick.filter((q) => /\/task\/[^/]+\/comment/.test(q.url));
    expect(comments).toHaveLength(20);
    expect(tick.filter((q) => /\/task\/[^/?]+(\?|$)/.test(q.url))).toEqual([]); // no GET /task per comment check
    expect(tick.length).toBeLessThanOrEqual(40);
  });
});

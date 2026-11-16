import { describe, expect, it, vi } from 'vitest';
import { auditSpy } from '../../../agents/test-helpers.js';
import { loadEnv } from '../../../core/env.js';
import { planClickupWatch, isError } from '../../../discord/commands/plans.js';
import { toolApprovalPayload } from '../../../discord/embeds/approval.js';
import type { Approval } from '../../../db/repos/ledger.js';
import { FakeConfig } from '../../../governance/test-helpers.js';
import { createHttpClient } from '../../../services/http.js';
import { workspaceFetch, ws, type WsState } from '../../../tests/fakes/clickup-workspace.js';
import type { ToolContext } from '../../types.js';
import { webRig } from '../web/test-helpers.js';
import type { PluginDeps } from '../deps.js';
import { createClickUpClient, E } from './client.js';
import { clickupGroup } from './index.js';
import { ClickUpPoller } from './poller.js';
import { memSeen } from './test-helpers.js';

/** Independent stage-6 acceptance checks for CLICKUP-ALL-1 (written by the tester, not the developer). Two workspaces: T=9001 (spaces 501, 502) and another one (space 999) the same token sees. */
const B = 'https://api.clickup.com/api/v2';
const TOKEN = 'pk_12345678_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';

class MemUsage {
  readonly days = new Map<string, number>();
  takes = 0;
  async take(day: string, cap: number): Promise<boolean> {
    this.takes++;
    const n = this.days.get(day) ?? 0;
    if (cap <= 0 || n >= cap) return false;
    this.days.set(day, n + 1);
    return true;
  }
}
function rig(over: Partial<WsState> = {}, cfgInit: Record<string, unknown> = {}) {
  const state = ws({ teams: [{ id: '9001' }, { id: '9002' }], ...over });
  const f = workspaceFetch(state);
  const client = createClickUpClient({ http: createHttpClient({ fetch: f }), token: state.token, teamId: '9001' });
  const usage = new MemUsage();
  const cfg = new FakeConfig(cfgInit as never);
  const clock = { now: Date.parse('2026-11-08T05:00:00Z') };
  const log = { warn: vi.fn() };
  const g = clickupGroup({ clickup: client, clickupUsage: usage, cfg, log, clock: () => clock.now } as unknown as PluginDeps);
  if ('disabled' in g) throw new Error(g.disabled);
  return { state, f, client, g, usage, cfg, clock, log };
}
const writes = (f: { requests: { method: string; url: string; body: string | null }[] }) => f.requests.filter((q) => q.method !== 'GET');
const direct: Partial<ToolContext> = { direct: true, origin: 'chat', tainted: () => false };
type Req = { tool: { name: string; input: Record<string, unknown> }; reason: string };
const filed = (a: { request: { mock: { calls: unknown[][] } } }): Req[] => a.request.mock.calls.map((x) => x[0] as Req);
const WAITING = /^NOT DONE YET: waiting for approval of/;

describe('(a) workspace mode: only workspace T, uniform refusals', () => {
  it('list_projects, search, detail, comments see T only; the other workspace gets the SAME text as a missing id', async () => {
    const { g, f } = rig();
    const { reg, c } = await webRig(g.tools, direct);
    const run = async (n: string, i: object) => (await reg.run(n, i, c)).content.replace(/untrusted-[0-9a-f]+/g, 'untrusted-N');
    const proj = await run('clickup_list_projects', {});
    expect(proj).toContain('Engineering / Backend / Sprint (id: 7001)');
    expect(proj).not.toMatch(/Foreign|7999/);
    const search = await run('clickup_search_tasks', {});
    expect(search).toContain('Write spec');
    expect(search).toContain('Launch plan'); // across lists / spaces of T
    expect(search).not.toMatch(/Foreign secret|OTHER WORKSPACE/);
    expect(await run('clickup_search_tasks', { query: 'launch' })).toContain('Launch plan');
    const detail = await run('clickup_get_task_detail', { task_id: 'a1' });
    expect(detail).toContain('Spec body');
    expect(detail).not.toMatch(/secret-inbox|creator@|watcher@|cfvalue|att/);
    expect(await run('clickup_list_comments', { task_id: 'a1' })).toContain('please do X');
    // another workspace vs nonexistent: byte-identical output, for every read that takes a task or list
    for (const [n, mk] of [
      ['clickup_get_task_detail', (id: string) => ({ task_id: id })], ['clickup_list_comments', (id: string) => ({ task_id: id })],
    ] as const) expect(await run(n, mk('z9')), n).toBe(await run(n, mk('nope')));
    for (const n of ['clickup_list_open_tasks', 'clickup_analyze_project', 'clickup_list_members'])
      expect(await run(n, { project: '7999' }), n).toBe(await run(n, { project: '7998' }));
    expect(await run('clickup_search_tasks', { list_id: '7999' })).toBe(await run('clickup_search_tasks', { list_id: '7998' }));
    expect(await run('clickup_search_tasks', { space_id: '999' })).toBe(await run('clickup_search_tasks', { space_id: '998' }));
    expect(await run('clickup_get_task_detail', { task_id: 'z9' })).toContain(E.SCOPE_TASK);
    // comments of the foreign task were never requested
    expect(f.requests.filter((q) => /\/task\/z9\/comment/.test(q.url))).toEqual([]);
    expect(writes(f)).toEqual([]);
  });
  it('workspace id the token does not see (CLICKUP_TEAM_ID=1234) = E_TEAM everywhere, never reaches /team/{T}', async () => {
    const state = ws({ teams: [{ id: '9001' }, { id: '9002' }] });
    const f = workspaceFetch(state);
    const client = createClickUpClient({ http: createHttpClient({ fetch: f }), token: state.token, teamId: '1234' });
    const g = clickupGroup({ clickup: client, cfg: new FakeConfig(), clock: Date.now } as unknown as PluginDeps);
    if ('disabled' in g) throw new Error('disabled');
    const { reg, c } = await webRig(g.tools, direct);
    for (const [n, i] of [['clickup_list_projects', {}], ['clickup_search_tasks', {}], ['clickup_get_task_detail', { task_id: 'a1' }], ['clickup_create_task', { list_id: '7001', name: 'x' }]] as const)
      expect((await reg.run(n, i, c)).content, n).toContain(E.TEAM);
    expect(f.requests.filter((q) => /\/team\/1234/.test(q.url))).toEqual([]);
  });
});

describe('(b) create_task: card, approve, reject, moved', () => {
  it('card has full path + full body; approve = exactly one POST; reject = none; renamed/moved before approval = E_MOVED', async () => {
    const { g, f, state, usage } = rig();
    const { reg, c, approvals } = await webRig(g.tools, direct);
    const body = 'Line one\n"quoted" \\ back <@123> @everyone\nThai ภาษาไทย 😀 `code` *b* _i_ [l](http://x)';
    expect((await reg.run('clickup_create_task', { list_id: '7001', name: 'Task N', description: body }, c)).content).toMatch(WAITING);
    const [r] = filed(approvals);
    expect(writes(f)).toEqual([]); // nothing before approval
    const stored = r!.tool.input;
    const card = toolApprovalPayload({ id: 5, taskId: 't', reason: r!.reason, estCostUsd: 0, requestedBy: 'x', status: 'pending', decidedBy: null, createdAt: new Date(0), decidedAt: null, toolName: 'clickup_create_task', toolInput: stored, inputSha256: 'a'.repeat(64), kind: 'tool' } as Approval);
    const flat = JSON.stringify(card).replace(/\u200b/g, '');
    expect(flat).toContain('Engineering / Backend / Sprint');
    expect(flat).toContain('Body');
    for (const part of ['Line one', 'back', 'everyone', 'Thai', 'code', '123']) expect(flat).toContain(part);
    expect(flat).not.toMatch(/truncated|cut/i);
    // approve -> exactly one POST
    expect((await reg.runApproved('clickup_create_task', stored, c)).isError).toBeFalsy();
    expect(writes(f).map((w) => `${w.method} ${w.url}`)).toEqual([`POST ${B}/list/7001/task`]);
    expect(usage.takes).toBe(1);
    // moved/renamed between card and approval
    state.lists.find((l) => l.id === '7001')!.name = 'Sprint 2';
    const moved = await reg.runApproved('clickup_create_task', stored, c);
    expect(moved.content).toBe(E.MOVED);
    expect(writes(f)).toHaveLength(1);
    expect(usage.takes).toBe(1);
  });
  it('reject = nothing is ever sent (no replay) and a foreign list files no card', async () => {
    const { g, f } = rig();
    const { reg, c, approvals } = await webRig(g.tools, direct);
    await reg.run('clickup_create_task', { list_id: '7002', name: 'to reject' }, c);
    expect(approvals.request).toHaveBeenCalledTimes(1);
    expect(writes(f)).toEqual([]);
    const a = await reg.run('clickup_create_task', { list_id: '7999', name: 'foreign' }, c);
    const b = await reg.run('clickup_create_task', { list_id: '7998', name: 'missing' }, c);
    expect(a.content).toBe(b.content);
    expect(approvals.request).toHaveBeenCalledTimes(1);
  });
});

describe('(c) mode matrix', () => {
  const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db', CONFIG_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'), BOT_ADMIN_ROLE_ID: '1565649426943442999' };
  it('token only = disabled; list id = list mode (team id ignored); token+team = workspace; bad team throws naming the key only', () => {
    expect(loadEnv({ ...base, CLICKUP_API_TOKEN: 'pk_1_X' }).clickup).toBeUndefined();
    expect(loadEnv({ ...base, CLICKUP_API_TOKEN: 'pk_1_X', CLICKUP_LIST_ID: 'abc1' }).clickup).toEqual({ apiToken: 'pk_1_X', listId: 'abc1' });
    expect(loadEnv({ ...base, CLICKUP_API_TOKEN: 'pk_1_X', CLICKUP_LIST_ID: 'abc1', CLICKUP_TEAM_ID: '9001' }).clickup).toEqual({ apiToken: 'pk_1_X', listId: 'abc1' });
    expect(loadEnv({ ...base, CLICKUP_API_TOKEN: 'pk_1_X', CLICKUP_TEAM_ID: '9001' }).clickup).toEqual({ apiToken: 'pk_1_X', teamId: '9001' });
    expect(loadEnv({ ...base, CLICKUP_API_TOKEN: 'pk_1_X', CLICKUP_LIST_ID: '  ', CLICKUP_TEAM_ID: '' }).clickup).toBeUndefined(); // blanks never widen
    expect(loadEnv({ ...base, CLICKUP_TEAM_ID: '9001' }).clickup).toBeUndefined();
    try { loadEnv({ ...base, CLICKUP_API_TOKEN: 'pk_1_X', CLICKUP_TEAM_ID: 'planted-bad' }); expect.unreachable(); } catch (e) { expect((e as Error).message).toContain('CLICKUP_TEAM_ID'); expect((e as Error).message).not.toContain('planted-bad'); }
  });
  it('disabled group text names both options', () => {
    const g = clickupGroup({ cfg: new FakeConfig(), clock: Date.now } as unknown as PluginDeps);
    expect('disabled' in g && g.disabled).toMatch(/CLICKUP_API_TOKEN.*CLICKUP_LIST_ID.*CLICKUP_TEAM_ID/);
  });
  it('list mode: delete registered, no search, no pin/list fields, and never a /team request', async () => {
    const state = ws();
    const f = workspaceFetch(state);
    const client = createClickUpClient({ http: createHttpClient({ fetch: f }), token: state.token, listId: '7001' });
    const g = clickupGroup({ clickup: client, cfg: new FakeConfig(), clock: Date.now } as unknown as PluginDeps);
    if ('disabled' in g) throw new Error('disabled');
    const names = g.tools.map((t) => t.name);
    expect(names).toContain('clickup_delete_task');
    expect(names).not.toContain('clickup_search_tasks');
    const create = g.tools.find((t) => t.name === 'clickup_create_task')!;
    expect(Object.keys((create.inputSchema as unknown as { shape: object }).shape)).toEqual(['name', 'description']);
    const { reg, c } = await webRig(g.tools, direct);
    await reg.run('clickup_list_open_tasks', {}, c);
    await reg.run('clickup_get_task_detail', { task_id: 'a1' }, c);
    expect((await reg.run('clickup_get_task_detail', { task_id: 'b2' }, c)).content).toContain('ClickUp: that task is not in the configured list');
    expect(f.requests.filter((q) => /\/team\b/.test(q.url))).toEqual([]);
  });
});

describe('(d) adversarial bodies: refused, or the real card fits whole', () => {
  const alphabets: Record<string, string> = {
    backslash: '\\', quote: '"', newline: '\n', zwsp: '\u200b', tagchar: '\u{E0041}', ctrl: '\u0001', at: '@', lt: '<', emoji: '😀', thai: 'ก', star: '*', tick: '`', bracket: '[', pipe: '|', bidi: '\u202e', nbsp: '\u00a0', ls: '\u2028', fe0f: '\ufe0f', mixed: '\\"\n@<*`[|ก😀',
  };
  const tools: [string, (b: string) => Record<string, unknown>][] = [
    ['clickup_create_task', (b) => ({ list_id: '7001', name: b.slice(0, 110), description: b })],
    ['clickup_update_task', (b) => ({ task_id: 'a1', name: b.slice(0, 110), description: b })],
    ['clickup_add_comment', (b) => ({ task_id: 'a1', text: b })],
    ['clickup_assign_task', (b) => ({ task_id: 'a1', add: Array.from({ length: 10 }, (_, i) => `${i}${b.repeat(100)}`.slice(0, 100)) })],
    ['clickup_update_status', (b) => ({ task_id: 'a1', status: b.slice(0, 100) })],
  ];
  for (const ctxName of ['direct', 'tainted']) {
    it(`every alphabet x tool (${ctxName} run): refused before a card, or the real solo card is whole (<=25 fields, <=1024, <=6000, no cut)`, async () => {
      let carded = 0;
      let refused = 0;
      for (const [alpha, ch] of Object.entries(alphabets)) {
        for (const [name, mk] of tools) {
          const { g } = rig();
          const ctx = ctxName === 'direct' ? direct : { direct: false, origin: 'delegated' as const, tainted: () => true };
          const { reg, c, approvals } = await webRig(g.tools, ctx);
          const body = ch.repeat(Math.ceil(1500 / ch.length)).slice(0, 1500);
          const r = await reg.run(name, mk(body), c);
          const reqs = filed(approvals);
          if (reqs.length === 0) { refused++; expect(r.isError || WAITING.test(r.content) === false, `${alpha}/${name}`).toBeTruthy(); continue; }
          carded++;
          const q = reqs[0]!;
          const p = toolApprovalPayload({ id: 999_999_999, taskId: c.task?.id ?? 't', reason: q.reason, estCostUsd: 0, requestedBy: 'actor', status: 'pending', decidedBy: null, createdAt: new Date(0), decidedAt: null, toolName: name, toolInput: q.tool.input, inputSha256: 'a'.repeat(64), kind: 'tool' } as Approval);
          const fields = p.fields ?? [];
          const total = (p.title ?? '').length + (p.body ?? '').length + fields.reduce((n, x) => n + x.name.length + x.value.length, 0);
          expect(fields.length, `${alpha}/${name}`).toBeLessThanOrEqual(25);
          expect(Math.max(0, ...fields.map((x) => x.value.length)), `${alpha}/${name}`).toBeLessThanOrEqual(1024);
          expect(total, `${alpha}/${name}`).toBeLessThanOrEqual(6000);
          expect(JSON.stringify(p), `${alpha}/${name}`).not.toMatch(/truncated/i);
          // the whole body is recoverable from the card: every body char is either shown or shown as a visible \u{...} code
          if (name === 'clickup_add_comment' && alpha === 'at') expect(fields.map((x) => x.value).join('').replace(/\u200b/g, '')).toContain('@'.repeat(100));
        }
      }
      expect(carded).toBeGreaterThan(0);
      expect(refused).toBeGreaterThan(0);
    });
  }
  it('1501 refused by zod; hidden/control in names refused too', async () => {
    const { g } = rig();
    const { reg, c, approvals } = await webRig(g.tools, direct);
    for (const [n, i] of [['clickup_add_comment', { task_id: 'a1', text: 'x'.repeat(1501) }], ['clickup_create_task', { list_id: '7001', name: 'a\u200bb' }], ['clickup_create_task', { list_id: '7001', name: 'n'.repeat(111) }]] as const) {
      expect((await reg.run(n, i, c)).isError, n).toBe(true);
    }
    expect(approvals.request).not.toHaveBeenCalled();
  });
});

describe('(e) caps', () => {
  it('5 per run on the request path, the 6th refused with no card; a new run is fine', async () => {
    const { g } = rig();
    const { reg, c, approvals } = await webRig(g.tools, direct);
    for (let i = 0; i < 5; i++) expect((await reg.run('clickup_add_comment', { task_id: 'a1', text: `c${i}` }, c)).content).toMatch(WAITING);
    const sixth = await reg.run('clickup_add_comment', { task_id: 'a1', text: 'c6' }, c);
    expect(sixth.isError).toBe(true);
    expect(sixth.content).toBe('ClickUp: at most 5 write requests per run');
    expect(approvals.request).toHaveBeenCalledTimes(5);
  });
  it('50/day default; timezone day (Asia/Bangkok) rolls at 17:00Z; 0 = off', async () => {
    const { g, f, clock, usage, cfg } = rig({}, { 'clickup.writesPerDay': 3 });
    const { reg, c, approvals } = await webRig(g.tools, direct);
    await reg.run('clickup_add_comment', { task_id: 'a1', text: 'x' }, c);
    const stored = filed(approvals)[0]!.tool.input;
    clock.now = Date.parse('2026-11-08T16:59:59Z'); // 23:59:59 local
    for (let i = 0; i < 3; i++) expect((await reg.runApproved('clickup_add_comment', stored, c)).isError).toBeFalsy();
    expect((await reg.runApproved('clickup_add_comment', stored, c)).content).toBe('ClickUp: the daily write limit is reached; nothing was done');
    clock.now = Date.parse('2026-11-08T17:00:00Z'); // 00:00:00 next local day
    expect((await reg.runApproved('clickup_add_comment', stored, c)).isError).toBeFalsy();
    expect([...usage.days.entries()]).toEqual([['2026-11-08', 3], ['2026-11-09', 1]]);
    expect(writes(f)).toHaveLength(4);
    cfg.values.set('clickup.writesPerDay' as never, 0 as never);
    clock.now = Date.parse('2026-11-10T00:00:00Z');
    expect((await reg.runApproved('clickup_add_comment', stored, c)).isError).toBe(true);
    expect(writes(f)).toHaveLength(4);
  });
  it('default cap is 50', () => { expect(new FakeConfig().get('clickup.writesPerDay')).toBe(50); });
});

describe('(f) /clickup watch and poller', () => {
  it('foreign list refused, own list added (risk), 11th refused, remove ok', async () => {
    const { client, cfg } = rig();
    const deps = { cfg, clickup: client } as never;
    const foreign = await planClickupWatch('7999', 'add', deps);
    expect(isError(foreign) && foreign.error).toBe('That list is not in the ClickUp workspace.');
    const missing = await planClickupWatch('7998', 'add', deps);
    expect(isError(missing) && missing.error).toBe('That list is not in the ClickUp workspace.');
    const ok = await planClickupWatch('7001', 'add', deps);
    expect(isError(ok)).toBe(false);
    cfg.values.set('clickup.pollListIds' as never, Array.from({ length: 10 }, (_, i) => `l${i}`) as never);
    const eleventh = await planClickupWatch('7002', 'add', deps);
    expect(isError(eleventh) && eleventh.error).toMatch(/At most 10/);
    cfg.values.set('clickup.pollListIds' as never, ['7001'] as never);
    expect(isError(await planClickupWatch('7001', 'remove', deps))).toBe(false);
  });
  it('poller: silent baseline, then notices; hostile task name cannot ping or link', async () => {
    const state = ws({ teams: [{ id: '9001' }] });
    const f = workspaceFetch(state);
    const client = createClickUpClient({ http: createHttpClient({ fetch: f }), token: state.token, teamId: '9001' });
    const posts: { payload: { body?: string; allowedMentions?: unknown } }[] = [];
    const port = { post: async (_a: unknown, _b: unknown, payload: never) => (posts.push({ payload }), { id: '1' }) };
    let now = Date.parse('2026-11-01T10:00:00Z');
    const seen = memSeen();
    const poller = new ClickUpPoller({ client, seen: seen as never, port: port as never, channel: async () => '1569000000000000001', intervalSec: () => 120, canRun: () => true, clock: () => now, log: { warn: vi.fn(), error: vi.fn() }, watched: () => ['7001'] } as never);
    await poller.tick();
    expect(posts).toHaveLength(0);
    state.tasks.push({ id: 'n1', name: '@everyone <@&123> [click](http://evil.test) **x**', listId: '7001', spaceId: '501', status: { status: 'to do', type: 'open' }, date_updated: String(now + 1000) });
    state.tasks.push({ id: 'n2', name: 'Foreign list task', listId: '7002', spaceId: '501', status: { status: 'to do', type: 'open' }, date_updated: String(now + 1000) });
    now += 120_000;
    await poller.tick();
    expect(posts).toHaveLength(1);
    const body = posts[0]!.payload.body ?? '';
    expect(body).not.toContain('Foreign list task');
    expect(body).not.toMatch(/(^|[^\\])@everyone/);
    expect(body).not.toMatch(/\]\(http/);
    expect(JSON.stringify(posts[0]!.payload)).not.toMatch(/9001|501|pk_1234/);
  });
});

describe('(g) no token, team id or space ids in any output, error, audit or log', () => {
  it('sweep over reads, writes, refusals and failures', async () => {
    const { g, f, state, log } = rig();
    const spy = auditSpy();
    const { reg, c, approvals } = await webRig(g.tools, { ...direct, audit: spy.audit });
    const outs: string[] = [];
    const call = async (n: string, i: object) => { const r = await reg.run(n, i, c); outs.push(r.content); return r; };
    for (const [n, i] of [
      ['clickup_list_projects', {}], ['clickup_search_tasks', {}], ['clickup_search_tasks', { space_id: '999' }], ['clickup_get_task_detail', { task_id: 'a1' }], ['clickup_get_task_detail', { task_id: 'z9' }],
      ['clickup_list_comments', { task_id: 'a1' }], ['clickup_list_open_tasks', { project: 'Sprint' }], ['clickup_analyze_project', { project: '7002' }], ['clickup_create_task', { list_id: '7999', name: 'x' }],
      ['clickup_create_task', { list_id: '7001', name: 'x' }], ['clickup_update_status', { task_id: 'a1', status: 'nonexistent' }], ['clickup_assign_task', { task_id: 'a1', add: ['nobody'] }],
    ] as const) await call(n, i);
    await reg.runApproved('clickup_assign_task', { task_id: 'a1', add: ['nobody'], in_list_id: '7001' }, c);
    state.tooManyRequests = true;
    await call('clickup_list_projects', {});
    state.tooManyRequests = false;
    state.token = 'rotated'; // 401 path
    outs.push((await reg.run('clickup_get_task_detail', { task_id: 'b2' }, c)).content);
    const hay = JSON.stringify([outs, spy.entries, approvals.request.mock.calls, log.warn.mock.calls]);
    expect(hay).not.toContain(TOKEN);
    expect(hay).not.toMatch(/pk_1234|rotated/);
    expect(hay).not.toMatch(/(?<![0-9a-z])(9001|9002|501|502|999)(?![0-9a-z])/);
    expect(hay).not.toMatch(/@x\.test|secret-inbox/);
    void f;
  });
});

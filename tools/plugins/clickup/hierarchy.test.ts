import { describe, expect, it, vi } from 'vitest';
import { auditSpy } from '../../../agents/test-helpers.js';
import { FakeConfig } from '../../../governance/test-helpers.js';
import { createHttpClient } from '../../../services/http.js';
import { workspaceFetch, ws, type WsState } from '../../../tests/fakes/clickup-workspace.js';
import { isNoApproval } from '../../policy-approval.js';
import { treeGrantCovers } from '../../tree-grant-scope.js';
import type { ToolContext, ToolPlugin } from '../../types.js';
import { webRig } from '../web/test-helpers.js';
import type { PluginDeps } from '../deps.js';
import { createClickUpClient, E, parentPathText, workspaceLabelText, type ClickUpClient } from './client.js';
import { clickupGroup } from './index.js';
import { allRig, teamB, TEAM_B } from './multi-helpers.js';
import { RUN_CAP, SYNTHETIC_REASON_LEN, WE, WORST_TARGET_LEN } from './workspace-write.js';

/** CLICKUP-HIER-1: create space / folder / list (Gate 1 CH-C1..CH-C9). The REAL client and tools against the workspace fake. */
const B = 'https://api.clickup.com/api/v2';
const TEAM = '9001';
const WAITING = /^NOT DONE YET: waiting for approval of/;
const NOW0 = Date.parse('2026-11-08T05:00:00Z');
const TOOLS = ['clickup_create_space', 'clickup_create_folder', 'clickup_create_list'];

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
type Req = { tool: { name: string; input: Record<string, unknown> }; reason: string };
const filed = (a: { request: { mock: { calls: unknown[][] } } }): Req[] => a.request.mock.calls.map((x) => x[0] as Req);
const ctxFor = (o: { direct?: boolean; tainted?: boolean } = {}): Partial<ToolContext> => ({ direct: o.direct ?? true, origin: 'chat', tainted: () => o.tainted ?? false });
const posts = (f: { requests: { method: string; url: string; body: string | null }[] }) => f.requests.filter((q) => q.method === 'POST');
const count = (f: { requests: { method: string; url: string }[] }, m: string, path: string) => f.requests.filter((q) => q.method === m && q.url.split('?')[0] === `${B}${path}`).length;

type Rig = ReturnType<typeof nrig>;
/** Numeric-mode rig: a mutable clock for the client, a failing/slow fetch hook, the counter, the group. */
function nrig(over: Partial<WsState> = {}, cfgInit: Partial<{ 'clickup.writesPerDay': number }> = {}, o: { before?: (key: string, state: WsState) => Promise<void> | void; failKey?: () => string | null; throwPost?: boolean } = {}) {
  const state = ws({ teamName: 'Core', ...over });
  const base = workspaceFetch(state);
  const clock = { t: NOW0 };
  const warn = vi.fn();
  const f = (async (u: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof u === 'string' ? u : u instanceof URL ? u.href : u.url;
    const key = `${(init?.method ?? 'GET').toUpperCase()} ${url.split('?')[0]!.replace(B, '')}`;
    if (o.throwPost && key.startsWith('POST ')) { base.requests.push({ method: 'POST', url, headers: {}, body: typeof init?.body === 'string' ? init.body : null }); throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); }
    await o.before?.(key, state);
    if (o.failKey?.() === key) return new Response('{}', { status: 500 });
    return base(u, init);
  }) as typeof fetch & { requests: typeof base.requests };
  f.requests = base.requests;
  const client = createClickUpClient({ http: createHttpClient({ fetch: f }), token: state.token, teamId: TEAM, now: () => clock.t, log: { warn } });
  const usage = new MemUsage();
  const g = clickupGroup({ clickup: client, clickupUsage: usage, cfg: new FakeConfig(cfgInit), log: { warn: vi.fn() }, clock: () => NOW0 } as unknown as PluginDeps);
  if ('disabled' in g) throw new Error(g.disabled);
  return { state, f, client, g, usage, clock, warn };
}
const ctxOf = (g: { tools: ToolPlugin<any>[] }, extra: Partial<ToolContext> = {}) => webRig(g.tools, { ...ctxFor(), ...extra });
/** The request path: a card is filed; returns the stored (pinned) input. */
async function file(g: { tools: ToolPlugin<any>[] }, name: string, input: Record<string, unknown>, extra: Partial<ToolContext> = {}) {
  const rg = await ctxOf(g, extra);
  const r = await rg.reg.run(name, input, rg.c);
  return { ...rg, r, stored: filed(rg.approvals)[0]?.tool.input };
}
/** The approved replay, in a fresh run (as production). */
async function replay(g: { tools: ToolPlugin<any>[] }, name: string, stored: unknown, extra: Partial<ToolContext> = {}) {
  const rg = await ctxOf(g, extra);
  return rg.reg.runApproved(name, stored, rg.c);
}
const tool = (g: { tools: ToolPlugin<any>[] }, name: string) => g.tools.find((t) => t.name === name)!;

describe('CH-C9 schemas and names', () => {
  it('list mode registers none of the three tools', () => {
    const client = createClickUpClient({ http: createHttpClient({ fetch: workspaceFetch(ws()) }), token: 't', listId: '7001' });
    const g = clickupGroup({ clickup: client, cfg: new FakeConfig(), log: { warn: vi.fn() }, clock: () => NOW0 } as unknown as PluginDeps);
    if ('disabled' in g) throw new Error(g.disabled);
    for (const n of TOOLS) expect(g.tools.map((t) => t.name)).not.toContain(n);
  });

  it('numeric mode: create_space has in_workspace but no workspace; all mode requires workspace; unknown keys are refused (strict)', () => {
    const { g } = nrig();
    const s = tool(g, 'clickup_create_space').inputSchema;
    expect(s.safeParse({ name: 'Alpha' }).success).toBe(true);
    expect(s.safeParse({ name: 'Alpha', in_workspace: 'x' }).success).toBe(true);
    for (const extra of [{ workspace: 'Core' }, { features: {} }, { private: true }, { multiple_assignees: false }, { admin_can_manage: true }]) expect(s.safeParse({ name: 'Alpha', ...extra }).success).toBe(false);
    const a = tool(allRig().g, 'clickup_create_space').inputSchema;
    expect(a.safeParse({ name: 'Alpha' }).success).toBe(false);
    expect(a.safeParse({ name: 'Alpha', workspace: 'Acme' }).success).toBe(true);
    // folder and list: no workspace input anywhere; in_workspace only in all mode
    expect(tool(g, 'clickup_create_folder').inputSchema.safeParse({ space_id: '501', name: 'F', in_workspace: 'x' }).success).toBe(false);
    expect(tool(allRig().g, 'clickup_create_folder').inputSchema.safeParse({ space_id: '501', name: 'F', in_workspace: 'x' }).success).toBe(true);
    expect(tool(g, 'clickup_create_folder').inputSchema.safeParse({ space_id: '501', name: 'F', workspace: 'Core' }).success).toBe(false);
  });

  it('create_list takes exactly one of space_id / folder_id; pins are typed', () => {
    const { g } = nrig();
    const s = tool(g, 'clickup_create_list').inputSchema;
    expect(s.safeParse({ space_id: '501', name: 'L' }).success).toBe(true);
    expect(s.safeParse({ folder_id: 'f1', name: 'L' }).success).toBe(true);
    expect(s.safeParse({ name: 'L' }).success).toBe(false);
    expect(s.safeParse({ space_id: '501', folder_id: 'f1', name: 'L' }).success).toBe(false);
    expect(s.safeParse({ space_id: '501', name: 'L', in_space_id: 'BAD ID' }).success).toBe(false);
    expect(s.safeParse({ space_id: '501', name: 'L', in_folder_id: '../x' }).success).toBe(false);
    expect(s.safeParse({ space_id: '501', name: 'L', parent_path: 'x'.repeat(81) }).success).toBe(false);
    expect(s.safeParse({ space_id: '501', name: 'L', description: 'd'.repeat(1501) }).success).toBe(false);
  });

  it.each([
    ['a slash', 'a/b'], ['a backslash', 'a\\b'], ['an open bracket', 'a[b'], ['a close bracket', 'a]b'], ['NBSP only', ' '], ['U+2800', '⠀'], ['a leading space', ' a'], ['a trailing space', 'a '],
    ['a newline', 'a\nb'], ['a tab', 'a\tb'], ['101 units', 'x'.repeat(101)], ['a double space', 'a  b'], ['a VS16 emoji', 'a❤️'], ['a ZWJ sequence', '\u{1F468}‍\u{1F469}'], ['a zero width space', 'a​b'], ['only a question mark', '?'], ['empty', ''],
  ])('refuses a name with %s, files no card', async (_l, name) => {
    for (const [tl, input] of [['clickup_create_space', { name }], ['clickup_create_folder', { space_id: '501', name }], ['clickup_create_list', { space_id: '501', name }]] as const) {
      const { g, f } = nrig();
      const { r, approvals } = await file(g, tl, input);
      expect(r.isError, tl).toBe(true);
      expect(r.content, tl).toContain(WE.BAD_NAME);
      expect(approvals.request, tl).not.toHaveBeenCalled();
      expect(posts(f), tl).toEqual([]);
    }
  });

  it('refuses with the fixed WE.BAD_NAME text', async () => {
    const { g } = nrig();
    expect((await file(g, 'clickup_create_space', { name: 'a/b' })).r.content).toContain(WE.BAD_NAME);
  });

  it('accepts a Thai name and a Thai name with combining marks (CH-C9)', async () => {
    for (const name of ['โครงการ ทดสอบ', 'ที่พักอาศัย']) {
      const { g } = nrig();
      const { r, approvals } = await file(g, 'clickup_create_space', { name });
      expect(r.content, name).toMatch(WAITING);
      expect(approvals.request).toHaveBeenCalledTimes(1);
    }
  });
});

describe('cards and approved replays: one POST, the typed body, ids only', () => {
  it('create_space (numeric): card pins the workspace, replay posts exactly {name, multiple_assignees, features}', async () => {
    const { g, f, usage, state } = nrig();
    const { r, stored } = await file(g, 'clickup_create_space', { name: 'Research' });
    expect(r.content).toMatch(WAITING);
    expect(stored).toEqual({ name: 'Research', in_workspace: workspaceLabelText(TEAM, 'Core') });
    expect(posts(f)).toEqual([]);
    const audit = auditSpy();
    const out = await replay(g, 'clickup_create_space', stored, { audit: audit.audit });
    expect(out.isError, out.content).toBeFalsy();
    expect(out.content).toBe(`Created space ${state.nextId - 1}.`);
    expect(posts(f)).toHaveLength(1);
    expect(posts(f)[0]!.url).toBe(`${B}/team/${TEAM}/space`);
    const body = JSON.parse(posts(f)[0]!.body!) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['features', 'multiple_assignees', 'name']); // CH-C7
    expect(body).toEqual({
      name: 'Research', multiple_assignees: true,
      features: {
        due_dates: { enabled: true, start_date: false, remap_due_dates: false, remap_closed_due_date: false }, time_tracking: { enabled: false }, tags: { enabled: true }, time_estimates: { enabled: false },
        checklists: { enabled: true }, custom_fields: { enabled: true }, remap_dependencies: { enabled: false }, dependency_warning: { enabled: false }, portfolios: { enabled: false },
      },
    });
    expect(usage.takes).toBe(1);
    expect(audit.entries.filter((e) => e.action === 'clickup.hierarchy.created')).toEqual([expect.objectContaining({ action: 'clickup.hierarchy.created', outcome: 'space' })]);
  });

  it('create_folder and create_list (space, folder): pins on the card, exact bodies, ids only', async () => {
    const { g, f, state } = nrig({ folders: [{ id: 'f501', name: 'Backend', spaceId: '501' }] });
    const a = await file(g, 'clickup_create_folder', { space_id: '502', name: 'Q4' });
    expect(a.stored).toMatchObject({ space_id: '502', name: 'Q4', in_space_id: '502', parent_path: expect.stringContaining('Marketing [') as string });
    expect((await replay(g, 'clickup_create_folder', a.stored)).content).toBe(`Created folder ${state.nextId - 1} in space 502.`);
    expect(JSON.parse(posts(f)[0]!.body!)).toEqual({ name: 'Q4' });
    const b = await file(g, 'clickup_create_list', { folder_id: 'f501', name: 'Sprint 2', description: 'hello' });
    expect(b.stored).toMatchObject({ folder_id: 'f501', in_folder_id: 'f501', parent_path: expect.stringContaining('Engineering / Backend [') as string });
    expect(b.stored).not.toHaveProperty('in_space_id');
    const rb = await replay(g, 'clickup_create_list', b.stored);
    expect(rb.content).toBe(`Created list ${state.nextId - 1}; use list_id ${state.nextId - 1} with clickup_create_task.`);
    expect(posts(f)[1]!.url).toBe(`${B}/folder/f501/list`);
    expect(JSON.parse(posts(f)[1]!.body!)).toEqual({ name: 'Sprint 2', content: 'hello' });
    const c = await file(g, 'clickup_create_list', { space_id: '501', name: 'Loose' });
    await replay(g, 'clickup_create_list', c.stored);
    expect(posts(f)[2]!.url).toBe(`${B}/space/501/list`);
    expect(JSON.parse(posts(f)[2]!.body!)).toEqual({ name: 'Loose' }); // no content key, no assignee/status/priority/due_date
  });

  it('the card target names the workspace label and the parent, with no team id', async () => {
    const { g } = nrig();
    const rg = await file(g, 'clickup_create_folder', { space_id: '501', name: 'Q4' });
    const req = filed(rg.approvals)[0]!;
    expect(req.reason).toContain('every change needs approval');
    const all = allRig({}, { usage: new MemUsage() });
    const ag = await file(all.g, 'clickup_create_space', { name: 'Alpha', workspace: 'Acme' });
    expect(filed(ag.approvals)[0]!.tool.input).toMatchObject({ name: 'Alpha', workspace: 'Acme', in_workspace: workspaceLabelText(TEAM_B, 'Acme') });
  });

  it('a tainted or delegated run files its card with the central reason that names the target, and still fits the card (C1b)', async () => {
    const { g } = nrig();
    for (const extra of [ctxFor({ tainted: true }), { direct: false, origin: 'delegated' as const }]) {
      const { r, approvals } = await file(g, 'clickup_create_list', { space_id: '501', name: 'N'.repeat(100), description: 'd'.repeat(1500) }, extra);
      expect(r.content).toMatch(WAITING);
      expect(filed(approvals)[0]!.reason.length).toBeLessThanOrEqual(500);
    }
  });
});

describe('CH-C8 approval is unconditional', () => {
  it('direct, untainted: each tool files a card and touches nothing; no grant surface', async () => {
    const calls: [string, Record<string, unknown>][] = [['clickup_create_space', { name: 'A1' }], ['clickup_create_folder', { space_id: '501', name: 'F1' }], ['clickup_create_list', { space_id: '501', name: 'L1' }]];
    for (const [name, input] of calls) {
      const { g, f } = nrig();
      const { r, approvals } = await file(g, name, input);
      expect(r.content, name).toMatch(WAITING);
      expect(approvals.request).toHaveBeenCalledTimes(1);
      expect(posts(f)).toEqual([]);
      expect(treeGrantCovers(name, 'write', tool(g, name).requiresApproval({} as never, {} as never))).toBe(false);
      expect(isNoApproval(name)).toBe(false);
    }
  });
});

describe('caps: run cap, space cap per run (CH-C6), daily cap', () => {
  it('a 6th write in a run is refused (RUN_CAP), shared with the task writes', async () => {
    const { g } = nrig();
    const rg = await ctxOf(g);
    for (let i = 0; i < RUN_CAP; i++) expect((await rg.reg.run('clickup_create_folder', { space_id: '501', name: `F${i}` }, rg.c)).content).toMatch(WAITING);
    expect((await rg.reg.run('clickup_create_task', { list_id: '7001', name: 'x' }, rg.c)).content).toBe(WE.RUN_CAP);
    expect((await rg.reg.run('clickup_create_list', { space_id: '501', name: 'L' }, rg.c)).content).toBe(WE.RUN_CAP);
  });

  it('a 3rd space card in one run is refused; refused space calls do not count; an approved replay is never refused by it', async () => {
    const { g, f } = nrig();
    const rg = await ctxOf(g);
    for (let i = 0; i < 3; i++) await rg.reg.run('clickup_create_space', { name: 'a/b' }, rg.c); // invalid: no card, no count
    await rg.reg.run('clickup_create_space', { name: 'S1' }, rg.c);
    await rg.reg.run('clickup_create_space', { name: 'S2' }, rg.c);
    const third = await rg.reg.run('clickup_create_space', { name: 'S3' }, rg.c);
    expect(third.content).toBe(WE.SPACE_RUN_CAP);
    expect(filed(rg.approvals)).toHaveLength(2);
    // other tools are not limited by the space counter
    expect((await rg.reg.run('clickup_create_folder', { space_id: '501', name: 'F' }, rg.c)).content).toMatch(WAITING);
    // an approved replay (a different run) is not refused
    const out = await replay(g, 'clickup_create_space', filed(rg.approvals)[0]!.tool.input);
    expect(out.isError, out.content).toBeFalsy();
    expect(posts(f)).toHaveLength(1);
  });

  it('a refusal at precheck (duplicate) does not use up the space cap', async () => {
    const { g } = nrig({ spaces: [{ id: '501', name: 'Engineering' }, { id: '502', name: 'Marketing' }] });
    const rg = await ctxOf(g);
    for (let i = 0; i < 3; i++) expect((await rg.reg.run('clickup_create_space', { name: 'Engineering' }, rg.c)).content).toBe(E.DUPLICATE);
    expect((await rg.reg.run('clickup_create_space', { name: 'S1' }, rg.c)).content).toMatch(WAITING);
    expect((await rg.reg.run('clickup_create_space', { name: 'S2' }, rg.c)).content).toMatch(WAITING);
  });

  it('the daily cap is shared with the task writes and nothing is posted past it', async () => {
    const { g, f, usage } = nrig({}, { 'clickup.writesPerDay': 1 });
    const t = await file(g, 'clickup_create_task', { list_id: '7001', name: 'x' });
    expect((await replay(g, 'clickup_create_task', t.stored)).isError).toBeFalsy();
    const s = await file(g, 'clickup_create_folder', { space_id: '501', name: 'F' });
    const out = await replay(g, 'clickup_create_folder', s.stored);
    expect(out.content).toBe(WE.DAY_CAP);
    expect(posts(f)).toHaveLength(1);
    expect(usage.takes).toBe(2);
  });
});

describe('duplicates, collisions, space limit, failed reads', () => {
  it.each([['case fold', 'r&d', 'R&D'], ['Cyrillic look-alike', 'Sаles', 'Sales'], ['the same first 30 units', 'A'.repeat(30) + 'XYZ', 'A'.repeat(30) + 'QRS']])('a duplicate (%s) is refused at precheck and at run, no take', async (_l, want, existing) => {
    for (const thing of ['space', 'folder', 'list'] as const) {
      const over: Partial<WsState> = thing === 'space' ? { spaces: [{ id: '501', name: existing }] } : thing === 'folder' ? { folders: [{ id: 'f9', name: existing, spaceId: '501' }] } : { lists: [{ id: '7050', name: existing, spaceId: '501' }] };
      const { g, f, usage } = nrig(over);
      const name = 'clickup_create_' + thing;
      const input = thing === 'space' ? { name: want } : { space_id: '501', name: want };
      expect((await file(g, name, input)).r.content, `${thing} precheck`).toBe(E.DUPLICATE);
      // the run itself (a human created it between the card and the approval): the card was made on a clean state
      const clean = nrig();
      const card = await file(clean.g, name, input);
      expect(card.r.content).toMatch(WAITING);
      Object.assign(clean.state, over);
      const out = await tool(clean.g, name).run(card.stored as never, card.c);
      expect(out.content, `${thing} run`).toBe(E.DUPLICATE);
      expect(clean.usage.takes).toBe(0);
      expect(posts(clean.f)).toEqual([]);
      expect(usage.takes).toBe(0);
      expect(posts(f)).toEqual([]);
    }
  });

  it('two approved replays of the same name in parallel produce exactly one POST (the per-parent mutex)', async () => {
    const { g, f, usage } = nrig();
    const a = await file(g, 'clickup_create_folder', { space_id: '501', name: 'Same' });
    const [x, y] = await Promise.all([replay(g, 'clickup_create_folder', a.stored), replay(g, 'clickup_create_folder', a.stored)]);
    expect([Boolean(x.isError), Boolean(y.isError)].sort()).toEqual([false, true]);
    expect([x.content, y.content]).toContain(E.DUPLICATE);
    expect(posts(f)).toHaveLength(1);
    expect(usage.takes).toBe(1);
  });

  it('100 spaces: E.SPACE_CAP at precheck', async () => {
    const spaces = Array.from({ length: 100 }, (_, i) => ({ id: `${3000 + i}`, name: `Space ${i}` }));
    const { g } = nrig({ spaces });
    expect((await file(g, 'clickup_create_space', { name: 'One more' })).r.content).toBe(E.SPACE_CAP);
  });

  it('the sibling read fails -> refusal, no take, no POST (fail closed), in run() and through the replay', async () => {
    let failing: string | null = null;
    const { g, f, usage } = nrig({}, {}, { failKey: () => failing });
    const a = await file(g, 'clickup_create_folder', { space_id: '501', name: 'F' });
    failing = 'GET /space/501/folder';
    const rg = await ctxOf(g);
    expect((await tool(g, 'clickup_create_folder').run(a.stored as never, rg.c)).isError).toBe(true);
    expect((await replay(g, 'clickup_create_folder', a.stored)).isError).toBe(true);
    expect(usage.takes).toBe(0);
    expect(posts(f)).toEqual([]);
  });

  it('all mode: a workspace-name collision (also display-key only) refuses with no card', async () => {
    const long = 'W'.repeat(30);
    const r = allRig({ teamName: `${long}AAA`, more: [teamB({ name: `${long}BBB` })] }, { usage: new MemUsage() });
    const sp = await file(r.g, 'clickup_create_space', { name: 'Alpha', workspace: `${long}AAA` });
    expect(sp.r.content).toBe(E.NAME_COLLISION);
    expect(sp.approvals.request).not.toHaveBeenCalled();
    const fo = await file(r.g, 'clickup_create_folder', { space_id: '501', name: 'F' });
    expect(fo.r.content).toBe(E.NAME_COLLISION);
    expect(fo.approvals.request).not.toHaveBeenCalled();
  });

  it('all mode: workspace naming errors use the fixed multi texts', async () => {
    const r = allRig({}, { usage: new MemUsage() });
    expect((await file(r.g, 'clickup_create_space', { name: 'Alpha', workspace: 'Nowhere' })).r.content).toBe(E.NO_TEAM);
  });
});

describe('CH-C1 a missing pin is "moved", never a skipped check', () => {
  it('run() with the pins stripped: E_MOVED, no POST, no take (each tool; all mode too)', async () => {
    const calls: [string, Record<string, unknown>][] = [['clickup_create_space', { name: 'A1' }], ['clickup_create_folder', { space_id: '501', name: 'F1' }], ['clickup_create_list', { space_id: '501', name: 'L1' }], ['clickup_create_list', { folder_id: 'f501', name: 'L2' }]];
    for (const [name, input] of calls) {
      const { g, f, usage } = nrig({ folders: [{ id: 'f501', name: 'Backend', spaceId: '501' }] });
      const rg = await ctxOf(g);
      const out = await tool(g, name).run(input as never, rg.c);
      expect(out.content, name).toBe(E.MOVED);
      expect(posts(f), name).toEqual([]);
      expect(usage.takes, name).toBe(0);
    }
    const a = allRig({}, { usage: new MemUsage() });
    for (const [name, input] of [['clickup_create_space', { name: 'A1', workspace: 'Acme' }], ['clickup_create_folder', { space_id: '501', name: 'F1' }]] as const) {
      const card = await file(a.g, name, input);
      const { in_workspace: _drop, ...noWs } = card.stored as Record<string, unknown>; // every other pin is right: only the workspace pin is missing
      expect(_drop).toBeTypeOf('string');
      const rg = await ctxOf(a.g);
      expect((await tool(a.g, name).run(noWs as never, rg.c)).content, name).toBe(E.MOVED);
    }
    expect(posts(a.f)).toEqual([]);
  });

  it('through runApproved, a stored input with full pins whose parent was renamed gives E_MOVED, no take', async () => {
    const { g, f, usage, state } = nrig();
    for (const [name, input] of [['clickup_create_folder', { space_id: '501', name: 'F1' }], ['clickup_create_list', { space_id: '501', name: 'L1' }]] as const) {
      const card = await file(g, name, input);
      state.spaces[0]!.name = `Renamed ${name}`;
      expect((await replay(g, name, card.stored)).content, name).toBe(E.MOVED);
    }
    expect(posts(f)).toEqual([]);
    expect(usage.takes).toBe(0);
  });

  it('forged pins: E_MOVED at precheck, no card', async () => {
    const { g } = nrig({ folders: [{ id: 'f501', name: 'Backend', spaceId: '501' }] });
    for (const [name, input] of [
      ['clickup_create_folder', { space_id: '501', name: 'F', in_space_id: '502' }], ['clickup_create_folder', { space_id: '501', name: 'F', parent_path: 'Engineering [000000]' }],
      ['clickup_create_list', { space_id: '501', name: 'L', in_folder_id: 'f501' }], ['clickup_create_list', { folder_id: 'f501', name: 'L', in_folder_id: 'f777' }], ['clickup_create_space', { name: 'S', in_workspace: 'Other [000000]' }],
    ] as const) {
      const { r, approvals } = await file(g, name, input);
      expect(r.content, name).toBe(E.MOVED);
      expect(approvals.request).not.toHaveBeenCalled();
    }
  });

  it('parent renamed, archived or gone between card and run: no take', async () => {
    const { g, state, usage, f } = nrig();
    const card = await file(g, 'clickup_create_folder', { space_id: '501', name: 'F' });
    state.archivedSpaces.push('501');
    expect((await replay(g, 'clickup_create_folder', card.stored)).content).toBe(E.SCOPE_SPACE);
    expect(usage.takes).toBe(0);
    expect(posts(f)).toEqual([]);
  });
});

describe('CH-C5 numeric create_space is pinned to its workspace; all mode label changes', () => {
  it('numeric: the team name changes between card and run -> E_MOVED, no take', async () => {
    const { g, state, usage, f } = nrig();
    const card = await file(g, 'clickup_create_space', { name: 'S' });
    state.teamName = 'Renamed Workspace';
    expect((await replay(g, 'clickup_create_space', card.stored)).content).toBe(E.MOVED);
    expect(usage.takes).toBe(0);
    expect(posts(f)).toEqual([]);
  });

  it('all mode: a workspace renamed to another name between card and run -> the card\'s workspace is gone (E.NO_TEAM), no take', async () => {
    const usage = new MemUsage();
    let t = NOW0;
    const r = allRig({}, { usage, now: () => t });
    const card = await file(r.g, 'clickup_create_space', { name: 'Alpha', workspace: 'Acme' });
    expect(card.r.content).toMatch(WAITING);
    r.state.more![0]!.name = 'Acme Renamed';
    t += 11 * 60_000; // the cached workspace set expires
    const out = await replay(r.g, 'clickup_create_space', card.stored);
    expect(out.content).toBe(E.NO_TEAM); // the card named "Acme"; there is no such workspace any more
    expect(usage.takes).toBe(0);
    expect(posts(r.f)).toEqual([]);
  });
});

describe('CH-C5 all mode: a case-only rename keeps the name resolvable but changes the label (E_MOVED on both paths)', () => {
  it('space, folder: E_MOVED at precheck and at run, no take', async () => {
    for (const [name, input] of [['clickup_create_space', { name: 'Alpha', workspace: 'Acme' }], ['clickup_create_folder', { space_id: '601', name: 'F' }]] as const) {
      const usage = new MemUsage();
      let t = NOW0;
      const r = allRig({}, { usage, now: () => t });
      const card = await file(r.g, name, input);
      expect(card.r.content, name).toMatch(WAITING);
      r.state.more![0]!.name = 'ACME';
      t += 11 * 60_000;
      expect((await replay(r.g, name, card.stored)).content, name).toBe(E.MOVED); // precheck
      const rg = await ctxOf(r.g);
      expect((await tool(r.g, name).run(card.stored as never, rg.c)).content, name).toBe(E.MOVED); // run itself
      expect(usage.takes).toBe(0);
      expect(posts(r.f)).toEqual([]);
    }
  });
});

describe('CH-C4 one refusal text per parent kind, on both paths', () => {
  const folders = [{ id: 'f501', name: 'Backend', spaceId: '501' }, { id: 'f999', name: 'Foreign', spaceId: '999' }, { id: 'fh', name: 'Hidden', spaceId: '501', hidden: true }, { id: 'fa', name: 'Arch', spaceId: '501', archived: true }];
  const spaceCases: [string, string, (s: WsState) => void][] = [
    ['404', '501', (s) => void (s.getStatus['501'] = 404)], ['403', '501', (s) => void (s.getStatus['501'] = 403)], ['unknown id', 'zz404', () => undefined], ['another workspace', '999', () => undefined],
    ['archived', '501', (s) => void s.archivedSpaces.push('501')], ['id mismatch', '501', (s) => void (s.wrongId['501'] = '502')],
  ];
  const folderCases: [string, string, (s: WsState) => void][] = [
    ['404', 'f501', (s) => void (s.getStatus['f501'] = 404)], ['403', 'f501', (s) => void (s.getStatus['f501'] = 403)], ['unknown id', 'zz404', () => undefined], ['space out of scope', 'f999', () => undefined],
    ['archived', 'fa', () => undefined], ['hidden', 'fh', () => undefined], ['id mismatch', 'f501', (s) => void (s.wrongId['f501'] = 'f502')],
  ];
  it.each(spaceCases)('space parent, %s: E.SCOPE_SPACE at precheck and at run (folder and list)', async (_l, id, mutate) => {
    for (const [name, input] of [['clickup_create_folder', { space_id: id, name: 'F' }], ['clickup_create_list', { space_id: id, name: 'L' }]] as const) {
      const { g, state, f, usage } = nrig({ folders });
      mutate(state);
      const pre = await file(g, name, input);
      expect(pre.r.content, name).toBe(E.SCOPE_SPACE);
      expect(pre.approvals.request).not.toHaveBeenCalled();
      const rg = await ctxOf(g);
      const run = await tool(g, name).run({ ...input, in_space_id: id, parent_path: 'x [000000]' } as never, rg.c);
      expect(run.content, name).toBe(E.SCOPE_SPACE);
      expect(posts(f)).toEqual([]);
      expect(usage.takes).toBe(0);
    }
  });
  it.each(folderCases)('folder parent, %s: E.SCOPE_FOLDER at precheck and at run', async (_l, id, mutate) => {
    const { g, state, f, usage } = nrig({ folders });
    mutate(state);
    const input = { folder_id: id, name: 'L' };
    const pre = await file(g, 'clickup_create_list', input);
    expect(pre.r.content).toBe(E.SCOPE_FOLDER);
    expect(pre.approvals.request).not.toHaveBeenCalled();
    const rg = await ctxOf(g);
    expect((await tool(g, 'clickup_create_list').run({ ...input, in_folder_id: id, parent_path: 'x [000000]' } as never, rg.c)).content).toBe(E.SCOPE_FOLDER);
    expect(posts(f)).toEqual([]);
    expect(usage.takes).toBe(0);
  });
  it('E_MOVED only when a pin no longer matches a parent that is still in scope', async () => {
    const { g, state } = nrig();
    const card = await file(g, 'clickup_create_folder', { space_id: '501', name: 'F' });
    state.spaces[0]!.name = 'Eng 2';
    expect((await replay(g, 'clickup_create_folder', card.stored)).content).toBe(E.MOVED);
  });
});

describe('CH-C3 outcomes of the POST', () => {
  const folderCard = (r: Rig) => file(r.g, 'clickup_create_folder', { space_id: '501', name: 'F' });
  it('a 4xx: E.CREATE_REFUSED and the counter is spent', async () => {
    const r = nrig();
    const card = await folderCard(r);
    r.state.postResponse = { status: 400, body: { err: 'plan limit: secret vendor text' } };
    const out = await replay(r.g, 'clickup_create_folder', card.stored);
    expect(out.content).toBe(E.CREATE_REFUSED);
    expect(r.usage.takes).toBe(1);
  });

  it('a 429: E.BUSY', async () => {
    const r = nrig();
    const card = await folderCard(r);
    r.state.postResponse = { status: 429, body: {} };
    expect((await replay(r.g, 'clickup_create_folder', card.stored)).content).toBe(E.BUSY);
  });

  it.each([['a 500', { status: 500, body: {} }], ['a 2xx without an id', { body: { name: 'x' } }], ['a 2xx with an invalid id', { body: { id: '../../x' } }], ['an unparsable 2xx', { body: 'not json at all <html>' }]])('%s: E.CREATE_UNKNOWN, the hierarchy cache is invalidated', async (_l, resp) => {
    const r = nrig();
    await r.client.hierarchy(); // fill the cache
    const card = await folderCard(r);
    r.state.postResponse = resp;
    const out = await replay(r.g, 'clickup_create_folder', card.stored);
    expect(out.isError).toBe(true);
    expect(out.content).toBe(E.CREATE_UNKNOWN);
    const mid = count(r.f, 'GET', '/space/501/folder');
    await r.client.hierarchy();
    expect(count(r.f, 'GET', '/space/501/folder')).toBeGreaterThan(mid); // the hierarchy cache was invalidated
  });

  it('a POST timeout invalidates the hierarchy; the next hierarchy() refetches', async () => {
    const r = nrig({}, {}, { throwPost: true });
    await r.client.hierarchy();
    const card = await file(r.g, 'clickup_create_list', { space_id: '501', name: 'L' });
    const out = await replay(r.g, 'clickup_create_list', card.stored);
    expect(out.content).toBe(E.CREATE_UNKNOWN);
    const n = count(r.f, 'GET', '/space/501/list');
    await r.client.hierarchy();
    expect(count(r.f, 'GET', '/space/501/list')).toBe(n + 1);
    expect(r.usage.takes).toBe(1);
  });

  it('after a successful create, hierarchy() refetches and shows the new list', async () => {
    const r = nrig();
    const h0 = await r.client.hierarchy();
    const card = await file(r.g, 'clickup_create_list', { space_id: '501', name: 'Fresh list' });
    await replay(r.g, 'clickup_create_list', card.stored);
    const h1 = await r.client.hierarchy();
    expect(h1.entries.some((e) => e.name === 'Fresh list')).toBe(true);
    expect(h0.entries.some((e) => e.name === 'Fresh list')).toBe(false);
  });

  it('a response whose space.id differs from the parent logs counts only (no ids)', async () => {
    const r = nrig();
    const card = await folderCard(r);
    r.state.postResponse = { body: { id: '8888', name: 'F', space: { id: '502' } } };
    expect((await replay(r.g, 'clickup_create_folder', card.stored)).isError).toBeFalsy();
    expect(r.warn).toHaveBeenCalled();
    expect(JSON.stringify(r.warn.mock.calls)).not.toMatch(/501|502|8888/);
  });
});

/** Direct client access for the scope tests: the guard the tool would build (the daily take is not under test here). */
const guardOf = (g: { workspace?: string; parentId?: string; parentPath?: string }) => ({ ...g, async beforeWrite() { /* no take */ } });

describe('CH-C2 a created space and the authoritative space list', () => {
  const label = (name = 'Core') => workspaceLabelText(TEAM, name);
  it('numeric: the space is in scope at once (no refresh inside 60 s), a later authoritative list without it removes it', async () => {
    const r = nrig();
    await r.client.describeParent('space', '501'); // warm S(T)
    const res = await r.client.createSpace({ name: 'Fresh' }, guardOf({ workspace: label() }));
    r.state.unlisted.push(res.id); // ClickUp's list is behind: it does not list it yet
    const spaceGets = count(r.f, 'GET', `/team/${TEAM}/space`);
    expect((await r.client.describeParent('space', res.id)).id).toBe(res.id);
    expect(count(r.f, 'GET', `/team/${TEAM}/space`)).toBe(spaceGets); // no reload inside the 60 s window
    r.clock.t += 11 * 60_000; // TTL over: the next check reads the authoritative list, which leaves it out
    await expect(r.client.describeParent('space', res.id)).rejects.toThrow(E.SCOPE_SPACE);
  });

  it('numeric: a refresh in flight while the create is running does not drop the new space', async () => {
    const state = ws({ teamName: 'Core' });
    const base = workspaceFetch(state);
    const clock = { t: NOW0 };
    let phase: 'idle' | 'armed' | 'held' = 'idle';
    let postStarted = false;
    let releasePost!: () => void;
    let releaseGet!: () => void;
    const postGate = new Promise<void>((r) => { releasePost = r; });
    const getGate = new Promise<void>((r) => { releaseGet = r; });
    const f = (async (u: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof u === 'string' ? u : u instanceof URL ? u.href : u.url;
      const m = (init?.method ?? 'GET').toUpperCase();
      if (m === 'POST' && url.endsWith(`/team/${TEAM}/space`)) { postStarted = true; await postGate; }
      const res = await base(u, init);
      if (phase === 'armed' && m === 'GET' && url.split('?')[0] === `${B}/team/${TEAM}/space`) { phase = 'held'; await getGate; } // a stale answer, delivered late
      return res;
    }) as typeof fetch;
    const client = createClickUpClient({ http: createHttpClient({ fetch: f }), token: state.token, teamId: TEAM, now: () => clock.t });
    await client.describeParent('space', '501');
    const create = client.createSpace({ name: 'Racer' }, guardOf({ workspace: label() }));
    await vi.waitFor(() => expect(postStarted).toBe(true));
    clock.t += 11 * 60_000;
    phase = 'armed';
    const racing = client.describeParent('space', '501'); // starts a load of S(T); its answer is held and will not contain the new space
    await vi.waitFor(() => expect(phase).toBe('held'));
    releasePost();
    await new Promise((r) => setTimeout(r, 20));
    releaseGet();
    const [, made] = await Promise.all([racing, create]);
    expect((await client.describeParent('space', made.id)).id).toBe(made.id);
  });

  it('all mode: the space is inserted into SI, so it is in scope with no refresh', async () => {
    const r = allRig();
    await r.client.describeParent('space', '501');
    const res = await r.client.createSpace({ name: 'Fresh', workspace: 'Acme' }, guardOf({ workspace: workspaceLabelText(TEAM_B, 'Acme') }));
    r.state.unlisted.push(res.id); // a refresh would not find it
    const n = count(r.f, 'GET', '/team');
    expect((await r.client.describeParent('space', res.id)).teamId).toBe(TEAM_B);
    expect(count(r.f, 'GET', '/team')).toBe(n);
  });

  it('all mode: an id that another team also lists is in no team\'s scope (the creator\'s and the other\'s), until an authoritative list decides', async () => {
    const r = allRig();
    await r.client.describeParent('space', '501');
    r.state.postResponse = { body: { id: '601', name: 'Dup', private: false } }; // Acme's own space id
    await r.client.createSpace({ name: 'Dup', workspace: 'Core' }, guardOf({ workspace: workspaceLabelText(TEAM, 'Core') }));
    await expect(r.client.describeParent('space', '601')).rejects.toThrow(E.SCOPE_SPACE);
  });

});

describe('CH-C2/CH-C3 all mode against a refresh in flight', () => {
  it('a refresh in flight while the create is running ends with the space in scope; the next full refresh without it removes it', async () => {
    const state = ws({ teamName: 'Core', more: [teamB()] });
    const base = workspaceFetch(state);
    const clock = { t: NOW0 };
    let phase: 'idle' | 'armed' | 'held' = 'idle';
    let releasePost!: () => void;
    let releaseGet!: () => void;
    const postGate = new Promise<void>((r) => { releasePost = r; });
    const getGate = new Promise<void>((r) => { releaseGet = r; });
    let postStarted = false;
    const f = (async (u: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof u === 'string' ? u : u instanceof URL ? u.href : u.url;
      const m = (init?.method ?? 'GET').toUpperCase();
      if (m === 'POST' && url.endsWith(`/team/${TEAM_B}/space`)) { postStarted = true; await postGate; }
      const res = await base(u, init);
      if (phase === 'armed' && m === 'GET' && url.split('?')[0] === `${B}/team/${TEAM_B}/space`) { phase = 'held'; await getGate; } // the stale answer is delivered late
      return res;
    }) as typeof fetch;
    (f as { requests?: unknown }).requests = base.requests;
    const client = createClickUpClient({ http: createHttpClient({ fetch: f }), token: state.token, allTeams: true, now: () => clock.t });
    await client.describeParent('space', '501');
    const create = client.createSpace({ name: 'Racer', workspace: 'Acme' }, guardOf({ workspace: workspaceLabelText(TEAM_B, 'Acme') }));
    await vi.waitFor(() => expect(postStarted).toBe(true));
    clock.t += 11 * 60_000; // scope expired while the POST is out
    phase = 'armed';
    const racing = client.describeParent('space', '501'); // starts a refresh whose Acme space answer is held (it will not contain the new space)
    await vi.waitFor(() => expect(phase).toBe('held'));
    releasePost();
    await new Promise((r) => setTimeout(r, 20));
    releaseGet();
    const [, made] = await Promise.all([racing, create]);
    expect((await client.describeParent('space', made.id)).teamId).toBe(TEAM_B);
    // ClickUp's authoritative answer later leaves it out: it leaves the scope
    state.unlisted.push(made.id);
    clock.t += 11 * 60_000;
    await expect(client.describeParent('space', made.id)).rejects.toThrow(E.SCOPE_SPACE);
  });

  it('the all-mode round trip: create space -> list in it -> task in it, two teams', async () => {
    const usage = new MemUsage();
    const r = allRig({}, { usage });
    const sp = await file(r.g, 'clickup_create_space', { name: 'Alpha', workspace: 'Acme' });
    const sid = String(r.state.nextId);
    expect((await replay(r.g, 'clickup_create_space', sp.stored)).content).toBe(`Created space ${sid}.`);
    const li = await file(r.g, 'clickup_create_list', { space_id: sid, name: 'Backlog' });
    expect(li.r.content).toMatch(WAITING);
    expect(li.stored).toMatchObject({ in_space_id: sid, in_workspace: workspaceLabelText(TEAM_B, 'Acme') });
    const lid = String(r.state.nextId);
    expect((await replay(r.g, 'clickup_create_list', li.stored)).isError).toBeFalsy();
    expect((await r.client.listInScope(lid)).teamId).toBe(TEAM_B); // usable at once, e.g. by `/clickup watch add` (it scope-checks the list)
    const tk = await file(r.g, 'clickup_create_task', { list_id: lid, name: 'First task' });
    expect(tk.r.content).toMatch(WAITING);
    expect((await replay(r.g, 'clickup_create_task', tk.stored)).isError).toBeFalsy();
    expect(posts(r.f).map((q) => q.url.replace(B, ''))).toEqual([`/team/${TEAM_B}/space`, `/space/${sid}/list`, `/list/${lid}/task`]);
  });
});

describe('C12 no team id or space id in audit or logs', () => {
  it('the audit row holds the kind only; the warn log (if any) holds counts only', async () => {
    const r = nrig();
    const audit = auditSpy();
    const card = await file(r.g, 'clickup_create_folder', { space_id: '501', name: 'Secretname' });
    await replay(r.g, 'clickup_create_folder', card.stored, { audit: audit.audit });
    const rows = audit.entries.filter((e) => e.action === 'clickup.hierarchy.created');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('folder');
    expect(JSON.stringify(audit.entries)).not.toMatch(/Secretname|9001|501/);
  });
});

describe('card sizes: the new targets stay inside the existing worst case', () => {
  it('parentPathText is at most 74 units and every create target is shorter than WORST_TARGET_LEN, so SYNTHETIC_REASON_LEN stays at 500', () => {
    const long = 'N'.repeat(100);
    const path = parentPathText({ kind: 'folder', id: 'f'.repeat(32), spaceId: 's'.repeat(32), space: long, folder: long });
    expect(path.length).toBeLessThanOrEqual(74);
    const worst = 'Workspace '.length + 40 + ' · '.length + 74 + ' (folder '.length + 32 + ')'.length;
    expect(worst).toBeLessThan(WORST_TARGET_LEN);
    expect(SYNTHETIC_REASON_LEN).toBe(500);
  });

  it('a 1500-unit description with a 100-unit name files a card on the solo path (cut false)', async () => {
    const { g } = nrig({ folders: [{ id: 'f501', name: 'Backend', spaceId: '501' }] });
    const { r, approvals } = await file(g, 'clickup_create_list', { folder_id: 'f501', name: 'N'.repeat(100), description: 'd'.repeat(1500) });
    expect(r.content).toMatch(WAITING);
    expect(approvals.request).toHaveBeenCalledTimes(1);
  });
});


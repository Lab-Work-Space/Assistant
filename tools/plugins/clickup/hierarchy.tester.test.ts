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


describe('CLICKUP-HIER-1 tester probes', () => {
  it('Praw flow in an empty-ish workspace: space -> folder -> list in folder -> task, sequential, ids only, 4 takes', async () => {
    const r = nrig({ spaces: [], lists: [], tasks: [], folders: [] });
    const sp = await file(r.g, 'clickup_create_space', { name: 'R&D' });
    expect(sp.r.content).toMatch(WAITING);
    const sid = /Created space (\w+)\./.exec((await replay(r.g, 'clickup_create_space', sp.stored)).content)![1]!;
    const fo = await file(r.g, 'clickup_create_folder', { space_id: sid, name: 'Product' });
    expect(fo.r.content).toMatch(WAITING);
    const fid = /Created folder (\w+) in space/.exec((await replay(r.g, 'clickup_create_folder', fo.stored)).content)![1]!;
    const li = await file(r.g, 'clickup_create_list', { folder_id: fid, name: 'Backlog', description: 'all work' });
    expect(li.r.content).toMatch(WAITING);
    const lid = /Created list (\w+);/.exec((await replay(r.g, 'clickup_create_list', li.stored)).content)![1]!;
    const tk = await file(r.g, 'clickup_create_task', { list_id: lid, name: 'T1' });
    expect(tk.r.content).toMatch(WAITING);
    expect((await replay(r.g, 'clickup_create_task', tk.stored)).isError).toBeFalsy();
    expect(r.usage.takes).toBe(4);
    expect(posts(r.f).map((q) => q.url.replace(B, '').replace(/\d+/g, 'N'))).toEqual(['/team/N/space', '/space/N/folder', '/folder/N/list', '/list/N/task']);
  });

  it('a 5xx on the space POST where the object WAS created: a retry of the same name is refused as a duplicate with no second POST or take', async () => {
    const r = nrig({ spaces: [] });
    const card = await file(r.g, 'clickup_create_space', { name: 'Research' });
    r.state.postResponse = { status: 502, body: {} };
    expect((await replay(r.g, 'clickup_create_space', card.stored)).content).toBe(E.CREATE_UNKNOWN);
    r.state.postResponse = undefined;
    r.state.spaces.push({ id: '777', name: 'Research' }); // it did exist in ClickUp
    const again = await file(r.g, 'clickup_create_space', { name: 'research' });
    expect(again.r.content).toBe(E.DUPLICATE);
    expect((await replay(r.g, 'clickup_create_space', card.stored)).content).toBe(E.DUPLICATE);
    expect(posts(r.f)).toHaveLength(1);
    expect(r.usage.takes).toBe(1);
  });

  it.each([
    ['tab', 'a\tb'], ['newline', 'a\nb'], ['ZWJ emoji', '\u{1F468}\u200D\u{1F4BB}'], ['VS16 emoji', '\u2764\uFE0F'], ['Hangul filler', 'a\u3164b'], ['braille blank', '\u2800'], ['double space', 'a  b'],
    ['trailing NBSP', 'ab\u00A0'], ['slash', 'a/b'], ['backslash', 'a\\b'], ['bracket', 'a[h6]'], ['empty', ''], ['101 units', 'x'.repeat(101)], ['bidi override', 'a\u202Eb'], ['tag char', 'a\u{E0041}'],
  ])('refuses the name (%s) at the schema, no card, no request', async (_l, name) => {
    const r = nrig();
    for (const [tl, input] of [['clickup_create_space', { name }], ['clickup_create_folder', { space_id: '501', name }], ['clickup_create_list', { space_id: '501', name }]] as const) {
      const out = await file(r.g, tl, input as never);
      expect(out.r.isError, `${tl} ${_l}`).toBe(true);
      expect(filed(out.approvals)).toEqual([]);
    }
    expect(r.f.requests.filter((q) => q.method !== 'GET')).toEqual([]);
    expect(r.usage.takes).toBe(0);
  });

  it('accepts exactly 100 units, Thai, and a mixed Thai/Latin name', async () => {
    const r = nrig();
    for (const name of ['x'.repeat(100), 'งานวิจัย R&D', 'ก\u0E49\u0E32 ทดสอบ']) expect((await file(r.g, 'clickup_create_folder', { space_id: '501', name })).r.content, name).toMatch(WAITING);
  });

  it('extra / forged keys are refused (strict): private, features, markdown_content, parent_folder_id, both or neither parent id', async () => {
    const r = nrig();
    const bad: [string, Record<string, unknown>][] = [
      ['clickup_create_space', { name: 'S', private: true }], ['clickup_create_space', { name: 'S', features: {} }], ['clickup_create_space', { name: 'S', multiple_assignees: false }], ['clickup_create_space', { name: 'S', workspace: 'x' }],
      ['clickup_create_folder', { space_id: '501', name: 'F', parent_folder_id: '1' }], ['clickup_create_list', { space_id: '501', name: 'L', markdown_content: 'x' }], ['clickup_create_list', { space_id: '501', name: 'L', assignee: 1 }],
      ['clickup_create_list', { space_id: '501', folder_id: 'f1', name: 'L' }], ['clickup_create_list', { name: 'L' }], ['clickup_create_list', { space_id: '../x', name: 'L' }],
    ];
    for (const [t, i] of bad) { const o = await file(r.g, t, i); expect(o.r.isError, `${t} ${JSON.stringify(i)}`).toBe(true); expect(filed(o.approvals)).toEqual([]); }
    expect(posts(r.f)).toEqual([]);
  });

  it('a secret-looking name or description is refused before a card (C5)', async () => {
    const r = nrig();
    const tok = 'pk_12345678_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
    for (const [t, i] of [['clickup_create_space', { name: tok }], ['clickup_create_list', { space_id: '501', name: 'ok', description: `token ${tok}` }]] as const) {
      const o = await file(r.g, t, i as never);
      expect(filed(o.approvals), t).toEqual([]);
    }
  });

  it('list mode: none of the three tools exist (workspace tools not registered)', async () => {
    const state = ws();
    const f = workspaceFetch(state);
    const client = createClickUpClient({ http: createHttpClient({ fetch: f }), token: state.token, listId: '7001', now: () => NOW0, log: { warn: vi.fn() } });
    const g = clickupGroup({ clickup: client, clickupUsage: new MemUsage(), cfg: new FakeConfig({}), log: { warn: vi.fn() }, clock: () => NOW0 } as unknown as PluginDeps);
    if ('disabled' in g) throw new Error(g.disabled);
    const names = g.tools.map((t) => t.name);
    for (const n of TOOLS) expect(names).not.toContain(n);
  });

  it('daily cap 50 is shared: 49 task takes then 1 space succeeds, the next create is refused with no POST', async () => {
    const r = nrig({ spaces: [] }, { 'clickup.writesPerDay': 50 });
    r.usage.days.set('2026-11-08', 49);
    const a = await file(r.g, 'clickup_create_space', { name: 'One' });
    expect((await replay(r.g, 'clickup_create_space', a.stored)).isError).toBeFalsy();
    const b = await file(r.g, 'clickup_create_folder', { space_id: '501', name: 'Two' });
    const out = await replay(r.g, 'clickup_create_folder', b.stored);
    expect(out.isError).toBe(true);
    expect(posts(r.f)).toHaveLength(1);
  });

  it('the tool run() result and the thrown text never carry a vendor message or a team id', async () => {
    const r = nrig();
    const card = await file(r.g, 'clickup_create_folder', { space_id: '501', name: 'F' });
    r.state.postResponse = { status: 403, body: { err: 'SECRET-VENDOR team 9001' } };
    const out = await replay(r.g, 'clickup_create_folder', card.stored);
    expect(out.content).toBe(E.CREATE_REFUSED);
    expect(out.content).not.toMatch(/SECRET|9001/);
  });
});

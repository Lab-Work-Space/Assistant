import { describe, expect, it, vi } from 'vitest';
import { FakeConfig } from '../governance/test-helpers.js';
import type { ToolKind } from '../tools/policy-approval.js';
import { REQUEST_TEXT, ToolRequestService, type ToolRequestDeps } from './tool-requests.js';

const kinds: Record<string, ToolKind | undefined> = { web_search: 'read', fetch_page: 'read', clickup_create_task: 'write', create_task: 'write' };
const HEAD = { kind: 'head', dept: 'rnd' } as const;
const MARKER = 'PLANTED-MARKER-31';

function rig(grant?: ToolRequestDeps['projectGrant']) {
  const create = vi.fn(async () => ({ ok: true as const, id: 9, token: 'a'.repeat(32), expiresAt: new Date(Date.now() + 1e6) }));
  const setCard = vi.fn(async () => true);
  const audits: { action: string; outcome?: string | null }[] = [];
  const posts: unknown[] = [];
  const logs: unknown[] = [];
  const deps = {
    repo: { create, setCard }, cfg: new FakeConfig({ 'tools.byDept': {} } as never),
    org: { dept: () => ({}) as never, toolsFor: () => ['respond'] },
    grant: { registered: () => Object.keys(kinds), builtins: () => ['create_task', 'respond'], kindOf: (n: string) => kinds[n] },
    plugins: () => Object.keys(kinds), halted: () => false, audit: async (e: never) => void audits.push(e), secrets: [], configChannelId: '1565682159375749161',
    postCard: async (p: unknown) => { posts.push(p); return '800000000000000101'; }, closeCard: async () => undefined, notifyHead: async () => undefined, log: { error: (o: unknown) => void logs.push(o) },
    ...(grant ? { projectGrant: grant } : {}),
  } as unknown as ToolRequestDeps;
  return { svc: new ToolRequestService(deps), create, audits, posts, logs };
}
const run = (over: Partial<{ tainted: boolean; task: { id: string; tainted: boolean } | null; ownsTask: boolean }> = {}) => ({ tainted: false, task: { id: 't1', tainted: false }, ownsTask: true, ...over });

describe('tool_request inside a project (SA-1 3.8, AP-C7)', () => {
  it('a granted project tool answers with the fixed text, no row, no card, and audits `project p<id> <tool>`', async () => {
    const g = vi.fn(async () => ({ kind: 'granted' as const, projectId: 4 }));
    const r = rig(g);
    const res = await r.svc.request(HEAD, run(), { tool: 'web_search', reason: 'need it' });
    expect(res).toEqual({ ok: true, id: null, text: "Granted for project #4 only: rnd may use web_search in this project's tasks from its next run there. No card was sent." });
    expect(g).toHaveBeenCalledWith({ dept: 'rnd', taskId: 't1', tool: 'web_search' });
    expect(r.create).not.toHaveBeenCalled();
    expect(r.posts).toHaveLength(0);
    expect(r.audits).toContainEqual(expect.objectContaining({ action: 'tool.request', outcome: 'project p4 web_search' }));
  });

  it('refused (exists or cap) is a tool error with the port\'s fixed text and no card', async () => {
    const r = rig(async () => ({ kind: 'refused', text: 'This project already has 10 granted tools.' }));
    expect(await r.svc.request(HEAD, run(), { tool: 'web_search', reason: 'x' })).toMatchObject({ ok: false, error: 'This project already has 10 granted tools.' });
    expect(r.create).not.toHaveBeenCalled();
  });

  it('not_project, and a port that throws, fall through to today\'s card flow (the throw logs errName only)', async () => {
    const a = rig(async () => ({ kind: 'not_project' }));
    expect(await a.svc.request(HEAD, run(), { tool: 'web_search', reason: 'x' })).toMatchObject({ ok: true, id: 9 });
    expect(a.posts).toHaveLength(1);
    const b = rig(async () => { throw new TypeError(MARKER); });
    expect(await b.svc.request(HEAD, run(), { tool: 'web_search', reason: 'x' })).toMatchObject({ ok: true, id: 9 });
    expect(b.logs).toEqual([{ errName: 'TypeError' }]);
    expect(JSON.stringify([b.logs, b.audits])).not.toContain(MARKER);
  });

  it('the port is never asked: without a task, for a task the caller does not own, after taint (task or run), or for Praw and unknown tools', async () => {
    const g = vi.fn(async () => ({ kind: 'granted' as const, projectId: 4 }));
    const r = rig(g);
    await r.svc.request(HEAD, run({ task: null }), { tool: 'web_search', reason: 'x' });
    await r.svc.request(HEAD, run({ ownsTask: false }), { tool: 'web_search', reason: 'x' });
    expect(await r.svc.request(HEAD, run({ tainted: true }), { tool: 'web_search', reason: 'x' })).toMatchObject({ code: 'tainted', error: REQUEST_TEXT.tainted });
    expect(await r.svc.request(HEAD, run({ task: { id: 't1', tainted: true } }), { tool: 'web_search', reason: 'x' })).toMatchObject({ code: 'tainted' });
    expect(await r.svc.request({ kind: 'head', dept: 'praw' }, run(), { tool: 'web_search', reason: 'x' })).toMatchObject({ code: 'not_head' });
    expect(await r.svc.request(HEAD, run(), { tool: 'ghost', reason: 'x' })).toMatchObject({ code: 'unknown_tool' });
    expect(await r.svc.request(HEAD, run(), { tool: 'create_task', reason: 'x' })).toMatchObject({ code: 'not_grantable' });
    expect(g).not.toHaveBeenCalled();
  });

  it('a reason with a secret-like value is refused before the port (screen)', async () => {
    const g = vi.fn(async () => ({ kind: 'granted' as const, projectId: 4 }));
    const r = rig(g);
    expect(await r.svc.request(HEAD, run(), { tool: 'web_search', reason: 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' })).toMatchObject({ code: 'screen' });
    expect(g).not.toHaveBeenCalled();
  });

  it('with no projectGrant port the behaviour is today\'s', async () => {
    const r = rig();
    expect(await r.svc.request(HEAD, run(), { tool: 'web_search', reason: 'x' })).toMatchObject({ ok: true, id: 9 });
  });
});

describe('tool_request in a company tree (AUTO-2 3.7, AC-C11)', () => {
  it('granted_tree: the fixed text, no row, no card, audit `tree <root8> <tool>`', async () => {
    const g = vi.fn(async () => ({ kind: 'granted_tree' as const, rootId: 'abcdef0123456789' }));
    const r = rig(g);
    const res = await r.svc.request(HEAD, run(), { tool: 'web_search', reason: 'need it' });
    expect(res).toEqual({ ok: true, id: null, text: "Granted for this task tree only: rnd may use web_search in this tree's tasks from its next run there. No card was sent." });
    expect(r.create).not.toHaveBeenCalled();
    expect(r.posts).toHaveLength(0);
    expect(r.audits).toContainEqual(expect.objectContaining({ action: 'tool.request', outcome: 'tree abcdef01 web_search' }));
  });
  it('the planted marker in the reason never reaches the grant text or the audit', async () => {
    const r = rig(async () => ({ kind: 'granted_tree', rootId: 'abcdef0123456789' }));
    const res = await r.svc.request(HEAD, run(), { tool: 'web_search', reason: `need it ${MARKER}` });
    expect(JSON.stringify([res, r.audits, r.logs])).not.toContain(MARKER);
  });
  it('a tainted run is refused before the port, so a tree grant never happens in a tainted run', async () => {
    const g = vi.fn(async () => ({ kind: 'granted_tree' as const, rootId: 'abcdef0123456789' }));
    const r = rig(g);
    expect(await r.svc.request(HEAD, run({ tainted: true }), { tool: 'web_search', reason: 'x' })).toMatchObject({ code: 'tainted' });
    expect(await r.svc.request(HEAD, run({ ownsTask: false }), { tool: 'web_search', reason: 'x' })).toMatchObject({ ok: true, id: 9 }); // no owned task: today's card, not the port
    expect(g).not.toHaveBeenCalled();
  });
});

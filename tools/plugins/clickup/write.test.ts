import { describe, expect, it, vi } from 'vitest';
import { toGeminiSchema } from '../../../providers/gemini/convert.js';
import { createHttpClient } from '../../../services/http.js';
import { clickupRoutes, fakeFetch, type CuFakeTask, type HttpRoute } from '../../../tests/fakes/http.js';
import { FakeConfig } from '../../../governance/test-helpers.js';
import type { ToolContext } from '../../types.js';
import { webRig } from '../web/test-helpers.js';
import type { PluginDeps } from '../deps.js';
import { createClickUpClient } from './client.js';
import { clickupGroup } from './index.js';

const TOKEN = 'pk_12345678_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
const LIST = '901800000001';
const B = 'https://api.clickup.com/api/v2';
const alice = { id: 1, username: 'alice', email: 'alice@x.test' };
const bob = { id: 2, username: 'bob', email: 'bob@x.test' };
const bobby = { id: 3, username: 'bobby', email: 'bobby@x.test' };
const open = { status: 'in progress', type: 'custom' };
const TASKS: CuFakeTask[] = [
  { id: 'a1', name: 'Write spec', status: open, assignees: [alice] },
  { id: 'b2', name: 'Ship it', status: open, assignees: [] },
];

function rig(extra: Record<string, HttpRoute> = {}, tasks = TASKS) {
  const f = fakeFetch({ ...clickupRoutes({ token: TOKEN, listId: LIST, tasks, members: [alice, bob, bobby] }), ...extra });
  const client = createClickUpClient({ http: createHttpClient({ fetch: f }), token: TOKEN, listId: LIST });
  const g = clickupGroup({ clickup: client, cfg: new FakeConfig(), log: { warn: vi.fn() } } as unknown as PluginDeps);
  if ('disabled' in g) throw new Error(g.disabled);
  return { f, g };
}
const writes = (f: ReturnType<typeof rig>['f']) => f.requests.filter((q) => q.method !== 'GET');
const WRITE = ['clickup_create_task', 'clickup_update_task', 'clickup_update_status', 'clickup_assign_task', 'clickup_add_comment'];
/** A ToolContext override per origin; `direct` is only true for a human talking straight to praw (R3). */
const ctxFor = (o: { direct: boolean; origin: ToolContext['origin']; tainted?: boolean }): Partial<ToolContext> => ({ direct: o.direct, origin: o.origin, tainted: () => o.tainted ?? false });
const CALLS: [string, unknown][] = [
  ['clickup_create_task', { name: 'New thing', description: 'd' }],
  ['clickup_update_task', { task_id: 'a1', name: 'Renamed' }],
  ['clickup_update_status', { task_id: 'a1', status: 'complete' }],
  ['clickup_assign_task', { task_id: 'b2', add: ['alice'] }],
  ['clickup_add_comment', { task_id: 'a1', text: 'hello' }],
];

describe('clickup', () => {
  it('write tools: kinds, schemas, no taint', () => {
    const { g } = rig();
    const by = Object.fromEntries(g.tools.map((t) => [t.name, t]));
    for (const n of WRITE) {
      expect(by[n]?.kind, n).toBe('write');
      expect(by[n]?.untrustedOutput, n).toBeFalsy();
      expect(typeof by[n]?.summary, n).toBe('function');
      expect(() => toGeminiSchema(by[n]!.inputSchema as never), n).not.toThrow();
    }
    expect(by['clickup_delete_task']?.kind).toBe('destructive');
    expect(typeof by['clickup_delete_task']?.summary).toBe('function');
  });

  it('update_status with unknown status returns tool error', async () => {
    const { f, g } = rig();
    const { reg, c } = await webRig(g.tools, ctxFor({ direct: true, origin: 'chat' }));
    const bad = await reg.run('clickup_update_status', { task_id: 'a1', status: 'bogus' }, c);
    expect(bad.isError).toBe(true);
    expect(bad.content).toMatch(/unknown status/i);
    expect(bad.content).toContain('complete');
    expect(writes(f)).toEqual([]);
    const ok = await reg.run('clickup_update_status', { task_id: 'a1', status: 'COMPLETE' }, c);
    expect(ok.isError, ok.content).toBeFalsy();
    const put = writes(f);
    expect(put).toHaveLength(1);
    expect(`${put[0]!.method} ${put[0]!.url}`).toBe(`PUT ${B}/task/a1`);
    expect(JSON.parse(put[0]!.body!)).toEqual({ status: 'complete' }); // the list's own spelling
  });

  it('assign resolves member by name via list_members', async () => {
    const { f, g } = rig();
    const { reg, c } = await webRig(g.tools, ctxFor({ direct: true, origin: 'chat' }));
    const r = await reg.run('clickup_assign_task', { task_id: 'a1', add: ['bob@x.test'], remove: ['Alice'] }, c);
    expect(r.isError, r.content).toBeFalsy();
    expect(f.requests.map((q) => `${q.method} ${q.url.split('?')[0]}`)).toContain(`GET ${B}/list/${LIST}/member`);
    const put = writes(f);
    expect(put).toHaveLength(1);
    expect(JSON.parse(put[0]!.body!)).toEqual({ assignees: { add: [2], rem: [1] } });
    // partial names and unknown names are refused before any write (exact username/email only, P3)
    f.requests.length = 0;
    for (const name of ['bo', 'nobody']) {
      const e = await reg.run('clickup_assign_task', { task_id: 'a1', add: [name] }, c);
      expect(e.isError, name).toBe(true);
    }
    expect(writes(f)).toEqual([]);
  });

  it('create targets the configured list; update/comment/delete hit the documented endpoints', async () => {
    const { f, g } = rig();
    const { reg, c } = await webRig(g.tools, ctxFor({ direct: true, origin: 'chat' }));
    const made = await reg.run('clickup_create_task', { name: 'New thing', description: 'body' }, c);
    expect(made.isError, made.content).toBeFalsy();
    expect(made.content).toContain('new1');
    await reg.run('clickup_update_task', { task_id: 'a1', description: 'x', due_date: '2026-12-01', priority: 2 }, c);
    await reg.run('clickup_add_comment', { task_id: 'a1', text: 'hi' }, c);
    const seen = writes(f).map((q) => `${q.method} ${q.url}`);
    expect(seen).toEqual([`POST ${B}/list/${LIST}/task`, `PUT ${B}/task/a1`, `POST ${B}/task/a1/comment`]);
    const [post, put, com] = writes(f);
    expect(JSON.parse(post!.body!)).toEqual({ name: 'New thing', description: 'body' });
    expect(JSON.parse(put!.body!)).toMatchObject({ description: 'x', due_date: Date.UTC(2026, 11, 1), due_date_time: false, priority: 2 });
    expect(JSON.parse(com!.body!)).toEqual({ comment_text: 'hi', notify_all: false });
    for (const q of writes(f)) expect(q.headers['authorization']).toBe(TOKEN);
    // delete (destructive) only runs once approved
    const { reg: reg2, c: c2 } = await webRig(g.tools, ctxFor({ direct: true, origin: 'chat' }));
    f.requests.length = 0;
    const d = await reg2.runApproved('clickup_delete_task', { task_id: 'a1' }, c2);
    expect(d.isError, d.content).toBeFalsy();
    expect(writes(f).map((q) => `${q.method} ${q.url}`)).toEqual([`DELETE ${B}/task/a1`]);
  });

  it('writes outside CLICKUP_LIST_ID are refused before any write call', async () => {
    const routes = {
      [`GET ${B}/task/zz9`]: { body: { id: 'zz9', name: 'Elsewhere', status: open, list: { id: '555' } } },
      [`PUT ${B}/task/zz9`]: { body: {} }, [`DELETE ${B}/task/zz9`]: { status: 204 }, [`POST ${B}/task/zz9/comment`]: { body: { id: 'c' } },
    };
    const { f, g } = rig(routes);
    const { reg, c } = await webRig(g.tools, ctxFor({ direct: true, origin: 'chat' }));
    const calls: [string, unknown][] = [
      ['clickup_update_task', { task_id: 'zz9', name: 'x' }], ['clickup_update_status', { task_id: 'zz9', status: 'complete' }],
      ['clickup_assign_task', { task_id: 'zz9', add: ['alice'] }], ['clickup_add_comment', { task_id: 'zz9', text: 'x' }],
    ];
    for (const [n, i] of calls) {
      const r = await reg.run(n, i, c);
      expect(r.isError, n).toBe(true);
      expect(r.content, n).toMatch(/not in the configured list/);
    }
    const d = await reg.runApproved('clickup_delete_task', { task_id: 'zz9' }, c);
    expect(d.isError).toBe(true);
    expect(writes(f)).toEqual([]);
    // bad ids never reach the network
    f.requests.length = 0;
    for (const bad of ['../user', 'A1', 'a/b', '']) expect((await reg.run('clickup_update_task', { task_id: bad, name: 'x' }, c)).isError, bad).toBe(true);
    expect(f.requests).toEqual([]);
  });

  it('update_task needs at least one field and a valid date; error text never carries the token', async () => {
    const { f, g } = rig();
    const { reg, c } = await webRig(g.tools, ctxFor({ direct: true, origin: 'chat' }));
    expect((await reg.run('clickup_update_task', { task_id: 'a1' }, c)).isError).toBe(true);
    expect((await reg.run('clickup_update_task', { task_id: 'a1', due_date: 'next tuesday-ish' }, c)).isError).toBe(true);
    expect(writes(f)).toEqual([]);
    const leaky = fakeFetch({ ...clickupRoutes({ token: TOKEN, listId: LIST, tasks: TASKS }), [`PUT ${B}/task/a1`]: (r) => ({ status: 500, body: { err: r.headers['authorization'] } }) });
    const client = createClickUpClient({ http: createHttpClient({ fetch: leaky }), token: TOKEN, listId: LIST });
    const g2 = clickupGroup({ clickup: client } as unknown as PluginDeps);
    if ('disabled' in g2) throw new Error('off');
    const rg = await webRig(g2.tools, ctxFor({ direct: true, origin: 'chat' }));
    const r = await rg.reg.run('clickup_update_task', { task_id: 'a1', name: 'n' }, rg.c);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('500');
    expect(r.content).not.toMatch(/pk_|authorization/i);
  });
});

describe('clickup approval-bound execution (P3)', () => {
  it('assign never falls back to a substring: "bo" is refused when only "bobby" exists', async () => {
    const f = fakeFetch(clickupRoutes({ token: TOKEN, listId: LIST, tasks: TASKS, members: [alice, bobby] }));
    const g = clickupGroup({ clickup: createClickUpClient({ http: createHttpClient({ fetch: f }), token: TOKEN, listId: LIST }) } as unknown as PluginDeps);
    if ('disabled' in g) throw new Error('off');
    const { reg, c } = await webRig(g.tools, ctxFor({ direct: true, origin: 'chat' }));
    const r = await reg.runApproved('clickup_assign_task', { task_id: 'a1', add: ['bo'] }, c);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/clickup_list_members/);
    expect(writes(f)).toEqual([]);
    expect((await reg.runApproved('clickup_assign_task', { task_id: 'a1', add: ['BOBBY@x.test'] }, c)).isError).toBeFalsy();
  });

  it('invalid update/assign calls are refused before an approval card exists', async () => {
    const { f, g } = rig();
    const { reg, c, approvals } = await webRig(g.tools, ctxFor({ direct: false, origin: 'delegated' }));
    for (const [n, i] of [['clickup_update_task', { task_id: 'a1' }], ['clickup_update_task', { task_id: 'a1', due_date: '2026-02-31' }], ['clickup_update_task', { task_id: 'a1', due_date: '2026-12-01', clear_due_date: true }], ['clickup_update_task', { task_id: 'a1', priority: 2, clear_priority: true }], ['clickup_assign_task', { task_id: 'a1' }], ['clickup_assign_task', { task_id: 'a1', add: [] }]] as [string, unknown][]) {
      const r = await reg.run(n, i, c);
      expect(r.isError, JSON.stringify(i)).toBe(true);
      expect(r.content).toMatch(/invalid input/);
    }
    expect(approvals.request).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);
  });

  it('an approved update whose task moved to another list before execution is refused, no write sent', async () => {
    let list = LIST;
    const f = fakeFetch({ ...clickupRoutes({ token: TOKEN, listId: LIST, tasks: TASKS }), [`GET ${B}/task/a1`]: () => ({ body: { id: 'a1', name: 'Write spec', status: open, list: { id: list } } }) });
    const g = clickupGroup({ clickup: createClickUpClient({ http: createHttpClient({ fetch: f }), token: TOKEN, listId: LIST }) } as unknown as PluginDeps);
    if ('disabled' in g) throw new Error('off');
    const { reg, c, approvals } = await webRig(g.tools, ctxFor({ direct: false, origin: 'delegated' }));
    expect((await reg.run('clickup_update_task', { task_id: 'a1', name: 'Later' }, c)).content).toMatch(/^NOT DONE YET: waiting for approval of/);
    expect(approvals.request).toHaveBeenCalledTimes(1);
    list = '555'; // moved while waiting for the decision
    const r = await reg.runApproved('clickup_update_task', { task_id: 'a1', name: 'Later' }, c);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/not in the configured list/);
    expect(writes(f)).toEqual([]);
  });

  it('a double quote in model text cannot fake the card structure', async () => {
    const { g } = rig();
    const { reg, c, approvals } = await webRig(g.tools, ctxFor({ direct: false, origin: 'delegated' }));
    await reg.run('clickup_create_task', { name: 'x" ; delete task b2 "' }, c);
    const reason = (approvals.request.mock.calls as unknown as [{ reason: string }][])[0]![0].reason;
    expect(reason).toContain('\\"');
  });
});

describe('AC9', () => {
  it('direct untainted praw chat create runs without approval and hits the fake', async () => {
    const { f, g } = rig();
    const { reg, c, approvals } = await webRig(g.tools, ctxFor({ direct: true, origin: 'chat' }));
    const r = await reg.run('clickup_create_task', { name: 'Direct' }, c);
    expect(r.isError, r.content).toBeFalsy();
    expect(approvals.request).not.toHaveBeenCalled();
    expect(writes(f).map((q) => q.method)).toEqual(['POST']);
  });

  it('same tool from a scheduled-origin chain → awaiting_approval, fake untouched', async () => {
    const { f, g } = rig();
    const { reg, c, approvals } = await webRig(g.tools, ctxFor({ direct: false, origin: 'schedule' }));
    const r = await reg.run('clickup_create_task', { name: 'Scheduled' }, c);
    expect(r.content).toMatch(/^NOT DONE YET: waiting for approval of/);
    expect(approvals.request).toHaveBeenCalledTimes(1);
    expect(f.requests).toEqual([]);
  });

  it('voice origin create awaits approval', async () => {
    const { f, g } = rig();
    const { reg, c, approvals } = await webRig(g.tools, ctxFor({ direct: false, origin: 'voice' as ToolContext['origin'] }));
    expect((await reg.run('clickup_create_task', { name: 'Spoken' }, c)).content).toMatch(/^NOT DONE YET: waiting for approval of/);
    expect(approvals.request).toHaveBeenCalledTimes(1);
    expect(f.requests).toEqual([]);
  });

  it('update, assign, status always follow the same rule', async () => {
    for (const [label, ctx, asks] of [
      ['direct', ctxFor({ direct: true, origin: 'chat' }), false], ['tainted', ctxFor({ direct: true, origin: 'chat', tainted: true }), true],
      ['delegated', ctxFor({ direct: false, origin: 'delegated' }), true], ['schedule', ctxFor({ direct: false, origin: 'schedule' }), true],
    ] as const) {
      for (const [name, input] of CALLS) {
        const { f, g } = rig();
        const { reg, c, approvals } = await webRig(g.tools, ctx);
        const r = await reg.run(name, input, c);
        expect(approvals.request.mock.calls.length, `${label} ${name}`).toBe(asks ? 1 : 0);
        if (asks) {
          expect(r.content).toMatch(/^NOT DONE YET: waiting for approval of/);
          expect(f.requests, `${label} ${name}`).toEqual([]);
        } else expect(r.isError, `${label} ${name}: ${r.content}`).toBeFalsy();
      }
    }
  });

  it('clickup_delete_task always awaiting_approval even for human origin', async () => {
    const { f, g } = rig();
    const { reg, c, approvals } = await webRig(g.tools, ctxFor({ direct: true, origin: 'chat' }));
    const r = await reg.run('clickup_delete_task', { task_id: 'a1' }, c);
    expect(r.content).toMatch(/^NOT DONE YET: waiting for approval of/);
    expect(approvals.request).toHaveBeenCalledTimes(1);
    expect(f.requests).toEqual([]);
  });
});

describe('approval card', () => {
  it('names tool, target id and change summary', async () => {
    const { g } = rig();
    const { reg, c, approvals } = await webRig(g.tools, ctxFor({ direct: false, origin: 'delegated' }));
    await reg.run('clickup_update_task', { task_id: 'b2', name: 'Renamed', priority: 1 }, c);
    await reg.run('clickup_delete_task', { task_id: 'a1' }, c);
    await reg.run('clickup_create_task', { name: 'Launch plan' }, c);
    await reg.run('clickup_assign_task', { task_id: 'b2', add: ['bob'], remove: ['alice'] }, c);
    await reg.run('clickup_update_status', { task_id: 'b2', status: 'complete' }, c);
    const reasons = (approvals.request.mock.calls as unknown as [{ reason: string }][]).map((x) => x[0].reason);
    expect(reasons[0]).toMatch(/^tool clickup_update_task on b2: .*name -> \"Renamed\".*priority.*1/);
    expect(reasons[1]).toMatch(/^tool clickup_delete_task on a1: .*delete/i);
    expect(reasons[2]).toMatch(new RegExp(`^tool clickup_create_task on ${LIST}: .*Launch plan`));
    expect(reasons[3]).toMatch(/^tool clickup_assign_task on b2: .*add.*bob.*remove.*alice/);
    expect(reasons[4]).toMatch(/^tool clickup_update_status on b2: .*complete/);
    for (const r of reasons) expect(r).not.toContain('on call');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { FakeConfig } from './test-helpers.js';
import { AutopilotService, GRANT_TEXT, GRANT_TREE_TEXT, type AutopilotDeps } from './autopilot.js';
import type { ClaimResult, CompanyClaim, TreeGrantResult } from '../db/repos/projects.js';

const KINDS: Record<string, string | undefined> = {
  web_search: 'read', fetch_page: 'read', clickup_create_task: 'write', forum_post: 'write', clickup_delete_task: 'destructive', github_pr: 'write', image_generate: 'write', kindless: undefined,
  sheets_append_receipt: 'write', schedule_job: 'write', doc_create: 'write', write_file: 'write', clickup_add_comment: 'write',
};
/** Company repo stubs for the AUTO-1 rigs: no company tree. */
const CO = { companyRoot: async (): Promise<string | null> => null, claimCompany: vi.fn(), grantTreeTool: vi.fn(), treeToolsFor: async (): Promise<string[]> => [] };
const SECRET = 'SECRETLITERAL-0123456789';
const MARKER = 'PLANTED-MARKER-77';

function rig(over: Partial<AutopilotDeps> = {}, cfgInit: Record<string, unknown> = {}) {
  const cfg = new FakeConfig(cfgInit as never);
  const lines: unknown[] = [];
  const exhausted = vi.fn(async () => true);
  const claim = vi.fn(async (): Promise<ClaimResult> => ({ kind: 'run', used: 1, max: 500 }));
  const grant = vi.fn(async (): Promise<{ ok: true } | { ok: false; code: 'not_active' | 'exists' | 'cap' }> => ({ ok: true }));
  const d: AutopilotDeps = {
    cfg, halted: () => false, secrets: [SECRET], exhausted, log: { error: (o) => void lines.push(o) },
    repo: { projectOf: async () => ({ id: 4, rootTaskId: 'r', deadline: '2026-12-31' }), claimApproval: claim, toolsFor: async () => ['a'], toolsForTask: async () => ['b'], grantTool: grant, ...CO },
    org: { persona: (id) => (id === 'p1' ? { deptId: 'rnd' } : null) },
    describe: (n) => (n in KINDS ? { kind: KINDS[n] } : undefined),
    ...over,
  };
  return { svc: new AutopilotService(d), cfg, lines, exhausted, claim, grant };
}
const call = (svc: AutopilotService, tool: string, input: unknown) => svc.decide({ taskId: 't1', tool, input });

describe('AutopilotService.decide (SA-1 3.3)', () => {
  it('a plain tainted-class read and a ClickUp create run after one claim', async () => {
    const r = rig();
    expect(await call(r.svc, 'web_search', { query: 'plain words' })).toEqual({ kind: 'run' });
    expect(await call(r.svc, 'clickup_create_task', { list_id: '1', name: 'n' })).toEqual({ kind: 'run' });
    expect(r.claim).toHaveBeenCalledTimes(2);
    expect(r.claim).toHaveBeenCalledWith(4, 't1', 'web_search');
  });

  it('the switch off, a switch read error, a halt, and no project all give the card without a claim', async () => {
    const off = rig({}, { 'autopilot.enabled': false });
    expect(await call(off.svc, 'forum_post', {})).toEqual({ kind: 'card' });
    const err = rig();
    err.cfg.throwOn.add('autopilot.enabled');
    expect(await call(err.svc, 'forum_post', {})).toEqual({ kind: 'card' });
    const halted = rig({ halted: () => true });
    expect(await call(halted.svc, 'forum_post', {})).toEqual({ kind: 'card' });
    const none = rig({ repo: { projectOf: async () => null, claimApproval: vi.fn(), toolsFor: vi.fn(), toolsForTask: vi.fn(), grantTool: vi.fn(), ...CO } });
    expect(await call(none.svc, 'forum_post', {})).toEqual({ kind: 'card' });
    for (const x of [off, err, halted]) expect(x.claim).not.toHaveBeenCalled();
  });

  it('hard-deny classes (destructive, sensitive, money, cost or lasting, unknown, kindless, draft doc, overwrite) give the card and never claim', async () => {
    const r = rig();
    for (const [tool, input] of [
      ['clickup_delete_task', {}], ['github_pr', {}], ['sheets_append_receipt', {}], ['image_generate', {}], ['schedule_job', {}], ['ghost_tool', {}], ['kindless', {}],
      ['doc_create', { kind: 'quotation' }], ['write_file', { overwrite: true }],
    ] as [string, unknown][]) expect(await call(r.svc, tool, input), tool).toEqual({ kind: 'card' });
    expect(r.claim).not.toHaveBeenCalled();
  });

  it('comments keep their card (Gate 1 table) even though the code declares them write, and never claim', async () => {
    const r = rig();
    expect(await call(r.svc, 'clickup_add_comment', { task_id: 'a1', text: 'hi' })).toEqual({ kind: 'card' });
    expect(await call(r.svc, 'clickup_add_comment', { task_id: 'a', text: 'hi' })).toEqual({ kind: 'card' });
    expect(r.claim).not.toHaveBeenCalled();
  });

  it('data-like calls are refused with their code and never claim', async () => {
    const r = rig();
    expect(await call(r.svc, 'web_search', { query: 'a'.repeat(30) })).toEqual({ kind: 'refuse', code: 'query_heuristic' });
    expect(await call(r.svc, 'web_search', { query: 'mail me@x.com' })).toEqual({ kind: 'refuse', code: 'query_heuristic' });
    expect(await call(r.svc, 'fetch_page', { url: 'https://example.com/a?token=abcdefghijklmnopqrstuvwxyz0123456789' })).toEqual({ kind: 'refuse', code: 'url_heuristic' });
    expect(r.claim).not.toHaveBeenCalled();
  });

  it('a secret in the input is refused as masked_input', async () => {
    const r = rig();
    expect(await call(r.svc, 'clickup_create_task', { list_id: '1', name: `has ${SECRET} inside` })).toEqual({ kind: 'refuse', code: 'masked_input' });
    expect(r.claim).not.toHaveBeenCalled();
  });

  it('a text field over 4000 characters is refused as input_cut; 4000 exactly runs (the real limit is INPUT_STRING_MAX)', async () => {
    const r = rig();
    expect(await call(r.svc, 'clickup_create_task', { list_id: '1', name: 'n', description: 'x'.repeat(4001) })).toEqual({ kind: 'refuse', code: 'input_cut' });
    expect(await call(r.svc, 'clickup_create_task', { list_id: '1', name: 'n', description: 'x'.repeat(4000) })).toEqual({ kind: 'run' });
  });

  it('write_file content is exempt from the cut', async () => {
    const r = rig();
    expect(await call(r.svc, 'write_file', { path: 'a.txt', content: 'x'.repeat(9000) })).toEqual({ kind: 'run' });
  });

  it('claim budget: the one notice is requested and the call gets the card; not_active is a card without a notice', async () => {
    const r = rig();
    r.claim.mockResolvedValueOnce({ kind: 'budget' });
    expect(await call(r.svc, 'forum_post', {})).toEqual({ kind: 'card' });
    expect(r.exhausted).toHaveBeenCalledWith(4);
    r.claim.mockResolvedValueOnce({ kind: 'not_active' });
    expect(await call(r.svc, 'forum_post', {})).toEqual({ kind: 'card' });
    expect(r.exhausted).toHaveBeenCalledTimes(1);
  });

  it('AP-C10: projectOf, claimApproval, describe and exhausted that throw all give the card (never a run) and never throw', async () => {
    const a = rig({ repo: { projectOf: async () => { throw new Error('x'); }, claimApproval: vi.fn(), toolsFor: vi.fn(), toolsForTask: vi.fn(), grantTool: vi.fn(), ...CO } });
    expect(await call(a.svc, 'forum_post', {})).toEqual({ kind: 'card' });
    const b = rig();
    b.claim.mockRejectedValueOnce(new Error('tx failed'));
    expect(await call(b.svc, 'forum_post', {})).toEqual({ kind: 'card' });
    const c = rig({ describe: () => { throw new Error('registry'); } });
    expect(await call(c.svc, 'forum_post', {})).toEqual({ kind: 'card' });
    const d = rig({ exhausted: async () => { throw new Error('notice'); } });
    d.claim.mockResolvedValueOnce({ kind: 'budget' });
    expect(await call(d.svc, 'forum_post', {})).toEqual({ kind: 'card' });
  });

  it('AP-C14: a planted marker in tool input, and in an error message, never reaches a log line; only errName is logged', async () => {
    const r = rig();
    r.claim.mockRejectedValueOnce(new TypeError(`boom ${MARKER}`));
    await call(r.svc, 'clickup_create_task', { list_id: '1', name: MARKER, description: MARKER });
    await call(r.svc, 'web_search', { query: MARKER + ' ' + 'a'.repeat(30) });
    expect(r.lines).toEqual([{ errName: 'TypeError' }]);
    expect(JSON.stringify(r.lines)).not.toContain(MARKER);
  });
});

describe('AutopilotService.projectGrant (AP-C7)', () => {
  it('grants for the task\'s project with its own department', async () => {
    const r = rig();
    expect(await r.svc.projectGrant({ dept: 'rnd', taskId: 't1', tool: 'web_search' })).toEqual({ kind: 'granted', projectId: 4 });
    expect(r.grant).toHaveBeenCalledWith({ projectId: 4, deptId: 'rnd', tool: 'web_search', taskId: 't1' });
  });
  it('exists and the cap of 10 refuse with fixed text; a closed project, no project, halted or off fall to the card', async () => {
    const r = rig();
    r.grant.mockResolvedValueOnce({ ok: false, code: 'exists' });
    expect(await r.svc.projectGrant({ dept: 'rnd', taskId: 't1', tool: 'web_search' })).toEqual({ kind: 'refused', text: GRANT_TEXT.exists });
    r.grant.mockResolvedValueOnce({ ok: false, code: 'cap' });
    expect(await r.svc.projectGrant({ dept: 'rnd', taskId: 't1', tool: 'web_search' })).toEqual({ kind: 'refused', text: GRANT_TEXT.cap });
    r.grant.mockResolvedValueOnce({ ok: false, code: 'not_active' });
    expect(await r.svc.projectGrant({ dept: 'rnd', taskId: 't1', tool: 'web_search' })).toEqual({ kind: 'not_project' });
    const none = rig({ repo: { projectOf: async () => null, claimApproval: vi.fn(), toolsFor: vi.fn(), toolsForTask: vi.fn(), grantTool: vi.fn(), ...CO } });
    expect(await none.svc.projectGrant({ dept: 'rnd', taskId: 't1', tool: 'web_search' })).toEqual({ kind: 'not_project' });
    expect(await rig({ halted: () => true }).svc.projectGrant({ dept: 'rnd', taskId: 't1', tool: 'web_search' })).toEqual({ kind: 'not_project' });
    expect(await rig({}, { 'autopilot.enabled': false }).svc.projectGrant({ dept: 'rnd', taskId: 't1', tool: 'web_search' })).toEqual({ kind: 'not_project' });
  });
  it('a name-level hard-deny tool (destructive, sensitive, cost, unknown) goes to today\'s card flow and inserts nothing', async () => {
    const r = rig();
    for (const tool of ['clickup_delete_task', 'github_pr', 'image_generate', 'sheets_append_receipt', 'ghost_tool']) expect(await r.svc.projectGrant({ dept: 'rnd', taskId: 't1', tool }), tool).toEqual({ kind: 'not_project' });
    expect(r.grant).not.toHaveBeenCalled();
  });
  it('a throwing repo is not_project and logs errName only', async () => {
    const r = rig();
    r.grant.mockRejectedValueOnce(new RangeError(`x ${MARKER}`));
    expect(await r.svc.projectGrant({ dept: 'rnd', taskId: 't1', tool: 'web_search' })).toEqual({ kind: 'not_project' });
    expect(JSON.stringify(r.lines)).not.toContain(MARKER);
  });
});

describe('toolsFor / toolsForTask (the department comes from the actor)', () => {
  it('a head uses its dept, a persona its persona dept, an unknown persona gets nothing; a throwing repo gives []', async () => {
    const r = rig();
    const spy = vi.spyOn(r.svc, 'toolsFor');
    expect(await r.svc.toolsFor(4, { kind: 'head', dept: 'software' })).toEqual(['a']);
    expect(await r.svc.toolsFor(4, { kind: 'persona', personaId: 'p1' })).toEqual(['a']);
    expect(await r.svc.toolsFor(4, { kind: 'persona', personaId: 'nobody' })).toEqual([]);
    expect(await r.svc.toolsForTask('t1', { kind: 'head', dept: 'software' })).toEqual(['b']);
    expect(spy).toHaveBeenCalledTimes(3);
    const bad = rig({ repo: { projectOf: vi.fn(), claimApproval: vi.fn(), toolsFor: async () => { throw new Error('x'); }, toolsForTask: async () => { throw new Error('x'); }, grantTool: vi.fn(), ...CO } });
    expect(await bad.svc.toolsFor(4, { kind: 'head', dept: 'software' })).toEqual([]);
    expect(await bad.svc.toolsForTask('t1', { kind: 'head', dept: 'software' })).toEqual([]);
  });
});

/** AUTO-2: the company branch. No live project; the tree is a company tree when companyRoot answers. */
function crig(over: Partial<AutopilotDeps> = {}, cfgInit: Record<string, unknown> = { 'autopilot.scope': 'company' }, repoOver: Partial<AutopilotDeps['repo']> = {}) {
  const claimCompany = vi.fn(async (): Promise<CompanyClaim> => ({ kind: 'run', day: 1, tree: 1 }));
  const capNotice = vi.fn(async () => undefined);
  const grantTreeTool = vi.fn(async (): Promise<TreeGrantResult> => ({ ok: true, rootId: 'root1' }));
  const claimApproval = vi.fn();
  const r = rig({
    capNotice,
    repo: { projectOf: async () => null, claimApproval, toolsFor: async () => ['a'], toolsForTask: async () => ['b'], grantTool: vi.fn(), companyRoot: async () => 'root1', claimCompany, grantTreeTool, treeToolsFor: async () => ['t'], ...repoOver },
    ...over,
  }, cfgInit);
  return { ...r, claimCompany, capNotice, grantTreeTool, claimApproval };
}

describe('AUTO-2 company decide (SA-1 3.2)', () => {
  it('a plain read and a ClickUp create run after one company claim, never a project claim', async () => {
    const r = crig();
    expect(await call(r.svc, 'web_search', { query: 'plain words' })).toEqual({ kind: 'run' });
    expect(await call(r.svc, 'clickup_create_task', { list_id: '1', name: 'n' })).toEqual({ kind: 'run' });
    expect(r.claimCompany).toHaveBeenCalledWith('t1', 'web_search');
    expect(r.claimCompany).toHaveBeenCalledTimes(2);
    expect(r.claimApproval).not.toHaveBeenCalled();
  });
  it('hard-deny classes and always-card tools give the card and never claim', async () => {
    const r = crig();
    for (const [tool, input] of [['clickup_delete_task', {}], ['github_pr', {}], ['ghost_tool', {}], ['kindless', {}], ['doc_create', { kind: 'quotation' }], ['write_file', { overwrite: true }], ['clickup_add_comment', {}]] as [string, unknown][]) {
      expect(await call(r.svc, tool, input), tool).toEqual({ kind: 'card' });
    }
    expect(r.claimCompany).not.toHaveBeenCalled();
  });
  it('heuristic, masked and cut refusals carry company:true and never claim', async () => {
    const r = crig();
    expect(await call(r.svc, 'fetch_page', { url: 'https://example.com/?q=1234567890123' })).toEqual({ kind: 'refuse', code: 'url_heuristic', company: true });
    expect(await call(r.svc, 'web_search', { query: 'x'.repeat(201) })).toEqual({ kind: 'refuse', code: 'query_heuristic', company: true });
    expect(await call(r.svc, 'forum_post', { content: `has ${SECRET}` })).toEqual({ kind: 'refuse', code: 'masked_input', company: true });
    expect(await call(r.svc, 'forum_post', { content: 'y'.repeat(4001) })).toEqual({ kind: 'refuse', code: 'input_cut', company: true });
    expect(r.claimCompany).not.toHaveBeenCalled();
  });
  it('the project branch refusal carries no company flag', async () => {
    const r = rig();
    expect(await call(r.svc, 'web_search', { query: 'x'.repeat(201) })).toEqual({ kind: 'refuse', code: 'query_heuristic' });
  });
  it('cap gives the card and one notice call with the cap name (day, tree, person); a throwing notice still gives the card and logs errName only', async () => {
    for (const which of ['day', 'tree', 'person'] as const) {
      const r = crig({}, undefined, { claimCompany: vi.fn(async (): Promise<CompanyClaim> => ({ kind: 'cap', which })) });
      expect(await call(r.svc, 'web_search', { query: 'a b' })).toEqual({ kind: 'card' });
      expect(r.capNotice).toHaveBeenCalledWith(which);
    }
    const t = crig({ capNotice: async () => { throw new RangeError(`x ${MARKER}`); } }, undefined, { claimCompany: vi.fn(async (): Promise<CompanyClaim> => ({ kind: 'cap', which: 'day' })) });
    expect(await call(t.svc, 'web_search', { query: 'a b' })).toEqual({ kind: 'card' });
    expect(JSON.stringify(t.lines)).not.toContain(MARKER);
  });
  it('not_company gives the card', async () => {
    const r = crig({}, undefined, { claimCompany: vi.fn(async (): Promise<CompanyClaim> => ({ kind: 'not_company' })) });
    expect(await call(r.svc, 'web_search', { query: 'a b' })).toEqual({ kind: 'card' });
  });
  it('scope project, scope read error, enabled off, halt, companyRoot null or throwing, claimCompany throwing all give the card (AC-C8)', async () => {
    const proj = crig({}, { 'autopilot.scope': 'project' });
    const err = crig({}, { 'autopilot.scope': 'company' });
    err.cfg.throwOn.add('autopilot.scope');
    const off = crig({}, { 'autopilot.scope': 'company', 'autopilot.enabled': false });
    const halted = crig({ halted: () => true });
    const none = crig({}, undefined, { companyRoot: async () => null });
    const thrown = crig({}, undefined, { companyRoot: async () => { throw new Error('x'); } });
    const claimThrows = crig({}, undefined, { claimCompany: vi.fn(async () => { throw new Error(`boom ${MARKER}`); }) });
    for (const x of [proj, err, off, halted, none, thrown, claimThrows]) expect(await call(x.svc, 'web_search', { query: 'a b' })).toEqual({ kind: 'card' });
    for (const x of [proj, err, off, halted, none, thrown]) expect(x.claimCompany).not.toHaveBeenCalled();
    expect(JSON.stringify(claimThrows.lines)).not.toContain(MARKER);
  });
  it('a live project wins over company scope (project claim, not company claim)', async () => {
    const r = crig({}, undefined, { projectOf: async () => ({ id: 4, rootTaskId: 'r', deadline: '2026-12-31' }), claimApproval: vi.fn(async (): Promise<ClaimResult> => ({ kind: 'run', used: 1, max: 5 })) });
    expect(await call(r.svc, 'web_search', { query: 'a b' })).toEqual({ kind: 'run' });
    expect(r.claimCompany).not.toHaveBeenCalled();
  });
});

describe('AUTO-2 companyOn / inCompany / treeToolsFor / toolsForTask / projectGrant tree branch', () => {
  it('companyOn needs enabled, scope company and no halt; every read error is false and it never throws', () => {
    expect(crig().svc.companyOn()).toBe(true);
    expect(crig({}, {}).svc.companyOn()).toBe(false);
    expect(crig({}, { 'autopilot.scope': 'company', 'autopilot.enabled': false }).svc.companyOn()).toBe(false);
    expect(crig({ halted: () => true }).svc.companyOn()).toBe(false);
    expect(crig({ halted: () => { throw new Error('x'); } }).svc.companyOn()).toBe(false);
    for (const k of ['autopilot.enabled', 'autopilot.scope'] as const) {
      const r = crig();
      r.cfg.throwOn.add(k);
      expect(r.svc.companyOn(), k).toBe(false);
    }
  });
  it('inCompany: true only with companyOn and a company root; false on a null, a throw or project scope', async () => {
    expect(await crig().svc.inCompany('t1')).toBe(true);
    expect(await crig({}, undefined, { companyRoot: async () => null }).svc.inCompany('t1')).toBe(false);
    expect(await crig({}, undefined, { companyRoot: async () => { throw new Error('x'); } }).svc.inCompany('t1')).toBe(false);
    expect(await crig({}, { 'autopilot.scope': 'project' }).svc.inCompany('t1')).toBe(false);
  });
  it('treeToolsFor: the dept grants in company scope, [] in project scope or on a throw; toolsForTask unions project and tree grants without duplicates', async () => {
    const head = { kind: 'head', dept: 'software' } as const;
    const r = crig();
    expect(await r.svc.treeToolsFor('t1', head)).toEqual(['t']);
    expect(await r.svc.toolsForTask('t1', head)).toEqual(['b', 't']);
    expect(await crig({}, { 'autopilot.scope': 'project' }).svc.toolsForTask('t1', head)).toEqual(['b']);
    expect(await crig({}, { 'autopilot.scope': 'project' }).svc.treeToolsFor('t1', head)).toEqual([]);
    expect(await crig({}, undefined, { treeToolsFor: async () => { throw new Error('x'); } }).svc.treeToolsFor('t1', head)).toEqual([]);
    expect(await crig({}, undefined, { treeToolsFor: async () => { throw new Error('x'); } }).svc.toolsForTask('t1', head)).toEqual(['b']);
    expect(await crig({}, undefined, { toolsForTask: async () => ['t', 'b'] }).svc.toolsForTask('t1', head)).toEqual(['t', 'b']);
  });
  it('projectGrant with no live project: a company tree grants for the tree; exists and cap refuse with the fixed text; not_company, name-level hard-deny and a throw go to the card flow', async () => {
    const r = crig();
    expect(await r.svc.projectGrant({ dept: 'rnd', taskId: 't1', tool: 'web_search' })).toEqual({ kind: 'granted_tree', rootId: 'root1' });
    expect(r.grantTreeTool).toHaveBeenCalledWith({ taskId: 't1', deptId: 'rnd', tool: 'web_search' });
    const ex = crig({}, undefined, { grantTreeTool: async () => ({ ok: false, code: 'exists' }) });
    expect(await ex.svc.projectGrant({ dept: 'rnd', taskId: 't1', tool: 'web_search' })).toEqual({ kind: 'refused', text: GRANT_TREE_TEXT.exists });
    const cap = crig({}, undefined, { grantTreeTool: async () => ({ ok: false, code: 'cap' }) });
    expect(await cap.svc.projectGrant({ dept: 'rnd', taskId: 't1', tool: 'web_search' })).toEqual({ kind: 'refused', text: GRANT_TREE_TEXT.cap });
    const nc = crig({}, undefined, { grantTreeTool: async () => ({ ok: false, code: 'not_company' }) });
    expect(await nc.svc.projectGrant({ dept: 'rnd', taskId: 't1', tool: 'web_search' })).toEqual({ kind: 'not_project' });
    for (const tool of ['clickup_delete_task', 'github_pr', 'ghost_tool']) expect(await r.svc.projectGrant({ dept: 'rnd', taskId: 't1', tool }), tool).toEqual({ kind: 'not_project' });
    expect(r.grantTreeTool).toHaveBeenCalledTimes(1);
    const th = crig({}, undefined, { grantTreeTool: async () => { throw new Error(`x ${MARKER}`); } });
    expect(await th.svc.projectGrant({ dept: 'rnd', taskId: 't1', tool: 'web_search' })).toEqual({ kind: 'not_project' });
    expect(JSON.stringify(th.lines)).not.toContain(MARKER);
    expect(await crig({}, { 'autopilot.scope': 'project' }).svc.projectGrant({ dept: 'rnd', taskId: 't1', tool: 'web_search' })).toEqual({ kind: 'not_project' });
    expect(await crig({}, undefined, { companyRoot: async () => null }).svc.projectGrant({ dept: 'rnd', taskId: 't1', tool: 'web_search' })).toEqual({ kind: 'not_project' });
  });
});

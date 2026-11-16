import { describe, expect, it } from 'vitest';
import { seededOrg } from '../agents/test-helpers.js';
import { CONFIG_DEFAULTS } from '../config/defaults.js';
import { FakeConfig } from '../governance/test-helpers.js';
import { createToolPolicy, DEPT_ONLY } from './policy.js';
import { approvalFor, isNoApproval, NO_APPROVAL_TOOLS } from './policy-approval.js';
import { skillToolAllowed } from './skill-grant.js';
import { TREE_GRANT_TOOLS } from './tree-grant-tools.js';

const WS = ['ws_create', 'ws_list', 'ws_read', 'ws_write', 'ws_delete', 'ws_run', 'ws_export'];
const BUILTIN = ['create_task', 'update_task', 'respond'];
const REGISTERED = [...BUILTIN, 'web_search', 'fetch_page', ...WS];
const DEPTS = ['hq', 'rnd', 'sales', 'praw', 'software', 'it', 'ops', 'hr', 'marketing', 'finance'];
const mk = (cfg = new FakeConfig(), kindOf?: (n: string) => 'read' | 'write' | 'destructive' | undefined) => createToolPolicy(cfg, () => REGISTERED, () => BUILTIN, kindOf);

describe('WS-C19: DEPT_ONLY', () => {
  it('maps exactly the 7 ws names and release_request (R5 RL-C7) to software', () => {
    expect({ ...DEPT_ONLY }).toEqual(Object.fromEntries([...WS, 'release_request'].map((n) => [n, 'software'])));
    expect(Object.isFrozen(DEPT_ONLY)).toBe(true);
  });
  it('the defaults give software all 7 and no other department any', () => {
    const p = mk();
    expect(p.effective('software', ['respond']).filter((n) => n.startsWith('ws_')).sort()).toEqual([...WS].sort());
    for (const d of DEPTS.filter((x) => x !== 'software')) expect(p.effective(d, ['respond', ...WS]).filter((n) => n.startsWith('ws_')), d).toEqual([]);
    const byDept = CONFIG_DEFAULTS['tools.byDept'] as Record<string, string[]>;
    for (const d of Object.keys(byDept)) for (const n of WS) expect(byDept[d]!.includes(n), `${d}:${n}`).toBe(d === 'software');
    expect(byDept.software!.length).toBeLessThanOrEqual(100); // the schema limit
  });
  it('Praw "*" never expands to a ws tool', () => {
    expect(mk().effective('praw', ['*']).filter((n) => n.startsWith('ws_'))).toEqual([]);
    expect(mk().effective('praw', ['*'])).toEqual(expect.arrayContaining(['web_search', 'fetch_page']));
  });
  it('a stored tools.byDept that grants ws_run to every other department (or to praw) has no effect', () => {
    const stored = Object.fromEntries(DEPTS.map((d) => [d, ['web_search', ...WS]]));
    const p = mk(new FakeConfig({ 'tools.byDept': stored }));
    for (const d of DEPTS.filter((x) => x !== 'software')) expect(p.effective(d, ['*']).filter((n) => n.startsWith('ws_')), d).toEqual([]);
    expect(p.effective('software', []).filter((n) => n.startsWith('ws_')).sort()).toEqual([...WS].sort());
  });
  it('skills cannot add a ws write tool (named no-approval tools), and a skill of another department cannot add ws_list or ws_read either', () => {
    const env = { registered: () => REGISTERED, builtins: () => BUILTIN, kindOf: () => 'write' as const };
    for (const n of WS.filter((x) => x !== 'ws_list' && x !== 'ws_read')) expect(skillToolAllowed(n, env), n).toBe(false);
    expect(mk(new FakeConfig(), () => 'read').effective('marketing', [], WS).filter((n) => n.startsWith('ws_'))).toEqual([]);
  });
  it('through the Org: software head and personas see them, every other head and persona and Praw do not, whatever is stored', async () => {
    const org = await seededOrg();
    const stored = Object.fromEntries(DEPTS.map((d) => [d, ['web_search', ...WS]]));
    org.setToolPolicy(mk(new FakeConfig({ 'tools.byDept': stored })));
    const ws = (a: Parameters<typeof org.toolsFor>[0]) => org.toolsFor(a).filter((n) => n.startsWith('ws_'));
    expect(ws({ kind: 'head', dept: 'software' }).sort()).toEqual([...WS].sort());
    expect(ws({ kind: 'persona', personaId: 'system-analyst' }).sort()).toEqual([...WS].sort());
    for (const d of DEPTS.filter((x) => x !== 'software')) expect(ws({ kind: 'head', dept: d as never }), d).toEqual([]);
    for (const id of ['research-scientist', 'innovation-brainstorm', 'ceo-business-advisor', 'legal-and-contracts']) expect(ws({ kind: 'persona', personaId: id }), id).toEqual([]);
  });
  it('the ws names are in no tree grant list', () => {
    for (const n of WS) expect(TREE_GRANT_TOOLS).not.toContain(n);
  });
});

describe('WS-C18: NO_APPROVAL_TOOLS', () => {
  it('is exactly the named list', () => {
    expect([...NO_APPROVAL_TOOLS]).toEqual(['diagram_create', 'ws_create', 'ws_delete', 'ws_export', 'ws_run', 'ws_write']);
    for (const n of WS.filter((x) => !['ws_list', 'ws_read'].includes(x))) expect(isNoApproval(n), n).toBe(true);
    for (const n of ['ws_list', 'ws_read', 'ws_other', 'ws_write2', 'WS_WRITE']) expect(isNoApproval(n), n).toBe(false);
  });
  it('writes never ask, even delegated and tainted; a different write tool still asks', () => {
    const ctx = { direct: false, tainted: () => true };
    for (const tool of ['ws_create', 'ws_write', 'ws_delete', 'ws_run', 'ws_export']) expect(approvalFor('write', ctx, { tool, target: 't', change: 'c' }), tool).toBe(false);
    expect(approvalFor('write', ctx, { tool: 'write_file', target: 't', change: 'c' })).toMatchObject({ reason: expect.any(String) });
  });
});

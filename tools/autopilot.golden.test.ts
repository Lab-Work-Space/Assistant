import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CTO, MemNotes, MemTasks, auditSpy, newBus, runCtxBase, seededOrg } from '../agents/test-helpers.js';
import { AutopilotService } from '../governance/autopilot.js';
import { Limits } from '../governance/limits.js';
import { FakeConfig } from '../governance/test-helpers.js';
import { AUTOPILOT_OWN_WAIVE } from './autopilot.js';
import { CLICKUP_WORKSPACE_WRITE_NAMES } from './plugins/clickup/workspace-write.js';
import { canonicalGolden, readGolden, updateRequested } from '../tests/fakes/golden.js';
import { realRegistry } from './autopilot.golden.harness.js';
import { ToolRegistry } from './registry.js';
import type { ToolContext, ToolPlugin } from './types.js';

/** Plausible inputs for the tools that matter to the decision; every other tool is called with `{}` (the decision never reads more than the name for those). */
const SAMPLE: Record<string, unknown> = {
  ws_run: { slug: 'proj', command: 'npm test' },
  web_search: { query: 'plain words' },
  fetch_page: { url: 'https://example.com/a' },
  write_file: { path: 'a.txt', content: 'x' },
  forward_to: { dept: 'rnd' },
  doc_create: { kind: 'report' },
  clickup_create_task: { list_id: '7001', name: 'n' },
};

type Cls = 'plain' | 'run' | 'refuse' | 'card' | string;
async function classify(real: ToolRegistry, name: string, tainted: boolean, input: unknown = SAMPLE[name] ?? {}): Promise<Cls> {
  const orig = (real as unknown as { tools: Map<string, ToolPlugin<unknown>> }).tools.get(name)!;
  const spyRun = vi.fn(async () => ({ content: 'ran' }));
  const probe = { ...orig, inputSchema: z.any(), precheck: undefined, onApprovalTask: undefined, summary: () => ({ target: 't', change: 'c' }), untrustedOutput: false, run: spyRun } as unknown as ToolPlugin<unknown>;
  const reg = new ToolRegistry({ halt: { isHalted: () => false }, autopilot: true });
  reg.register(probe);
  const tasks = new MemTasks();
  const spy = auditSpy();
  const approvals = { needsApproval: () => false, request: vi.fn(async () => ({ id: 5 }) as never) };
  const task = await tasks.create({ title: 'x', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
  const decides: string[] = [];
  const svc = new AutopilotService({
    cfg: new FakeConfig(), halted: () => false, secrets: [], describe: (n) => real.describe(n), org: { persona: () => null }, exhausted: async () => true, log: { error: () => undefined },
    repo: { projectOf: async () => ({ id: 1, rootTaskId: task.id, deadline: '2026-12-31' }), claimApproval: async () => ({ kind: 'run', used: 1, max: 500 }), toolsFor: async () => [], toolsForTask: async () => [], grantTool: async () => ({ ok: true }), companyRoot: async () => null, claimCompany: async () => ({ kind: 'not_company' }), grantTreeTool: async () => ({ ok: false, code: 'not_company' }), treeToolsFor: async () => [] },
  });
  const base = runCtxBase();
  if (tainted) base.run.markTainted();
  const ctx: ToolContext = {
    actor: CTO, task: (await tasks.get(task.id))!, ...base, org: Object.assign(Object.create(await seededOrg()) as object, { toolsFor: () => [name] }) as never, tasks, approvals,
    limits: new Limits(new FakeConfig(), tasks), bus: newBus(), notes: new MemNotes(), audit: spy.audit,
    autopilot: { projectOf: svc.projectOf.bind(svc), decide: async (r) => (decides.push(r.tool), svc.decide(r)) },
  };
  const res = await reg.run(name, input, ctx);
  const last = spy.entries.at(-1)?.outcome ?? '';
  if (approvals.request.mock.calls.length) return 'card';
  if (last.startsWith('autopilot_refused:')) return 'refuse';
  if (spyRun.mock.calls.length) return decides.length ? 'run' : 'plain';
  return `other:${last}:${res.content.slice(0, 40)}`;
}

/** Variants that must change the class of the same tool (hard-deny input, data-like input, overwrite). */
const VARIANTS: Record<string, [string, unknown]> = {
  'doc_create (draft kind)': ['doc_create', { kind: 'invoice_receipt' }],
  'write_file (overwrite)': ['write_file', { path: 'a.txt', content: 'x', overwrite: true }],
  'fetch_page (url carries data)': ['fetch_page', { url: 'https://example.com/a?token=abcdefghijklmnopqrstuvwxyz0123456789' }],
  'web_search (query carries data)': ['web_search', { query: 'a'.repeat(30) }],
  'web_search (an @)': ['web_search', { query: 'mail a@b.c' }],
};

/**
 * The frozen table: `<class untainted>/<class tainted>` for the call of the task owner (a non-direct head run) inside an active project.
 *   plain  = needs no approval at all (the branch is not reached)    run    = decide() answered run (same run, no card)
 *   refuse = decide() refused the call as data-like                    card   = today's card (hard-deny, own reason off the list, tainted write_file, wider forward_to, comments)
 * A new tool, or a changed class, fails this test until a reviewer updates the table: that is the point (global rule 6, AP-C1).
 */
/** BE3: the frozen classes are one committed file (tools/__golden__/autopilot-classes.json, keys sorted, 2-space indent). Expected values are observed run-path classes, never computed from the manifest. */
const GOLDEN_FILE = new URL('./__golden__/autopilot-classes.json', import.meta.url);
const committed = (): Record<string, string> => JSON.parse(readFileSync(GOLDEN_FILE, 'utf8')) as Record<string, string>;

describe('AP-C1 golden table: the class of every registered tool inside a project (untainted / tainted)', () => {
  it('matches the frozen table for every tool of the real set, and the variants that change a class', async () => {
    const real = await realRegistry();
    const out: Record<string, string> = {};
    for (const n of real.names().sort()) out[n] = `${await classify(real, n, false)}/${await classify(real, n, true)}`;
    for (const [k, [n, i]] of Object.entries(VARIANTS)) out[k] = `${await classify(real, n, false, i)}/${await classify(real, n, true, i)}`;
    if (updateRequested()) readGolden(GOLDEN_FILE, canonicalGolden(out));
    const text = readFileSync(GOLDEN_FILE, 'utf8'); // GOLDEN_UPDATE=1 writes the observed table and fails the run (refused under CI); the comparison always reads the committed file itself
    const GOLDEN = JSON.parse(text) as Record<string, string>;
    expect(Object.keys(out).sort()).toEqual(Object.keys(GOLDEN).sort());
    expect(out).toEqual(GOLDEN);
    expect(text).toBe(canonicalGolden(out));
    // the classes `other:*` (a harness failure) never appear
    expect(Object.values(out).filter((v) => v.includes('other:'))).toEqual([]);
  });

  it('every ClickUp workspace write name that exists in the set is on the own-reason list, and no tool outside the list and the central rule runs on its own reason', async () => {
    const real = await realRegistry();
    for (const n of CLICKUP_WORKSPACE_WRITE_NAMES) expect(real.names(), n).toContain(n);
    // a tool classed run in BOTH contexts either has a central write approval only (own false) or is on the list; the tainted-only runs are exactly the two read tools
    const tainted = Object.entries(committed()).filter(([k, v]) => !k.includes('(') && v.split('/')[0] !== 'run' && v.split('/')[1] === 'run').map(([k]) => k).sort();
    expect(tainted).toEqual(['fetch_page', 'web_search']);
    for (const n of tainted) expect(AUTOPILOT_OWN_WAIVE).toContain(n);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CTO, MemNotes, MemTasks, auditSpy, newBus, runCtxBase, seededOrg } from '../agents/test-helpers.js';
import { AutopilotService } from '../governance/autopilot.js';
import { Limits } from '../governance/limits.js';
import { FakeConfig } from '../governance/test-helpers.js';
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

/** Variants that must change the class of the same tool (hard-deny input, data-like input, overwrite). */
const VARIANTS: Record<string, [string, unknown]> = {
  'doc_create (draft kind)': ['doc_create', { kind: 'invoice_receipt' }],
  'write_file (overwrite)': ['write_file', { path: 'a.txt', content: 'x', overwrite: true }],
  'fetch_page (url carries data)': ['fetch_page', { url: 'https://example.com/a?token=abcdefghijklmnopqrstuvwxyz0123456789' }],
  'web_search (query carries data)': ['web_search', { query: 'a'.repeat(30) }],
  'web_search (an @)': ['web_search', { query: 'mail a@b.c' }],
};

/** Same frozen classes as the project table (one committed file, see autopilot.golden.test.ts): the company claim is the only difference. */
const GOLDEN_FILE = new URL('./__golden__/autopilot-classes.json', import.meta.url);

type Mode = 'task' | 'hook' | 'nohook';
type Cls = 'plain' | 'run' | 'refuse' | 'card' | 'notask' | string;
/** AUTO-2 AC-C7: the same classification with NO project (the service's repo answers a company root), for a task run, a chat run with the conversation hook, and a chat run without it. */
async function classify(real: ToolRegistry, name: string, mode: Mode, tainted: boolean, input: unknown = SAMPLE[name] ?? {}): Promise<{ cls: Cls; opened: number }> {
  const orig = (real as unknown as { tools: Map<string, ToolPlugin<unknown>> }).tools.get(name)!;
  const spyRun = vi.fn(async () => ({ content: 'ran' }));
  const probe = { ...orig, inputSchema: z.any(), precheck: undefined, onApprovalTask: undefined, summary: () => ({ target: 't', change: 'c' }), untrustedOutput: false, run: spyRun } as unknown as ToolPlugin<unknown>;
  const reg = new ToolRegistry({ halt: { isHalted: () => false }, autopilot: true });
  reg.register(probe);
  const tasks = new MemTasks();
  const spy = auditSpy();
  const approvals = { needsApproval: () => false, request: vi.fn(async () => ({ id: 5 }) as never) };
  const mk = () => tasks.create({ title: 'x', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
  const own = mode === 'task' ? await mk() : null;
  const decides: string[] = [];
  const svc = new AutopilotService({
    cfg: new FakeConfig({ 'autopilot.scope': 'company' }), halted: () => false, secrets: [], describe: (n) => real.describe(n), org: { persona: () => null }, exhausted: async () => true, log: { error: () => undefined },
    repo: { projectOf: async () => null, claimApproval: async () => ({ kind: 'cap' } as never), toolsFor: async () => [], toolsForTask: async () => [], grantTool: async () => ({ ok: true }), companyRoot: async (id) => id, claimCompany: async () => ({ kind: 'run', day: 1, tree: 1 }), grantTreeTool: async () => ({ ok: false, code: 'not_company' }), treeToolsFor: async () => [] },
  });
  const base = runCtxBase({ origin: 'chat' });
  if (tainted) base.run.markTainted();
  let opened: Promise<Awaited<ReturnType<typeof mk>>> | null = null;
  const ctx: ToolContext = {
    actor: CTO, task: own, ...base, org: Object.assign(Object.create(await seededOrg()) as object, { toolsFor: () => [name] }) as never, tasks, approvals,
    limits: new Limits(new FakeConfig(), tasks), bus: newBus(), notes: new MemNotes(), audit: spy.audit,
    autopilot: { projectOf: svc.projectOf.bind(svc), companyOn: () => svc.companyOn(), inCompany: (id) => svc.inCompany(id), decide: async (r) => (decides.push(r.tool), svc.decide(r)) },
    ...(mode === 'hook' ? { ensureConversationTask: () => (opened ??= mk()) } : {}),
  };
  const res = await reg.run(name, input, ctx);
  const last = spy.entries.at(-1)?.outcome ?? '';
  const n = mode === 'hook' ? (opened ? 1 : 0) : 0;
  if (approvals.request.mock.calls.length) return { cls: 'card', opened: n };
  if (last.startsWith('autopilot_refused:')) return { cls: 'refuse', opened: n };
  if (last === 'approval_needs_task') return { cls: 'notask', opened: n };
  if (spyRun.mock.calls.length) return { cls: decides.length ? 'run' : 'plain', opened: n };
  return { cls: `other:${last}:${res.content.slice(0, 40)}`, opened: n };
}


describe('AUTO-2 AC-C7 golden table: every registered tool with NO project and scope company', () => {
  it('a task run and a chat run with the conversation hook match the frozen table; a chat run without the hook is approval_needs_task for everything that needs approval', async () => {
    const real = await realRegistry();
    const names: [string, string, unknown][] = [...real.names().sort().map((n) => [n, n, SAMPLE[n] ?? {}] as [string, string, unknown]), ...Object.entries(VARIANTS).map(([k, [n, i]]) => [k, n, i] as [string, string, unknown])];
    const rows = { task: {} as Record<string, string>, hook: {} as Record<string, string>, nohook: {} as Record<string, string> };
    const opened: string[] = [];
    for (const [key, n, input] of names) {
      for (const [mode, m] of [['task', 'task'], ['hook', 'hook'], ['nohook', 'nohook']] as const) {
        const u = await classify(real, n, m, false, input);
        const t = await classify(real, n, m, true, input);
        rows[mode][key] = `${u.cls}/${t.cls}`;
        if (mode === 'hook' && u.opened + t.opened > 2) opened.push(key);
        // the hook opens one task per run exactly when the call reaches the approval branch, never for a tool that needs none
        if (mode === 'hook') expect(u.opened, `${key} untainted`).toBe(u.cls === 'plain' ? 0 : 1);
        if (mode === 'hook') expect(t.opened, `${key} tainted`).toBe(t.cls === 'plain' ? 0 : 1);
      }
    }
    if (updateRequested()) readGolden(GOLDEN_FILE, canonicalGolden(rows.task));
    const text = readFileSync(GOLDEN_FILE, 'utf8'); // GOLDEN_UPDATE=1 writes the observed table and fails the run (refused under CI); the comparison always reads the committed file itself
    const GOLDEN = JSON.parse(text) as Record<string, string>;
    expect(Object.keys(rows.task).sort()).toEqual(Object.keys(GOLDEN).sort());
    expect(rows.task).toEqual(GOLDEN);
    expect(text).toBe(canonicalGolden(rows.task));
    expect(rows.hook).toEqual(GOLDEN);
    const none = Object.fromEntries(Object.entries(GOLDEN).map(([k, v]) => [k, v.split('/').map((c) => (c === 'plain' ? 'plain' : 'notask')).join('/')]));
    expect(rows.nohook).toEqual(none);
    expect(opened).toEqual([]);
    expect(Object.values({ ...rows.task, ...rows.hook, ...rows.nohook }).filter((v) => v.includes('other:'))).toEqual([]);
  });
});

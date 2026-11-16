import { describe, expect, it } from 'vitest';
import { CTO, MemNotes, MemTasks, auditSpy, newBus, seededOrg, runCtxBase } from '../../agents/test-helpers.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import type { TaskConsumeResult } from '../../db/repos/task-grants.js';
import { ToolRegistry } from '../registry.js';
import type { TaskGrantPort, ToolContext } from '../types.js';
import { forwardTo } from './forwardTo.js';

const SRC = '1570000000000000001';
class Port implements TaskGrantPort {
  calls = 0;
  async consume(): Promise<TaskConsumeResult> { this.calls++; return { ok: true, grantId: 1, used: this.calls, max: 40 }; }
}
const parse = (o: Record<string, unknown>) => ({ dept: 'finance', summary: 'Please prepare the Q4 budget', reason: 'budget work is finance duty', duty: 'finance', estCostUsd: 0.1, ...o });
const DEPTS = [['finance', 'finance'], ['hr', 'people'], ['ops', 'operations'], ['marketing', 'marketing'], ['sales', 'sales']] as const;

async function rig(o: { pub: boolean }) {
  const tasks = new MemTasks();
  const requests: unknown[] = [];
  const port = new Port();
  const root = await tasks.create({ title: 'r', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
  const reg = new ToolRegistry({ halt: { isHalted: () => false }, treeGrants: true });
  reg.register(forwardTo);
  const base = {
    actor: CTO, task: root, org: await seededOrg(), tasks, limits: new Limits(new FakeConfig(), tasks), bus: newBus(), notes: new MemNotes(), audit: auditSpy().audit,
    approvals: { needsApproval: () => false, request: async (r: unknown) => (requests.push(r), { id: requests.length }) as never },
    guildId: '1565649426943442944', channelIsPublic: async () => o.pub, canMemberView: async () => true, treeGrants: port,
    source: { channelId: SRC, threadId: null, messageId: '1570000000000000009', userId: null, attachments: [] },
  };
  const ctxFor = () => ({ ...runCtxBase(), ...base }) as unknown as ToolContext; // a fresh run state per run
  return { reg, port, tasks, requests, ctxFor, root };
}

describe('TG-C4 (b) and TG-C21 for forward_to under a live grant', () => {
  it('a wider audience keeps its card: no consume, no child, an approval request is filed', async () => {
    const r = await rig({ pub: false });
    const res = await r.reg.run('forward_to', parse({}), r.ctxFor());
    expect(res.content).toMatch(/^NOT DONE YET/);
    expect(r.port.calls).toBe(0);
    expect(r.requests).toHaveLength(1);
    expect(r.tasks.rows.size).toBe(1); // only the root
  });

  it('a not-wider audience runs inline on the grant and creates the child', async () => {
    const r = await rig({ pub: true });
    const res = await r.reg.run('forward_to', parse({}), r.ctxFor());
    expect(res.isError).toBeFalsy();
    expect(res.content).not.toMatch(/^NOT DONE YET/);
    expect(r.port.calls).toBe(1);
    expect(r.requests).toHaveLength(0);
    expect(r.tasks.rows.size).toBe(2);
  });

  it('the third forward of one run is refused by the tool\'s own precheck under a grant (and consumes nothing)', async () => {
    const r = await rig({ pub: true });
    const ctx = r.ctxFor(); // one run state for the three calls
    const out = [];
    for (const [d, duty] of DEPTS.slice(0, 3)) out.push(await r.reg.run('forward_to', parse({ dept: d, duty }), ctx));
    expect(out.map((x) => !!x.isError)).toEqual([false, false, true]);
    expect(out[2]!.content).toMatch(/at most 2 forwards per run/);
    expect(r.port.calls).toBe(2);
    expect(r.requests).toHaveLength(0);
  });

  it('the fifth forward in one tree is refused by the per-root cap of 4 even with a live grant; the grant slot spent on it is not a bypass', async () => {
    const r = await rig({ pub: true });
    const out = [];
    for (const [d, duty] of DEPTS) out.push(await r.reg.run('forward_to', parse({ dept: d, duty }), r.ctxFor())); // a new run each time
    expect(out.map((x) => !!x.isError)).toEqual([false, false, false, false, true]);
    expect(out[4]!.content).toMatch(/maximum number of times/);
    expect(r.requests).toHaveLength(0);
  });

  it('a tainted run in a public source is still the audience question only: forward_to is covered when not wider (RF11 reads the same ctx)', async () => {
    const r = await rig({ pub: true });
    const ctx = r.ctxFor();
    ctx.run.markTainted();
    const res = await r.reg.run('forward_to', parse({}), ctx);
    expect(res.isError).toBeFalsy();
    expect(r.port.calls).toBe(1);
  });
});

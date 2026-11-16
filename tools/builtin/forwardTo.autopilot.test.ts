import { describe, expect, it } from 'vitest';
import { CTO, MemNotes, MemTasks, auditSpy, newBus, seededOrg, runCtxBase } from '../../agents/test-helpers.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { ToolRegistry } from '../registry.js';
import type { AutopilotPort, ToolContext } from '../types.js';
import { forwardTo } from './forwardTo.js';

const SRC = '1570000000000000001';
const parse = (o: Record<string, unknown>) => ({ dept: 'finance', summary: 'Please prepare the Q4 budget', reason: 'budget work is finance duty', duty: 'finance', estCostUsd: 0.1, ...o });
const DEPTS = [['finance', 'finance'], ['hr', 'people'], ['ops', 'operations'], ['marketing', 'marketing'], ['sales', 'sales']] as const;

/** AP-C2: forward_to inside a project: the audience rule, the 2-per-run cap and the 4-per-root cap are all still in force. */
async function rig(o: { pub: boolean }) {
  const tasks = new MemTasks();
  const requests: unknown[] = [];
  const decided: string[] = [];
  const port: AutopilotPort = { projectOf: async () => ({ id: 1, rootTaskId: 'r', deadline: '2026-12-31' }), decide: async (r) => (decided.push(r.tool), { kind: 'run' }) };
  const root = await tasks.create({ title: 'r', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
  const reg = new ToolRegistry({ halt: { isHalted: () => false }, autopilot: true });
  reg.register(forwardTo);
  const base = {
    actor: CTO, task: root, org: await seededOrg(), tasks, limits: new Limits(new FakeConfig(), tasks), bus: newBus(), notes: new MemNotes(), audit: auditSpy().audit,
    approvals: { needsApproval: () => false, request: async (r: unknown) => (requests.push(r), { id: requests.length }) as never },
    guildId: '1565649426943442944', channelIsPublic: async () => o.pub, canMemberView: async () => true, autopilot: port,
    source: { channelId: SRC, threadId: null, messageId: '1570000000000000009', userId: null, attachments: [] },
  };
  const ctxFor = () => ({ ...runCtxBase(), ...base }) as unknown as ToolContext;
  return { reg, tasks, requests, decided, ctxFor };
}

describe('AP-C2: forward_to inside a project', () => {
  it('a wider audience is a card (decide is not asked); a not-wider one runs in the same run', async () => {
    const wide = await rig({ pub: false });
    expect((await wide.reg.run('forward_to', parse({}), wide.ctxFor())).content).toMatch(/^NOT DONE YET/);
    expect(wide.decided).toEqual([]);
    expect(wide.requests).toHaveLength(1);
    const narrow = await rig({ pub: true });
    const res = await narrow.reg.run('forward_to', parse({}), narrow.ctxFor());
    expect(res.isError).toBeFalsy();
    expect(res.content).not.toMatch(/^NOT DONE YET/);
    expect(narrow.decided).toEqual(['forward_to']);
    expect(narrow.requests).toHaveLength(0);
  });

  it('the third forward of one run is refused by the tool\'s own cap, with no extra approval spent after it', async () => {
    const r = await rig({ pub: true });
    const ctx = r.ctxFor();
    const out = [];
    for (const [d, duty] of DEPTS.slice(0, 3)) out.push(await r.reg.run('forward_to', parse({ dept: d, duty }), ctx));
    expect(out.map((x) => !!x.isError)).toEqual([false, false, true]);
    expect(out[2]!.content).toMatch(/at most 2 forwards per run/);
    expect(r.decided).toHaveLength(2); // the refused third never reached decide: the precheck runs first
    expect(r.requests).toHaveLength(0);
  });

  it('the fifth forward of one tree is refused by the per-root cap of 4', async () => {
    const r = await rig({ pub: true });
    const out = [];
    for (const [d, duty] of DEPTS) out.push(await r.reg.run('forward_to', parse({ dept: d, duty }), r.ctxFor()));
    expect(out.map((x) => !!x.isError)).toEqual([false, false, false, false, true]);
    expect(r.requests).toHaveLength(0);
  });
});

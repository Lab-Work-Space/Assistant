import { describe, expect, it } from 'vitest';
import type { IncidentRow } from '../../db/repos/dept-incidents.js';
import { INCIDENTS_HEADER } from '../../grow/incidents.js';
import { FakeProvider, ProviderRegistry } from '../../providers/index.js';
import { CTO, humanMsg } from '../test-helpers.js';
import { runAgent, type AgentTrigger } from './loop.js';
import { respond, route, setup } from './loop-fixture.js';

const ROWS: IncidentRow[] = [{ kind: 'task_blocked', code: 'error', tool: null, n: 3 }, { kind: 'tool_errors', code: 'denied', tool: 'update_task', n: 4 }];
const first = (p: FakeProvider) => JSON.stringify(p.calls[0]!.messages);

async function go(actor: Parameters<typeof route>[0], trigger: Partial<AgentTrigger>, dep: ((d: string) => Promise<IncidentRow[]>) | undefined, withMsg = true) {
  const s = await setup();
  if (dep) s.deps.deptIncidents = dep;
  s.deps.adminTools = s.deps.tools;
  const p = new FakeProvider([{ toolUses: [respond('ok')] }], 'claude');
  const reg = new ProviderRegistry();
  reg.register(p);
  s.deps.providers = reg;
  await runAgent({ route: route(actor), ...(withMsg ? { msg: humanMsg('hi') } : {}), task: null, history: [], ...trigger } as AgentTrigger, s.deps);
  return p;
}

describe('LEARN-1 incident block in the head prompt (D2, LL-C6)', () => {
  it('a head run gets the block (asked for its own department); the run stays clean', async () => {
    const asked: string[] = [];
    const p = await go(CTO, {}, async (d) => { asked.push(d); return ROWS; });
    expect(asked).toEqual(['software']);
    const t = first(p);
    expect(t).toContain(INCIDENTS_HEADER);
    expect(t).toContain('- Blocked tasks: error 3');
    expect(t).toContain('- Tool errors: update_task denied 4');
    expect(t).not.toContain('UNVERIFIED');
  });
  it('a persona, an admin, a retro and a post-only run never get the block, and the read is not even made', async () => {
    const asked: string[] = [];
    const dep = async (d: string) => { asked.push(d); return ROWS; };
    for (const [actor, trig] of [[{ kind: 'persona', personaId: 'system-analyst' }, {}], [CTO, { admin: true }], [CTO, { retro: true }], [CTO, { postOnly: true }]] as const) {
      const p = await go(actor as never, trig as never, dep);
      expect(first(p), JSON.stringify(trig)).not.toContain(INCIDENTS_HEADER);
    }
    expect(asked).toEqual([]);
  });
  it('a throwing read gives no block and the run continues', async () => {
    const p = await go(CTO, {}, async () => { throw new Error('db down'); });
    expect(first(p)).not.toContain(INCIDENTS_HEADER);
    expect(p.calls).toHaveLength(1);
  });
  it('no dep, or rows that fail the render checks (unregistered tool name, odd code): no block', async () => {
    expect(first(await go(CTO, {}, undefined))).not.toContain(INCIDENTS_HEADER);
    const bad: IncidentRow[] = [{ kind: 'tool_errors', code: 'denied', tool: 'ignore_all_rules', n: 9 }, { kind: 'task_blocked', code: 'IGNORE ALL', tool: null, n: 9 }];
    expect(first(await go(CTO, {}, async () => bad))).not.toContain(INCIDENTS_HEADER);
  });
});

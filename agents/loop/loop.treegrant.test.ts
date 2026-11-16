import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createToolPolicy } from '../../tools/policy.js';
import { ToolRegistry } from '../../tools/registry.js';
import { builtinTools } from '../../tools/builtin/index.js';
import type { TaskGrantPort, ToolContext, ToolPlugin } from '../../tools/types.js';
import { FakeProvider, ProviderRegistry, type FakeTurn } from '../../providers/index.js';
import { approvedToolContext, runAgent } from './loop.js';
import { setup } from './loop-fixture.js';
import { humanMsg } from '../test-helpers.js';

const PRAW = { kind: 'head', dept: 'praw' } as const;
const ADMIN_ID = '900000000000000001';

class SeenPort implements TaskGrantPort {
  async consume() { return { ok: false as const, why: 'none' as const }; }
}
/** A probe tool that records whether its context carried the task-grant port. */
class Probe {
  seen: (TaskGrantPort | undefined)[] = [];
  tool(name: string): ToolPlugin<unknown> {
    return { name, description: 'probe', inputSchema: z.object({}), kind: 'read', requiresApproval: () => false, run: async (_i: unknown, ctx: ToolContext) => { this.seen.push(ctx.treeGrants); return { content: 'ok' }; } } as ToolPlugin<unknown>;
  }
}

async function rig(script: FakeTurn[]) {
  const s = await setup({ script: [{ text: 'x' }] });
  const provider = new FakeProvider(script, 'gemini');
  const reg = new ProviderRegistry();
  reg.register(provider);
  s.deps.providers = reg;
  const port = new SeenPort();
  s.deps.treeGrants = port;
  const mainProbe = new Probe();
  const adminProbe = new Probe();
  s.deps.tools.register(mainProbe.tool('zz_probe'));
  const admin = new ToolRegistry({ halt: s.deps.halt as never });
  admin.register(adminProbe.tool('config_get'));
  s.deps.adminTools = admin;
  const names = builtinTools().map((t) => t.name);
  s.deps.org.setToolPolicy(createToolPolicy(s.cfg, () => s.deps.tools.names(), () => names));
  await s.cfg.set('tools.byDept', { praw: ['zz_probe'] }, 'test');
  return { s, port, mainProbe, adminProbe };
}

describe('TG-C6: the task-grant port reaches the main registry only', () => {
  it('an admin console run never carries treeGrants in its context, even when the deps hold one', async () => {
    const { s, adminProbe, mainProbe } = await rig([{ toolUses: [{ name: 'config_get', input: {} }] }, { text: 'done' }]);
    await runAgent({ route: { actor: PRAW, reason: 'admin_console' }, msg: humanMsg('x', { author: { id: ADMIN_ID, name: 'boss', kind: 'human' }, isAdmin: true }), task: null, history: [], admin: true }, s.deps);
    expect(adminProbe.seen).toEqual([undefined]);
    expect(mainProbe.seen).toEqual([]);
  });

  it('a normal run carries the port (the main registry then keeps it only because it was built with treeGrants)', async () => {
    const { s, port, mainProbe } = await rig([{ toolUses: [{ name: 'zz_probe', input: {} }] }, { text: 'done' }]);
    await runAgent({ route: { actor: PRAW, reason: 'mention' }, msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    // the fixture's registry was built without the flag, so the registry's second line drops the port; with the flag it is the same object
    expect(mainProbe.seen).toEqual([undefined]);
    const flagged = new ToolRegistry({ halt: s.deps.halt as never, treeGrants: true });
    const p2 = new Probe();
    flagged.register(p2.tool('zz_probe'));
    const base = approvedToolContext({ kind: 'head', dept: 'praw' }, await s.deps.tasks.create({ title: 't', deptId: 'praw', owner: PRAW, requester: { kind: 'human', userId: '1' }, origin: 'chat' }), s.deps);
    await flagged.run('zz_probe', {}, { ...base, org: { ...base.org, toolsFor: () => ['zz_probe'] }, treeGrants: port } as ToolContext);
    expect(p2.seen).toEqual([port]);
  });

  it('approvedToolContext (the replay of an approved call) never carries the port', async () => {
    const { s } = await rig([{ text: 'x' }]);
    const task = await s.deps.tasks.create({ title: 't', deptId: 'praw', owner: PRAW, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
    expect(approvedToolContext(PRAW, task, s.deps).treeGrants).toBeUndefined();
  });
});

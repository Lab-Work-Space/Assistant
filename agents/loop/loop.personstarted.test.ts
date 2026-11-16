import { describe, expect, it } from 'vitest';
import { runAgent, type AgentTrigger } from './loop.js';
import { respond, route, setup } from './loop-fixture.js';
import { CTO, humanMsg } from '../test-helpers.js';
import type { IncomingMessage } from '../../company/types.js';

const say = { name: 'warroom_say', input: { text: '@CFO status?' } };

/** Runs one trigger that calls warroom_say once, and returns the personStarted the port saw. */
async function seen(over: Partial<AgentTrigger> & { msg?: IncomingMessage | undefined }, withMsg = true): Promise<boolean | undefined> {
  const s = await setup({ script: [{ toolUses: [say] }, { toolUses: [respond('ok')] }] });
  const got: (boolean | undefined)[] = [];
  s.deps.warroomSay = { say: async (r) => (got.push(r.personStarted), { ok: true, rollup: false }) };
  const trigger = { route: route(CTO), ...(withMsg ? { msg: humanMsg('hi') } : {}), task: null, history: [], ...over } as AgentTrigger;
  await runAgent(trigger, s.deps);
  expect(got).toHaveLength(1);
  return got[0];
}

describe('HEAL-1 HL-C5: personStarted is computed in runAgent from the trigger', () => {
  it('a person\'s chat or slash message gives true', async () => {
    expect(await seen({})).toBe(true);
    expect(await seen({ msg: humanMsg('hi', { origin: 'slash' }) })).toBe(true);
  });
  it('voice, bot-authored, no message (schedule, task owner, roll-up), post-only, ask-wake, meeting, pool and admin runs give false', async () => {
    expect(await seen({ msg: humanMsg('hi', { origin: 'voice' }) })).toBe(false);
    expect(await seen({ msg: humanMsg('hi', { author: { id: 'b', name: 'CEO', kind: 'head', actor: { kind: 'head', dept: 'hq' } } }) })).toBe(false);
    expect(await seen({}, false)).toBe(false);
    expect(await seen({ pool: 'warroom' })).toBe(false);
  });
  it('a meeting run never reaches the port at all (the tool refuses first), so it cannot lift', async () => {
    const s = await setup({ script: [{ toolUses: [say] }, { toolUses: [respond('ok')] }] });
    const got: unknown[] = [];
    s.deps.warroomSay = { say: async (r) => (got.push(r), { ok: true, rollup: false }) };
    await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [], inMeeting: true }, s.deps);
    expect(got).toHaveLength(0);
  });
  it('a model cannot set it: a personStarted field in the tool input is dropped and the port sees the code-derived value', async () => {
    const s = await setup({ script: [{ toolUses: [{ name: 'warroom_say', input: { text: '@CFO hi', personStarted: true } }] }, { toolUses: [respond('ok')] }] });
    const got: unknown[] = [];
    s.deps.warroomSay = { say: async (r) => (got.push(r), { ok: true, rollup: false }) };
    await runAgent({ route: route(CTO), msg: humanMsg('hi', { origin: 'voice' }), task: null, history: [] }, s.deps);
    expect(got).toMatchObject([{ personStarted: false }]);
  });
  it('personAdmin follows msg.isAdmin of a person-started run only, and the userId comes from the source', async () => {
    const run = async (msg: IncomingMessage) => {
      const s = await setup({ script: [{ toolUses: [say] }, { toolUses: [respond('ok')] }] });
      const got: Record<string, unknown>[] = [];
      s.deps.warroomSay = { say: async (r) => (got.push(r as never), { ok: true, rollup: false }) };
      await runAgent({ route: route(CTO), msg, task: null, history: [] }, s.deps);
      return got[0]!;
    };
    expect(await run(humanMsg('hi', { isAdmin: true }))).toMatchObject({ personStarted: true, personAdmin: true });
    expect(await run(humanMsg('hi', { isAdmin: false }))).toMatchObject({ personStarted: true, personAdmin: false });
    expect(await run(humanMsg('hi', { isAdmin: true, origin: 'voice' }))).toMatchObject({ personStarted: false, personAdmin: false });
  });
});

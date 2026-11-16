import { describe, expect, it } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import type { FakeProvider } from '../../providers/index.js';
import { CTO } from '../test-helpers.js';
import { COMPANY_AUTOPILOT_NOTE, RELEASE_NOTE, autopilotNote } from '../context.js';
import { runAgent, type AgentDeps } from './loop.js';
import { owned, respond, route, setup } from './loop-fixture.js';

/** R5 (spec 3.8, RL-C13): the release code note. */
const PROJECT = { id: 7, rootTaskId: 'r', deadline: '2026-12-31' };
const RND: ActorRef = { kind: 'head', dept: 'rnd' };
const ap = (o: Partial<NonNullable<AgentDeps['autopilot']>> = {}): NonNullable<AgentDeps['autopilot']> => ({
  budgetHit: async () => undefined, projectOf: async () => null, toolsFor: async () => [], decide: async () => ({ kind: 'card' }), companyOn: () => false, inCompany: async () => false, treeToolsFor: async () => [], ...o,
});
const COMPANY = { companyOn: () => true, inCompany: async () => true };

async function system(actor: ActorRef, autopilot: AgentDeps['autopilot'], tweak?: (cfg: Awaited<ReturnType<typeof setup>>['cfg']) => void): Promise<string> {
  const s = await setup({ script: [{ toolUses: [respond('ok')] }] });
  if (autopilot) s.deps.autopilot = autopilot;
  tweak?.(s.cfg);
  const task = await owned(s.tasks, actor);
  await runAgent({ route: route(actor), task, history: [] }, s.deps);
  return (s.provider as FakeProvider).calls[0]!.system;
}

describe('RELEASE_NOTE', () => {
  it('is a fixed text with no variables, exactly the spec text', () => {
    expect(RELEASE_NOTE).not.toContain('${');
    expect(RELEASE_NOTE).toBe('RELEASE (code note): When a deliverable in a workspace is finished, call release_request with the workspace, a short title and a summary instead of saying it is shipped. Only a Bot Admin approves a release; until you are told, say it is waiting for approval. Do not push, publish or deploy it with other tools. A ws_export post is a review copy, not a release.');
  });
});

describe('the loop appends RELEASE_NOTE only for the software head under a project or company note', () => {
  it('a project run of the software head gets it, right after the project note', async () => {
    const sys = await system(CTO, ap({ projectOf: async () => PROJECT }));
    expect(sys).toContain(RELEASE_NOTE);
    expect(sys.indexOf(RELEASE_NOTE)).toBeGreaterThan(sys.indexOf(autopilotNote(PROJECT)));
    expect(sys).toContain(`${autopilotNote(PROJECT)}\n\n${RELEASE_NOTE}`);
  });
  it('a company-scope run of the software head gets it, right after the company note', async () => {
    const sys = await system(CTO, ap(COMPANY));
    expect(sys).toContain(`${COMPANY_AUTOPILOT_NOTE}\n\n${RELEASE_NOTE}`);
  });
  it('another head, a run with neither note, and a run without autopilot do not get it', async () => {
    expect(await system(RND, ap({ projectOf: async () => PROJECT }))).not.toContain(RELEASE_NOTE);
    expect(await system(RND, ap(COMPANY))).not.toContain(RELEASE_NOTE);
    expect(await system(CTO, ap())).not.toContain(RELEASE_NOTE);
    expect(await system(CTO, undefined)).not.toContain(RELEASE_NOTE);
  });
  it('RL-C13: the switch off, and a switch that cannot be read, mean no note', async () => {
    expect(await system(CTO, ap({ projectOf: async () => PROJECT }), (c) => { c.values.set('release.enabled', false); })).not.toContain(RELEASE_NOTE);
    expect(await system(CTO, ap(COMPANY), (c) => { c.throwOn.add('release.enabled'); })).not.toContain(RELEASE_NOTE);
    expect(await system(CTO, ap(COMPANY), (c) => { c.values.set('release.enabled', 'true'); })).not.toContain(RELEASE_NOTE); // only exactly true is on
  });
});

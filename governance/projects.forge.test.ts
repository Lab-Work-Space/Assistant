import { describe, expect, it, vi } from 'vitest';
import { PROPOSE_TEXT, ProjectProposeInput, ProjectService, type ProjectServiceDeps } from './projects.js';

/** R7 PLUGIN-FORGE BE2 (spec 3.0 F7, 5.2, 7.1; FG-AC13 unit half, FG-AC17): `project_propose` and `/project start` gain the optional idea link; the card names the forge. */
const BASE = { title: 'Forge project', goal: 'Build the tool from the idea.', deadline: '2026-12-01', budget: { maxLocalCalls: 100, maxUsd: 1 } };
const NOW = Date.parse('2026-11-13T05:00:00Z');
const project = (over: Record<string, unknown> = {}) => ({
  id: 5, token: 'a'.repeat(32), title: 'Forge project', goal: 'g', ownerDept: 'hq', deadline: '2026-12-01', maxLocalCalls: 100, maxUsd: 1, maxApprovals: 10, status: 'proposed', proposer: 'head:hq', tainted: false,
  expiresAt: new Date('2026-11-20T00:00:00Z'), ...over,
});

function rig(o: { forge?: unknown; forgeOn?: () => unknown; created?: unknown } = {}) {
  const cards: Record<string, unknown>[] = [];
  const create = vi.fn(async () => o.created ?? { ok: true as const, project: project(), adopt: { ids: [], skipped: [] }, ...(o.forge === undefined ? {} : { forge: o.forge }) });
  const deps = {
    repo: { create, setCard: vi.fn(async () => true) },
    cfg: { get: (k: string) => (k === 'autopilot.enabled' ? true : k === 'forge.enabled' ? (o.forgeOn ? o.forgeOn() : true) : k === 'schedule.timezone' ? 'Asia/Bangkok' : undefined) },
    tasks: { get: async () => null }, bus: { emit: async () => undefined }, halted: () => false, secrets: [], configChannelId: '1565682159375749161',
    postCard: async (p: Record<string, unknown>) => { cards.push(p); return '800000000000000021'; }, closeCard: async () => undefined, notifyHead: async () => undefined, log: { error: () => undefined }, now: () => NOW,
  } as unknown as ProjectServiceDeps;
  return { svc: new ProjectService(deps), create, cards };
}
const HQ = { kind: 'head', dept: 'hq' } as const;
const RUN = { tainted: false, task: null };

describe('ProjectProposeInput.toolIdea', () => {
  it('is an optional positive integer; the schema stays strict', () => {
    expect(ProjectProposeInput.safeParse(BASE).success).toBe(true);
    expect(ProjectProposeInput.safeParse({ ...BASE, toolIdea: 3 }).success).toBe(true);
    for (const bad of [0, -1, 1.5, '3', null, 1e12]) expect(ProjectProposeInput.safeParse({ ...BASE, toolIdea: bad }).success, String(bad)).toBe(false);
    expect(ProjectProposeInput.safeParse({ ...BASE, extra: 1 }).success).toBe(false);
  });
});

describe('propose with toolIdea', () => {
  it('forge off (false, a read error, not exactly true): forge_off with the fixed text, and nothing is created', async () => {
    for (const forgeOn of [() => false, () => { throw new Error('x'); }, () => 'true']) {
      const r = rig({ forgeOn });
      expect(await r.svc.propose(HQ, RUN, { ...BASE, toolIdea: 3 })).toEqual({ ok: false, code: 'forge_off', error: 'The plugin forge is switched off.' });
      expect(r.create).not.toHaveBeenCalled();
    }
  });
  it('a proposal without toolIdea never reads the forge switch', async () => {
    const r = rig({ forgeOn: () => { throw new Error('must not be read'); } });
    expect(await r.svc.propose(HQ, RUN, BASE)).toMatchObject({ ok: true });
    expect(r.create).toHaveBeenCalledWith(expect.not.objectContaining({ ideaId: expect.anything() }));
  });
  it('passes the idea id to the repo; the card carries the forge line from the repo result', async () => {
    const r = rig({ forge: { id: 2, ideaId: 3, ideaName: 'csvtool', deptId: 'software' } });
    expect(await r.svc.propose(HQ, RUN, { ...BASE, toolIdea: 3 })).toMatchObject({ ok: true, id: 5 });
    expect(r.create).toHaveBeenCalledWith(expect.objectContaining({ ideaId: 3, proposer: 'head:hq' }));
    expect(String(r.cards[0]!.body)).toContain('Forge: builds tool idea #3 csvtool (software) as a plugin.');
  });
  it('a card without a forge has no forge line', async () => {
    const r = rig();
    await r.svc.propose(HQ, RUN, BASE);
    expect(String(r.cards[0]!.body)).not.toContain('Forge:');
  });
  it('the repo refusals map to fixed texts: idea_invalid, idea_busy, forge_cap', async () => {
    expect(PROPOSE_TEXT.idea_invalid).toBe('That tool idea is not open or was filed by a run that read outside content.');
    expect(PROPOSE_TEXT.idea_busy).toBe('That tool idea already has a forge.');
    expect(PROPOSE_TEXT.forge_cap).toBe('There are already 3 forges in progress.');
    for (const code of ['idea_invalid', 'idea_busy', 'forge_cap'] as const) {
      const r = rig({ created: { ok: false, code } });
      expect(await r.svc.propose(HQ, RUN, { ...BASE, toolIdea: 3 })).toEqual({ ok: false, code, error: PROPOSE_TEXT[code] });
    }
  });
});

describe('/project start with idea', () => {
  const START = { userId: '900000000000000001', title: 'Forge project', goal: 'Build it.', deadline: '2026-12-01', usd: 1, calls: 100 };
  it('passes the idea as toolIdea with the user proposer; no idea keeps the old input exactly', async () => {
    const r = rig({ forge: { id: 2, ideaId: 3, ideaName: 'csvtool', deptId: 'software' } });
    await r.svc.start({ ...START, idea: 3 });
    expect(r.create).toHaveBeenCalledWith(expect.objectContaining({ ideaId: 3, proposer: 'user:900000000000000001', tainted: false }));
    const n = rig();
    await n.svc.start(START);
    expect(n.create).toHaveBeenCalledWith(expect.not.objectContaining({ ideaId: expect.anything() }));
  });
  it('an out-of-range idea is invalid before anything is created', async () => {
    const r = rig();
    expect(await r.svc.start({ ...START, idea: 0 })).toMatchObject({ ok: false, code: 'invalid' });
    expect(r.create).not.toHaveBeenCalled();
  });
});

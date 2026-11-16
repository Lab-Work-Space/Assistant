import { describe, expect, it, vi } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import { forgeNoteHq, forgeNoteSoftware, type IdeaForNote } from '../../forge/notes.js';
import type { FakeProvider } from '../../providers/index.js';
import { CTO } from '../test-helpers.js';
import { runAgent, type AgentDeps } from './loop.js';
import { owned, respond, route, setup } from './loop-fixture.js';

/** R7 PLUGIN-FORGE BE2 (spec 5.5, PF-C17, PF-C18; FG-AC17, FG-AC18): the two forge notes reach only their own actor, only while `forge.enabled` reads true, and never with a tainted idea. */
const HQ: ActorRef = { kind: 'head', dept: 'hq' };
const RND: ActorRef = { kind: 'head', dept: 'rnd' };
const idea = (o: Partial<IdeaForNote> = {}): IdeaForNote => ({ id: 3, name: 'csvtool', deptId: 'sales', problem: 'Turn a CSV export into a table.', example: 'Input: a.csv', tainted: false, status: 'open', ...o });
const forgeDeps = (o: Partial<NonNullable<AgentDeps['forge']>> = {}): NonNullable<AgentDeps['forge']> => ({
  hqIdeas: vi.fn(async () => [idea()]), softwareIdea: vi.fn(async () => ({ projectId: 12, idea: { ...idea(), example: 'Input: a.csv' } })), ...o,
});

async function system(actor: ActorRef, forge: AgentDeps['forge'], tweak: (cfg: Awaited<ReturnType<typeof setup>>['cfg']) => void = (c) => { c.values.set('forge.enabled', true); }, trigger: Record<string, unknown> = {}): Promise<string> {
  const s = await setup({ script: [{ toolUses: [respond('ok')] }] });
  if (forge) s.deps.forge = forge;
  tweak(s.cfg);
  const task = await owned(s.tasks, actor);
  await runAgent({ route: route(actor), task, history: [], ...trigger } as never, s.deps);
  return (s.provider as FakeProvider).calls[0]!.system;
}

describe('FORGE_NOTE_HQ', () => {
  it('the CEO gets it with the eligible ideas, exactly the note text', async () => {
    const f = forgeDeps();
    const sys = await system(HQ, f);
    expect(sys).toContain(forgeNoteHq([idea()]));
    expect(sys).toContain('call project_propose with toolIdea set to its number');
    expect(f.hqIdeas).toHaveBeenCalledTimes(1);
  });
  it('another head, the software head and Praw do not get it, and the closure is not even asked', async () => {
    for (const a of [RND, CTO]) {
      const f = forgeDeps();
      expect(await system(a, f), a.kind === 'head' ? a.dept : '').not.toContain('PLUGIN FORGE (code note): Open tool ideas');
      expect(f.hqIdeas).not.toHaveBeenCalled();
    }
  });
  it('no eligible idea means no note; a tainted idea from the closure is dropped (defence in depth)', async () => {
    expect(await system(HQ, forgeDeps({ hqIdeas: async () => [] }))).not.toContain('PLUGIN FORGE');
    const sys = await system(HQ, forgeDeps({ hqIdeas: async () => [idea({ tainted: true }), idea({ id: 9, name: 'okayone' })] }));
    expect(sys).toContain('#9 okayone');
    expect(sys).not.toContain('#3 csvtool');
  });
  it('PF-C17: the switch off, unreadable or not exactly true means no note, and the closure is not asked', async () => {
    for (const tweak of [(c: never) => { (c as { values: Map<string, unknown> }).values.set('forge.enabled', false); }, (c: never) => { (c as { throwOn: Set<string> }).throwOn.add('forge.enabled'); }, (c: never) => { (c as { values: Map<string, unknown> }).values.set('forge.enabled', 'true'); }]) {
      const f = forgeDeps();
      expect(await system(HQ, f, tweak as never)).not.toContain('PLUGIN FORGE');
      expect(f.hqIdeas).not.toHaveBeenCalled();
    }
  });
  it('a closure that throws means no note and the run still completes', async () => {
    expect(await system(HQ, forgeDeps({ hqIdeas: async () => { throw new Error('db'); } }))).not.toContain('PLUGIN FORGE');
  });
  it('without forge deps there is no note (the default config also keeps it off)', async () => {
    expect(await system(HQ, undefined)).not.toContain('PLUGIN FORGE');
    expect(await system(HQ, forgeDeps(), () => undefined)).not.toContain('PLUGIN FORGE');
  });
  it('an admin run never gets it', async () => {
    const f = forgeDeps();
    const s = await setup({ script: [{ toolUses: [respond('ok')] }] });
    s.deps.forge = f;
    s.cfg.values.set('forge.enabled', true);
    expect(f.hqIdeas).not.toHaveBeenCalled();
  });
});

describe('FORGE_NOTE_SOFTWARE', () => {
  it('the software head gets it when the task root is a forge project, with the project, the idea and the delimited text', async () => {
    const f = forgeDeps();
    const sys = await system(CTO, f);
    expect(sys).toContain(forgeNoteSoftware({ projectId: 12, idea: { ...idea(), example: 'Input: a.csv' } }));
    expect(sys).toContain('[[Turn a CSV export into a table.]]');
    expect(f.softwareIdea).toHaveBeenCalledTimes(1);
    expect(typeof (f.softwareIdea as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('string');
  });
  it('not for the CEO or another head, and the closure is not asked for them', async () => {
    for (const a of [HQ, RND]) {
      const f = forgeDeps();
      expect(await system(a, f)).not.toContain('This task belongs to forge project');
      expect(f.softwareIdea).not.toHaveBeenCalled();
    }
  });
  it('a task that is not under a forge project (null) gets no note; a throwing closure gets none and the run completes; a tainted idea is dropped', async () => {
    expect(await system(CTO, forgeDeps({ softwareIdea: async () => null }))).not.toContain('PLUGIN FORGE');
    expect(await system(CTO, forgeDeps({ softwareIdea: async () => { throw new Error('db'); } }))).not.toContain('PLUGIN FORGE');
    expect(await system(CTO, forgeDeps({ softwareIdea: async () => ({ projectId: 1, idea: { ...idea({ tainted: true }), example: 'x' } }) }))).not.toContain('PLUGIN FORGE');
  });
  it('PF-C17: the switch off or unreadable means no note and no closure call', async () => {
    for (const tweak of [(c: never) => { (c as { values: Map<string, unknown> }).values.set('forge.enabled', false); }, (c: never) => { (c as { throwOn: Set<string> }).throwOn.add('forge.enabled'); }]) {
      const f = forgeDeps();
      expect(await system(CTO, f, tweak as never)).not.toContain('PLUGIN FORGE');
      expect(f.softwareIdea).not.toHaveBeenCalled();
    }
  });
});

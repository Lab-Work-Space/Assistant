import { describe, expect, it, vi } from 'vitest';
import type { RetroRepo } from '../db/repos/grow.js';
import type { SkillRepo } from '../db/repos/skills.js';
import { SkillService, type SkillDeps } from './service.js';

const head = { kind: 'head', dept: 'software' } as const;
const input = { op: 'create' as const, skill: 'handover', title: 'Handover', instructions: 'Write the handover note before closing a task.', reason: 'we keep forgetting' };
const run = { tainted: false, task: { id: 'retro-task', tainted: false } };

function mk(o: { slot?: 'claimed' | 'used' | 'not_retro'; claimThrows?: boolean; create?: () => Promise<{ ok: true; id: number } | { ok: false; reason: 'pending_exists' }> } = {}) {
  const retro = {
    claimSkill: vi.fn(async () => { if (o.claimThrows) throw new Error('db down'); return o.slot ?? 'claimed'; }),
    releaseSkill: vi.fn(async () => undefined),
    setSkillProposal: vi.fn(async () => undefined),
  };
  const createProposal = vi.fn(o.create ?? (async () => ({ ok: true as const, id: 7 })));
  const repo = { countOpen: async () => 0, pendingFor: async () => null, get: async () => null, createProposal } as unknown as SkillRepo;
  const audit = vi.fn(async () => undefined);
  const log = { error: vi.fn() };
  const svc = new SkillService({
    repo, retro: retro as unknown as Pick<RetroRepo, 'claimSkill' | 'releaseSkill' | 'setSkillProposal'>, org: { dept: () => null, persona: () => null, personasOf: () => [], reload: async () => undefined } as never,
    classify: async () => ({ allow: true as const }), audit, secrets: [], grant: { registered: () => [], builtins: () => [], kindOf: () => undefined }, cfg: { get: () => undefined } as never, log,
  } as SkillDeps);
  vi.spyOn(svc as never as { capsPreview: () => Promise<null> }, 'capsPreview').mockResolvedValue(null);
  return { svc, retro, createProposal, audit, log };
}

describe('GROW-1: one skill per retro (claimSkill inside propose)', () => {
  it('the first proposal claims the slot and records its proposal id; no release', async () => {
    const t = mk();
    expect(await t.svc.propose(head, run, input)).toMatchObject({ ok: true, id: 7 });
    expect(t.retro.claimSkill).toHaveBeenCalledWith('retro-task');
    expect(t.retro.setSkillProposal).toHaveBeenCalledWith('retro-task', 7);
    expect(t.retro.releaseSkill).not.toHaveBeenCalled();
  });
  it('a second proposal of the same retro is refused retro_skill_used before the write, with the fixed text', async () => {
    const t = mk({ slot: 'used' });
    const r = await t.svc.propose(head, run, input);
    expect(r).toMatchObject({ ok: false, code: 'retro_skill_used' });
    expect((r as { error: string }).error).toContain('only one skill per weekly retro');
    expect(t.createProposal).not.toHaveBeenCalled();
    expect(t.retro.releaseSkill).not.toHaveBeenCalled();
  });
  it('a refused write (pending_exists) gives the slot back', async () => {
    const t = mk({ create: async () => ({ ok: false, reason: 'pending_exists' }) });
    expect(await t.svc.propose(head, run, input)).toMatchObject({ ok: false, code: 'pending_exists' });
    expect(t.retro.releaseSkill).toHaveBeenCalledWith('retro-task');
    expect(t.retro.setSkillProposal).not.toHaveBeenCalled();
  });
  it('a THROWN write gives the slot back too (try/finally) and the error still propagates', async () => {
    const t = mk({ create: async () => { throw new Error('db down'); } });
    await expect(t.svc.propose(head, run, input)).rejects.toThrow('db down');
    expect(t.retro.releaseSkill).toHaveBeenCalledWith('retro-task');
  });
  it('a claim that throws refuses with unavailable and writes nothing (log: error name only)', async () => {
    const t = mk({ claimThrows: true });
    expect(await t.svc.propose(head, run, input)).toMatchObject({ ok: false, code: 'unavailable' });
    expect(t.createProposal).not.toHaveBeenCalled();
    expect(t.log.error).toHaveBeenCalledWith({ errName: 'Error' }, 'retro skill claim failed');
  });
  it('a non-retro task (no retro row) is not limited and nothing is recorded or released', async () => {
    const t = mk({ slot: 'not_retro' });
    expect(await t.svc.propose(head, run, input)).toMatchObject({ ok: true });
    expect(t.retro.setSkillProposal).not.toHaveBeenCalled();
    expect(t.retro.releaseSkill).not.toHaveBeenCalled();
  });
  it('a run without a task never touches the claim', async () => {
    const t = mk();
    await t.svc.propose(head, { tainted: false, task: null }, input);
    expect(t.retro.claimSkill).not.toHaveBeenCalled();
  });
});

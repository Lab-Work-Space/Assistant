import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { SkillRepo } from '../db/repos/skills.js';
import { SkillService, type SkillDeps } from './service.js';

const head = { kind: 'head', dept: 'software' } as const;
const input = { op: 'create' as const, skill: 'handover', title: 'Handover', instructions: 'Write the handover note before closing a task.', reason: 'we keep forgetting' };
const run = { tainted: false, task: null };

function mk(cfgGet: (k: string) => unknown) {
  const repo = { countOpen: async () => 0, pendingFor: async () => null, get: async () => null, createProposal: async () => ({ ok: true as const, id: 7 }) } as unknown as SkillRepo;
  const notify = vi.fn(async () => undefined);
  const svc = new SkillService({
    repo, org: { dept: () => null, persona: () => null, personasOf: () => [], reload: async () => undefined } as never, classify: async () => ({ allow: true as const }),
    audit: async () => undefined, secrets: [], grant: { registered: () => [], builtins: () => [], kindOf: () => undefined }, cfg: { get: cfgGet } as never, notify, log: { error: vi.fn() },
  } as SkillDeps);
  vi.spyOn(svc as never as { capsPreview: () => Promise<null> }, 'capsPreview').mockResolvedValue(null);
  return { svc, notify };
}

describe('GROW-1: the propose hook (SA-1 C5, GW-C13)', () => {
  it('judge set and skills.ai.enabled on: offers the proposal, the notice is NOT posted here, the reply is neutral', async () => {
    const t = mk((k) => k === 'skills.ai.enabled');
    const offer = vi.fn();
    t.svc.setJudge({ offer });
    const r = await t.svc.propose(head, run, input);
    expect(offer).toHaveBeenCalledWith(7);
    expect(t.notify).not.toHaveBeenCalled();
    expect(r).toEqual({ ok: true, id: 7, text: 'Proposal #7 saved. An AI reviewer checks it first; if it does not approve, a Bot Admin reviews it. NOTHING has changed yet. Do not say it is done.' });
  });
  it('switch off, a read error, or no judge: exactly today\'s notice and reply', async () => {
    const today = 'Proposal #7 saved. NOTHING has changed: a Bot Admin must review and confirm it. Do not say it is done.';
    for (const [get, judge] of [[() => false, true], [() => { throw new Error('read'); }, true], [() => true, false]] as const) {
      const t = mk(get as never);
      const offer = vi.fn();
      if (judge) t.svc.setJudge({ offer });
      expect(await t.svc.propose(head, run, input)).toEqual({ ok: true, id: 7, text: today });
      expect(offer).not.toHaveBeenCalled();
      expect(t.notify).toHaveBeenCalledWith('Skill proposal #7 from software head: create handover. Review: /skill review 7');
    }
  });
  it('an offer that throws falls back to the human notice and still replies neutrally', async () => {
    const t = mk((k) => k === 'skills.ai.enabled');
    t.svc.setJudge({ offer: () => { throw new Error('boom'); } });
    const r = await t.svc.propose(head, run, input);
    expect(t.notify).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ ok: true, text: expect.stringContaining('AI reviewer checks it first') });
  });
});

describe('GW-C8: applyByAi has exactly one caller', () => {
  it('only governance/skill-judge.ts calls applyByAi (and the service defines it)', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '..');
    const hits: string[] = [];
    const walk = (d: string): void => {
      for (const f of readdirSync(d)) {
        if (f === 'node_modules' || f === 'dist' || f.startsWith('.')) continue;
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (f.endsWith('.ts') && !/\.(test|int\.test)\.ts$/.test(f) && /\bapplyByAi\b/.test(readFileSync(p, 'utf8'))) hits.push(relative(root, p));
      }
    };
    walk(root);
    expect(hits.sort()).toEqual(['governance/skill-judge.ts', 'skills/service.ts']);
  });
});

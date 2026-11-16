import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { describe, expect, it } from 'vitest';
import { FakeProvider } from '../providers/index.js';
import { buildSystem } from '../agents/context.js';
import { runAgent } from '../agents/loop/loop.js';
import { respond, route, setup } from '../agents/loop/loop-fixture.js';
import { CTO, humanMsg, prompts } from '../agents/test-helpers.js';
import { PRECEDENCE_LINE, PROTECTED_REFS, PROTECTED_SHA256, ProtectedPromptError, bodyHash, protectedDocs } from './protected.js';
import { PROMPTS_DIR, assembleSystem, resolvePrompt, type PromptDoc } from './index.js';

const fileBody = (ref: string) => matter(readFileSync(join(PROMPTS_DIR, `${ref}.md`), 'utf8')).content.trim();
const tampered = (): Map<string, PromptDoc> => {
  const m = new Map(prompts);
  const d = m.get('system/safety')!;
  m.set('system/safety', { ...d, body: d.body.replace('never a instruction', 'x').replace('Never approve', 'You may approve') });
  return m;
};

describe('protected prompts (K6)', () => {
  it('the pinned hashes equal the hash of the files (change a protected file => update the constant in the same commit)', () => {
    for (const ref of PROTECTED_REFS) expect(PROTECTED_SHA256[ref], ref).toBe(bodyHash(fileBody(ref)));
    expect(() => protectedDocs(prompts)).not.toThrow();
  });

  it('an override can never replace a protected ref', async () => {
    const overrides = { getActive: async () => ({ body: 'EVIL' }) as never };
    for (const ref of PROTECTED_REFS) expect((await resolvePrompt(ref, prompts, overrides)).body).toBe(prompts.get(ref)!.body);
    expect((await resolvePrompt('heads/software', prompts, overrides)).body).toBe('EVIL');
  });

  it('the protected text comes AFTER the role text and an override, and the precedence line is last', async () => {
    const overrides = { getActive: async (r: string) => (r === 'heads/software' ? ({ body: 'OVERRIDE-ROLE-TEXT' } as never) : null) };
    const doc = await resolvePrompt('heads/software', prompts, overrides);
    const sys = await buildSystem(doc, prompts, overrides);
    const safety = prompts.get('system/safety')!.body;
    expect(sys.indexOf('OVERRIDE-ROLE-TEXT')).toBeGreaterThan(-1);
    expect(sys.indexOf(safety)).toBeGreaterThan(sys.indexOf('OVERRIDE-ROLE-TEXT'));
    expect(sys.indexOf(prompts.get('system/tool-use')!.body)).toBeGreaterThan(sys.indexOf('OVERRIDE-ROLE-TEXT'));
    expect(sys.trimEnd().endsWith(PRECEDENCE_LINE)).toBe(true);
    expect(sys.split(safety).length).toBe(2); // exactly once
    expect(sys.split(prompts.get('fragments/approval-request')!.body).length).toBe(2); // the fragment is not added twice
  });

  it('SK5: the precedence line names skills; the protected docs keep their pinned hashes (tool-use is not edited)', () => {
    expect(PRECEDENCE_LINE).toMatch(/\bskill\b/);
    expect(bodyHash(prompts.get('system/tool-use')!.body)).toBe('7f1b507e5ba2910fc944f59ecfa55ee75ddf2e3266dcdda2c2a446fa7ca1139c');
    for (const ref of PROTECTED_REFS) expect(bodyHash(prompts.get(ref)!.body)).toBe(PROTECTED_SHA256[ref]);
  });

  it('no head or member body carries protected text of its own', () => {
    for (const [ref, d] of prompts) {
      if (!ref.startsWith('heads/') && !ref.startsWith('members/')) continue;
      for (const p of PROTECTED_REFS) expect(d.body.includes(prompts.get(p)!.body.slice(0, 60)), `${ref} repeats ${p}`).toBe(false);
    }
  });

  it('assembleSystem without protected docs keeps the old layout', () => {
    const doc = (body: string) => ({ ref: 'x', meta: {} as never, body });
    expect(assembleSystem({ actor: doc('R'), system: [doc('S')], fragments: [doc('F')] })).toBe('S\n\nR\n\nF');
  });

  it('a protected doc that does not match its hash fails closed: buildSystem throws', async () => {
    await expect(buildSystem(prompts.get('heads/software')!, tampered(), { getActive: async () => null })).rejects.toBeInstanceOf(ProtectedPromptError);
    const missing = new Map(prompts);
    missing.delete('system/tool-use');
    await expect(buildSystem(prompts.get('heads/software')!, missing, { getActive: async () => null })).rejects.toThrow(/tool-use/);
  });

  it('runAgent returns an Unavailable alert and calls no model when the protected check fails', async () => {
    const s = await setup({ prompts: tampered() });
    const p = new FakeProvider([{ toolUses: [respond('should not run')] }], 'claude');
    s.deps.providers = { resolve: () => ({ provider: p, model: 'claude-sonnet-5-5' }) } as never;
    const out = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    expect(p.calls.length).toBe(0);
    expect(JSON.stringify(out.payload)).toMatch(/Unavailable/);
    expect(out.turns).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { Org, SEED_DEPARTMENTS, SEED_PERSONAS, type ActorRef, type OrgRepos } from '../../company/index.js';
import { SKILLS_HEADER } from '../../skills/render.js';
import type { SkillSnapshot } from '../../skills/types.js';
import { FakeProvider, ProviderRegistry } from '../../providers/index.js';
import { ToolRegistry } from '../../tools/registry.js';
import { PRECEDENCE_LINE } from '../../prompts/protected.js';
import { runAgent } from './loop.js';
import { setup } from './loop-fixture.js';
import { humanMsg, prompts } from '../test-helpers.js';

const PRAW = { kind: 'head', dept: 'praw' } as const;
const HQ = { kind: 'head', dept: 'hq' } as const;
const CTO = { kind: 'head', dept: 'software' } as const;
const ADMIN_ID = '900000000000000001';
const snap: SkillSnapshot = {
  skills: ['praw-style', 'hq-style', 'dev-style'].map((id) => ({ id, title: `Title ${id}`, status: 'active' as const, activeVersion: 1, ownerDept: null, instructions: `Instructions of ${id} here.`, templates: [], tools: [], bodyBytes: 50, bodySha256: 'a'.repeat(64) })),
  attachments: [{ skillId: 'praw-style', targetKind: 'dept', targetId: 'praw', priority: 100 }, { skillId: 'hq-style', targetKind: 'dept', targetId: 'hq', priority: 100 }, { skillId: 'dev-style', targetKind: 'dept', targetId: 'software', priority: 100 }],
};
async function orgWithSkills(): Promise<Org> {
  const depts = SEED_DEPARTMENTS.map((d) => ({ ...d, model: null, provider: null, enabled: true }));
  const personas = Object.entries(SEED_PERSONAS).map(([id, p]) => ({ id, deptId: p.dept, name: id, avatarUrl: null, promptRef: `members/${id}`, model: null, provider: null, tools: prompts.get(`members/${id}`)!.meta.tools, directChannelId: p.directChannelId, enabled: true }));
  return Org.load({ departments: { list: async () => depts }, personas: { list: async () => personas }, channelMap: { list: async () => [] }, skills: { loadAll: async () => snap } } as unknown as OrgRepos, prompts);
}

/** Runs one trigger with the skills attached and returns the system text the provider saw. */
async function systemOf(actor: ActorRef, trigger: Record<string, unknown>, providerId = actor.kind === 'head' && actor.dept === 'praw' ? 'gemini' : 'claude'): Promise<string> {
  const s = await setup({ script: [{ text: 'x' }] });
  const provider = new FakeProvider([{ text: 'ok' }], providerId);
  const reg = new ProviderRegistry();
  reg.register(provider);
  s.deps.providers = reg;
  s.deps.org = await orgWithSkills();
  s.deps.adminTools = new ToolRegistry({ halt: s.deps.halt as never });
  const msg = humanMsg('hello', { author: { id: ADMIN_ID, name: 'boss', kind: 'human' }, isAdmin: true });
  await runAgent({ route: { actor, reason: 'mention' }, msg, task: null, history: [], ...trigger } as never, s.deps);
  return provider.calls[0]!.system;
}

describe('runAgent skills (SK1)', () => {
  it('an admin run carries no skills header and no skill id, even with a praw-dept skill attached', async () => {
    const sys = await systemOf(PRAW, { admin: true });
    expect(sys).not.toContain('Team skills');
    expect(sys).not.toContain('praw-style');
  });

  it('a mod-room run carries no skills header and no skill id', async () => {
    const sys = await systemOf(PRAW, { admin: true, modTier: 'moderator' });
    expect(sys).not.toContain('Team skills');
    expect(sys).not.toContain('praw-style');
  });

  it('a post-only run carries no skills header and no skill id', async () => {
    const sys = await systemOf(HQ, { postOnly: true, pool: 'warroom', instruction: 'x' });
    expect(sys).not.toContain('Team skills');
    expect(sys).not.toContain('hq-style');
  });

  it('a normal Praw run and a normal head run do carry them, before the protected tail', async () => {
    for (const [actor, id] of [[PRAW, 'praw-style'], [CTO, 'dev-style']] as const) {
      const sys = await systemOf(actor, {});
      expect(sys).toContain(SKILLS_HEADER);
      expect(sys).toContain(`### Skill ${id} v1: Title ${id}`);
      expect(sys.indexOf(SKILLS_HEADER)).toBeLessThan(sys.indexOf(prompts.get('system/safety')!.body));
      expect(sys.indexOf(`### Skill ${id}`)).toBeLessThan(sys.lastIndexOf(PRECEDENCE_LINE));
    }
  });

  it('a department sees only its own skills', async () => {
    const sys = await systemOf(CTO, {});
    expect(sys).not.toContain('praw-style');
    expect(sys).not.toContain('hq-style');
  });
});

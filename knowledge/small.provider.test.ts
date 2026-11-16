import { describe, expect, it } from 'vitest';
import { SEED_DEPARTMENTS, SEED_PERSONAS, Org, seed } from '../company/index.js';
import type { ActorRef } from '../company/types.js';
import { FakeConfig } from '../governance/test-helpers.js';
import { loadPrompts, PROMPTS_DIR } from '../prompts/index.js';
import { FakeProvider, ProviderRegistry } from '../providers/index.js';
import { smallRig } from './test-helpers.js';
import { smallCall } from './small.js';

// PROV-HELPER: helper LLM calls (reflect, review, classify) use the calling department's own provider. Only `praw` uses Gemini.
const prompts = loadPrompts(PROMPTS_DIR);
const LIVE_DEFAULT = { provider: 'claude-code-local', model: 'local/claude-sonnet-5-5' } as const;

async function realOrg() {
  const depts = new Map<string, never>();
  const personas = new Map<string, never>();
  const repos = {
    departments: { get: async (id: string) => depts.get(id) ?? null, upsert: async (d: { id: string }) => void depts.set(d.id, d as never), list: async () => [...depts.values()] },
    personas: { get: async (id: string) => personas.get(id) ?? null, upsert: async (p: { id: string }) => void personas.set(p.id, p as never), list: async () => [...personas.values()] },
    channelMap: { list: async () => [] },
  };
  await seed(repos as never, prompts);
  return Org.load(repos as never, prompts);
}

const actors: ActorRef[] = [
  ...SEED_DEPARTMENTS.map((d) => ({ kind: 'head', dept: d.id }) as ActorRef),
  ...Object.keys(SEED_PERSONAS).map((personaId) => ({ kind: 'persona', personaId }) as ActorRef),
];
const LABELS = ['reflect', 'review', 'classify'] as const;

async function rig() {
  const org = await realOrg();
  const ok = () => Array.from({ length: 200 }, () => ({ text: 'ok' }));
  const local = new FakeProvider(ok(), 'claude-code-local');
  const gemini = new FakeProvider(ok(), 'gemini');
  const claude = new FakeProvider(ok(), 'claude');
  const cfg = new FakeConfig({ provider: { default: LIVE_DEFAULT } as never } as never);
  cfg.values.set('provider.default', LIVE_DEFAULT);
  const s = smallRig([local, gemini, claude], { cfg: cfg as never, profiles: { org, prompts, overrides: { getActive: async () => null } as never } });
  return { s, local, gemini, claude };
}

describe('PROV-HELPER: smallCall provider', () => {
  it('no actor other than praw ever resolves to gemini, for every helper label, and none resolves to the cheapest model', async () => {
    const { s, local, gemini, claude } = await rig();
    for (const actor of actors) {
      for (const tool of LABELS) {
        const r = await smallCall(s.d, { actor, task: null, system: 's', user: 'u', maxTokens: 10, timeoutMs: 1000, tool });
        expect(r.ok, `${JSON.stringify(actor)} ${tool}`).toBe(true);
      }
    }
    const isPraw = (a: ActorRef) => a.kind === 'head' && a.dept === 'praw';
    const nonPraw = actors.filter((a) => !isPraw(a)).length * LABELS.length;
    expect(gemini.calls).toHaveLength(LABELS.length); // praw only (head)
    expect(local.calls).toHaveLength(nonPraw);
    expect(claude.calls).toHaveLength(0);
    expect(local.calls.every((c) => c.model === 'local/claude-sonnet-5-5')).toBe(true);
  });

  it('praw still resolves to its own Gemini model', async () => {
    const { s, gemini } = await rig();
    await smallCall(s.d, { actor: { kind: 'head', dept: 'praw' }, task: null, system: 's', user: 'u', maxTokens: 10, timeoutMs: 1000, tool: 'reflect' });
    expect(gemini.calls[0]!.model).toBe('gemini-3.8-flash');
  });

  it('falls back to provider.default (never gemini, never cheapest) when the actor has no profile or none is configured', async () => {
    const { s, local, gemini } = await rig();
    await smallCall(s.d, { actor: { kind: 'head', dept: 'nope' } as never, task: null, system: 's', user: 'u', maxTokens: 10, timeoutMs: 1000 });
    const bare = smallRig([local, gemini], { cfg: s.d.cfg });
    await smallCall(bare.d, { actor: { kind: 'head', dept: 'praw' }, task: null, system: 's', user: 'u', maxTokens: 10, timeoutMs: 1000 });
    expect(local.calls).toHaveLength(2);
    expect(gemini.calls).toHaveLength(0);
  });

  it('with the seed default config (claude) a non-praw actor still never gets gemini', async () => {
    const org = await realOrg();
    const claude = new FakeProvider([{ text: 'ok' }], 'claude');
    const gemini = new FakeProvider([{ text: 'ok' }], 'gemini');
    const s = smallRig([claude, gemini], { profiles: { org, prompts, overrides: { getActive: async () => null } as never } });
    await smallCall(s.d, { actor: { kind: 'head', dept: 'hq' }, task: null, system: 's', user: 'u', maxTokens: 10, timeoutMs: 1000 });
    expect(claude.calls).toHaveLength(1);
    expect(gemini.calls).toHaveLength(0);
  });

  it('a registry with no registered provider for the resolved selection returns no_model (no silent fallback)', async () => {
    const org = await realOrg();
    const s = smallRig([new FakeProvider([], 'claude-code-local')], { profiles: { org, prompts, overrides: { getActive: async () => null } as never } });
    s.d.cfg = new FakeConfig() as never; // default claude: not registered
    const r = await smallCall(s.d, { actor: { kind: 'head', dept: 'hq' }, task: null, system: 's', user: 'u', maxTokens: 10, timeoutMs: 1000 });
    expect(r).toEqual({ ok: false, reason: 'no_model' });
  });
});

describe('PROV-HELPER: quota hold and queue priority', () => {
  it('fails fast with ok:false and spawns nothing while the Claude quota hold is on (local provider only)', async () => {
    const { s, local, gemini } = await rig();
    s.d.quotaHold = { heldUntil: () => Date.now() + 60_000 };
    const r = await smallCall(s.d, { actor: { kind: 'head', dept: 'hq' }, task: null, system: 's', user: 'u', maxTokens: 10, timeoutMs: 1000, tool: 'reflect' });
    expect(r.ok).toBe(false);
    expect(local.calls).toHaveLength(0);
    expect(s.log.reserved).toBe(0);
    const p = await smallCall(s.d, { actor: { kind: 'head', dept: 'praw' }, task: null, system: 's', user: 'u', maxTokens: 10, timeoutMs: 1000, tool: 'reflect' });
    expect(p.ok).toBe(true);
  });

  it('reflect and review queue behind people (priority bot); classify does not', async () => {
    const { s, local } = await rig();
    for (const tool of LABELS) await smallCall(s.d, { actor: { kind: 'head', dept: 'hq' }, task: null, system: 's', user: 'u', maxTokens: 10, timeoutMs: 1000, tool });
    expect(local.calls.map((c) => c.priority)).toEqual(['bot', 'bot', undefined]);
  });
});

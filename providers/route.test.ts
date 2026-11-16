import { describe, expect, it } from 'vitest';
import { SEED_DEPARTMENTS, SEED_PERSONAS, Org, seed } from '../company/index.js';
import type { ActorRef } from '../company/types.js';
import { FakeConfig } from '../governance/test-helpers.js';
import { resolveActor } from '../agents/context.js';
import { loadPrompts, PROMPTS_DIR } from '../prompts/index.js';
import { fromLocalModel } from './claude-code-local/protocol.js';
import { FakeProvider, ProviderRegistry } from './index.js';
import { FALLBACK_EXCLUDED_DEPTS, FALLBACK_PROVIDER, fallbackEnabled, resolveEffective, type FallbackState } from './route.js';

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

const registry = (ids = ['claude-code-local', 'gemini', 'claude']) => {
  const r = new ProviderRegistry();
  for (const id of ids) r.register(new FakeProvider([], id));
  return r;
};
const config = (over: Record<string, unknown> = {}) => {
  const c = new FakeConfig();
  c.values.set('provider.default', LIVE_DEFAULT);
  for (const [k, v] of Object.entries(over)) c.values.set(k as never, v);
  return c;
};
const state = (o: { held?: boolean; usable?: boolean } = {}): FallbackState & { marks: unknown[] } => ({
  marks: [],
  heldUntil: () => (o.held === false ? null : Date.now() + 60_000),
  usable: () => o.usable !== false,
  mark(e) { this.marks.push(e); },
});

describe('R8 fromLocalModel (PV-C05)', () => {
  it('maps only the local Sonnet id to the API id; Haiku and anything else give null', () => {
    expect(fromLocalModel('local/claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    expect(fromLocalModel('local/claude-haiku-5-5')).toBeNull();
    expect(fromLocalModel('claude-sonnet-5-5')).toBeNull();
    expect(fromLocalModel('local/other')).toBeNull();
    expect(fromLocalModel('__proto__')).toBeNull();
    expect(fromLocalModel('constructor')).toBeNull();
  });
});

describe('R8 constants', () => {
  it('the fallback target and the excluded set are code constants', () => {
    expect(FALLBACK_PROVIDER).toBe('claude');
    expect([...FALLBACK_EXCLUDED_DEPTS]).toEqual(['praw']);
    expect(Object.isFrozen(FALLBACK_EXCLUDED_DEPTS)).toBe(true);
  });
});

describe('R8 resolveEffective', () => {
  it('no hold: the primary, route primary (G3: nobody resolves to claude)', async () => {
    const org = await realOrg();
    const reg = registry();
    const cfg = config({ 'provider.fallback.enabled': true });
    for (const actor of actors) {
      const profile = await resolveActor(actor, org, prompts, { getActive: async () => null } as never);
      if (typeof profile === 'string') continue;
      const r = resolveEffective(reg, profile, actor, cfg as never, state({ held: false }));
      expect(r.route, JSON.stringify(actor)).toBe('primary');
      expect(r.provider.id, JSON.stringify(actor)).not.toBe('claude');
    }
  });

  it('G1/G2 matrix: every seed head and persona x hold on/off x switch on/off x gate usable', async () => {
    const org = await realOrg();
    const reg = registry();
    for (const held of [true, false]) for (const enabled of [true, false]) for (const usable of [true, false]) {
      const cfg = config({ 'provider.fallback.enabled': enabled });
      for (const actor of actors) {
        const profile = await resolveActor(actor, org, prompts, { getActive: async () => null } as never);
        if (typeof profile === 'string') continue;
        const label = `${JSON.stringify(actor)} held=${held} enabled=${enabled} usable=${usable}`;
        const r = resolveEffective(reg, profile, actor, cfg as never, state({ held, usable }));
        const praw = profile.deptId === 'praw';
        // G1: a non-praw actor never resolves to gemini, in any state
        if (!praw) expect(r.provider.id, label).not.toBe('gemini');
        // G2: praw never resolves to claude, in any state
        if (praw) expect(r.provider.id, label).not.toBe('claude');
        // PV-C02: a held result never carries the claude provider
        if (r.route === 'held') expect(r.provider.id, label).not.toBe('claude');
        if (r.route === 'fallback') {
          expect(held && enabled && usable && !praw, label).toBe(true);
          expect(r.provider.id).toBe('claude');
          expect(r.model).toBe('claude-sonnet-5-5');
        } else if (r.provider.id === 'claude-code-local') {
          expect(r.route, label).toBe(held ? 'held' : 'primary');
        }
      }
    }
  });

  it('praw: Gemini always, and a praw persona on local is held, never the API', async () => {
    const org = await realOrg();
    const reg = registry();
    const cfg = config({ 'provider.fallback.enabled': true });
    const head = await resolveActor({ kind: 'head', dept: 'praw' }, org, prompts, { getActive: async () => null } as never);
    if (typeof head === 'string') throw new Error(head);
    expect(resolveEffective(reg, head, { kind: 'head', dept: 'praw' }, cfg as never, state())).toMatchObject({ route: 'primary' });
    expect(resolveEffective(reg, head, { kind: 'head', dept: 'praw' }, cfg as never, state()).provider.id).toBe('gemini');
    // a praw persona that resolves to local
    const persona = { deptId: 'praw', doc: head.doc, sel: { actor: { model: 'claude-sonnet-5-5' } } } as never;
    const r = resolveEffective(reg, persona, { kind: 'persona', personaId: 'x' } as never, cfg as never, state());
    expect(r.route).toBe('held');
    expect(r.provider.id).toBe('claude-code-local');
  });

  const hq = { deptId: 'hq', doc: undefined as never, sel: {} };
  const hqActor: ActorRef = { kind: 'head', dept: 'hq' };

  it('held for each eligibility failure, and the engaged route carries the API model', () => {
    const on = config({ 'provider.fallback.enabled': true });
    const run = (o: { reg?: ProviderRegistry; cfg?: FakeConfig; fb?: FallbackState; opts?: { allowFallback?: boolean }; profile?: typeof hq }) =>
      resolveEffective(o.reg ?? registry(), o.profile ?? hq, hqActor, (o.cfg ?? on) as never, o.fb ?? state(), o.opts);
    expect(run({}).route).toBe('fallback');
    expect(run({ cfg: config() }).route).toBe('held'); // switch off (default)
    expect(run({ reg: registry(['claude-code-local', 'gemini']) }).route).toBe('held'); // claude not registered
    expect(run({ fb: state({ usable: false }) }).route).toBe('held'); // gate blocked
    expect(run({ opts: { allowFallback: false } }).route).toBe('held');
    expect(run({ profile: { ...hq, deptId: 'praw' } }).route).toBe('held');
    expect(run({ profile: { ...hq, deptId: '' } }).route).toBe('held'); // no dept: fail closed
    expect(run({ profile: { ...hq, sel: { actor: { provider: 'claude-code-local', model: 'claude-haiku-5-5' } } } }).route).toBe('held'); // Haiku: no map (PV-C05)
    const noPrice = config({ 'provider.fallback.enabled': true, pricing: {} });
    expect(run({ cfg: noPrice }).route).toBe('held'); // the mapped model has no price
  });

  it('a primary that is not local ends at step 2 whatever the state', () => {
    const on = config({ 'provider.fallback.enabled': true, 'provider.default': { provider: 'claude', model: 'claude-sonnet-5-5' } });
    const r = resolveEffective(registry(), hq, hqActor, on as never, state());
    expect(r).toMatchObject({ route: 'primary' });
    expect(r.provider.id).toBe('claude');
  });

  it('no state or no hold: primary (today); an unregistered primary throws as today', () => {
    const on = config({ 'provider.fallback.enabled': true });
    expect(resolveEffective(registry(), hq, hqActor, on as never).route).toBe('primary');
    expect(resolveEffective(registry(), hq, hqActor, on as never, state({ held: false })).route).toBe('primary');
    expect(() => resolveEffective(registry(['gemini']), hq, hqActor, on as never, state())).toThrow();
  });

  it('G6: a read error, an unhealthy config listener or a throwing state each give held (fail closed)', () => {
    const on = config({ 'provider.fallback.enabled': true });
    on.throwOn.add('provider.fallback.enabled');
    expect(resolveEffective(registry(), hq, hqActor, on as never, state()).route).toBe('held');
    const unhealthy = config({ 'provider.fallback.enabled': true });
    unhealthy.listenerOk = false;
    expect(resolveEffective(registry(), hq, hqActor, unhealthy as never, state()).route).toBe('held');
    expect(fallbackEnabled(unhealthy as never)).toBe(false);
    const noListener = { get: (k: string) => (k === 'provider.fallback.enabled' ? true : (config().get as (k: string) => unknown)(k)) };
    expect(fallbackEnabled(noListener as never)).toBe(false); // cannot prove the listener is healthy: off
    const bad: FallbackState = { heldUntil: () => Date.now() + 1000, usable: () => { throw new Error('boom'); }, mark: () => undefined };
    expect(resolveEffective(registry(), hq, hqActor, config({ 'provider.fallback.enabled': true }) as never, bad).route).toBe('held');
    const noHas = { resolve: registry().resolve.bind(registry()) };
    expect(resolveEffective(noHas as never, hq, hqActor, config({ 'provider.fallback.enabled': true }) as never, state()).route).toBe('held');
  });

  it('only a value that is exactly true turns the switch on', () => {
    for (const v of ['true', 1, null, 'on']) expect(fallbackEnabled(config({ 'provider.fallback.enabled': v as never }) as never)).toBe(false);
    expect(fallbackEnabled(config({ 'provider.fallback.enabled': true }) as never)).toBe(true);
  });

  it('the task id is handed to the gate', () => {
    const seen: unknown[] = [];
    const fb: FallbackState = { heldUntil: () => Date.now() + 1000, usable: (a, d, t) => (seen.push([d, t]), true), mark: () => undefined };
    resolveEffective(registry(), hq, hqActor, config({ 'provider.fallback.enabled': true }) as never, fb, { taskId: 't1' });
    expect(seen).toEqual([['hq', 't1']]);
  });
});

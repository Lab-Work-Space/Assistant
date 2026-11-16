import { describe, expect, it } from 'vitest';
import { Org, seed } from '../company/index.js';
import { FakeConfig } from '../governance/test-helpers.js';
import { loadPrompts, PROMPTS_DIR } from '../prompts/index.js';
import { FallbackGate } from '../providers/fallback-gate.js';
import { FakeProvider, ProviderError } from '../providers/index.js';
import type { LLMProvider } from '../providers/types.js';
import { smallRig } from './test-helpers.js';
import { smallCall } from './small.js';

// R8 PROV-FALLBACK, BE2: helper calls. classify may use the backup; reflect and review fail fast (as today); marks come from smallCall too (PV-C09).
const prompts = loadPrompts(PROMPTS_DIR);
const T0 = Date.UTC(2026, 10, 16, 12, 0, 0);
async function org() {
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
async function rig(o: { enabled?: boolean; held?: boolean; claude?: LLMProvider; refuse?: 'company' | 'task' } = {}) {
  const local = new FakeProvider(Array.from({ length: 10 }, () => ({ text: 'local' })), 'claude-code-local');
  const claude = o.claude ?? new FakeProvider(Array.from({ length: 10 }, () => ({ text: 'api' })), 'claude');
  const gemini = new FakeProvider(Array.from({ length: 10 }, () => ({ text: 'gem' })), 'gemini');
  const cfg = new FakeConfig();
  cfg.values.set('provider.default', { provider: 'claude-code-local', model: 'local/claude-sonnet-5-5' });
  if (o.enabled !== false) cfg.values.set('provider.fallback.enabled', true);
  const marks: unknown[] = [];
  const hold = { until: o.held === false ? null : T0 + 3_600_000 };
  const gate = new FallbackGate({ heldUntil: () => hold.until, now: () => T0, onMark: (e) => marks.push(e) });
  const s = smallRig([local, claude, gemini], { cfg: cfg as never, fallback: gate, profiles: { org: await org(), prompts, overrides: { getActive: async () => null } as never } });
  if (o.refuse) s.d.call.budget = { ...s.d.call.budget, reserve: async () => ({ ok: false as const, scope: o.refuse! }) } as never;
  return { s, local, claude, gemini, marks, gate, hold };
}
const go = (r: Awaited<ReturnType<typeof rig>>, tool: string, dept = 'software', task: unknown = null) =>
  smallCall(r.s.d, { actor: { kind: 'head', dept } as never, task: task as never, system: 's', user: 'u', maxTokens: 10, timeoutMs: 1000, tool });

describe('R8 smallCall', () => {
  it('classify on a held run runs on the API with the API model id and the fallback route flag', async () => {
    const r = await rig();
    expect(await go(r, 'classify')).toMatchObject({ ok: true, text: 'api' });
    const c = (r.claude as FakeProvider).calls;
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ model: 'claude-sonnet-5-5', route: 'fallback' });
    expect(r.local.calls).toHaveLength(0);
  });

  it('reflect, review (and any other label) fail fast during the hold: ok:false, no call, no reservation', async () => {
    const r = await rig();
    for (const tool of ['reflect', 'review']) expect(await go(r, tool)).toEqual({ ok: false, reason: 'failed' });
    expect((r.claude as FakeProvider).calls).toHaveLength(0);
    expect(r.local.calls).toHaveLength(0);
    expect(r.s.log.reserved).toBe(0);
  });

  it('switch off: classify fails fast too (today\'s behaviour)', async () => {
    const r = await rig({ enabled: false });
    expect(await go(r, 'classify')).toEqual({ ok: false, reason: 'failed' });
    expect(r.s.log.reserved).toBe(0);
  });

  it('no hold: the local provider serves every label as before', async () => {
    const r = await rig({ held: false });
    for (const tool of ['classify', 'reflect', 'review']) expect(await go(r, tool)).toMatchObject({ ok: true, text: 'local' });
    expect((r.claude as FakeProvider).calls).toHaveLength(0);
  });

  it('praw (gemini) is unaffected and never reaches the API', async () => {
    const r = await rig();
    expect(await go(r, 'classify', 'praw')).toMatchObject({ ok: true, text: 'gem' });
    expect((r.claude as FakeProvider).calls).toHaveLength(0);
  });

  it('marks the gate: 401 -> api_off, 529 -> api_busy, a company refusal -> budget; a 400 only with a task (PV-C09)', async () => {
    const err = (status: number): LLMProvider => ({ id: 'claude', async *chat() { throw new ProviderError('VENDOR', { retryable: false, status }); } });
    const a = await rig({ claude: err(401) });
    expect(await go(a, 'classify')).toMatchObject({ ok: false });
    expect(a.marks).toEqual([{ kind: 'api_off', status: 401 }]);
    const b = await rig({ claude: err(529) });
    await go(b, 'classify');
    expect(b.marks).toEqual([{ kind: 'api_busy', status: 529 }]);
    const c = await rig({ refuse: 'company' });
    expect(await go(c, 'classify')).toEqual({ ok: false, reason: 'budget' });
    expect(c.marks).toEqual([{ kind: 'budget', scope: 'company', actor: { kind: 'head', dept: 'software' }, dept: 'software' }]);
    const d = await rig({ claude: err(400) });
    await go(d, 'classify');
    expect(d.marks).toEqual([]);
    const e = await rig({ claude: err(400) });
    await go(e, 'classify', 'software', { id: 'T9' });
    expect(e.marks).toEqual([{ kind: 'task_400', taskId: 'T9' }]);
    const f = await rig({ refuse: 'task' });
    await go(f, 'classify');
    expect(f.marks).toEqual([]);
  });

  it('the quotaHold-only wiring (no fallback state) is today\'s fail-fast', async () => {
    const r = await rig();
    delete (r.s.d as { fallback?: unknown }).fallback;
    r.s.d.quotaHold = { heldUntil: () => T0 + 1000 };
    expect(await go(r, 'classify')).toEqual({ ok: false, reason: 'failed' });
    expect(r.local.calls).toHaveLength(0);
  });
});

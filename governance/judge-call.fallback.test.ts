import { describe, expect, it } from 'vitest';
import { prompts, seededOrg } from '../agents/test-helpers.js';
import { FallbackGate } from '../providers/fallback-gate.js';
import { ProviderError, type ChatChunk, type ChatRequest, type LLMProvider } from '../providers/types.js';
import { ProviderRegistry } from '../providers/registry.js';
import { quotaRejection } from '../providers/claude-code-local/quota.js';
import { JudgeCaller, JudgeError, type JudgeCallerDeps } from './judge-call.js';
import { FakeConfig } from './test-helpers.js';

// R8 PROV-FALLBACK, BE2: the judges. ai_review may use the backup; skill_review fails fast; both stand down while held (PV-C09 marks too).
const usage: ChatChunk = { type: 'usage', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
const verdict: ChatChunk[] = [{ type: 'text', text: JSON.stringify({ decision: 'approve', reason: 'fine' }) }, usage, { type: 'stop', reason: 'end_turn' }];
const T0 = Date.UTC(2026, 10, 16, 12, 0, 0);

async function rig(o: { tool?: 'ai_review' | 'skill_review'; held?: boolean; enabled?: boolean; claude?: LLMProvider; refuse?: 'company' | 'task' } = {}) {
  const calls: { provider: string; req: ChatRequest }[] = [];
  const mk = (id: string, err?: () => unknown): LLMProvider => ({ id, async *chat(req) { calls.push({ provider: id, req }); if (err) throw err(); yield* verdict; } });
  const reg = new ProviderRegistry();
  reg.register(mk('claude-code-local', quotaRejection));
  reg.register(o.claude ?? mk('claude'));
  const cfg = new FakeConfig();
  cfg.values.set('provider.default', { provider: 'claude-code-local', model: 'local/claude-sonnet-5-5' });
  if (o.enabled !== false) cfg.values.set('provider.fallback.enabled', true);
  const reserves: unknown[] = [];
  const marks: unknown[] = [];
  const hold = { until: o.held === false ? null : T0 + 3_600_000 };
  const gate = new FallbackGate({ heldUntil: () => hold.until, now: () => T0, onMark: (e) => marks.push(e) });
  const deps: JudgeCallerDeps & { fallback?: FallbackGate } = {
    cfg: cfg as never, secrets: [], org: await seededOrg({}), prompts, overrides: { getActive: async () => null } as never, providers: reg,
    call: {
      budget: { reserve: async (r: unknown) => (reserves.push(r), o.refuse ? { ok: false as const, scope: o.refuse } : { ok: true as const, reservationId: 'r1' }), settle: async () => undefined, release: async () => undefined, costOf: () => 0.001 } as never,
      halt: { track: () => () => undefined }, audit: async () => undefined,
    },
    fallback: gate,
  };
  const caller = new JudgeCaller(deps, 'system', o.tool ?? 'ai_review', 1);
  return { caller, calls, reserves, marks, gate, cfg };
}

describe('R8 JudgeCaller', () => {
  it('ai_review on a held run with the backup eligible runs on the API with the API model', async () => {
    const r = await rig();
    await expect(r.caller.run('u')).resolves.toMatchObject({ decision: 'approve' });
    expect(r.calls.map((c) => [c.provider, c.req.model, c.req.route])).toEqual([['claude', 'claude-sonnet-5-5', 'fallback']]);
    expect(r.reserves[0]).toMatchObject({ provider: 'claude' });
  });

  it('skill_review never uses the backup: judge_error before any reservation or call', async () => {
    const r = await rig({ tool: 'skill_review' });
    await expect(r.caller.run('u')).rejects.toMatchObject({ code: 'judge_error' });
    expect(r.calls).toEqual([]);
    expect(r.reserves).toEqual([]);
  });

  it('held (switch off) fails fast for both judges: no spawn, no reservation (the hold fail-fast the judge lacked)', async () => {
    for (const tool of ['ai_review', 'skill_review'] as const) {
      const r = await rig({ tool, enabled: false });
      await expect(r.caller.run('u')).rejects.toBeInstanceOf(JudgeError);
      expect(r.calls).toEqual([]);
      expect(r.reserves).toEqual([]);
    }
  });

  it('no hold: the subscription provider serves as before', async () => {
    const ok = await rig({ held: false });
    await expect(ok.caller.run('u')).rejects.toMatchObject({ code: 'judge_error' }); // the fake local rejects: unchanged failure path
    expect(ok.calls.map((c) => c.provider)).toEqual(['claude-code-local']);
    expect(ok.marks).toEqual([]);
  });

  it('marks the gate from the judge\'s fallback outcomes: 401 -> api_off, 429 -> api_busy, a company refusal -> budget (PV-C09)', async () => {
    const e = (status: number) => (): unknown => new ProviderError('VENDOR', { retryable: false, status });
    const mk = (id: string, err: () => unknown): LLMProvider => ({ id, async *chat() { throw err(); } });
    const a = await rig({ claude: mk('claude', e(401)) });
    await expect(a.caller.run('u')).rejects.toMatchObject({ code: 'judge_error' });
    expect(a.marks).toEqual([{ kind: 'api_off', status: 401 }]);
    const b = await rig({ claude: mk('claude', e(429)) });
    await expect(b.caller.run('u')).rejects.toBeInstanceOf(JudgeError);
    expect(b.marks).toEqual([{ kind: 'api_busy', status: 429 }]);
    const c = await rig({ refuse: 'company' });
    await expect(c.caller.run('u')).rejects.toMatchObject({ code: 'judge_budget' });
    expect(c.marks).toEqual([{ kind: 'budget', scope: 'company', actor: { kind: 'head', dept: 'hq' }, dept: 'hq' }]);
    const d = await rig({ refuse: 'task' });
    await expect(d.caller.run('u')).rejects.toMatchObject({ code: 'judge_budget' });
    expect(d.marks).toEqual([]);
  });

  it('a 400 from a task-less judge call sets no mark', async () => {
    const r = await rig({ claude: { id: 'claude', async *chat() { throw new ProviderError('x', { retryable: false, status: 400 }); } } });
    await expect(r.caller.run('u')).rejects.toBeInstanceOf(JudgeError);
    expect(r.marks).toEqual([]);
  });

  it('after a mark the next judge call is held (fail fast)', async () => {
    const r = await rig();
    r.gate.mark({ kind: 'api_off', status: 403 });
    await expect(r.caller.run('u')).rejects.toBeInstanceOf(JudgeError);
    expect(r.calls).toEqual([]);
  });
});

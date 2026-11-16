import { describe, expect, it } from 'vitest';
import { callProvider, type CallDeps } from './call.js';
import { MID_STREAM_DIAG, ProviderError } from '../../providers/types.js';
import type { ChatRequest, LLMProvider } from '../../providers/types.js';

// R8 PV-C04: a fallback-route call that fails AFTER message_start was billed for its input by the API, so it settles at the reservation estimate, not $0.
const req = (route?: 'fallback'): ChatRequest => ({ model: 'claude-sonnet-5-5', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }], tools: [], maxTokens: 1000, ...(route ? { route } : {}) });
function rig() {
  const settled: [string, number][] = [];
  const released: string[] = [];
  const audits: Record<string, unknown>[] = [];
  const deps = {
    budget: { reserve: async () => ({ ok: true, reservationId: 'r1' }), settle: async (id: string, usd: number) => void settled.push([id, usd]), release: async (id: string) => void released.push(id), costOf: () => 0.0123 },
    halt: { track: () => () => undefined },
    audit: async (r: Record<string, unknown>) => void audits.push(r),
  } as unknown as CallDeps;
  return { deps, settled, released, audits };
}
const failing = (err: unknown): LLMProvider => ({ id: 'claude', async *chat() { throw err; } });
const midStream = () => new ProviderError('x', { retryable: false, diag: MID_STREAM_DIAG });

describe('callProvider settle on failure (R8)', () => {
  it('fallback route + failure after message_start: settled at the estimate, costUsd and the audit row carry it', async () => {
    const r = rig();
    const o = await callProvider(req('fallback'), failing(midStream()), { kind: 'head', dept: 'hq' }, null, r.deps);
    expect(r.settled).toEqual([['r1', 0.0123]]);
    expect(r.released).toEqual([]);
    expect(o).toMatchObject({ kind: 'done', costUsd: 0.0123 });
    expect(r.audits.at(-1)).toMatchObject({ action: 'llm.call', provider: 'claude', costUsd: 0.0123, outcome: 'error' });
  });
  it('fallback route + a failure before the stream started (401, 400, 429): released at $0', async () => {
    for (const status of [400, 401, 429]) {
      const r = rig();
      await callProvider(req('fallback'), failing(new ProviderError('x', { retryable: false, status })), { kind: 'head', dept: 'hq' }, null, r.deps);
      expect(r.released).toEqual(['r1']);
      expect(r.settled).toEqual([]);
    }
  });
  it('without the route flag (the VPS path) a mid-stream failure is released as before', async () => {
    const r = rig();
    await callProvider(req(), failing(midStream()), { kind: 'head', dept: 'hq' }, null, r.deps);
    expect(r.released).toEqual(['r1']);
    expect(r.settled).toEqual([]);
  });
  it('an aborted call is never settled at the estimate', async () => {
    const r = rig();
    const p: LLMProvider = { id: 'claude', async *chat(_q, sig) { yield { type: 'stop', reason: 'aborted' }; void sig; } };
    await callProvider(req('fallback'), p, { kind: 'head', dept: 'hq' }, null, r.deps);
    expect(r.settled).toEqual([]);
  });
});

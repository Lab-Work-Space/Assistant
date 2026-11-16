import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { MID_STREAM_DIAG, ProviderError } from '../types.js';
import type { ChatChunk, ChatRequest } from '../types.js';
import { createClaudeProvider } from './index.js';
import { buildParams } from './request.js';

type Ev = Record<string, unknown>;
const streamOf = (events: Ev[], err?: unknown): AsyncIterable<Ev> => ({ async *[Symbol.asyncIterator]() { for (const e of events) yield e; if (err) throw err; } });
function stub(events: Ev[], err?: unknown) {
  const std = vi.fn((_p: unknown, _o?: unknown) => streamOf(events, err));
  const beta = vi.fn((_p: unknown, _o?: unknown) => streamOf(events, err));
  return { std, beta, client: { messages: { stream: std }, beta: { messages: { stream: beta } } } };
}
const sonnet: ChatRequest = { model: 'claude-sonnet-5-5', system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], maxTokens: 10 };
const start: Ev = { type: 'message_start', message: { usage: { input_tokens: 10 } } };
const done: Ev[] = [start, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }];
const drain = async (p: ReturnType<typeof createClaudeProvider>, req: ChatRequest): Promise<ChatChunk[]> => { const o: ChatChunk[] = []; for await (const c of p.chat(req, new AbortController().signal)) o.push(c); return o; };

// R8 PV-C04: on the fallback route the server-side fallback beta is not sent, so a refusal ends as "Declined" (like local) and the meter prices what it reserved.
describe('claude provider on the fallback route (PV-C04)', () => {
  it('the VPS request is unchanged without the flag: Sonnet carries betas and fallbacks and uses the beta client', async () => {
    const s = stub(done);
    await drain(createClaudeProvider('k', { client: s.client as never }), sonnet);
    expect(s.beta).toHaveBeenCalledTimes(1);
    expect(s.std).not.toHaveBeenCalled();
    expect(s.beta.mock.calls[0]![0]).toMatchObject({ betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
    expect(buildParams(sonnet)).toMatchObject({ betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  });

  it('with route fallback: no betas, no fallbacks, the standard client', async () => {
    const s = stub(done);
    await drain(createClaudeProvider('k', { client: s.client as never }), { ...sonnet, route: 'fallback' });
    expect(s.std).toHaveBeenCalledTimes(1);
    expect(s.beta).not.toHaveBeenCalled();
    const params = s.std.mock.calls[0]![0] as Record<string, unknown>;
    expect(params).not.toHaveProperty('betas');
    expect(params).not.toHaveProperty('fallbacks');
    expect(params.model).toBe('claude-sonnet-5-5');
    const built = buildParams({ ...sonnet, route: 'fallback' });
    expect(built).not.toHaveProperty('betas');
    expect(built).not.toHaveProperty('fallbacks');
  });

  it('a failure after message_start is tagged with the fixed diag; a failure before it is not', async () => {
    const err = new Anthropic.APIError(undefined, { type: 'error' }, 'overloaded', new Headers());
    const after = await drain(createClaudeProvider('k', { client: stub([start], err).client as never }), { ...sonnet, route: 'fallback' }).catch((e: unknown) => e);
    expect(after).toBeInstanceOf(ProviderError);
    expect((after as ProviderError).diag).toBe(MID_STREAM_DIAG);
    const before = await drain(createClaudeProvider('k', { client: stub([], new Anthropic.APIError(401, { type: 'error' }, 'no', new Headers())).client as never }), { ...sonnet, route: 'fallback' }).catch((e: unknown) => e);
    expect((before as ProviderError).diag).toBeUndefined();
    expect((before as ProviderError).status).toBe(401);
  });

  // Gate 2 G2-PV-01: unparseable tool input is thrown after the whole message was streamed (and billed), before the usage chunk.
  it('unparseable tool input after a billed stream carries the fixed diag (the meter settles it at the estimate, never $0)', async () => {
    const events: Ev[] = [
      start,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'respond' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"text": ' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
    ];
    const e = await drain(createClaudeProvider('k', { client: stub(events).client as never }), { ...sonnet, route: 'fallback' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect((e as ProviderError).message).toBe('model produced unparseable tool input');
    expect((e as ProviderError).diag).toBe(MID_STREAM_DIAG);
  });
});

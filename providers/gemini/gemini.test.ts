import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeGemini, type GeminiAttempt } from '../../tests/fakes/gemini.js';
import { ProviderError, type ChatChunk, type ChatRequest } from '../types.js';
import { createGeminiProvider, GeminiHttpError } from './index.js';

const REQ: ChatRequest = { model: 'gemini-3-flash', system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], maxTokens: 100 };
const ok: GeminiAttempt = { chunks: [{ text: 'hello' }, { finishReason: 'STOP', usage: { promptTokens: 10, candidatesTokens: 3 } }] };
const http = (s: number) => ({ reject: new GeminiHttpError(s) });

const make = (script: GeminiAttempt[], o: Partial<Parameters<typeof createGeminiProvider>[0]> = {}) => {
  const client = fakeGemini(script);
  const sleeps: number[] = [];
  const provider = createGeminiProvider({ client, random: () => 0.5, sleep: async (ms) => void sleeps.push(ms), ...o });
  return { client, provider, sleeps };
};
async function run(p: ReturnType<typeof make>['provider'], req: ChatRequest = REQ, signal = new AbortController().signal): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of p.chat(req, signal)) out.push(c);
  return out;
}
const fail = async (p: ReturnType<typeof make>['provider'], req: ChatRequest = REQ): Promise<ProviderError> => {
  try {
    await run(p, req);
  } catch (e) {
    return e as ProviderError;
  }
  throw new Error('expected failure');
};

describe('gemini provider', () => {
  it('429 then success yields text and stop end_turn', async () => {
    const { provider, client, sleeps } = make([http(429), ok]);
    const out = await run(provider);
    expect(out.filter((c) => c.type === 'text')).toEqual([{ type: 'text', text: 'hello' }]);
    expect(out.at(-1)).toEqual({ type: 'stop', reason: 'end_turn' });
    expect(client.calls).toBe(2);
    expect(sleeps).toHaveLength(1);
  });

  it('backs off 500ms * 2^n with jitter', async () => {
    const { provider, sleeps } = make([http(503), http(503), http(503), ok], { random: () => 0 });
    await run(provider);
    expect(sleeps).toEqual([500, 1000, 2000]);
    const j = make([http(503), ok], { random: () => 1 });
    await run(j.provider);
    expect(j.sleeps[0]).toBeGreaterThan(500);
    expect(j.sleeps[0]).toBeLessThanOrEqual(750);
  });

  it('503 x4 -> ProviderError retryable status 503 after 3 retries', async () => {
    const { provider, client } = make([http(503)]);
    const e = await fail(provider);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e).toMatchObject({ retryable: true, status: 503 });
    expect(client.calls).toBe(4);
  });

  it('network error (no status) is retried', async () => {
    const { provider, client } = make([{ reject: new TypeError('fetch failed') }, ok]);
    await run(provider);
    expect(client.calls).toBe(2);
  });

  it('400 retried exactly once then ProviderError retryable false status 400', async () => {
    const { provider, client } = make([http(400)]);
    const e = await fail(provider);
    expect(e).toMatchObject({ retryable: false, status: 400 });
    expect(client.calls).toBe(2);
  });

  it.each([401, 403, 404])('%i not retried', async (s) => {
    const { provider, client } = make([http(s)]);
    const e = await fail(provider);
    expect(e).toMatchObject({ retryable: false, status: s });
    expect(client.calls).toBe(1);
  });

  it('failure after first text chunk -> ProviderError retryable, no retry', async () => {
    const { provider, client } = make([{ chunks: [{ text: 'par' }], thenThrow: new GeminiHttpError(503) }, ok]);
    const out: ChatChunk[] = [];
    let err: unknown;
    try {
      for await (const c of provider.chat(REQ, new AbortController().signal)) out.push(c);
    } catch (e) {
      err = e;
    }
    expect(out).toEqual([{ type: 'text', text: 'par' }]);
    expect(err).toMatchObject({ name: 'ProviderError', retryable: true, status: 503 });
    expect(client.calls).toBe(1);
  });

  it('functionCall -> tool_use chunk, ids unique across calls, stop tool_use', async () => {
    const call = { chunks: [{ functionCalls: [{ name: 'a', args: { x: 1 } }, { name: 'b', args: {} }] }, { finishReason: 'STOP' }] };
    const { provider } = make([call], { random: () => 0.1 });
    const one = await run(provider);
    const two = await run(provider);
    const uses = [...one, ...two].filter((c): c is Extract<ChatChunk, { type: 'tool_use' }> => c.type === 'tool_use');
    expect(uses).toHaveLength(4);
    expect(uses[0]).toMatchObject({ name: 'a', input: { x: 1 } });
    expect(new Set(uses.map((u) => u.id)).size).toBe(4);
    for (const u of uses) expect(u.id).toMatch(/^gemini_tu_\d+_/);
    expect(one.at(-1)).toEqual({ type: 'stop', reason: 'tool_use' });
  });

  it('signed functionCall and thought parts become raw chunks; raw functionCall.id equals the tool_use id', async () => {
    const signed = { functionCall: { id: 'g-own-id', name: 'a', args: {} }, thoughtSignature: 'SIG' };
    const thought = { thought: true, text: 'secret reasoning', thoughtSignature: 'T' };
    const { provider } = make([{ chunks: [{ rawParts: [thought], functionCalls: [{ name: 'a', args: {}, part: signed }, { name: 'b', args: {}, part: { functionCall: { name: 'b', args: {} } } }] }, { finishReason: 'STOP' }] }]);
    const out = await run(provider);
    expect(out.filter((c) => c.type === 'text')).toEqual([]);
    const raws = out.filter((c): c is Extract<ChatChunk, { type: 'raw' }> => c.type === 'raw');
    expect(raws).toHaveLength(2); // thought + signed call; the unsigned call needs no raw block
    expect(raws[0]).toEqual({ type: 'raw', provider: 'gemini', block: thought });
    const uses = out.filter((c): c is Extract<ChatChunk, { type: 'tool_use' }> => c.type === 'tool_use');
    expect(raws[1]!.block).toEqual({ functionCall: { id: uses[0]!.id, name: 'a', args: {} }, thoughtSignature: 'SIG' });
    expect(signed.functionCall.id).toBe('g-own-id'); // input not mutated
  });

  it('usage mapping subtracts cached tokens and bills thoughts as output', async () => {
    const { provider } = make([{ chunks: [{ text: 'x', usage: { promptTokens: 100, candidatesTokens: 7, cachedTokens: 40, thoughtsTokens: 5 } }, { finishReason: 'STOP' }] }]);
    const out = await run(provider);
    expect(out.find((c) => c.type === 'usage')).toEqual({ type: 'usage', inputTokens: 60, outputTokens: 12, cacheReadTokens: 40, cacheWriteTokens: 0 });
  });

  it('usage with thoughtsTokenCount only is charged as output', async () => {
    const { provider } = make([{ chunks: [{ usage: { promptTokens: 1, candidatesTokens: 0, thoughtsTokens: 30 } }, { finishReason: 'STOP' }] }]);
    expect((await run(provider)).find((c) => c.type === 'usage')).toMatchObject({ inputTokens: 1, outputTokens: 30 });
  });

  it('thought part is not emitted as text', async () => {
    const { provider } = make([{ chunks: [{ rawParts: [{ thought: true, text: 'inner' }], text: 'answer' }, { finishReason: 'STOP' }] }]);
    const out = await run(provider);
    expect(JSON.stringify(out.filter((c) => c.type === 'text'))).not.toContain('inner');
  });

  it('SAFETY finish and blocked prompt -> stop refusal', async () => {
    const a = await run(make([{ chunks: [{ finishReason: 'SAFETY' }] }]).provider);
    expect(a.at(-1)).toEqual({ type: 'stop', reason: 'refusal' });
    const b = await run(make([{ chunks: [{ blockedReason: 'PROHIBITED_CONTENT' }] }]).provider);
    expect(b.at(-1)).toEqual({ type: 'stop', reason: 'refusal' });
  });

  it('request has only functionDeclarations and the converted contents', async () => {
    const { provider, client } = make([ok]);
    await run(provider, { ...REQ, tools: [{ name: 't', description: 'd', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } }] });
    const r = client.requests[0]!;
    expect(Object.keys(r).sort()).toEqual(['contents', 'functionDeclarations', 'maxOutputTokens', 'model', 'systemInstruction']);
    expect(r.functionDeclarations).toHaveLength(1);
  });

  it('error message and cause never contain the API key', async () => {
    const KEY = 'AIzaSySECRETKEY123456789';
    for (const reject of [new GeminiHttpError(500, `bad ?key=${KEY}`), new TypeError(`fetch failed https://x/?key=${KEY}`, { cause: new Error(KEY) })]) {
      const e = await fail(make([{ reject }], { maxRetries: 0 }).provider);
      expect(JSON.stringify([e.message, e.stack, String((e as any).cause), (e as any).cause?.message])).not.toContain(KEY);
    }
  });

  it('400 retry reserves twice (beforeRetry called once)', async () => {
    const { provider } = make([http(400)]);
    const beforeRetry = vi.fn(async () => undefined);
    await fail(provider, { ...REQ, beforeRetry });
    expect(beforeRetry).toHaveBeenCalledTimes(1);
  });

  it('beforeRetry runs before every retry and is awaited before the request', async () => {
    const { provider, client } = make([http(503), http(503), ok]);
    const seen: number[] = [];
    await run(provider, { ...REQ, beforeRetry: async () => void seen.push(client.calls) });
    expect(seen).toEqual([1, 2]);
  });

  it('beforeRetry throwing stops the retry: no further provider call', async () => {
    const { provider, client } = make([http(503)]);
    const e = await fail(provider, { ...REQ, beforeRetry: async () => { throw new Error('budget gone'); } });
    expect(client.calls).toBe(1);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e).toMatchObject({ retryable: false, status: 503 });
  });

  it('already-aborted signal makes no request', async () => {
    const ac = new AbortController();
    ac.abort();
    const { provider, client } = make([ok]);
    expect(await run(provider, REQ, ac.signal)).toEqual([{ type: 'stop', reason: 'aborted' }]);
    expect(client.calls).toBe(0);
  });
});

describe('abort (fake clock)', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('abort mid-stream resolves usage + stop aborted within 2000 ms, even if the client ignores the signal', async () => {
    const { provider } = make([{ chunks: [{ text: 'a', usage: { promptTokens: 5, candidatesTokens: 1 } }], hang: true }]);
    const ac = new AbortController();
    const out: ChatChunk[] = [];
    const done = (async () => { for await (const c of provider.chat(REQ, ac.signal)) out.push(c); })();
    await vi.advanceTimersByTimeAsync(100);
    ac.abort();
    let finished = false;
    void done.then(() => (finished = true));
    await vi.advanceTimersByTimeAsync(2000);
    expect(finished).toBe(true);
    expect(out.map((c) => c.type)).toEqual(['text', 'usage', 'stop']);
    expect(out.at(-1)).toEqual({ type: 'stop', reason: 'aborted' });
  });

  it('abort during backoff sleep ends within 2000 ms and makes no further request', async () => {
    const client = fakeGemini([http(503)]);
    const provider = createGeminiProvider({ client, random: () => 0 }); // default abortable sleep on the fake clock
    const ac = new AbortController();
    const out: ChatChunk[] = [];
    const done = (async () => { for await (const c of provider.chat(REQ, ac.signal)) out.push(c); })();
    await vi.advanceTimersByTimeAsync(100); // inside the 500 ms backoff
    expect(client.calls).toBe(1);
    ac.abort();
    let finished = false;
    void done.then(() => (finished = true));
    await vi.advanceTimersByTimeAsync(2000);
    expect(finished).toBe(true);
    expect(out).toEqual([{ type: 'stop', reason: 'aborted' }]);
    expect(client.calls).toBe(1);
  });

  it('abort during beforeRetry makes no further request', async () => {
    const client = fakeGemini([http(503)]);
    const provider = createGeminiProvider({ client, random: () => 0, sleep: async () => undefined });
    const ac = new AbortController();
    const out: ChatChunk[] = [];
    for await (const c of provider.chat({ ...REQ, beforeRetry: async () => ac.abort() }, ac.signal)) out.push(c);
    expect(out).toEqual([{ type: 'stop', reason: 'aborted' }]);
    expect(client.calls).toBe(1);
  });
});

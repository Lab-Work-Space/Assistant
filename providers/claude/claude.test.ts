import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { ProviderError } from '../types.js';
import type { ChatChunk, ChatRequest } from '../types.js';
import { createClaudeProvider } from './index.js';

type Ev = Record<string, unknown>;
function streamOf(events: Ev[], err?: unknown): AsyncIterable<Ev> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
      if (err) throw err;
    },
  };
}
function stub(events: Ev[], err?: unknown) {
  const std = vi.fn((_p: unknown, _o?: unknown) => streamOf(events, err));
  const beta = vi.fn((_p: unknown, _o?: unknown) => streamOf(events, err));
  return { std, beta, client: { messages: { stream: std }, beta: { messages: { stream: beta } } } };
}
const base: ChatRequest = {
  model: 'claude-haiku-5-5',
  system: 'sys',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [{ name: 'echo', description: 'd', inputSchema: { type: 'object' } }],
  maxTokens: 100,
  effort: 'low',
};
async function run(events: Ev[], req = base, signal = new AbortController().signal, err?: unknown) {
  const s = stub(events, err);
  const p = createClaudeProvider('k', { client: s.client as never });
  const out: ChatChunk[] = [];
  for await (const c of p.chat(req, signal)) out.push(c);
  return { out, ...s };
}
async function stubRun(events: Ev[]) {
  const s = stub(events);
  return createClaudeProvider('k', { client: s.client as never }).chat(base, new AbortController().signal)[Symbol.asyncIterator]();
}
const start = (usage: Ev = { input_tokens: 10, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 }): Ev => ({
  type: 'message_start',
  message: { usage },
});
const delta = (stop: string, out = 4): Ev => ({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: out } });

describe('claude provider', () => {
  it('maps text, tool_use, usage and stop', async () => {
    const { out } = await run([
      start(),
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'echo', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"a":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '1}' } },
      { type: 'content_block_stop', index: 1 },
      delta('tool_use'),
      { type: 'message_stop' },
    ]);
    expect(out).toEqual([
      { type: 'text', text: 'ok' },
      { type: 'tool_use', id: 'tu1', name: 'echo', input: { a: 1 } },
      { type: 'usage', inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2 },
      { type: 'stop', reason: 'tool_use' },
    ]);
  });

  it('maps tool_use content block with no input to empty object', async () => {
    const { out } = await run([
      start({ input_tokens: 1 }),
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'echo', input: {} } },
      { type: 'content_block_stop', index: 0 },
      delta('tool_use'),
    ]);
    expect(out[0]).toEqual({ type: 'tool_use', id: 't', name: 'echo', input: {} });
    expect(out[1]).toMatchObject({ type: 'usage', cacheReadTokens: 0, cacheWriteTokens: 0 });
  });

  it('emits thinking and redacted_thinking as raw chunks in order', async () => {
    const { out } = await run([
      start(),
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'blob' } },
      { type: 'content_block_stop', index: 1 },
      delta('end_turn'),
    ]);
    expect(out[0]).toEqual({ type: 'raw', provider: 'claude', block: { type: 'thinking', thinking: 'hm', signature: 'sig' } });
    expect(out[1]).toEqual({ type: 'raw', provider: 'claude', block: { type: 'redacted_thinking', data: 'blob' } });
  });

  it('maps refusal and max_tokens stop reasons', async () => {
    expect((await run([start(), delta('refusal')])).out.at(-1)).toEqual({ type: 'stop', reason: 'refusal' });
    expect((await run([start(), delta('max_tokens')])).out.at(-1)).toEqual({ type: 'stop', reason: 'max_tokens' });
  });

  it('sends cache_control on system, no sampling params, effort, eager tools', async () => {
    const { std, beta } = await run([start(), delta('end_turn')]);
    expect(beta).not.toHaveBeenCalled();
    const [params, opts] = std.mock.calls[0] as unknown as [Record<string, unknown>, { signal: AbortSignal }];
    expect(params.system).toEqual([{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }]);
    expect(params.output_config).toEqual({ effort: 'low' });
    expect(params.max_tokens).toBe(100);
    for (const k of ['temperature', 'top_p', 'top_k', 'thinking', 'betas', 'fallbacks']) expect(params).not.toHaveProperty(k);
    expect(params.tools).toEqual([{ name: 'echo', description: 'd', input_schema: { type: 'object' }, eager_input_streaming: true }]);
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses beta endpoint with server-side fallback for sonnet only', async () => {
    const { std, beta } = await run([start(), delta('end_turn')], { ...base, model: 'claude-sonnet-5-5' });
    expect(std).not.toHaveBeenCalled();
    const [params] = beta.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect(params.fallbacks).toBe('default');
  });

  it('replays claude raw blocks in order and drops other providers raw', async () => {
    const thinking = { type: 'thinking', thinking: 't', signature: 's' };
    const { std } = await run([start(), delta('end_turn')], {
      ...base,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        {
          role: 'assistant',
          content: [
            { type: 'raw', provider: 'claude', block: thinking },
            { type: 'raw', provider: 'other', block: { x: 1 } },
            { type: 'tool_use', id: 'tu', name: 'echo', input: { a: 1 } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu', content: 'r', isError: true }] },
      ],
    });
    const params = std.mock.calls[0]![0] as unknown as { messages: { role: string; content: unknown[] }[] };
    expect(params.messages[1]!.content).toEqual([thinking, { type: 'tool_use', id: 'tu', name: 'echo', input: { a: 1 } }]);
    expect(params.messages[2]!.content).toEqual([{ type: 'tool_result', tool_use_id: 'tu', content: 'r', is_error: true }]);
  });

  it('abort signal yields stop aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const { out } = await run([start(), delta('end_turn')], base, ac.signal, new Anthropic.APIUserAbortError());
    expect(out).toEqual([{ type: 'stop', reason: 'aborted' }]);
  });

  it('mid-stream user abort error yields stop aborted', async () => {
    const { out } = await run([start()], base, new AbortController().signal, new Anthropic.APIUserAbortError());
    expect(out).toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 0, cacheReadTokens: 3, cacheWriteTokens: 2 },
      { type: 'stop', reason: 'aborted' },
    ]);
  });

  it('truncated tool input with max_tokens yields no tool_use and stop max_tokens', async () => {
    const { out } = await run([
      start(),
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'echo', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a": [1,' } },
      { type: 'content_block_stop', index: 0 },
      delta('max_tokens'),
    ]);
    expect(out.map((c) => c.type)).toEqual(['usage', 'stop']);
    expect(out.at(-1)).toEqual({ type: 'stop', reason: 'max_tokens' });
  });

  it('unparseable tool input with stop tool_use throws ProviderError', async () => {
    const it = (await stubRun([
      start(),
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't', name: 'echo', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"a":' } },
      { type: 'content_block_stop', index: 0 },
      delta('tool_use'),
    ])).next();
    await expect(it).rejects.toBeInstanceOf(ProviderError);
  });

  it('mid-stream abort emits accumulated usage before stop aborted', async () => {
    const ac = new AbortController();
    const events: Ev[] = [start(), { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }];
    const s = stub([]);
    s.std.mockImplementation(() => ({
      async *[Symbol.asyncIterator]() {
        for (const e of events) yield e;
        ac.abort();
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'late' } };
      },
    }));
    const p = createClaudeProvider('k', { client: s.client as never });
    const out: ChatChunk[] = [];
    for await (const c of p.chat(base, ac.signal)) out.push(c);
    expect(out).toEqual([
      { type: 'usage', inputTokens: 10, outputTokens: 0, cacheReadTokens: 3, cacheWriteTokens: 2 },
      { type: 'stop', reason: 'aborted' },
    ]);
  });

  it('builds the client with maxRetries 3 and maps a final APIError to ProviderError', async () => {
    const ctor = vi.fn();
    const err = new Anthropic.APIError(429, { type: 'error' }, 'rate', new Headers());
    const s = stub([], err);
    const p = createClaudeProvider('k', {
      client: s.client as never,
      onClientOptions: ctor,
    });
    expect(ctor).toHaveBeenCalledWith(expect.objectContaining({ maxRetries: 3, apiKey: 'k' }));
    const it = p.chat(base, new AbortController().signal)[Symbol.asyncIterator]();
    await expect(it.next()).rejects.toMatchObject({ name: 'ProviderError', status: 429, retryable: true });
    const bad = new Anthropic.APIError(400, { type: 'error' }, 'bad', new Headers());
    const p2 = createClaudeProvider('k', { client: stub([], bad).client as never });
    const err2 = await p2.chat(base, new AbortController().signal)[Symbol.asyncIterator]().next().catch((e: unknown) => e);
    expect(err2).toBeInstanceOf(ProviderError);
    expect(err2).toMatchObject({ status: 400, retryable: false });
  });
});

describe('claude provider streamToolInput (STREAM-1, S12/S18)', () => {
  const events = (): Ev[] => [
    start(),
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'THINKING-MARKER' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'TEXT-MARKER' } },
    { type: 'content_block_stop', index: 1 },
    { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'tu1', name: 'respond', input: {} } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"body":"he' } },
    { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'llo"}' } },
    { type: 'content_block_stop', index: 2 },
    delta('tool_use'),
  ];

  it('absent streamToolInput: the chunk sequence is identical to before (no delta, no reset chunks)', async () => {
    const { out } = await run(events());
    expect(out.map((c) => c.type)).toEqual(['raw', 'text', 'tool_use', 'usage', 'stop']);
  });

  it('present: tool_use input fragments become tool_input_delta chunks; thinking/signature/text deltas never do; blocks are unchanged', async () => {
    const plain = (await run(events())).out;
    const { out } = await run(events(), { ...base, streamToolInput: true });
    const deltas = out.filter((c) => c.type === 'tool_input_delta');
    expect(deltas).toEqual([
      { type: 'tool_input_delta', index: 2, name: 'respond', partialJson: '{"body":"he' },
      { type: 'tool_input_delta', index: 2, name: 'respond', partialJson: 'llo"}' },
    ]);
    expect(JSON.stringify(out.filter((c) => c.type === 'tool_input_delta'))).not.toMatch(/THINKING-MARKER|TEXT-MARKER|SIG/);
    expect(out.filter((c) => c.type !== 'tool_input_delta' && c.type !== 'stream_reset')).toEqual(plain);
  });

  it('a new message_start (server fallback / restart) yields stream_reset before its fragments', async () => {
    const ev = [start(), { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'respond', input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"body":"old' } }, start(), { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'b', name: 'respond', input: {} } }, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"body":"new"}' } }, { type: 'content_block_stop', index: 0 }, delta('tool_use')];
    const { out } = await run(ev, { ...base, streamToolInput: true });
    const seq = out.filter((c) => c.type === 'tool_input_delta' || c.type === 'stream_reset').map((c) => (c.type === 'stream_reset' ? 'reset' : (c as { partialJson: string }).partialJson));
    expect(seq).toEqual(['reset', '{"body":"old', 'reset', '{"body":"new"}']);
  });
});

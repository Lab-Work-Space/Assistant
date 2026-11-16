import { describe, expect, it } from 'vitest';
import { FakeProvider, ProviderRegistry } from '../../providers/index.js';
import type { ChatChunk, ChatRequest, LLMProvider } from '../../providers/types.js';
import type { StreamDelta } from '../call/call.js';
import { runAgent } from './loop.js';
import { respond, route, setup } from './loop-fixture.js';
import type { ReplyStreamSink } from '../stream/stream.js';
import { CTO, humanMsg } from '../test-helpers.js';

/** STREAM-1 in the loop: typing once, a segment per provider call, streamToolInput only with a sink and a respond tool, deltas forwarded and never blocks. */

function recorder() {
  const log: string[] = [];
  const deltas: StreamDelta[] = [];
  const sink: ReplyStreamSink = {
    typing: () => void log.push('typing'),
    segment: (tools) => void log.push(`segment:${[...tools].includes('respond') ? 'respond' : 'no-respond'}`),
    delta: (c) => void deltas.push(c),
  };
  return { sink, log, deltas };
}

/** Streams the respond body as fragments when asked to; records every request. */
class StreamingFake implements LLMProvider {
  readonly id = 'claude';
  readonly calls: ChatRequest[] = [];
  private n = 0;
  constructor(private readonly turns: { tool: string; input: unknown }[]) {}
  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    this.calls.push(req);
    const t = this.turns[this.n++]!;
    if (req.streamToolInput) {
      yield { type: 'stream_reset' };
      const json = JSON.stringify(t.input);
      yield { type: 'tool_input_delta', index: 0, name: t.tool, partialJson: json.slice(0, 10) };
      yield { type: 'tool_input_delta', index: 0, name: t.tool, partialJson: json.slice(10) };
    }
    yield { type: 'tool_use', id: `tu_${this.n}`, name: t.tool, input: t.input };
    yield { type: 'usage', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    yield { type: 'stop', reason: 'tool_use' };
  }
}
async function withProvider(p: LLMProvider) {
  const s = await setup();
  const reg = new ProviderRegistry();
  reg.register(p);
  s.deps.providers = reg;
  return s;
}

describe('runAgent with a stream sink', () => {
  it('typing once before the first call, a segment before every provider call, streamToolInput set, deltas forwarded; the outcome equals the run without a sink', async () => {
    const p = new StreamingFake([{ tool: 'respond', input: { type: 'chat', body: 'Hello world' } }]);
    const s = await withProvider(p);
    const r = recorder();
    const withSink = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [], stream: r.sink }, s.deps);
    expect(r.log).toEqual(['typing', 'segment:respond']);
    expect(p.calls[0]!.streamToolInput).toBe(true);
    expect(r.deltas.map((d) => d.type)).toEqual(['stream_reset', 'tool_input_delta', 'tool_input_delta']);

    const p2 = new StreamingFake([{ tool: 'respond', input: { type: 'chat', body: 'Hello world' } }]);
    const s2 = await withProvider(p2);
    const plain = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s2.deps);
    expect(p2.calls[0]).not.toHaveProperty('streamToolInput'); // absent without a sink: the request is exactly what it was
    expect(withSink.payload.body).toBe(plain.payload.body);
    expect(withSink.turns).toBe(plain.turns);
  });

  it('a tool round then respond: two provider calls = two segments, typing still once', async () => {
    const s = await setup();
    const p = new FakeProvider([{ toolUses: [{ name: 'get_task', input: { id: 'none' } }] }, { toolUses: [respond('done')] }], 'claude');
    const reg = new ProviderRegistry();
    reg.register(p);
    s.deps.providers = reg;
    const r = recorder();
    const out = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [], stream: r.sink }, s.deps);
    expect(out.payload.body).toBe('done');
    expect(r.log).toEqual(['typing', 'segment:respond', 'segment:respond']);
  });

  it('a sink that throws on delta does not change the run', async () => {
    const p = new StreamingFake([{ tool: 'respond', input: { type: 'chat', body: 'ok body' } }]);
    const s = await withProvider(p);
    const sink: ReplyStreamSink = { typing: () => undefined, segment: () => undefined, delta: () => { throw new Error('sink'); } };
    const out = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [], stream: sink }, s.deps);
    expect(out.payload.body).toBe('ok body');
  });

  it('a provider that cannot stream tool input (Gemini) still gets typing and segments, and the answer is unchanged', async () => {
    const s = await setup({ script: [{ toolUses: [respond('praw answer')] }] });
    const r = recorder();
    const out = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [], stream: r.sink }, s.deps);
    expect(out.payload.body).toBe('praw answer');
    expect(r.log[0]).toBe('typing');
    expect(r.deltas).toEqual([]);
  });
});

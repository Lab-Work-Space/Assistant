import { describe, expect, it } from 'vitest';
import { FakeProvider } from './fake.js';
import type { ChatChunk, ChatRequest } from './types.js';

const req: ChatRequest = { model: 'm', system: 's', messages: [], tools: [], maxTokens: 10 };
async function collect(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

describe('FakeProvider', () => {
  it('yields scripted text, tool_use, usage, stop', async () => {
    const p = new FakeProvider([
      { text: 'hi', toolUses: [{ name: 'echo', input: { a: 1 } }], usage: { inputTokens: 5, outputTokens: 7 } },
      { text: 'done' },
    ]);
    const first = await collect(p.chat(req, new AbortController().signal));
    expect(first[0]).toEqual({ type: 'text', text: 'hi' });
    expect(first[1]).toMatchObject({ type: 'tool_use', name: 'echo', input: { a: 1 } });
    expect(first[2]).toEqual({ type: 'usage', inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(first[3]).toEqual({ type: 'stop', reason: 'tool_use' });
    const second = await collect(p.chat(req, new AbortController().signal));
    expect(second.at(-1)).toEqual({ type: 'stop', reason: 'end_turn' });
    expect(p.calls).toHaveLength(2);
    expect(p.calls[0]).toBe(req);
  });

  it('yields stop aborted when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const chunks = await collect(new FakeProvider([{ text: 'x' }]).chat(req, ac.signal));
    expect(chunks).toEqual([{ type: 'stop', reason: 'aborted' }]);
  });

  it('throws when the script is exhausted', async () => {
    await expect(collect(new FakeProvider([]).chat(req, new AbortController().signal))).rejects.toThrow(/script/);
  });
});

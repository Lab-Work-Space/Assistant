import { describe, expect, it } from 'vitest';
import { callProvider, type CallDeps, type StreamDelta } from './call.js';
import type { ChatChunk, ChatRequest, LLMProvider } from '../../providers/types.js';

/** STREAM-1 (S12): delta and reset chunks have their own branches; they are never blocks and never a stop reason. */

const req: ChatRequest = { model: 'claude-haiku-5-5', system: 's', messages: [], tools: [], maxTokens: 10, streamToolInput: true };
const deps: CallDeps = {
  budget: { reserve: async () => ({ ok: true, reservationId: 'r1' }), settle: async () => undefined, release: async () => undefined, costOf: () => 0 } as unknown as CallDeps['budget'],
  halt: { track: () => () => undefined },
  audit: async () => undefined,
};
const actor = { kind: 'head', dept: 'hq' } as never;
const prov = (chunks: ChatChunk[]): LLMProvider => ({ id: 'claude', async *chat() { yield* chunks; } });
const usage: ChatChunk = { type: 'usage', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe('callProvider streaming branches', () => {
  it('forwards deltas and resets to onDelta only; blocks and reason are unchanged', async () => {
    const seen: StreamDelta[] = [];
    const chunks: ChatChunk[] = [
      { type: 'stream_reset' },
      { type: 'tool_input_delta', index: 0, name: 'respond', partialJson: '{"body":"a' },
      { type: 'tool_use', id: 't', name: 'respond', input: { body: 'a' } },
      usage,
      { type: 'stop', reason: 'tool_use' },
    ];
    const o = await callProvider(req, prov(chunks), actor, null, deps, undefined, undefined, undefined, (c) => seen.push(c));
    expect(seen).toEqual([chunks[0], chunks[1]]);
    expect(o).toMatchObject({ kind: 'done', reason: 'tool_use', blocks: [{ type: 'tool_use', name: 'respond' }] });
    if (o.kind === 'done') expect(o.blocks).toHaveLength(1);
  });

  it('an unknown stream chunk after the last stop would not become the stop reason (last branch tests c.type === stop)', async () => {
    const chunks: ChatChunk[] = [{ type: 'stop', reason: 'end_turn' }, { type: 'tool_input_delta', index: 0, name: 'x', partialJson: '' }, { type: 'stream_reset' }, usage];
    const o = await callProvider(req, prov(chunks), actor, null, deps);
    expect(o).toMatchObject({ kind: 'done', reason: 'end_turn' });
  });

  it('a throwing sink is ignored and the call completes', async () => {
    const chunks: ChatChunk[] = [{ type: 'tool_input_delta', index: 0, name: 'respond', partialJson: 'x' }, usage, { type: 'stop', reason: 'end_turn' }];
    const o = await callProvider(req, prov(chunks), actor, null, deps, undefined, undefined, undefined, () => { throw new Error('sink'); });
    expect(o).toMatchObject({ kind: 'done', reason: 'end_turn' });
    if (o.kind === 'done') expect(o.failed).toBeUndefined();
  });
});

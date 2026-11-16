import type { ChatChunk, ChatRequest, LLMProvider } from './types.js';

export type FakeTurn = {
  text?: string;
  toolUses?: { name: string; input: unknown }[];
  usage?: { inputTokens: number; outputTokens: number };
};

/** Scripted provider for tests: one FakeTurn per chat() call; records requests in `.calls`. */
export class FakeProvider implements LLMProvider {
    readonly calls: ChatRequest[] = [];
  private next = 0;
  private toolSeq = 0;

  constructor(
    private readonly script: FakeTurn[],
    readonly id: string = 'fake',
  ) {}

  async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk> {
    this.calls.push(req);
    const turn = this.script[this.next++];
    if (!turn) throw new Error('FakeProvider script exhausted');
    if (signal.aborted) {
      yield { type: 'stop', reason: 'aborted' };
      return;
    }
    if (turn.text) yield { type: 'text', text: turn.text };
    for (const tu of turn.toolUses ?? []) yield { type: 'tool_use', id: `fake_tu_${++this.toolSeq}`, name: tu.name, input: tu.input };
    yield {
      type: 'usage',
      inputTokens: turn.usage?.inputTokens ?? 0,
      outputTokens: turn.usage?.outputTokens ?? 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    yield { type: 'stop', reason: turn.toolUses?.length ? 'tool_use' : 'end_turn' };
  }
}

import { STRUCTURED_OUTPUT_TOOL } from '../../providers/types.js';
import type { StreamDelta } from '../call/call.js';
import { RespondExtractor } from './stream-extract.js';

/**
 * STREAM-1: what the agent loop talks to while a model call streams. `segment` = a provider call starts (the previous text is void), `delta` =
 * a fragment or reset of the provider (synchronous, O(fragment): a slow Discord call can never back-pressure the provider loop), `typing` = the
 * run starts. Only the body of the FIRST `respond` tool input of a segment is ever decoded; text before tool calls and other tools' inputs
 * are never shown (S18/S20).
 */
export interface ReplyStreamSink {
  segment(tools: ReadonlySet<string>): void;
  delta(c: StreamDelta): void;
  typing(): void;
}

/** The part of a ReplyStream the sink drives (discord/reply-stream.ts). */
export type StreamTarget = { typing(): void; update(raw: string): void; restart(): void };

export function createReplySink(target: StreamTarget): ReplyStreamSink {
  let tools: ReadonlySet<string> = new Set();
  let ex: RespondExtractor | null = null;
  let exIndex = -1;
  let exName = '';
  const reset = (): void => {
    ex = null;
    exIndex = -1;
    exName = '';
    target.restart();
  };
  return {
    segment(t) {
      tools = t;
      reset();
    },
    typing: () => target.typing(),
    delta(c) {
      if (c.type === 'stream_reset') return reset();
      if (!ex) {
        // the first respond block (Claude: a tool_use named respond; claude-code-local: the structured-output block that carries tool_calls)
        if (c.name === 'respond') ex = new RespondExtractor({ shape: 'input' });
        else if (c.name === STRUCTURED_OUTPUT_TOOL) ex = new RespondExtractor({ shape: 'local', tools });
        else return;
        exIndex = c.index;
        exName = c.name;
      } else if (c.index !== exIndex || c.name !== exName) return;
      if (ex.feed(c.partialJson)) target.update(ex.body);
    },
  };
}

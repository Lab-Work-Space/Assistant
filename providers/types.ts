export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
  /** Inline media (an image, a PDF, or STT audio/wav, Task 37) as base64. Only the metered service builds these (Task 32); the bytes are never decoded locally. */
  | { type: 'media'; mimeType: string; data: string }
  /** Opaque provider-specific block (e.g. Claude thinking); replayed only to the same provider. */
  | { type: 'raw'; provider: string; block: unknown };

export type ChatMessage = { role: 'user' | 'assistant'; content: ContentBlock[] };

export type ToolSpec = { name: string; description: string; inputSchema: object };

export type ChatRequest = {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high';
  /**
   * Supplied by the agent loop for providers that retry internally: awaited before every retry attempt; it makes a fresh
   * budget reservation and throws when the budget is gone, which stops the retry (Gate 1 D3/D4).
   */
  beforeRetry?: () => Promise<void>;
  /**
   * WS5: who the run is for. 'bot' = bot-triggered work with no person behind it; a provider with a wait queue serves every waiting
   * 'human' (or unset) call before any 'bot' call. Set by the agent loop from the run's trigger, never from model output.
   */
  priority?: 'human' | 'bot';
  /**
   * STREAM-1: opt-in. A provider that can then yields `tool_input_delta` (fragments of tool_use input JSON) and `stream_reset` (a retry or a new
   * attempt starts; discard the fragments so far). Absent: the chunk sequence is exactly what it was before streaming existed. Providers that
   * cannot stream tool input (Gemini) ignore it. Set by the agent loop only.
   */
  streamToolInput?: boolean;
  /**
   * R8 PROV-FALLBACK: set only by `fallbackRequest` (the loop, the judge and the helper call) on a call that runs on the Claude API as the backup
   * for the subscription. The claude provider then omits the server-side fallback beta (PV-C04) and the meter settles a mid-stream failure at the
   * estimate. Absent on every other call, so the VPS request is byte for byte what it was.
   */
  route?: 'fallback';
};

export type StopReason = 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted' | 'refusal';

export type ChatChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'raw'; provider: string; block: unknown }
  | { type: 'usage'; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }
  | { type: 'stop'; reason: StopReason }
  /** STREAM-1 (only with `streamToolInput`): a fragment of the input JSON of a tool_use block; display only, never part of the blocks. */
  | { type: 'tool_input_delta'; index: number; name: string; partialJson: string }
  /** STREAM-1 (only with `streamToolInput`): a retry, a fallback or a new attempt starts; earlier fragments belong to a discarded attempt. */
  | { type: 'stream_reset' };

export interface LLMProvider {
  readonly id: string;
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk>;
}

/** Provider call failed after the SDK exhausted its own retries. */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  readonly retryable: boolean;
  readonly status: number | undefined;
  /** Optional short failure class (fixed vocabulary, never CLI output or prompt text); safe to log. */
  readonly diag: string | undefined;
  constructor(message: string, opts: { retryable: boolean; status?: number | undefined; cause?: unknown; diag?: string | undefined }) {
    super(message, { cause: opts.cause });
    this.retryable = opts.retryable;
    this.status = opts.status;
    this.diag = opts.diag;
  }
}

/** The registered id of the Claude CLI provider (the same string as claude-code-local's PROVIDER_ID; a test pins that). */
export const CLAUDE_LOCAL_ID = 'claude-code-local';
/** OPS-HOLD: `ProviderError.diag` of a call the subscription quota rejected (classified in claude-code-local from the structured rate_limit_event). */
export const QUOTA_REJECTED_DIAG = 'quota_rejected';
/** R8 PV-C04: `ProviderError.diag` of a failure after the API stream started (the input was billed): settled at the estimate on the fallback route. */
export const MID_STREAM_DIAG = 'after_start';
export const isQuotaRejection = (e: unknown): boolean => e instanceof ProviderError && e.diag === QUOTA_REJECTED_DIAG;

/** STREAM-1: the name of claude-code-local's structured-output tool block (CLI 2.1.319); chunks of that block carry this name. */
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';

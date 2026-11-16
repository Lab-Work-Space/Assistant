import Anthropic from '@anthropic-ai/sdk';
import { MID_STREAM_DIAG, ProviderError } from '../types.js';
import type { ChatChunk, LLMProvider, StopReason } from '../types.js';
import { buildParams, isSonnet, PROVIDER_ID } from './request.js';

type Ev = { type: string; [k: string]: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
type StreamFn = (params: any, opts: { signal: AbortSignal }) => AsyncIterable<Ev>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Minimal client surface used here; the real Anthropic client satisfies it, tests inject a stub. */
export type ClaudeClient = {
  messages: { stream: StreamFn };
  beta: { messages: { stream: StreamFn } };
};

export type ClaudeOptions = {
  client?: ClaudeClient;
  /** Observes the options the SDK client is built with (maxRetries etc.). */
  onClientOptions?: (o: ClientOptions) => void;
  /** ANTHROPIC-WS: sent as anthropic-workspace-id (organization-scoped keys). */
  workspaceId?: string;
};

/**
 * R8 PV-C07: the options the SDK client is built with. The SDK would otherwise read `ANTHROPIC_BASE_URL` (the key would go to that host),
 * `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_LOG` (debug output that bypasses the masking logger) from the process environment, and `--env-file`
 * loads every line of the owner's env file. The URL is fixed, the token is off and the SDK's own logging is off.
 * (`ANTHROPIC_CUSTOM_HEADERS` is still read by the SDK: it adds headers, it cannot redirect the key. Recorded as a residual.)
 */
export type ClientOptions = { apiKey: string; maxRetries: number; baseURL: string; logLevel: 'off'; authToken: null; defaultHeaders?: Record<string, string>; openTelemetry: { propagation: false; traces: { enabled: false } } };
export const API_BASE_URL = 'https://api.anthropic.com';
export const buildClientOptions = (apiKey: string, workspaceId?: string): ClientOptions => ({ apiKey, maxRetries: 3, baseURL: API_BASE_URL, logLevel: 'off', authToken: null, ...(workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': workspaceId } } : {}), openTelemetry: { propagation: false, traces: { enabled: false } } }); // G2-PV-06: tracing off, whatever the environment says

const STOP: Record<string, StopReason> = {
  end_turn: 'end_turn',
  stop_sequence: 'end_turn',
  pause_turn: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  model_context_window_exceeded: 'max_tokens',
  refusal: 'refusal',
};

type Pending = { type: string; json: string; thinking: string; signature: string; id?: string; name?: string; data?: string };

/** `started`: a message_start was seen, so the API has billed the input. The fixed diag tells the meter (R8 PV-C04). */
function toProviderError(err: unknown, started = false): ProviderError {
  if (err instanceof ProviderError) return err;
  const diag = started ? { diag: MID_STREAM_DIAG } : {};
  if (err instanceof Anthropic.APIError) {
    const s = err.status;
    const retryable = s === undefined || s === 408 || s === 409 || s === 429 || s >= 500;
    return new ProviderError(err.message, { retryable, status: s, cause: err, ...diag });
  }
  return new ProviderError(err instanceof Error ? err.message : String(err), { retryable: false, cause: err, ...diag });
}

export function createClaudeProvider(apiKey: string, opts: ClaudeOptions = {}): LLMProvider {
  // The SDK retries 408/409/429/5xx/connection errors with backoff; errors seen here are post-exhaustion.
  const clientOptions = buildClientOptions(apiKey, opts.workspaceId);
  opts.onClientOptions?.(clientOptions);
  const client = opts.client ?? (new Anthropic(clientOptions) as unknown as ClaudeClient);

  return {
    id: PROVIDER_ID,
    async *chat(req, signal): AsyncIterable<ChatChunk> {
      if (signal.aborted) {
        yield { type: 'stop', reason: 'aborted' };
        return;
      }
      const params = buildParams(req);
      const target = isSonnet(req.model) && req.route !== 'fallback' ? client.beta.messages : client.messages;
      const usage = (): ChatChunk => ({ type: 'usage', inputTokens, outputTokens, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });
      const blocks = new Map<number, Pending>();
      let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheWrite = 0;
      let stop: StopReason = 'end_turn';
      let badInput: unknown;
      let started = false;
      try {
        for await (const ev of target.stream(params, { signal })) {
          if (signal.aborted) break;
          if (ev.type === 'message_start') {
            if (req.streamToolInput) yield { type: 'stream_reset' }; // S12: a server fallback or retry restarts the message; earlier fragments are void
            started = true;
            const u = ev.message?.usage ?? {};
            inputTokens = u.input_tokens ?? 0;
            cacheRead = u.cache_read_input_tokens ?? 0;
            cacheWrite = u.cache_creation_input_tokens ?? 0;
            outputTokens = u.output_tokens ?? 0;
          } else if (ev.type === 'content_block_start') {
            const cb = ev.content_block;
            blocks.set(ev.index, { type: cb.type, json: '', thinking: cb.thinking ?? '', signature: cb.signature ?? '', id: cb.id, name: cb.name, data: cb.data });
          } else if (ev.type === 'content_block_delta') {
            const b = blocks.get(ev.index);
            const d = ev.delta;
            if (d.type === 'text_delta') yield { type: 'text', text: d.text };
            else if (!b) continue;
            else if (d.type === 'input_json_delta') {
              b.json += d.partial_json;
              // S18: only the input JSON of a tool_use block feeds the stream; thinking, signature and text deltas never do
              if (req.streamToolInput && b.type === 'tool_use' && typeof d.partial_json === 'string') yield { type: 'tool_input_delta', index: ev.index, name: b.name ?? '', partialJson: d.partial_json };
            }
            else if (d.type === 'thinking_delta') b.thinking += d.thinking;
            else if (d.type === 'signature_delta') b.signature += d.signature;
          } else if (ev.type === 'content_block_stop') {
            const b = blocks.get(ev.index);
            blocks.delete(ev.index);
            if (!b) continue;
            if (b.type === 'tool_use') {
              const parsed = parseInput(b.json);
              if (parsed.ok) yield { type: 'tool_use', id: b.id!, name: b.name!, input: parsed.value };
              else badInput = parsed.error; // truncated by max_tokens is fine; judged against the final stop reason
            } else if (b.type === 'thinking') {
              yield { type: 'raw', provider: PROVIDER_ID, block: { type: 'thinking', thinking: b.thinking, signature: b.signature } };
            } else if (b.type === 'redacted_thinking') {
              yield { type: 'raw', provider: PROVIDER_ID, block: { type: 'redacted_thinking', data: b.data } };
            }
          } else if (ev.type === 'message_delta') {
            const u = ev.usage ?? {};
            outputTokens = u.output_tokens ?? outputTokens;
            inputTokens = u.input_tokens ?? inputTokens;
            cacheRead = u.cache_read_input_tokens ?? cacheRead;
            cacheWrite = u.cache_creation_input_tokens ?? cacheWrite;
            if (ev.delta?.stop_reason) stop = STOP[ev.delta.stop_reason] ?? 'end_turn';
          }
        }
      } catch (err) {
        if (signal.aborted || err instanceof Anthropic.APIUserAbortError) {
          if (started) yield usage();
          yield { type: 'stop', reason: 'aborted' };
          return;
        }
        throw toProviderError(err, started);
      }
      if (signal.aborted) {
        if (started) yield usage();
        yield { type: 'stop', reason: 'aborted' };
        return;
      }
      if (badInput !== undefined && stop === 'tool_use') {
        // Gate 2 G2-PV-01 (PV-C04): the whole message was streamed and billed, but no usage chunk follows this throw; the diag lets the fallback route settle at the estimate
        throw new ProviderError('model produced unparseable tool input', { retryable: false, cause: badInput, ...(started ? { diag: MID_STREAM_DIAG } : {}) });
      }
      yield usage();
      yield { type: 'stop', reason: stop };
    },
  };
}

function parseInput(json: string): { ok: true; value: unknown } | { ok: false; error: unknown } {
  if (!json) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(json) };
  } catch (error) {
    return { ok: false, error: error ?? new Error('bad json') };
  }
}

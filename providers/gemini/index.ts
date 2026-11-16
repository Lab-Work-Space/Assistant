import { randomBytes } from 'node:crypto';
import { ProviderError } from '../types.js';
import type { ChatChunk, LLMProvider } from '../types.js';
import { mapFinish, PROVIDER_ID, toGeminiRequest } from './convert.js';
import { abortableSleep, backoffMs, classify, DEFAULT_MAX_RETRIES, onAbort } from './retry.js';
import type { GeminiChunk, GeminiClient } from './types.js';

export { GeminiHttpError } from './types.js';
export type { GeminiChunk, GeminiClient } from './types.js';
export { adaptGenAi } from './adapter.js';

export type GeminiOptions = {
  client: GeminiClient;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  maxRetries?: number;
};

type Usage = NonNullable<GeminiChunk['usage']>;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Upstream text can echo request URLs (and so the key): messages and causes carry only the status / error name. */
function failure(err: unknown, status: number | undefined, retryable: boolean, midStream: boolean): ProviderError {
  const what = status !== undefined ? `HTTP ${status}` : 'network error';
  const cause = new Error(status !== undefined ? what : err instanceof Error ? err.name : 'unknown');
  return new ProviderError(`Gemini ${midStream ? 'stream failed' : 'request failed'} (${what})`, { retryable, status, cause });
}

export function createGeminiProvider(o: GeminiOptions): LLMProvider {
  const sleep = o.sleep ?? abortableSleep;
  const random = o.random ?? Math.random;
  const maxRetries = o.maxRetries ?? DEFAULT_MAX_RETRIES;
  let seq = 0;
  const nextId = () => `gemini_tu_${++seq}_${randomBytes(4).toString('hex')}`;

  return {
    id: PROVIDER_ID,
    async *chat(req, signal): AsyncIterable<ChatChunk> {
      if (signal.aborted) {
        yield { type: 'stop', reason: 'aborted' };
        return;
      }
      const greq = toGeminiRequest(req);
      const abort = onAbort(signal);
      try {
        for (let retries = 0; ; ) {
          let started = false;
          let yielded = false;
          let usage: Usage | undefined;
          let finish: string | undefined;
          let blocked: string | undefined;
          let sawCall = false;
          const usageChunk = (): ChatChunk => {
            const cached = usage?.cachedTokens ?? 0;
            return {
              type: 'usage',
              inputTokens: Math.max(0, (usage?.promptTokens ?? 0) - cached),
              outputTokens: (usage?.candidatesTokens ?? 0) + (usage?.thoughtsTokens ?? 0),
              cacheReadTokens: cached,
              cacheWriteTokens: 0,
            };
          };
          const aborted = function* (): Generator<ChatChunk> {
            if (started) yield usageChunk();
            yield { type: 'stop', reason: 'aborted' };
          };
          let it: AsyncIterator<GeminiChunk> | undefined;
          try {
            const stream = await Promise.race([o.client.stream(greq, signal), abort.promise]);
            if (stream === 'abort') {
              yield* aborted();
              return;
            }
            it = stream[Symbol.asyncIterator]();
            for (;;) {
              const r = await Promise.race([it.next(), abort.promise]);
              if (r === 'abort' || signal.aborted) {
                void Promise.resolve(it.return?.()).catch(() => undefined);
                yield* aborted();
                return;
              }
              if (r.done) break;
              const c = r.value;
              started = true;
              if (c.usage) usage = c.usage;
              if (c.finishReason) finish = c.finishReason;
              if (c.blockedReason) blocked = c.blockedReason;
              // Thought parts are never text; they are kept only as opaque raw blocks (never logged or audited).
              for (const block of c.rawParts ?? []) {
                yielded = true;
                yield { type: 'raw', provider: PROVIDER_ID, block };
              }
              if (c.text) {
                yielded = true;
                yield { type: 'text', text: c.text };
              }
              for (const fc of c.functionCalls ?? []) {
                sawCall = true;
                const id = nextId();
                yielded = true;
                const p = fc.part;
                if (isObj(p) && p.thoughtSignature && isObj(p.functionCall)) {
                  // the signed Part is replayed as-is, so its functionCall.id must be the tool_use id (convert.ts dedups on it)
                  yield { type: 'raw', provider: PROVIDER_ID, block: { ...p, functionCall: { ...p.functionCall, id } } };
                }
                yield { type: 'tool_use', id, name: fc.name, input: fc.args };
              }
            }
          } catch (err) {
            if (signal.aborted) {
              yield* aborted();
              return;
            }
            const f = classify(err, maxRetries);
            if (yielded) throw failure(err, f.status, true, true); // mid-stream: the consumer already has output
            if (!f.retryable && retries >= f.limit) throw failure(err, f.status, false, false);
            if (f.retryable && retries >= f.limit) throw failure(err, f.status, true, false);
            await sleep(backoffMs(retries, random), signal);
            if (signal.aborted) {
              yield { type: 'stop', reason: 'aborted' };
              return;
            }
            try {
              await req.beforeRetry?.();
            } catch {
              // the budget is gone (or the meter is down): stop retrying, surface the failure that caused it
              throw failure(err, f.status, false, false);
            }
            if (signal.aborted) {
              yield { type: 'stop', reason: 'aborted' };
              return;
            }
            retries++;
            continue;
          }
          yield usageChunk();
          yield { type: 'stop', reason: mapFinish(blocked ? 'blocked' : finish, sawCall) };
          return;
        }
      } finally {
        abort.dispose();
      }
    },
  };
}

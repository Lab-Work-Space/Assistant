import { GoogleGenAI } from '@google/genai';
import type { GeminiChunk, GeminiClient, GeminiRequest } from './types.js';
import { GeminiHttpError } from './types.js';

// Step 0 (@google/genai 2.32.0 d.ts): ai.models.generateContentStream(params) -> Promise<AsyncGenerator<GenerateContentResponse>>;
// abort = params.config.abortSignal (client-side only); errors are ApiError {status}; chunks carry candidates[0].content.parts,
// candidates[0].finishReason, promptFeedback.blockReason and usageMetadata (cumulative; the last one wins).
type Part = { text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: { name?: string; args?: Record<string, unknown> } };
type Resp = {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; thoughtsTokenCount?: number };
};

function toChunk(r: Resp): GeminiChunk {
  const out: GeminiChunk = {};
  const cand = r.candidates?.[0];
  // Parts are read directly: `response.text` would warn and mix in non-text parts.
  for (const p of cand?.content?.parts ?? []) {
    if (p.thought) (out.rawParts ??= []).push(p);
    else if (p.functionCall?.name) (out.functionCalls ??= []).push({ name: p.functionCall.name, args: p.functionCall.args ?? {}, part: p });
    else if (typeof p.text === 'string' && p.text) out.text = (out.text ?? '') + p.text;
  }
  if (cand?.finishReason) out.finishReason = cand.finishReason;
  if (r.promptFeedback?.blockReason) out.blockedReason = r.promptFeedback.blockReason;
  const u = r.usageMetadata;
  if (u) {
    out.usage = {
      promptTokens: u.promptTokenCount ?? 0,
      candidatesTokens: u.candidatesTokenCount ?? 0,
      ...(u.cachedContentTokenCount ? { cachedTokens: u.cachedContentTokenCount } : {}),
      ...(u.thoughtsTokenCount ? { thoughtsTokens: u.thoughtsTokenCount } : {}),
    };
  }
  return out;
}

const asHttp = (e: unknown): unknown => {
  const s = (e as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? new GeminiHttpError(s) : e;
};

/**
 * SDK request params. P11: `automaticContinuation: false` (2.32.0 defaults to true and would re-send billable requests on
 * finish reason CONTINUATION, bypassing beforeRetry/budget.reserve) and `retryOptions.attempts: 1` (the SDK's default is 5
 * attempts); all retrying is done in index.ts. functionDeclarations is the ONLY tool field.
 */
export function toSdkParams(req: GeminiRequest, signal: AbortSignal) {
  return {
    model: req.model,
    contents: req.contents as never,
    config: {
      systemInstruction: req.systemInstruction,
      maxOutputTokens: req.maxOutputTokens,
      ...(req.functionDeclarations.length ? { tools: [{ functionDeclarations: req.functionDeclarations as never }] } : {}),
      automaticContinuation: false,
      httpOptions: { retryOptions: { attempts: 1 } },
      abortSignal: signal,
    },
  };
}

/** Client options: only the key is taken from the caller, so SDK-level retries can never be re-enabled from outside. */
export const sdkClientOptions = (apiKey: string) => ({ apiKey, httpOptions: { retryOptions: { attempts: 1 } } });

/** Thin adapter over the SDK (the only file importing it). Builds its own client from `{ apiKey }`; caller options are ignored. */
export function adaptGenAi(ai: unknown): GeminiClient {
  const apiKey = (ai as { apiKey?: unknown } | null)?.apiKey;
  if (typeof apiKey !== 'string' || !apiKey) throw new Error('adaptGenAi requires { apiKey: string }');
  const client = new GoogleGenAI(sdkClientOptions(apiKey));
  return {
    async stream(req, signal) {
      let gen: AsyncGenerator<Resp>;
      try {
        gen = (await client.models.generateContentStream(toSdkParams(req, signal))) as unknown as AsyncGenerator<Resp>;
      } catch (e) {
        throw asHttp(e);
      }
      return (async function* () {
        try {
          for await (const r of gen) yield toChunk(r);
        } catch (e) {
          throw asHttp(e);
        }
      })();
    },
  };
}

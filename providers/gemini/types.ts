/**
 * Plan-owned wire types for the Gemini provider (field names verified against @google/genai 2.32.0 d.ts:
 * Part, FunctionCall, FunctionResponse, Schema, UsageMetadata). We never import SDK types here so the
 * converters stay dependency-free; Task 3 adapts these to the SDK.
 */
export type GeminiPart = {
  text?: string;
  /** true = model reasoning; such parts never become `text` blocks. */
  thought?: boolean;
  /** Opaque, base64; replayed unchanged to Gemini only, never shown or audited. */
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  /** `response` uses the "output" / "error" keys. */
  functionResponse?: { id?: string; name: string; response: { output?: string; error?: string } };
  inlineData?: { mimeType: string; data: string };
};

export type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] };

/** `functionDeclarations` is the ONLY tool field (P11): no googleSearch / urlContext / codeExecution. */
export type GeminiRequest = {
  model: string;
  systemInstruction: string;
  contents: GeminiContent[];
  /** `parameters` is omitted for tools that take no arguments (an empty OBJECT schema is not sent). */
  functionDeclarations: { name: string; description: string; parameters?: object }[];
  maxOutputTokens: number;
};

/**
 * One streamed response chunk, already reduced by the adapter. Thought parts are NEVER in `text`: they come in
 * `rawParts` (whole Part objects). A functionCall that carried a thoughtSignature has its whole Part in `part`.
 */
export type GeminiChunk = {
  text?: string;
  functionCalls?: { name: string; args: Record<string, unknown>; part?: unknown }[];
  rawParts?: unknown[];
  finishReason?: string;
  blockedReason?: string;
  usage?: { promptTokens: number; candidatesTokens: number; cachedTokens?: number; thoughtsTokens?: number };
};

export interface GeminiClient {
  stream(req: GeminiRequest, signal: AbortSignal): Promise<AsyncIterable<GeminiChunk>>;
}

/** HTTP failure from the Gemini API; `status` is the HTTP status code. */
export class GeminiHttpError extends Error {
  override readonly name = 'GeminiHttpError';
  readonly status: number;
  constructor(status: number, message = `HTTP ${status}`) {
    super(message);
    this.status = status;
  }
}

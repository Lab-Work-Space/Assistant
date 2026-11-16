import type { GeminiChunk, GeminiClient, GeminiRequest } from '../../providers/gemini/types.js';

/** One scripted `stream()` call. */
export type GeminiAttempt =
  /** stream() itself rejects (HTTP error before any chunk). */
  | { reject: unknown }
  | {
      chunks?: GeminiChunk[];
      /** thrown by the iterator after `chunks` were delivered. */
      thenThrow?: unknown;
      /** after `chunks`, wait forever (the SDK would honour the signal; this fake ignores it on purpose). */
      hang?: boolean;
    };

export type FakeGemini = GeminiClient & { requests: GeminiRequest[]; signals: AbortSignal[]; readonly calls: number };

/** Scripted GeminiClient: one GeminiAttempt per stream() call; the last entry repeats when the script runs out. */
export function fakeGemini(script: GeminiAttempt[]): FakeGemini {
  const requests: GeminiRequest[] = [];
  const signals: AbortSignal[] = [];
  return {
    requests,
    signals,
    get calls() {
      return requests.length;
    },
    async stream(req, signal) {
      requests.push(req);
      signals.push(signal);
      const a = script[Math.min(requests.length - 1, script.length - 1)]!;
      if ('reject' in a) throw a.reject;
      return (async function* () {
        for (const c of a.chunks ?? []) yield c;
        if (a.thenThrow !== undefined) throw a.thenThrow;
        if (a.hang) await new Promise<never>(() => undefined);
      })();
    },
  };
}

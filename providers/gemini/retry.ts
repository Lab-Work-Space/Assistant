import { GeminiHttpError } from './types.js';

export const BASE_BACKOFF_MS = 500;
export const DEFAULT_MAX_RETRIES = 3;

export type Failure = { status: number | undefined; retryable: boolean; limit: number };

/**
 * 429 / 408 / 5xx / network (no status): up to `maxRetries` retries, final error retryable.
 * 400: exactly one retry, final error not retryable. 401 / 403 / 404 / other 4xx: none.
 */
export function classify(err: unknown, maxRetries: number): Failure {
  const status = err instanceof GeminiHttpError ? err.status : undefined;
  if (status === undefined) return { status, retryable: true, limit: maxRetries };
  if (status === 429 || status === 408 || status >= 500) return { status, retryable: true, limit: maxRetries };
  if (status === 400) return { status, retryable: false, limit: Math.min(1, maxRetries) };
  return { status, retryable: false, limit: 0 };
}

/** 500 ms * 2^n, plus up to 50% jitter. `random` is injectable for tests. */
export const backoffMs = (n: number, random: () => number): number => Math.round(BASE_BACKOFF_MS * 2 ** n * (1 + 0.5 * random()));

/** Resolves after `ms` or as soon as `signal` aborts, whichever is first (never rejects). */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** A promise that resolves when `signal` aborts, with a disposer so the listener never leaks. */
export function onAbort(signal: AbortSignal): { promise: Promise<'abort'>; dispose: () => void } {
  let dispose = () => {};
  const promise = new Promise<'abort'>((resolve) => {
    if (signal.aborted) return resolve('abort');
    const h = () => resolve('abort');
    signal.addEventListener('abort', h, { once: true });
    dispose = () => signal.removeEventListener('abort', h);
  });
  return { promise, dispose };
}

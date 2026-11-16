import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ErrorSink } from '../../core/events.js';
import { ProviderError } from '../types.js';
import type { ChatChunk, ChatRequest, LLMProvider } from '../types.js';
import { quotaRejection, type QuotaSnapshot } from './quota.js';
import { buildArgs, createStreamParser, PROVIDER_ID, renderConversation, renderSystem, STREAM_LINE_CAP_BYTES, STREAM_TOTAL_CAP_BYTES, toCliModel, type Interpreted, type StreamSink } from './protocol.js';
import { childEnv, resolveClaudePath, runCli, type CliOutcome, type SpawnImpl } from './spawn.js';

export { argvDigest, buildArgs, createStreamParser, interpretStream, LOCAL_MODEL_IDS, LOCAL_MODELS, parseResponse, PROVIDER_ID as LOCAL_PROVIDER_ID, toLocalModel, renderConversation, renderSystem, RESPONSE_SCHEMA, toCliModel, UNKNOWN_TOOL_NOTE } from './protocol.js';
export { parseRateLimitEvent, type QuotaSnapshot, type QuotaWindow, type QuotaWindowName, type QuotaStatus, QUOTA_WINDOWS } from './quota.js';
export { CHILD_ENV_KEYS, childEnv, resolveClaudePath } from './spawn.js';
export { envFilesOf, inContainer, localFlagOk, localModeOf, localOffByOwner, localProviderAllowed, nodeGuardExec, nodeGuardFs, processGuardEnv, sha256File, type GuardEnv, type GuardExec, type GuardFs, type GuardResult } from './guard.js';

/** Gate 1 L6: calls waiting for a slot beyond this are refused. */
export const MAX_QUEUE = 20;

export type LocalAuditEntry = { actor: string; action: string; provider: string; model: string; outcome: string };

export type LocalProviderOptions = {
  claudePath: string;
  timeoutMs: number;
  concurrency: number;
  spawnImpl?: SpawnImpl;
  /** Receives one `unknown_tool` entry per dropped tool call (never the tool name). Best effort: a failure goes to `log`. */
  audit: (e: LocalAuditEntry) => Promise<void> | void;
  /** Error sink for fixed-text warnings (default console). */
  log?: ErrorSink;
  /**
   * R-L5: awaited before each spawn, the retry included (attempt 1, 2). Throwing refuses the call:
   * nothing is spawned and the call fails with a non-retryable ProviderError (e.g. the local call quota).
   */
  onAttempt?: (attempt: number, signal: AbortSignal) => Promise<void>;
  /** USAGE-1: receives each parsed subscription-quota snapshot (numeric/enum fields only). */
  onQuota?: (s: QuotaSnapshot) => void;
};

/** Counting semaphore with a bounded wait queue whose waiters leave on abort. */
export class Slots {
  private active = 0;
  /** WS5: waiters for people's work, served first; bot-only work waits in `waitingBot` and takes a slot only when no person is waiting. */
  private readonly waiting: Array<() => void> = [];
  private readonly waitingBot: Array<() => void> = [];
  constructor(private readonly max: number, private readonly maxQueue: number) {}

  /** Resolves true with a slot held, false when aborted while waiting; throws when the queue is full. */
  acquire(signal: AbortSignal, priority: 'human' | 'bot' = 'human'): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(true);
    }
    if (this.waiting.length + this.waitingBot.length >= this.maxQueue) {
      return Promise.reject(new ProviderError('claude-code-local: call queue is full', { retryable: true }));
    }
    const queue = priority === 'bot' ? this.waitingBot : this.waiting;
    return new Promise((resolve) => {
      const grant = () => {
        signal.removeEventListener('abort', onAbort);
        resolve(true);
      };
      const onAbort = () => {
        const i = queue.indexOf(grant);
        if (i >= 0) queue.splice(i, 1);
        resolve(false);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      queue.push(grant);
    });
  }

  release(): void {
    const next = this.waiting.shift() ?? this.waitingBot.shift();
    if (next) next(); // the slot passes straight to the next waiter
    else this.active--;
  }
}

type Attempt = { kind: 'ok' } | { kind: 'aborted' } | { kind: 'retry'; error: ProviderError } | { kind: 'fail'; error: ProviderError };

/** Errors are fixed text plus an exit code: stderr and CLI result text never leave the provider (Gate 1 L4). */
function classify(o: CliOutcome): Attempt {
  switch (o.kind) {
    case 'aborted':
      return { kind: 'aborted' };
    case 'timeout':
      return { kind: 'retry', error: new ProviderError('claude-code-local: CLI timed out', { retryable: true, diag: 'timeout' }) };
    case 'overflow':
      return { kind: 'fail', error: new ProviderError('claude-code-local: CLI output limit exceeded', { retryable: false, diag: 'overflow' }) };
    case 'spawn_error':
      return { kind: 'fail', error: new ProviderError('claude-code-local: CLI could not be started', { retryable: false, diag: 'spawn_error' }) };
    case 'exit':
      if (o.code === 0) return { kind: 'ok' };
      // Killed by a signal we did not send: treat as transient (OOM killer, system sleep).
      if (o.code === null) return { kind: 'retry', error: new ProviderError(`claude-code-local: CLI ended by signal ${o.signal ?? 'unknown'}`, { retryable: true, diag: `signal:${o.signal ?? 'unknown'}` }) };
      return { kind: 'fail', error: new ProviderError(`claude-code-local: CLI exited with code ${o.code}`, { retryable: false, diag: `exit:${o.code}` }) };
  }
}

export function createClaudeCodeLocalProvider(opts: LocalProviderOptions): LLMProvider {
  const claudePath = resolveClaudePath(opts.claudePath);
  const slots = new Slots(Math.max(1, opts.concurrency), MAX_QUEUE);
  const log: ErrorSink = opts.log ?? console;

  /** One process in a fresh 0700 temp dir that is removed whatever happens (Gate 1 L1, L6). */
  async function attempt(req: ChatRequest, signal: AbortSignal, onLine: (line: string) => void): Promise<Attempt> {
    const made = await mkdtemp(join(tmpdir(), 'assistant-local-'));
    try {
      const dir = await realpath(made);
      const systemFile = join(dir, 'system.md');
      await writeFile(systemFile, renderSystem(req), { mode: 0o600 });
      const outcome = await runCli({
        path: claudePath,
        args: buildArgs(req, systemFile),
        stdin: renderConversation(req),
        lines: { onLine, maxLineBytes: STREAM_LINE_CAP_BYTES, maxTotalBytes: STREAM_TOTAL_CAP_BYTES },
        cwd: dir,
        env: childEnv(),
        timeoutMs: opts.timeoutMs,
        signal,
        ...(opts.spawnImpl ? { spawnImpl: opts.spawnImpl } : {}),
      });
      return classify(outcome);
    } finally {
      await rm(made, { recursive: true, force: true });
    }
  }

  /** Returns the interpreted result, or null when aborted; at most one retry on a transient failure. `sink` (streamToolInput only) gets display-only deltas and a reset per attempt (S12). */
  async function call(req: ChatRequest, signal: AbortSignal, callerSignal: AbortSignal, allowed: ReadonlySet<string>, sink: StreamSink | undefined): Promise<Interpreted | null> {
    if (!(await slots.acquire(signal, req.priority))) return null;
    try {
      for (let i = 0; ; i++) {
        if (opts.onAttempt) {
          try {
            await opts.onAttempt(i + 1, callerSignal); // the caller's own signal: the budget binds a local reservation to it
          } catch {
            throw new ProviderError('claude-code-local: call refused (quota)', { retryable: false });
          }
          if (signal.aborted) return null;
        }
        if (i > 0) sink?.({ type: 'stream_reset' }); // S12: the retry starts over; fragments of attempt 1 are void
        const parser = createStreamParser(allowed, sink, opts.onQuota); // a fresh parser per attempt: attempt 2 never appends to attempt 1
        const a = await attempt(req, signal, parser.feed);
        if (a.kind === 'ok') return parser.finish();
        if (a.kind === 'aborted' || signal.aborted) return null;
        if (parser.rejected()) throw quotaRejection(); // OPS-HOLD: a failed attempt after a rejected rate_limit_event: no retry, the same call would be rejected again
        if (a.kind === 'fail' || i >= 1) throw a.error;
      }
    } finally {
      slots.release();
    }
  }

  return {
    id: PROVIDER_ID,
    async *chat(req, signal): AsyncIterable<ChatChunk> {
      if (signal.aborted) {
        yield { type: 'stop', reason: 'aborted' };
        return;
      }
      toCliModel(req.model); // Gate 1 L1: refuse a bad model id before queueing or spawning
      const allowed = new Set(req.tools.map((t) => t.name));
      // The CLI runs in the background of this generator; display-only deltas are queued and yielded as they arrive.
      const queue: ChatChunk[] = [];
      let wake: (() => void) | null = null;
      let finished = false;
      const poke = () => {
        const w = wake;
        wake = null;
        w?.();
      };
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      const sink: StreamSink | undefined = req.streamToolInput ? (c) => { queue.push(c); poke(); } : undefined;
      let outcome: { ok: Interpreted | null } | { err: unknown } | undefined;
      const running = call(req, ac.signal, signal, allowed, sink).then(
        (r) => { outcome = { ok: r }; },
        (e: unknown) => { outcome = { err: e }; },
      ).finally(() => { finished = true; poke(); });
      try {
        for (;;) {
          while (queue.length) yield queue.shift()!;
          if (finished) break;
          await new Promise<void>((r) => { wake = r; });
        }
      } finally {
        // The consumer stopped early (or finished): never leave the CLI, the slot or the temp dir behind.
        if (!finished) ac.abort();
        signal.removeEventListener('abort', onAbort);
        await running;
      }
      if (!outcome) throw new ProviderError('claude-code-local: call ended without a result', { retryable: false });
      if ('err' in outcome) throw outcome.err;
      const res = outcome.ok;
      if (res === null) {
        yield { type: 'stop', reason: 'aborted' };
        return;
      }
      const { chunks, unknownTools } = res;
      for (let i = 0; i < unknownTools; i++) {
        try {
          await opts.audit({ actor: `provider:${PROVIDER_ID}`, action: 'llm.tool_call', provider: PROVIDER_ID, model: req.model, outcome: 'unknown_tool' });
        } catch {
          // Best effort (the call is dropped either way), but never silent. Fixed text: no tool name, no error text.
          log.error({ provider: PROVIDER_ID, outcome: 'unknown_tool' }, 'claude-code-local: unknown_tool audit failed');
        }
      }
      yield* chunks;
    },
  };
}

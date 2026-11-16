import type { ActorRef } from '../../company/types.js';
import type { Task } from '../../db/repos/tasks.js';
import type { AuditFn } from '../../governance/audit.js';
import { actorKey, LOCAL_PROVIDER, type Budget, type ReserveScope, type Usage } from '../../governance/budget.js';
import type { Halt } from '../../governance/halt.js';
import { MID_STREAM_DIAG, type ChatChunk, type ChatRequest, type ContentBlock, type LLMProvider, type StopReason } from '../../providers/types.js';
import { estimateInputTokens } from '../context.js';
import type { IncidentSink } from '../../core/incidents.js';

/** What one metered provider call needs. Shared by the agent loop and the metered model service (Task 32). */
export type CallDeps = {
  budget: Pick<Budget, 'reserve' | 'settle' | 'release' | 'costOf'>;
  halt: Pick<Halt, 'track'>;
  /** TASKADMIN-1 (TA-C10): where the stream of a run with a task is registered so an admin cancel can abort it. Required for the agent loop (AgentDeps); the metered services have no task. */
  taskRuns?: Pick<import('../tasks/task-runs.js').TaskRuns, 'track'>;
  audit: AuditFn;
  /** Optional warn sink for provider failures (class only: never prompt text, CLI output or secrets). */
  log?: { warn(obj: unknown, msg?: string): void };
  /** BOTLOG-1: where a failed provider call is reported (#bot-log, deduped). Absent = log only. */
  incidents?: IncidentSink;
};

/**
 * The error handed to #bot-log. claude-code-local messages are fixed strings (Gate 1 L4) and pass through with `diag`; for every other
 * provider only class and status are kept, since an SDK message can quote the request (prompt text).
 */
export function providerFault(err: unknown, providerId: string): unknown {
  if (providerId === LOCAL_PROVIDER && (err as { name?: unknown } | null)?.name === 'ProviderError') return err;
  const e = err as { name?: unknown; status?: unknown } | null;
  const name = typeof e?.name === 'string' ? e.name : 'Error';
  const status = typeof e?.status === 'number' ? e.status : undefined;
  return Object.assign(new Error(`${name}${status ? ` HTTP ${status}` : ''} after retries (provider message withheld)`), { name, ...(status ? { status } : {}) });
}

/**
 * Failure class for a log line. ProviderError messages of claude-code-local are fixed strings (Gate 1 L4), so they and
 * `diag` (exit code, is_error subtype, ...) are logged; for every other provider only name + status, since SDK errors can quote the request.
 */
export function failureInfo(err: unknown, providerId: string): Record<string, unknown> {
  const e = err as { name?: unknown; status?: unknown; retryable?: unknown; message?: unknown; diag?: unknown } | null;
  const out: Record<string, unknown> = { errName: typeof e?.name === 'string' ? e.name : typeof err };
  if (typeof e?.status === 'number') out.status = e.status;
  if (typeof e?.retryable === 'boolean') out.retryable = e.retryable;
  if (providerId === LOCAL_PROVIDER && e?.name === 'ProviderError') {
    if (typeof e.message === 'string') out.reason = e.message;
    if (typeof e.diag === 'string') out.diag = e.diag;
  }
  return out;
}

/**
 * Neutral outcome; callers turn it into their own reply. `refused` (any reserve refusal, `price` included, first attempt or
 * retry) and `meter` (the meter threw) are already audited here. `done` carries the streamed blocks and the settled cost.
 */
export type CallOutcome =
  | { kind: 'refused'; scope: ReserveScope; est: number }
  | { kind: 'meter'; phase: 'reserve' | 'settle' }
  | { kind: 'done'; blocks: ContentBlock[]; text: string; reason: StopReason; costUsd: number; failed?: unknown; aborted: boolean };

/** Fixed text for a budget stop that needs no approval flow (the loop handles the task/local_task cap approvals itself). */
export function budgetText(o: Extract<CallOutcome, { kind: 'refused' | 'meter' }>, model: string): string {
  if (o.kind === 'meter') return o.phase === 'reserve' ? 'The budget meter is unavailable. Nothing was run.' : 'The budget meter is unavailable. Stopped after the last model call.';
  if (o.scope === 'price') return `Model ${model} has no price configured, so it cannot be metered.`;
  if (o.scope === 'local') return 'The daily local call quota (claude-code-local) is used up.';
  if (o.scope === 'local_task') return 'This task tree used its local model call cap.';
  if (o.scope === 'project') return 'This project used its budget.';
  if (o.scope === 'warroom_bot') return 'This bot used its daily share of bot-to-bot talk.';
  if (o.scope === 'warroom') return 'The daily pool for bot-to-bot talk is used up.';
  if (o.scope === 'dept') return 'The department monthly budget is used up. A Bot Admin can approve a raise in #⚙️-setting.';
  return `The ${o.scope === 'company' ? 'company' : 'bot'} daily budget is used up.`;
}

/** STREAM-1: what a streaming sink sees of a call (never part of the returned blocks). */
export type StreamDelta = Extract<ChatChunk, { type: 'tool_input_delta' | 'stream_reset' }>;

/**
 * Reserve -> stream (tracked for halt) -> settle actual, or release when no usage arrived -> `llm.call` audit.
 * `started` runs once, right before the request reaches the provider (the loop's approved-results delivery hook).
 */
export async function callProvider(req: ChatRequest, provider: LLMProvider, actor: ActorRef, task: Task | null, deps: CallDeps, started?: () => Promise<void>, pool?: 'warroom', tool?: string, onDelta?: (c: StreamDelta) => void, trackTaskId?: string): Promise<CallOutcome> {
  const who = actorKey(actor);
  const taskId = task?.id ?? null;
  // Gate 1 L8: a local call costs 0 by definition (no price lookup); Budget counts it instead. D4 holds for every other provider.
  const local = provider.id === LOCAL_PROVIDER;
  const costOf = (u: Usage) => (local ? 0 : deps.budget.costOf(req.model, u));
  let est: number;
  try {
    est = costOf({ inputTokens: estimateInputTokens(req), outputTokens: req.maxTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });
  } catch {
    await deps.audit({ actor: who, action: 'budget.reserve', taskId, model: req.model, outcome: 'refused:price' });
    return { kind: 'refused', scope: 'price', est: NaN };
  }
  // Created before the reservation: a local reservation is bound to this signal so the provider can count its retries.
  // SPEND-1: the rollup label of this call, only when the caller names one (the agent loop does not: its reserve request is unchanged).
  const attribution = tool === undefined ? {} : { attribution: { provider: provider.id, model: req.model, tool } };
  const ac = new AbortController();
  let res: Awaited<ReturnType<CallDeps['budget']['reserve']>>;
  try {
    res = await deps.budget.reserve({ actor, ...(task ? { taskId: task.id } : {}), estUsd: est, model: req.model, provider: provider.id, ...(pool ? { pool } : {}), ...(local ? { signal: ac.signal } : {}), ...attribution });
  } catch {
    // Gate 1 D23: the meter is unavailable, so fail closed with no provider call.
    await deps.audit({ actor: who, action: 'budget.reserve', taskId, model: req.model, outcome: 'error' });
    return { kind: 'meter', phase: 'reserve' };
  }
  const refused = async (r: { scope: ReserveScope }): Promise<CallOutcome> => {
    await deps.audit({ actor: who, action: 'budget.reserve', taskId, model: req.model, outcome: `refused:${r.scope}` });
    return { kind: 'refused', scope: r.scope, est };
  };
  if (!res.ok) return refused(res);
  // The request is about to reach the provider: whatever it carries counts as seen (a failure here only risks a repeat).
  await started?.().catch(() => undefined);

  const untrack = deps.halt.track(ac);
  const trackId = task?.id ?? trackTaskId; // G2-03: a run with no task of its own tracks the conversation task it opened mid-run (budget and audit stay task-less)
  const untrackRun = trackId ? deps.taskRuns?.track(trackId, ac) : undefined; // TA-C10: the same controller, removed in the same finally
  // Gate 1 D3/D4 (P11): a provider that retries internally calls this before each retry; every retry attempt gets a fresh
  // reservation (throws when refused or the meter is down, which stops the retry). Extra holds are released afterwards.
  const extra: string[] = [];
  let retryStop: { scope: ReserveScope } | 'error' | undefined;
  const beforeRetry = async () => {
    let r: Awaited<ReturnType<CallDeps['budget']['reserve']>>;
    try {
      r = await deps.budget.reserve({ actor, ...(task ? { taskId: task.id } : {}), estUsd: est, model: req.model, provider: provider.id, ...(pool ? { pool } : {}), ...attribution });
    } catch (e) {
      retryStop = 'error';
      await deps.audit({ actor: who, action: 'budget.reserve', taskId, model: req.model, outcome: 'error' });
      throw e;
    }
    if (!r.ok) {
      retryStop = r;
      throw new Error(`budget refused retry: ${r.scope}`);
    }
    extra.push(r.reservationId);
  };
  const blocks: ContentBlock[] = [];
  let text = '';
  let usage: Usage | undefined;
  let reason: StopReason = 'end_turn';
  let failed: unknown;
  try {
    for await (const c of provider.chat(local ? req : { ...req, beforeRetry }, ac.signal)) {
      if (c.type === 'text') {
        text += c.text;
        const last = blocks.at(-1);
        if (last?.type === 'text') last.text += c.text;
        else blocks.push({ type: 'text', text: c.text });
      } else if (c.type === 'tool_use') blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
      else if (c.type === 'raw') blocks.push({ type: 'raw', provider: c.provider, block: c.block });
      else if (c.type === 'usage') usage = { inputTokens: c.inputTokens, outputTokens: c.outputTokens, cacheReadTokens: c.cacheReadTokens, cacheWriteTokens: c.cacheWriteTokens };
      else if (c.type === 'tool_input_delta' || c.type === 'stream_reset') {
        // STREAM-1 (S12): explicit branches (a bare `else reason = c.reason` would read these as a stop). Display only; a throwing sink is ignored.
        try {
          onDelta?.(c);
        } catch {
          // the sink must never change the outcome
        }
      } else if (c.type === 'stop') reason = c.reason;
    }
  } catch (err) {
    failed = err ?? new Error('provider failed');
  } finally {
    untrack();
    untrackRun?.();
  }
  const aborted = ac.signal.aborted || reason === 'aborted';
  if (failed !== undefined && !aborted) {
    try {
      deps.log?.warn({ provider: provider.id, model: req.model, taskId, ...failureInfo(failed, provider.id) }, 'model call failed');
      deps.incidents?.report({ source: `provider ${provider.id}`, stage: 'llm.call', err: providerFault(failed, provider.id), actor: actor.kind === 'head' ? { kind: 'head', dept: actor.dept } : { kind: 'persona', personaId: actor.personaId }, ...(task ? { taskId: task.id, taskTitle: task.title } : {}) });
    } catch {
      // diagnostics must never change the outcome
    }
  }
  let costUsd = 0;
  try {
    if (usage) {
      costUsd = costOf(usage);
      await deps.budget.settle(res.reservationId, costUsd);
    } else if (req.route === 'fallback' && !aborted && (failed as { diag?: unknown } | undefined)?.diag === MID_STREAM_DIAG) {
      // R8 PV-C04: the API stream had started, so Anthropic billed the input although no usage reached us; settle at the reserved estimate, never $0.
      costUsd = est;
      await deps.budget.settle(res.reservationId, costUsd);
    } else {
      await deps.budget.release(res.reservationId);
    }
    for (const id of extra) await deps.budget.release(id);
  } catch {
    // The reservation stays held (conservative); stop rather than run on an unmetered call.
    await deps.audit({ actor: who, action: 'budget.settle', taskId, model: req.model, outcome: 'error' });
    return { kind: 'meter', phase: 'settle' };
  }
  await deps.audit({
    actor: who, action: 'llm.call', taskId, provider: provider.id, model: req.model,
    tokensIn: usage?.inputTokens ?? null, tokensOut: usage?.outputTokens ?? null, costUsd,
    outcome: aborted ? 'aborted' : failed !== undefined ? 'error' : reason,
  });
  // The failure came from a refused/failed retry reservation: same outcome as a refused first reservation.
  if (retryStop !== undefined && failed !== undefined && !aborted) return retryStop === 'error' ? { kind: 'meter', phase: 'reserve' } : refused(retryStop);
  return { kind: 'done', blocks, text, reason, costUsd, aborted, ...(failed !== undefined && !aborted ? { failed } : {}) };
}

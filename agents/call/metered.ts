import { PRAW_DEFAULT_MODEL } from '../../company/seed.js';
import type { ActorRef } from '../../company/types.js';
import type { ConfigStore } from '../../config/store.js';
import type { Task } from '../../db/repos/tasks.js';
import type { Halt } from '../../governance/halt.js';
import type { ProviderRegistry } from '../../providers/registry.js';
import type { ChatMessage } from '../../providers/types.js';
import { budgetText, callProvider, type CallDeps } from './call.js';

/** PF21: media work (OCR, receipts, STT) always runs on this provider, whatever the calling head runs on. */
export const METERED_PROVIDER = 'gemini';

/** `tool` is the spend rollup label (`ocr`, `stt`, `vision`, ...): a lowercase word, anything else is booked as `other`. */
export type MeteredCall = { actor: ActorRef; task: Task | null; system: string; messages: ChatMessage[]; maxTokens: number; model?: string; tool?: string };

/**
 * A model call for tools (Task 32): the same reserve -> stream (halt-tracked) -> settle -> `llm.call` audit path as the agent loop,
 * attributed to the calling actor and task. Tools get only this closure, never a provider, key or registry (D16). It throws a
 * MeteredError with fixed text when the call is refused or fails; nothing upstream is quoted.
 */
export interface MeteredModel {
  call(a: MeteredCall): Promise<{ text: string; costUsd: number }>;
}

export type MeteredFailure = 'halted' | 'unavailable' | 'budget' | 'failed' | 'refusal';
export class MeteredError extends Error {
  override readonly name = 'MeteredError';
  constructor(readonly reason: MeteredFailure, message: string) {
    super(message);
  }
}

export type MeteredDeps = {
  providers: Pick<ProviderRegistry, 'has' | 'get'>;
  /** Kept for parity with the loop's deps; pricing is read through `budget.costOf`. */
  cfg: Pick<ConfigStore, 'get'>;
  budget: CallDeps['budget'];
  audit: CallDeps['audit'];
  log?: CallDeps['log'];
  incidents?: CallDeps['incidents'];
  halt: Pick<Halt, 'isHalted' | 'track'>;
};

export function createMeteredModel(d: MeteredDeps): MeteredModel {
  return {
    async call(a) {
      if (d.halt.isHalted()) throw new MeteredError('halted', 'The company is halted. Nothing was run.');
      if (!d.providers.has(METERED_PROVIDER)) throw new MeteredError('unavailable', 'Gemini is not available here (no key is configured), so attachments cannot be read.');
      const provider = d.providers.get(METERED_PROVIDER);
      const model = a.model ?? PRAW_DEFAULT_MODEL;
      // No tools: the model can only answer with text (D16).
      const req = { model, system: a.system, messages: a.messages, tools: [], maxTokens: a.maxTokens };
      const o = await callProvider(req, provider, a.actor, a.task, d, undefined, undefined, a.tool);
      // No cap approval is requested from here: a tool call that hits a cap is simply refused.
      if (o.kind === 'refused' && o.scope === 'task') throw new MeteredError('budget', 'This task tree reached its budget.');
      if (o.kind !== 'done') throw new MeteredError('budget', budgetText(o, model));
      if (o.aborted) throw new MeteredError('halted', 'The call was stopped (halted).');
      if (o.failed !== undefined) throw new MeteredError('failed', 'The model provider failed after retries. Try again later.');
      if (o.reason === 'refusal') throw new MeteredError('refusal', 'The model declined this request.');
      return { text: o.text, costUsd: o.costUsd };
    },
  };
}

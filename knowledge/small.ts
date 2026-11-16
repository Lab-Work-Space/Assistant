import type { ActorRef } from '../company/types.js';
import type { ConfigStore } from '../config/store.js';
import type { Task } from '../db/repos/tasks.js';
import { callProvider, type CallDeps } from '../agents/call/call.js';
import { resolveActor, type ActorProfile } from '../agents/context.js';
import type { Org } from '../company/org.js';
import type { PromptDoc } from '../prompts/index.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { reportFallback } from '../providers/fallback-gate.js';
import { fallbackRequest, resolveEffective, type FallbackState, type RouteKind } from '../providers/route.js';
import type { LLMProvider } from '../providers/types.js';

export type SmallDeps = {
  providers: Pick<ProviderRegistry, 'resolve'> & Partial<Pick<ProviderRegistry, 'has' | 'get'>>;
  cfg: Pick<ConfigStore, 'get'> & Partial<Pick<ConfigStore, 'listenerHealthy'>>;
  /** The same metered call core the agent loop uses: reserve, stream, settle, audit. */
  call: CallDeps;
  /** Where the actor's own provider selection comes from (the org rows and prompts the agent loop uses). Absent = `provider.default`. */
  profiles?: { org: Org; prompts: Map<string, PromptDoc>; overrides: Parameters<typeof resolveActor>[3] };
  /** OPS-HOLD: while the Claude subscription quota is held a helper call on claude-code-local fails fast (`ok:false`), spawning nothing. */
  quotaHold?: { heldUntil(): number | null };
  /** R8 PROV-FALLBACK: the Claude API backup gate. `classify` may use the backup during the hold; the other labels fail fast. Absent: `quotaHold` alone, today's fail-fast. */
  fallback?: FallbackState;
};

type ProviderSelection = ActorProfile['sel'];

/**
 * PROV-HELPER (supersedes K8/K15 "cheapest"): a helper call uses the provider of the calling actor's own profile, resolved exactly as the
 * agent loop and the judge do (`providers.resolve(profile.sel, cfg)`). Owner rule: only the department `praw` uses Gemini; every other
 * department uses `provider.default` (Claude). Picking the cheapest model across providers is forbidden: it sent every department to Gemini.
 * With no profile source, an unknown department or persona, or a failed profile read, the fallback is `provider.default` and never another
 * provider. A provider that is not registered here gives null (`no_model`). The resolved model is used as is (no downshift).
 */
export async function resolveSmall(d: Pick<SmallDeps, 'providers' | 'cfg' | 'profiles' | 'quotaHold' | 'fallback'>, actor: ActorRef, opts: { allowFallback?: boolean; taskId?: string } = {}): Promise<{ provider: LLMProvider; model: string; route: RouteKind; deptId: string } | null> {
  let sel: ProviderSelection = {};
  let deptId = '';
  if (d.profiles) {
    try {
      const profile = await resolveActor(actor, d.profiles.org, d.profiles.prompts, d.profiles.overrides);
      if (typeof profile !== 'string') { sel = profile.sel; deptId = profile.deptId; }
    } catch {
      sel = {};
    }
  }
  // R8: the one route function. Without a fallback gate a plain hold still means "held" for the subscription provider (today's fail-fast).
  const fb: FallbackState | undefined = d.fallback ?? (d.quotaHold ? { heldUntil: () => d.quotaHold!.heldUntil(), usable: () => false, mark: () => undefined } : undefined);
  try {
    return { ...resolveEffective(d.providers, { sel, deptId }, actor, d.cfg, fb, { ...(opts.allowFallback === undefined ? {} : { allowFallback: opts.allowFallback }), ...(opts.taskId ? { taskId: opts.taskId } : {}) }), deptId };
  } catch {
    return null;
  }
}

export type SmallResult = { ok: true; text: string; costUsd: number } | { ok: false; reason: 'no_model' | 'budget' | 'failed' | 'timeout' | 'refused' };

/** One tool-less, capped, metered call on the actor's own provider and model with a hard timeout. Anything but a clean answer is `ok: false`. */
export async function smallCall(d: SmallDeps, o: { actor: ActorRef; task: Task | null; system: string; user: string; maxTokens: number; timeoutMs: number; /** SPEND-1 rollup label (`reflect`, `review`, `classify`). */ tool?: string }): Promise<SmallResult> {
  // R8: only `classify` (a person's proposal) may use the backup; reflect and review fail fast during the hold, as before.
  const pick = await resolveSmall(d, o.actor, { allowFallback: o.tool === 'classify', ...(o.task ? { taskId: o.task.id } : {}) });
  if (!pick) return { ok: false, reason: 'no_model' };
  if (pick.route === 'held') return { ok: false, reason: 'failed' }; // fail fast: no spawn, no reservation, no task effect
  const onApi = pick.route === 'fallback';
  const ctx = { actor: o.actor, deptId: pick.deptId, taskId: o.task?.id };
  // Reflect and review are bot-only work: they queue behind people's calls on the local provider's slots. The classifier answers a person's proposal.
  const priority = o.tool === 'classify' ? {} : { priority: 'bot' as const };
  const base: Parameters<typeof callProvider>[0] = { model: pick.model, system: o.system, messages: [{ role: 'user', content: [{ type: 'text', text: o.user }] }], tools: [], maxTokens: o.maxTokens, ...priority };
  const call = callProvider(onApi ? fallbackRequest(base) : base, pick.provider, o.actor, o.task, d.call, undefined, undefined, o.tool);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), o.timeoutMs); timer.unref?.(); });
  try {
    const out = await Promise.race([call, timeout]);
    if (out === 'timeout') { call.catch(() => undefined); return { ok: false, reason: 'timeout' }; }
    if (onApi) reportFallback(d.fallback, ctx, out); // PV-C09: the gate learns from the helper's outcomes too
    if (out.kind !== 'done') return { ok: false, reason: 'budget' };
    if (out.failed !== undefined || out.aborted || out.reason === 'refusal' || out.reason === 'max_tokens') return { ok: false, reason: out.reason === 'refusal' ? 'refused' : 'failed' };
    return { ok: true, text: out.text, costUsd: out.costUsd };
  } catch {
    return { ok: false, reason: 'failed' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

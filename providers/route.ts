import type { ActorRef } from '../company/types.js';
import type { ConfigStore } from '../config/store.js';
import { fromLocalModel } from './claude-code-local/protocol.js';
import type { ProviderRegistry } from './registry.js';
import { CLAUDE_LOCAL_ID, type ChatRequest, type ContentBlock, type LLMProvider } from './types.js';

/**
 * R8 PROV-FALLBACK (Gate 1 S1): the fallback target and the excluded departments are CODE constants. No config row, selection, prompt or
 * model output reaches either one.
 */
export const FALLBACK_PROVIDER = 'claude';
export const FALLBACK_EXCLUDED_DEPTS: readonly string[] = Object.freeze(['praw']);
/** The config switch (a HANDLER key, default false). */
export const FALLBACK_SWITCH = 'provider.fallback.enabled' as const;

export type RouteKind = 'primary' | 'fallback' | 'held';
/** `held` carries the PRIMARY provider (never `claude`, PV-C02): the caller makes no call and the work waits. */
export type Effective = { provider: LLMProvider; model: string; route: RouteKind };

/** What a fallback-route caller reports back; the gate turns it into a block for the rest of the hold episode (or day, or task). */
export type FallbackMark =
  | { kind: 'api_off'; status: number }
  | { kind: 'api_busy'; status: number }
  /** PV-C06: an HTTP 400 on the fallback route holds that task only (a Console spend limit answers 400; anyone can also cause one). */
  | { kind: 'task_400'; taskId: string }
  | { kind: 'budget'; scope: 'company' | 'bot' | 'dept'; actor: ActorRef; dept: string };

/** The placeholder every media block becomes on the fallback route (the same text the CLI protocol uses): no attachment bytes go to the API. */
export const MEDIA_PLACEHOLDER = '[attachment omitted]';

/**
 * R8: the request as the fallback route sends it: tagged `route: 'fallback'` (no server-side fallback beta, mid-stream failures settle at the
 * estimate) and every `media` block replaced by the placeholder (the API would send image bytes and refuse PDFs). Does not mutate its input.
 */
export function fallbackRequest(req: ChatRequest): ChatRequest {
  return {
    ...req, route: 'fallback',
    messages: req.messages.map((m) => ({ ...m, content: m.content.map((b): ContentBlock => (b.type === 'media' ? { type: 'text', text: MEDIA_PLACEHOLDER } : b)) })),
  };
}

export interface FallbackState {
  /** The quota hold (QuotaStore.heldUntil): null while no hold is on. */
  heldUntil(): number | null;
  /** Whether the gate lets this actor, department and task use the API now (the switch is read separately). */
  usable(actor: ActorRef, deptId: string, taskId?: string): boolean;
  mark(e: FallbackMark): void;
  /** A call was made on the fallback route (the end alert reports API spend only then). Optional so a test double can leave it out. */
  noteUsed?(): void;
}

type RouteRegistry = Pick<ProviderRegistry, 'resolve'> & Partial<Pick<ProviderRegistry, 'has' | 'get'>>;
type RouteConfig = Pick<ConfigStore, 'get'> & Partial<Pick<ConfigStore, 'listenerHealthy'>>;
type Profile = { sel: Parameters<ProviderRegistry['resolve']>[0]; deptId: string };

/**
 * PV-C08: the switch is on only when the row reads exactly `true` AND the config listener is provably healthy (while its LISTEN connection
 * is down the cache can be stale, so an owner who switched it off with psql may not be seen). A read error, or a config without the
 * health probe, reads as off.
 */
export function fallbackEnabled(cfg: RouteConfig): boolean {
  try {
    if (typeof cfg.listenerHealthy !== 'function' || cfg.listenerHealthy() !== true) return false;
    return cfg.get(FALLBACK_SWITCH) === true;
  } catch {
    return false;
  }
}

/**
 * The ONE route function (G4 pins that nothing else calls the registry's `resolve`). Returns the actor's primary provider unless a quota hold
 * is on and the actor is eligible for the Claude API backup. Order: a throw from `registry.resolve` propagates (the loop shows "Unavailable");
 * a primary that is not claude-code-local ends here (praw on Gemini always does); no hold means the primary; then every eligibility test, and
 * any doubt or fault in them gives `held` (fail closed).
 */
export function resolveEffective(
  registry: RouteRegistry,
  profile: Profile,
  actor: ActorRef,
  cfg: RouteConfig,
  fb?: FallbackState,
  opts: { allowFallback?: boolean; taskId?: string } = {},
): Effective {
  const primary = registry.resolve(profile.sel, cfg);
  if (primary.provider.id !== CLAUDE_LOCAL_ID) return { ...primary, route: 'primary' };
  if (!fb) return { ...primary, route: 'primary' };
  const held = { ...primary, route: 'held' as const };
  try {
    if (fb.heldUntil() === null) return { ...primary, route: 'primary' };
    if (typeof profile.deptId !== 'string' || !profile.deptId || FALLBACK_EXCLUDED_DEPTS.includes(profile.deptId)) return held;
    if (opts.allowFallback === false) return held;
    if (!fallbackEnabled(cfg)) return held;
    if (typeof registry.has !== 'function' || typeof registry.get !== 'function' || !registry.has(FALLBACK_PROVIDER)) return held;
    if (!fb.usable(actor, profile.deptId, opts.taskId)) return held;
    const model = fromLocalModel(primary.model);
    if (model === null || !Object.hasOwn(cfg.get('pricing'), model)) return held;
    return { provider: registry.get(FALLBACK_PROVIDER), model, route: 'fallback' };
  } catch {
    return held;
  }
}

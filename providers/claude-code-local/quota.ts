import { z } from 'zod';
import { isQuotaRejection, ProviderError, QUOTA_REJECTED_DIAG } from '../types.js';

/**
 * USAGE-1: the subscription quota the CLI reports in its `rate_limit_event` stream event. Only numeric/enum fields are read; the event's
 * uuid, session id and every other field are never copied. An invalid window is dropped, an unusable event is ignored (null).
 */
export const QUOTA_WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'] as const;
export type QuotaWindowName = (typeof QUOTA_WINDOWS)[number];
export const QUOTA_STATUSES = ['allowed', 'allowed_warning', 'rejected', 'unknown'] as const;
export type QuotaStatus = (typeof QUOTA_STATUSES)[number];
export type QuotaWindow = { utilization: number; resetsAt: number; status: QuotaStatus };
export type QuotaSnapshot = {
  status: QuotaStatus;
  /** One of the window names, or 'unknown' (including the CLI's overage type). */
  rateLimitType: QuotaWindowName | 'unknown' | null;
  windows: Partial<Record<QuotaWindowName, QuotaWindow>>;
};

const STATUS_SET: ReadonlySet<unknown> = new Set(['allowed', 'allowed_warning', 'rejected']);
const status = z.unknown().transform((v): QuotaStatus => (STATUS_SET.has(v) ? (v as QuotaStatus) : 'unknown'));
const util = z.number().min(0).max(1.5);
const epoch = z.number().int().positive().max(4_102_444_800);
const windowSchema = z.object({ utilization: util, resetsAt: epoch, status });
const topSchema = z.object({
  status,
  rateLimitType: z.unknown().transform((v): QuotaSnapshot['rateLimitType'] => (typeof v !== 'string' ? null : (QUOTA_WINDOWS as readonly string[]).includes(v) ? (v as QuotaWindowName) : 'unknown')),
  resetsAt: epoch.optional().catch(undefined),
  utilization: util.optional().catch(undefined),
  unifiedWindows: z.record(z.string(), z.unknown()).optional().catch(undefined),
});

export function parseRateLimitEvent(e: unknown): QuotaSnapshot | null {
  const info = (e as { rate_limit_info?: unknown } | null)?.rate_limit_info;
  if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
  const top = topSchema.safeParse(info);
  if (!top.success) return null;
  const windows: QuotaSnapshot['windows'] = {};
  for (const name of QUOTA_WINDOWS) {
    const w = windowSchema.safeParse(top.data.unifiedWindows?.[name]);
    if (w.success) windows[name] = { utilization: w.data.utilization, resetsAt: w.data.resetsAt, status: w.data.status };
  }
  const type = top.data.rateLimitType ?? null;
  const t = type && type !== 'unknown' ? type : null;
  if (t && !windows[t] && top.data.utilization !== undefined && top.data.resetsAt !== undefined) {
    windows[t] = { utilization: top.data.utilization, resetsAt: top.data.resetsAt, status: top.data.status };
  }
  if (Object.keys(windows).length === 0) return null;
  return { status: top.data.status, rateLimitType: type, windows };
}

/**
 * OPS-HOLD: the subscription quota rejected the call. Classified from the structured `rate_limit_event` (status 'rejected') seen in the same attempt together
 * with a failed call (error result or non-zero exit), never from the CLI's error text. Fixed message, not retryable (the same call would be rejected again).
 */
export { isQuotaRejection, QUOTA_REJECTED_DIAG };
export const quotaRejection = (): ProviderError => new ProviderError('claude-code-local: subscription quota rejected the call', { retryable: false, diag: QUOTA_REJECTED_DIAG });
/** The windows whose rejection stops every Claude-backed bot; a per-model window only does so when the CLI rejected the call itself (top-level status). */
export const SHARED_WINDOWS: readonly QuotaWindowName[] = ['five_hour', 'seven_day'];
/**
 * R1-01: the ONE rule for "this snapshot starts a hold": a shared window is rejected, or the top-level status is rejected. `quotaHoldUntil` (governance/quota) applies it
 * (plus the reset/staleness clock) and `eventRejected` classifies with it, so a call is only requeued as a quota rejection when a hold will actually follow.
 */
export function snapshotRejectsHold(s: QuotaSnapshot): boolean {
  return s.status === 'rejected' || SHARED_WINDOWS.some((n) => s.windows[n]?.status === 'rejected');
}
/** Whether a raw `rate_limit_event` says the call was rejected in a way that holds (see snapshotRejectsHold). An unusable event (no parsed snapshot) starts no hold, so it is not a quota rejection. */
export function eventRejected(_e: unknown, parsed: QuotaSnapshot | null): boolean {
  return parsed ? snapshotRejectsHold(parsed) : false;
}

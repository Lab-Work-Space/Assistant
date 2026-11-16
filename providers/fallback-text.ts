/**
 * R8 PROV-FALLBACK alert and line builders. Every text is fixed wording plus numbers and enums only (Gate 1 S6, PV-C10): nothing here
 * accepts a provider message, a model answer or a task text, and a value that is not a finite number prints as a fixed placeholder, never as itself.
 * `when` and `label` come from code (the quota store's own reset text and window label).
 */
const usd = (n: unknown): string => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(2) : '?');
const count = (n: unknown): string => (typeof n === 'number' && Number.isInteger(n) && n >= 0 ? String(n) : '?');
const http = (s: unknown): string => (typeof s === 'number' && Number.isInteger(s) && s >= 100 && s <= 599 ? `HTTP ${s}` : 'an error');
const calls = (n: unknown): string => `${count(n)} ${n === 1 ? 'call' : 'calls'}`;

/** The two fixed lines the loop and the helpers use when work waits or a task-less run cannot be re-run by itself. */
export const WAITS_TEXT = 'The Claude subscription quota is used up. This work waits and resumes by itself after the quota resets.';
export const SEND_AGAIN_TEXT = 'The subscription quota just ran out. Send your message again to get a reply on the backup route.';

/** A1: the hold started and the backup will serve. */
export const alertEngage = (a: { label: string; capUsd: number; when: string }): string =>
  `The ${a.label} Claude quota is used up. Bots except Praw continue on the Claude API (metered; company cap $${usd(a.capUsd)}/day) until ${a.when}.`;

/** A1 variant: the switch is on but no API key is registered, so the work waits. */
export const alertBackupUnavailable = (a: { label: string; when: string }): string =>
  `The ${a.label} Claude quota is used up. The Claude API backup is unavailable: no API key. The bots will idle until ${a.when}.`;

/** A2: the hold is over; the API spend is added only when the backup ran. */
export const alertEnd = (spent: { usd: number; calls: number } | null): string =>
  `The Claude quota hold is over. Bots are back on the subscription.${spent ? ` Claude API spend today: $${usd(spent.usd)} (${calls(spent.calls)}).` : ''}`;

/** A3: the API refused the backup (401, 402, 403, or a 400 on a task): numbers only. */
export const alertApiOff = (a: { status: number; when: string }): string =>
  `The Claude API backup was refused (${http(a.status)}). Claude-backed bots now wait until ${a.when}.`;

/** A4: the API is busy (429, 5xx, 529 after the SDK's own retries). */
export const alertApiBusy = (a: { status: number }): string => `The Claude API is busy (${http(a.status)}). Backup work pauses 5 minutes.`;

/** `/usage range:quota` line. */
export const usageBackupLine = (a: { enabled: boolean; route: 'subscription' | 'Claude API' | 'held'; usd: number; capUsd: number }): string =>
  `Backup: ${a.enabled ? 'on' : 'off'} · route: ${a.route} · Claude API today $${usd(a.usd)} / company cap $${usd(a.capUsd)}`;

/** Weekly spend summary line. */
export const weeklyApiLine = (a: { usd: number; calls: number }): string => `Claude API (metered) last week: $${usd(a.usd)}, ${calls(a.calls)}`;

/** A3 variant for a per-task HTTP 400 (PV-C06): the refusal is about one task, so the text does not say the bots wait. */
export const alertTaskRefused = (a: { status: number }): string => `The Claude API refused one task's request (${http(a.status)}). That task waits until the hold ends; other work continues on the backup.`;

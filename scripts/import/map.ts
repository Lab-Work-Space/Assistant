import { isDenied } from '../../company/denylist.js';
import type { JobRepo } from '../../db/repos/jobs.js';
import type { LessonRepo } from '../../db/repos/lessons.js';
import type { ReminderRepo } from '../../db/repos/reminders.js';
import type { WatchRepo } from '../../db/repos/watches.js';
import type { Resolver } from '../../net/guard.js';
import { planLesson } from '../../tools/plugins/lessons/index.js';
import { planReminder, TEXT_MAX } from '../../tools/plugins/reminders/index.js';
import { PROMPT_MAX } from '../../tools/plugins/schedule/index.js';
import { MIN_INTERVAL_MINUTES, planJob } from '../../tools/plugins/schedule/time.js';
import { clip } from '../../tools/plugins/watch/diff.js';
import { planWatch } from '../../tools/plugins/watch/index.js';
import { idText, num, str, type SourceRow } from './source.js';

export interface Repos { reminders: ReminderRepo; jobs: JobRepo; watches: WatchRepo; lessons: LessonRepo }
export interface Ctx { guildId: string; tz: string; nowMs: number; resolver: Resolver; lessonMax: number }
/** `skip` drops the row (counted by reason); `notes` count adjustments on a row that is still imported. */
export type Mapped = { skip: string } | { legacyId: number; notes: string[]; add: (r: Repos) => Promise<unknown> };

export const SNAPSHOT_MAX = 6000;
const MAX_INTERVAL = 525_600;

/** Rows from another guild or a denied channel (D8) never come in. */
function place(row: SourceRow, ctx: Ctx): { guildId: string; channelId: string; userId: string } | string {
  const guildId = idText(row.guild_id), channelId = idText(row.channel_id), userId = idText(row.user_id);
  if (!guildId || !channelId || !userId) return 'invalid';
  if (guildId !== ctx.guildId) return 'foreign_guild';
  if (isDenied(channelId, null)) return 'denied_channel';
  return { guildId, channelId, userId };
}
const epochDate = (v: unknown): Date | null => { const n = num(v); return Number.isFinite(n) ? new Date(n * 1000) : null; };

export function mapReminder(row: SourceRow, ctx: Ctx): Mapped {
  if (num(row.fired) !== 0) return { skip: 'fired' };
  const at = place(row, ctx);
  if (typeof at === 'string') return { skip: at };
  const text = str(row.text).trim(), when = epochDate(row.remind_at);
  if (!text || text.length > TEXT_MAX || !when) return { skip: 'invalid' };
  const adv = row.advance_minutes === undefined ? 0 : num(row.advance_minutes);
  const via = row.notify_via === 'dm' ? 'dm' : 'channel';
  const plan = planReminder({ text, when: when.toISOString(), ...(adv > 0 ? { advanceMinutes: adv } : {}), notifyVia: via }, ctx.nowMs, ctx.tz);
  // Past-due and unfired (the old bot was down): kept, it fires on the first sweep. Too far ahead or malformed: dropped.
  if ('error' in plan && when.getTime() > ctx.nowMs) return { skip: 'invalid' };
  const remindAt = 'error' in plan ? when : plan.remindAt;
  const advanceMinutes = 'error' in plan ? null : plan.advanceMinutes;
  const legacyId = num(row.id);
  return { legacyId, notes: [], add: (r) => r.reminders.add({ ...at, text, remindAt, advanceMinutes, notifyVia: via, legacyId }, 'unlimited') };
}

export function mapJob(row: SourceRow, ctx: Ctx): Mapped {
  if (num(row.active) !== 1) return { skip: 'inactive' };
  const at = place(row, ctx);
  if (typeof at === 'string') return { skip: at };
  const prompt = str(row.prompt).trim(), next = epochDate(row.next_run_at), kind = str(row.schedule_kind);
  if (!prompt || prompt.length > PROMPT_MAX || !next) return { skip: 'invalid' };
  const notes: string[] = [];
  const legacyId = num(row.id);
  const job = (extra: { hhmm?: string; tz?: string; intervalMinutes?: number }, k: 'daily' | 'interval' | 'once'): Mapped => ({
    legacyId, notes, add: (r) => r.jobs.add({ ...at, prompt, origin: 'import', kind: k, nextRunAt: next, legacyId, ...extra }, 'unlimited'),
  });
  if (kind === 'once') return job({}, 'once'); // keeps its absolute time; planJob would refuse a past one
  if (kind === 'daily') {
    const p = planJob({ kind: 'daily', hhmm: str(row.daily_hhmm) }, ctx.nowMs, ctx.tz);
    return 'error' in p ? { skip: 'invalid' } : job({ hhmm: p.hhmm!, tz: ctx.tz }, 'daily'); // R10: epoch kept, --tz for later runs
  }
  if (kind === 'interval') {
    let n = num(row.interval_minutes);
    if (!Number.isInteger(n) || n > MAX_INTERVAL) return { skip: 'invalid' };
    if (n < MIN_INTERVAL_MINUTES) { n = MIN_INTERVAL_MINUTES; notes.push('interval_raised'); }
    return job({ intervalMinutes: n }, 'interval');
  }
  return { skip: 'invalid' };
}

export async function mapWatch(row: SourceRow, ctx: Ctx): Promise<Mapped> {
  if (num(row.active) !== 1) return { skip: 'inactive' };
  const at = place(row, ctx);
  if (typeof at === 'string') return { skip: at };
  const kind = str(row.kind), target = str(row.target).trim(), next = epochDate(row.next_check_at);
  if ((kind !== 'url' && kind !== 'topic') || !target || target.length > 2000 || !next) return { skip: 'invalid' };
  const notes: string[] = [];
  let intervalMinutes = num(row.interval_minutes);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes > MAX_INTERVAL) return { skip: 'invalid' };
  if (intervalMinutes < MIN_INTERVAL_MINUTES) { intervalMinutes = MIN_INTERVAL_MINUTES; notes.push('interval_raised'); }
  const plan = await planWatch({ kind, target, intervalMinutes }, { resolver: ctx.resolver, extraPorts: () => [] });
  let enabled = true, finalTarget = target;
  if ('error' in plan) {
    if (kind === 'topic') return { skip: 'invalid' };
    // P21: a url that fails the SSRF check comes in disabled, never with embedded credentials (an unparsable one is not imported)
    const clean = withoutCredentials(target);
    if (clean === null) return { skip: 'invalid' };
    if (clean !== target) notes.push('credentials_stripped');
    enabled = false;
    finalTarget = clean;
    notes.push('disabled_url');
  } else finalTarget = plan.target;
  const snap = typeof row.last_snapshot === 'string' ? clip(row.last_snapshot, SNAPSHOT_MAX) : null;
  const hrefs = parseHrefs(row.last_hrefs_json);
  const legacyId = num(row.id);
  return { legacyId, notes, add: (r) => r.watches.add({ ...at, kind, target: finalTarget, intervalMinutes, nextCheckAt: next, legacyId, enabled,
    lastSnapshot: snap, lastHrefs: hrefs, hasBaseline: num(row.has_baseline) === 1 }, 'unlimited') };
}

/** The url with any user:pass@ removed; null when it is not a parsable url. */
function withoutCredentials(t: string): string | null {
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (!u.username && !u.password) return t;
  u.username = '';
  u.password = '';
  return u.href;
}

function parseHrefs(v: unknown): string[] | null {
  if (typeof v !== 'string') return null;
  try {
    const a: unknown = JSON.parse(v);
    return Array.isArray(a) && a.every((x) => typeof x === 'string') ? (a as string[]).slice(0, 200) : null;
  } catch { return null; }
}

export function mapLesson(row: SourceRow, ctx: Ctx): Mapped {
  if (num(row.active) !== 1) return { skip: 'inactive' };
  const p = planLesson(str(row.text), ctx.lessonMax);
  if ('error' in p) return { skip: 'invalid' };
  const legacyId = num(row.id);
  return { legacyId, notes: [], add: (r) => r.lessons.add({ text: p.text, source: 'import', authorId: null, origin: 'import', legacyId }) };
}

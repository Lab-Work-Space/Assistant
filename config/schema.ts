import { z } from 'zod';
import { DEPT_IDS } from '../core/env.js';
import { DUTY_IDS } from '../company/duties.js';
import { CompanyProfileSchema } from '../company/profile.js';
import { WELCOME_RAID_MAX, WELCOME_RAID_MIN, welcomeMessageProblem } from './welcome.js';

// Finite, non-negative, capped: rejects NaN, +-Infinity, 1e308 and negatives (Gate 1 D4).
const usd = z.number().finite().min(0).max(1_000_000);
/** SPEND-1 (SP-01): the one maximum for every spend money value: numeric(12,6) holds at most 999999.999999, so 1e6 would overflow a column. */
export const SPEND_MAX_USD = 999_999.99;
const spendUsd = z.number().finite().min(0).max(SPEND_MAX_USD);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM');
const price = z.number().finite().min(0).max(100_000);
const count = (max: number) => z.number().int().min(1).max(max);

/** A real calendar date written YYYY-MM-DD (2026-02-30 is refused). */
export const isCalendarDate = (s: string): boolean => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
};

export const Holiday = z.object({
  date: z.string().refine(isCalendarDate, 'must be a date written YYYY-MM-DD'),
  name: z.string().min(1).max(60).regex(/^[^\p{Cc}]*$/u, 'no control characters').optional(),
}).strict();

export const ModelPrice = z.object({
  inPerMTok: price,
  outPerMTok: price,
  cacheReadPerMTok: price.optional(),
});

/** TW13: a weekly meeting started by code. `day` 0 = Sunday (as schedule.offDays), `time` HH:MM in schedule.timezone, topic <= 100 characters. */
export const MeetingEntry = z.object({
  day: z.number().int().min(0).max(6),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM'),
  kind: z.enum(['planning', 'progress', 'review']),
  topic: z.string().trim().min(1).max(100).regex(/^[^\p{Cc}]*$/u, 'no control characters'),
}).strict();

export const ConfigSchema = {
  'budget.companyDailyUsd': usd,
  'budget.botDailyUsd': usd,
  'budget.taskUsd': usd,
  'approval.thresholdUsd': usd,
  'approval.expiryHours': z.number().finite().min(0).max(24 * 365),
  'limits.turnsPerTask': count(1000),
  'limits.depth': count(20),
  'limits.concurrency': count(100),
  'limits.childrenPerTask': count(100),
  'limits.openTasks': count(10_000),
  'limits.humanRunsPer10Min': count(1000),
  'limits.prawPerUser10Min': count(1000),
  'limits.prawConcurrency': count(100),
  // P15 (Task 34): OCR/receipt extractions per human per UTC day (chat, /ocr, /receipt and the auto-OCR channel all count).
  'limits.visionPerUserDay': count(10_000),
  'forum.postsPerHeadPerDay': count(100),
  // Teamwork C (Gate 1 TW1-TW6, TW13, TW14): the warroom guard and its own daily pool for bot-origin runs.
  'warroom.turnsPerThreadPerHour': count(1000),
  'warroom.turnsPerHour': count(10_000),
  // WS3: min 1 on purpose; the stall guard cannot be switched off (Gate 1 WS3). Raising it is a card.
  'warroom.stallTurns': count(200),
  'warroom.localCallsPerDay': count(100_000),
  'warroom.dailyUsd': usd,
  'warroom.botDailyUsd': usd,
  'warroom.rootTasksPerDay': count(1000),
  'warroom.heldMax': count(1000),
  'meetings.adHocPerDay': z.number().int().min(0).max(20),
  'meetings.weekly': z.array(MeetingEntry).max(3).refine((a) => new Set(a.map((m) => `${m.day}|${m.time}`)).size === a.length, 'meetings must be unique'),
  // P15 (Task 37): minutes of a user's speech sent to STT per UTC day.
  'limits.voiceMinPerUserDay': count(24 * 60),
  // claude-code-local (Gate 1 L8, spec §4): calls are counted, not priced.
  'limits.localCallsPerDay': count(100_000),
  'limits.localCallsPerTask': count(10_000),
  // Work-style §6 / Gate 1 WS1: when true, EXACTLY these caps are skipped for calls that resolve to the local provider: limits.turnsPerTask,
  // limits.localCallsPerDay, limits.localCallsPerTask, warroom.localCallsPerDay, warroom.turnsPerThreadPerHour, warroom.turnsPerHour,
  // warroom.rootTasksPerDay, meetings.adHocPerDay. Every other cap and every USD scope stays. Counters keep counting.
  'limits.localUnlimited': z.boolean(),
  // WS5: alert-only (one notice a day in #bot-log); it refuses nothing. Counts bot-triggered local calls per UTC day.
  'limits.localBotCallsAlert': count(1_000_000),
  // P14: caps on user-created reminders/schedules/watches, per user and company-wide.
  'limits.remindersPerUser': count(1000),
  'limits.schedulesPerUser': count(1000),
  'limits.watchesPerUser': count(1000),
  'limits.remindersTotal': count(100_000),
  'limits.schedulesTotal': count(100_000),
  'limits.watchesTotal': count(100_000),
  // P13/PF13: lessons injected into Praw's runs (total characters) and the size of one lesson (the table also CHECKs 500).
  'lessons.promptChars': count(100_000),
  'lessons.perLessonChars': count(500),
  'limits.localConcurrency': count(16),
  'schedule.timezone': z.string().min(1).max(64).refine((tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }, 'unknown IANA time zone'),
  // Off days (company/calendar.ts): weekdays (0 = Sunday) and dated holidays in schedule.timezone; automated work waits, humans are answered.
  'schedule.offDays': z.array(z.number().int().min(0).max(6)).max(7).refine((a) => new Set(a).size === a.length, 'days must be unique'),
  'schedule.holidays': z.array(Holiday).max(100).refine((a) => new Set(a.map((h) => h.date)).size === a.length, 'dates must be unique'),
  // Extra working dates (/holiday workday): a listed date is a workday even when it is a weekly off day or a listed holiday.
  'schedule.workDays': z.array(z.string().refine(isCalendarDate, 'must be a date written YYYY-MM-DD')).max(50).refine((a) => new Set(a).size === a.length, 'dates must be unique'),
  'provider.localTimeoutMs': z.number().int().min(1000).max(3_600_000),
  'context.messages': count(500),
  halted: z.boolean(),
  'provider.default': z.object({ provider: z.string().min(1).max(64), model: z.string().min(1).max(128) }),
  // R8 PROV-FALLBACK: during a Claude quota hold, non-praw work reruns on the metered Claude API. A handler key (the owner's call); default false.
  'provider.fallback.enabled': z.boolean(),
  pricing: z.record(z.string().min(1).max(128), ModelPrice),
  // Plugin tools a department (and its personas) may call, by explicit name; edited with `/bot tools` (P16b).
  'tools.byDept': z.record(z.string().min(1).max(32), z.array(z.string().min(1).max(64)).max(100)),
  // T25/T27: ClickUp change poller interval (min 30 s) and the channel its notices go to (null = Praw's mapped home channel).
  'clickup.pollIntervalSec': z.number().int().min(30).max(86_400),
  // CLICKUP-ALL-1 (C9, C11): workspace mode only. The daily write cap (0 = writes off; raised only by a person with /settings) and the lists the poller watches (only via /clickup watch).
  'clickup.writesPerDay': z.number().int().min(0).max(500),
  'clickup.pollListIds': z.array(z.string().regex(/^[a-z0-9]{1,32}$/, 'must be a ClickUp list id')).max(10),
  // Task 34: a channel whose image posts Praw reads automatically; it must also be mapped to praw (null = off).
  'ocr.autoChannelId': z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake').nullable(),
  // Gate 1 S11-S14 (server management): the automatic welcome. Set only through admin_op_propose `welcome_set` (roles and channel are checked live there).
  /** Self-code (Gate 1 self-code): the whole feature is off until the owner sets this, and the budget/cap/owner keys are owner-set (handler keys). */
  'devjob.enabled': z.boolean(),
  /** TEAMTALK-1 kill switch: false = no handoff lines, room lines, room boards or room memory (subtask reports and the handle defang stay). Read live. */
  'teamtalk.enabled': z.boolean(),
  /** REROUTE-1 (RR-C20): a mention of a head whose bot cannot work in the channel becomes a task in its own room. Owner-only (HANDLER_KEYS). */
  'reroute.enabled': z.boolean(),
  /** ASKBACK-1 (AB10): a task owner may ask its requester one clarifying question (read live). Owner-only (HANDLER_KEYS). */
  'ask.enabled': z.boolean(),
  /** ASKBACK-1: how long a question waits for its answer before the owner decides alone (hours). */
  'ask.timeoutHours': z.number().int().min(1).max(72),
  /** ASKBACK-1: questions per task tree (at least 2, the per-task cap) and per day. */
  'ask.perRoot': z.number().int().min(2).max(20),
  'ask.perDay': z.number().int().min(1).max(500),
  /** STREAM-1: live reply streaming (a preview message edited while the model writes, plus the typing indicator). false = replies are posted once at the end, as before. Read live; a read error counts as off. */
  'stream.enabled': z.boolean(),
  'devjob.budgetUsd': z.number().min(0).max(1000),
  'devjob.jobCapUsd': z.number().min(0.1).max(50),
  'devjob.ownerUserId': z.string().regex(/^\d{17,20}$/).nullable(),
  'welcome.enabled': z.boolean(),
  'welcome.roleIds': z.array(z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake')).max(5).refine((a) => new Set(a).size === a.length, 'roles must be unique'),
  'welcome.message': z.string().max(500).refine((m) => welcomeMessageProblem(m) === null, 'no mentions, links or placeholders other than {user}'),
  'welcome.channelId': z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake').nullable(),
  'welcome.raidPerMinute': z.number().int().min(WELCOME_RAID_MIN).max(WELCOME_RAID_MAX),
  // Delegated tiers (Gate 1 delta T7-T10): the Moderator and Manager roles and the mod room. Set only by a Bot Admin card in #setting (config_propose, high risk,
  // checked live by the executor); the executor reads them from the config table itself and re-validates the roles at every apply.
  'roles.managerId': z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake').nullable(),
  'roles.moderatorId': z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake').nullable(),
  'roles.modRoomId': z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake').nullable(),
  'clickup.notifyChannelId': z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake').nullable(),
  // P6/AC10: repositories the GitHub write tools may change, by the id GitHub returned when an admin added them (`/github allow`).
  // The name is for display only; the deny check always uses the id and the canonical full_name fetched at call time.
  'github.repoAllowlist': z.array(z.object({ id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), fullName: z.string().min(3).max(201) }).strict()).max(200),
  // P7/PF13 (Task 36): hosts a music link may name (exact hostnames, lower case); anything else is refused before yt-dlp runs.
  // A name only: an IP literal (all-numeric labels, which WHATWG URL also reads as IPv4) would let a link aim at an address.
  'media.ytHostAllowlist': z.array(z.string().min(1).max(253).regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'must be a lower-case host name')
    .refine((h) => !/^[0-9.]+$/.test(h) && !/\.(0x[0-9a-f]*|[0-9]+)$/i.test(h), 'must be a host name, not an IP address')).min(1).max(20),
  // RFMD P5 / Gate 1 RF28: AI image and video. NOT inside `pricing` (a per-model token record). Prices have a floor > 0 (a zero or missing price refuses the call, D4);
  // the model ids and personGeneration are code constants (tools/plugins/media/pins.ts), not keys. Every change is a card; none is in LIFTED_CAPS.
  // M2: token prices per modality, USD per million tokens, floored at 50 % of the list price (a missing value refuses the call). Units per image/second are code constants (pins.ts).
  'media.image.inPerMTok': z.number().finite().min(0.75).max(1000),
  'media.image.textOutPerMTok': z.number().finite().min(3.75).max(1000),
  'media.image.imageOutPerMTok': z.number().finite().min(15).max(1000),
  'media.video.inPerMTok': z.number().finite().min(0.75).max(1000),
  'media.video.textOutPerMTok': z.number().finite().min(4.5).max(1000),
  'media.video.videoOutPerMTok': z.number().finite().min(6).max(1000),
  'media.imagesPerDay': count(1000),
  'media.videosPerDay': count(100),
  'media.imagesPerPersonPerDay': count(1000),
  'media.videosPerPersonPerDay': count(100),
  // Task 37 (P20): voice chat. Auto-leave after maxSessionMin and after idleMin without speech; silenceMs closes an utterance.
  'voice.maxSessionMin': count(24 * 60),
  'voice.idleMin': count(24 * 60),
  'voice.stt': z.enum(['gemini']),
  'voice.silenceMs': z.number().int().min(200).max(10_000),
  // Interpolated into the Edge SSML <voice name>: an Edge neural voice name only (voice/chat/tts.ts TTS_VOICE_RE).
  'voice.ttsVoice': z.string().regex(/^[a-z]{2,3}-[A-Z]{2}-[A-Za-z]+Neural$/, 'must be an Edge neural voice name like th-TH-NiwatNeural'),
  // Work-style §2 / Gate 1 WS7, WS8: category id -> the post-only approvals room of that category. Card-gated (WS9). Each value is validated live at every post.
  'approvals.channelByCategory': z.record(z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake'), z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake')).refine((r) => Object.keys(r).length <= 25, 'at most 25 categories')
    .refine((r) => new Set(Object.values(r)).size === Object.values(r).length, 'a room serves one category')
    .refine((r) => !Object.values(r).some((v) => Object.hasOwn(r, v)), 'a room cannot also be a category'),
  // Work-style §5 / Gate 1 WS11: the daily goal and evening report (CEO, workdays) are posted in this post-only channel (null = off). A handler key: the channel is checked by its plan function.
  'rhythm.dailyGoalChannelId': z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake').nullable(),
  'rhythm.dailyGoalTime': z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM'),
  'rhythm.eveningReportTime': z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM'),
  // Work-style §5 / Gate 1 WS10: the pinned counts-only dashboard (null = off). A handler key, like the above.
  'dashboard.channelId': z.string().regex(/^\d{17,20}$/, 'must be a Discord snowflake').nullable(),
  // Work-style §5 / Gate 1 WS12: department -> duties, values of the closed enum in company/duties.ts only.
  'duties.byDept': z.record(z.string(), z.array(z.enum(DUTY_IDS)).max(10)).refine((r) => Object.keys(r).every((k) => (DEPT_IDS as readonly string[]).includes(k)), 'unknown department')
    .refine((r) => Object.values(r).every((a) => new Set(a).size === a.length), 'duties must be unique'),
  // RFMD P3 / Gate 1 RF20: the legal details printed on business documents (null = unset: money and tax documents are refused). A handler key: only the Founder sets it, with /settings.
  'company.profile': CompanyProfileSchema.nullable(),
  // P4: ports safeFetch may use besides 80/443 (unprivileged only; default none).
  'net.extraPorts': z.array(z.number().int().min(1024).max(65535)).max(20),
  // WEBGRANT-1: the task web grant (one approval per task tree for fetch_page). The caps are copied into the grant row when it is made; `enabled` is read live on every use (kill switch).
  // SEARCH-1: web_search falls back to Wikipedia, Hacker News, Stack Overflow, npm and GitHub when DuckDuckGo refuses. Read live on every call (kill switch).
  'web.search.openSources': z.boolean(),
  'web.taskGrant.enabled': z.boolean(),
  'web.taskGrant.hours': z.number().finite().min(0.25).max(24),
  'web.taskGrant.maxFetches': z.number().int().min(1).max(200),
  'web.taskGrant.maxHosts': z.number().int().min(1).max(50),
  'web.taskGrant.maxUrlChars': z.number().int().min(500).max(20000),
  // TREEGRANT-1: "Approve the whole task". `enabled` is read live on every use (kill switch, the only one with a /settings path); the cap and hours are copied into the grant row when it is made.
  // `conversationHours` caps a Praw conversation root (the boot refuses conversationHours > hours); `allowTainted` is read live by the consume gate. Every key is owner-only (HANDLER_KEYS).
  'taskGrant.enabled': z.boolean(),
  'taskGrant.hours': z.number().int().min(1).max(72),
  'taskGrant.conversationHours': z.number().int().min(1).max(72),
  'taskGrant.maxCalls': z.number().int().min(1).max(500),
  'taskGrant.allowTainted': z.boolean(),
  // OT-1: overtime requests. Bounds sit inside the ot_requests CHECKs (hours <= 12, runs 1-200, usd <= 50, seq 1-5); caps are copied into the grant when it is approved.
  'ot.enabled': z.boolean(),
  'ot.hours': z.number().finite().min(0.5).max(12),
  'ot.maxRuns': z.number().int().min(1).max(200),
  'ot.maxUsd': z.number().finite().min(0.01).max(50),
  'ot.requestsPerRootPerDay': z.number().int().min(1).max(5),
  'ot.requestsPerDay': z.number().int().min(1).max(100),
  'ot.requestsPerPersonPerDay': z.number().int().min(1).max(100),
  // HEAL-1 (Gate 1 HL-C2, HL-C17): self-healing. Every key is a handler key. Only heal.enabled has a /settings path; the caps are the owner's, in the database.
  // warroom.stallQuietMinutes stays 15-360 (SA-1 C8). The two lift caps are per day in schedule.timezone; 0 switches that path off. Neither is on the WS1 local-unlimited list.
  'heal.enabled': z.boolean(),
  'heal.maxRetries': z.number().int().min(0).max(5),
  'heal.maxWakesPerTask': z.number().int().min(0).max(5),
  'heal.maxWakesPerDeciderDay': z.number().int().min(1).max(50),
  // OPS-HOLD: hours a review task waits before the code closes it (0 = off). Owner's key, psql only.
  'review.autoCloseHours': z.number().int().min(0).max(720),
  'warroom.stallQuietMinutes': z.number().int().min(15).max(360),
  'warroom.quietLiftsPerDay': z.number().int().min(0).max(24),
  'warroom.personLiftsPerDay': z.number().int().min(0).max(24),
  // AI-APPROVE-1 (Gate 1 AA-C17): the AI approver. All handler keys; only approval.ai.enabled has a /settings path, the caps are the owner's (psql). The switch defaults to off.
  'approval.ai.enabled': z.boolean(),
  'approval.ai.maxPerTree': z.number().int().min(1).max(500),
  'approval.ai.maxPerDay': z.number().int().min(1).max(5000),
  // WS-1 (SA-1 5.5, Gate 1 WS-C24): project workspaces. All handler keys. ws.enabled defaults to false until Gate 2 passes (its /settings path is added in WS-BE3); the run caps are the owner's (psql).
  'ws.enabled': z.boolean(),
  'ws.maxRunsPerTree': z.number().int().min(1).max(200),
  'ws.maxRunsPerDay': z.number().int().min(1).max(1000),
  // R6 MCP-1 (spec 5.9, Gate 1 MC-C14): external (MCP) tools. Handler keys; only `mcp.enabled` has a /settings path (risk when turned on), the caps are psql only. Read live, a read error counts as off.
  'mcp.enabled': z.boolean(),
  'mcp.maxCallsPerTree': z.number().int().min(1).max(500),
  'mcp.maxCallsPerDay': z.number().int().min(1).max(5000),
  // R7 PLUGIN-FORGE (spec 5.10, PF-C13): the plugin forge switch. A handler key with a /settings path (risk when turned on); read live at every site, a read error counts as off.
  'forge.enabled': z.boolean(),
  // R5 RELEASE-1 (Gate 1 RL-C13): the release card kill switch. A handler key (psql only, no /settings path, no AdminOp); read live, a read error counts as off.
  'release.enabled': z.boolean(),
  // AUTO-1 (Gate 1 AP-C10): project autopilot. Handler keys; only `enabled` has a /settings path (risk when turned on), the approval cap is psql only. `enabled` is read live on every use (a read error counts as off).
  'autopilot.enabled': z.boolean(),
  'autopilot.maxApprovalsPerProject': z.number().int().min(1).max(5000),
  // AUTO-2 (Gate 1 AC-C4, AC-C16): company autopilot. Handler keys. Only `autopilot.scope` has a /settings path (risk on 'company'); the caps are psql only. A read error on the scope counts as 'project'.
  'autopilot.scope': z.enum(['project', 'company']),
  'autopilot.company.maxApprovalsPerDay': z.number().int().min(1).max(10000),
  'autopilot.company.maxApprovalsPerTree': z.number().int().min(1).max(1000),
  'autopilot.company.maxApprovalsPerPersonDay': z.number().int().min(1).max(10000),
  // GROW-1 (Gate 1 GW-C27): weekly retro and AI skill review. All handler keys; only the two switches have a /settings path (skills.ai.enabled's case is added with the judge), the rest are the owner's (psql). skills.ai.enabled defaults to off.
  'grow.retro.enabled': z.boolean(),
  'grow.retro.weekday': z.number().int().min(1).max(7),
  'grow.retro.hour': z.number().int().min(0).max(23),
  'skills.ai.enabled': z.boolean(),
  // LEARN-1 (LL-C9): the incident log switch, the incident-retro threshold (0 = trigger off) and the seed-skill switch. Handler keys, owner-only (psql); no /settings path.
  'grow.incidents.enabled': z.boolean(),
  'grow.retro.incidentThreshold': z.number().int().min(0).max(50),
  'skills.seed.enabled': z.boolean(),
  'skills.ai.maxPerDeptWeek': z.number().int().min(0).max(10),
  'skills.ai.maxPerWeek': z.number().int().min(0).max(50),
  // SPEND-1 (Gate 1 S1, S19): department monthly budgets and the trend alerts. Every key is a handler key: no model-reachable path writes one.
  // Department -> monthly USD cap in schedule.timezone months; an absent department has no cap (off).
  'spend.deptMonthlyUsd': z.partialRecord(z.enum(DEPT_IDS), spendUsd),
  'spend.warnPct': z.number().int().min(50).max(99),
  'spend.anomalyMultiplier': z.number().finite().min(1.5).max(20),
  'spend.anomalyMinUsd': z.number().finite().min(0.05).max(1000),
  'spend.alertsEnabled': z.boolean(),
  'spend.weeklySummary': z.boolean(),
  'spend.weeklySummaryTime': hhmm,
  'spend.overrideStepPct': z.number().int().min(5).max(100),
  'spend.retentionDays': z.number().int().min(90).max(1830),
} as const;

export type ConfigSchemaMap = typeof ConfigSchema;
export type ConfigKey = keyof ConfigSchemaMap;
export type ConfigValue<K extends ConfigKey> = z.infer<ConfigSchemaMap[K]>;

export const isConfigKey = (k: string): k is ConfigKey => Object.hasOwn(ConfigSchema, k);

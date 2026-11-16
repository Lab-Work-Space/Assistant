# SPEND-1 — spend trends and department budget control (spec)

Owner request 2026-11-08: "the system should be able to analyse trends and control spending". Requires security gate. Migration **029_spend**. Open questions resolved with defaults (end).

## Files
governance/budget.ts, agents/call.ts, tools/plugins/media/index.ts, discord/commands/{usage,budget,definitions,index,settings}.ts, admin/keys.ts, config/{schema,defaults}.ts, core/events.ts, agents/notices.ts, dashboard/{server,pages}.ts, app.ts; new governance/spend.ts (SpendRepo, SpendWatch, SpendOverrides); migration 029.

## Actors / boundary
Bot Admin (human): /usage, /budget dept, /settings set spend.* in #⚙️-setting; presses override buttons there. Owner viewers of #🧾-bot-log (Founders + Praw, CEO, Admin bots; BOTLOG-1) get alerts and weekly summary. Model (Praw config_propose / admin_op_propose, dashboard /propose): NO path to any spend.* key or override (trust boundary). Dashboard read-only /spend page, local mode only (127.0.0.1, existing session + CSRF).

## Facts driving design
budget_days.day is a UTC date (budget.ts isoDay toISOString), no provider/tool; warroom USD booked on warroom_bot rows. audit_log cannot be the ledger (best effort — createAudit swallows store errors; no dept; media rows no provider). So new rollup `spend_days` written inside Budget.close()'s transaction (as authoritative as spent_usd).
Clocks: dept months, rollup days, trends, alerts use schedule.timezone (default Asia/Bangkok). Existing daily caps stay UTC, unchanged; /usage today|week titles gain " (UTC)".

## A. Reserve (metered only; local calls never touch dept row, L8)
1. Dept: head:<d> → d; persona:<id> → `SELECT dept_id FROM personas WHERE id=$1`; missing → `_unattributed` (no cap).
2. `{date} = localDay(now, schedule.timezone)`, month = date.slice(0,7)+'-01'; both captured on the Reservation (settle after midnight books to reserve-time keys).
3. Key `{day: month, scope:'dept', scopeId: dept}`. New global lock order: company → dept → bot → task → local → warroom → warroom_bot. Normal layout [company, dept, bot, task?]; warroom layout [company, dept, task?, warroom, warroom_bot]. Update budget.ts lock-order comment and KeyScope type.
4. `limits.dept = await opts.deptCap(dept, month, client)`: Infinity when spend.deptMonthlyUsd[dept] unset; else max(cfg value, max(new_cap_usd) of approved spend_overrides for (dept, month)) (default impl SpendOverrides.effectiveCap). Refuse when spent+reserved+est > cap + EPS.
5. Refusal `{ok:false, scope:'dept'}` + announce('dept'), key `${month}|dept|${dept}`, emits `governance.paused {scope:'dept', dept, day: month}`.
- Dept row always created for metered calls even with no cap (MTD correct when cap set mid-month). Budget.usage() SQL gets `AND scope <> 'dept'`.

## B. Settle (close())
After budget_days updates, same tx, run the rollup upsert (below). Skipped when actualUsd = 0 and not local. Local call books calls = attempts (≥1), spent 0. Sanitise: tool `^[a-z0-9_]{1,40}$` else `other`; provider sliced 64 else `unknown`; model sliced 128; dept `^[a-z_]{1,32}$` else `_unattributed`. Insert failure → settle fails → existing meter stop (fail closed).

## C. Attribution
ReserveRequest gains `attribution?: {provider?, model?, tool?}` — rollup only, never read by a limit decision. Defaults r.provider ?? 'unknown', r.model ?? '', 'llm'. callProvider gains optional trailing `tool?: string` passing attribution only when given (loop doesn't pass it; loop.test.ts:148,333 stay green). Media (index.ts:162) passes `{provider:'gemini', model:<pinned id>, tool:'image_generate'|'video_generate'}` (no provider field; RF28/RF29 comment stands). Grep callers of createMeteredModel and smallCall and pass 'ocr' | 'stt' | 'vision' | 'reflect' | 'review'.

## D. Hard stop and override (refuse-and-announce; no task waiter flow)
1. governance.paused scope dept → SpendOverrides.onStop (wired in app.ts next to scheduler.ts:190).
2. Newest decided override for (dept, month) is rejected → only #🧾-bot-log alert (claim (YYYY-MM,'stop',dept)), no card.
3. Else INSERT ... ON CONFLICT DO NOTHING on the one-pending index: new_cap = ceil_cent(max(used + est, max(cap,1) × (1 + spend.overrideStepPct/100))) capped 1e6; used = spent+reserved of dept row; expires_at = least(now() + approval.expiryHours, start of next local month).
4. Inserted → post card in #⚙️-setting (CONFIG_CHANNEL_ID): governance embed dept, month, MTD, cap → new_cap, step %; buttons `spendovr:<id>:approve` / `spendovr:<id>:reject`; alert text to #🧾-bot-log.
5. route() adds `spendovr:` prefix; decide() enforces #⚙️-setting + live Bot Admin; deferEphemeral includes spendovr:. Handler: `UPDATE spend_overrides SET status=$2, decided_by=$3, decided_at=now() WHERE id=$1 AND status='pending' AND expires_at>now() RETURNING *`; no row → "That raise expired or was already decided." (ephemeral); card edited with outcome. Audit spend.override outcome `approved|rejected cap=<old>-><new> dept month`.
6. Approval works while halted (changes a cap, runs nothing). Refused run not resumed (user/bot asks again). Cap never decreases within a month; override lapses at month end (keyed by month).

## E. SpendWatch (setInterval 60 s, unref, busy guard; $0, no model call)
- Warn (every tick): each capped dept, spent(dept row)/effectiveCap ≥ spend.warnPct/100 → claim (YYYY-MM,'warn',dept) → alert.
- Anomaly (every 5 min, intraday running spend): today = local-day sum from spend_days; median7 = median of previous 7 complete local days (missing = 0); fire if today > max(spend.anomalyMultiplier × median7, spend.anomalyMinUsd); per dept and `_company`; claim (YYYY-MM-DD,'anomaly',scope).
- Projection (hourly, capped depts): proj = MTD + mean7 × (daysInMonth − dayOfMonth), mean7 = last 7 complete local days / 7; fire if proj > cap AND MTD < cap; claim (YYYY-MM,'projection',dept).
- Weekly summary: only when not an off day and local time ≥ spend.weeklySummaryTime; claim (isoWeek(date),'summary',''), Monday holiday catches up on first workday (like selfReview.ts); previous ISO week Mon–Sun local + MTD; posted to #🧾-bot-log (BOT_LOG_CHANNEL_ID), not dashboard.channelId.
- Prune once per local day: spend_days older than spend.retentionDays; spend_alerts older than 400 days; pending overrides past expires_at → expired.
- spend.alertsEnabled=false disables warn/anomaly/projection; stop alert + card always run. Alerts run on off days and while halted.
- Claim first; post failure → posted_at null, retry up to 3 attempts, then log + incident.

## F. Views
- `/usage` new choice `range: trend` and option `by: dept|provider|tool` (default dept). Stays a configReply embed (Bot-Admin-only command reply in #⚙️-setting = admin card under the 2026-11-05 owner rule). Body: `MTD $x · 7d $a (prev 7d $b, ±p%) · 30d $c · projected month end $d (schedule.timezone days)`. Fields (≤23 group fields + "Top drivers" + "Budgets") sorted by 30d desc; each value `7d $ (±%) · 30d $ · MTD $ / cap $ (q%) · proj $` + 14-day sparkline ▁▂▃▄▅▆▇█. Top drivers: top 5 (dept·provider·tool) by 7d, top 3 roots `#<id8> dept $` (never task titles). Each value ≤1024, message ≤6000, truncate with "…".
- Weekly summary: same builder, governance embed in #🧾-bot-log, NO_PING.
- Dashboard `GET /spend` read-only, session-gated like /audit: server-rendered tables (30 days day × dept; provider and tool totals; budgets + overrides; last 50 spend_alerts). No forms, no JS, HTML-escaped. Local mode only.

## G. Setting budgets (human paths only)
`/budget dept dept:<choice> usd:<0..1e6>` or `clear:true`. `/settings set spend.deptMonthlyUsd <dept> <usd|none>` via new handlerSet case → planDeptBudget. Scalar spend.* keys via planSpendKey (schema check, risk = loosening).

## Migration 029_spend
up:
```sql
CREATE TABLE spend_days (
  day date NOT NULL,
  dept_id text NOT NULL CHECK (dept_id ~ '^[a-z_]{1,32}$'),
  provider text NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  model text NOT NULL DEFAULT '' CHECK (length(model) <= 128),
  tool text NOT NULL CHECK (tool ~ '^[a-z0-9_]{1,40}$'),
  root_id text NOT NULL DEFAULT '',
  spent_usd numeric(12,6) NOT NULL DEFAULT 0 CHECK (spent_usd >= 0),
  calls integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  PRIMARY KEY (day, dept_id, provider, model, tool, root_id)
);
CREATE INDEX spend_days_dept_day_idx ON spend_days (dept_id, day);

CREATE TABLE spend_alerts (
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(W[0-9]{2}|[0-9]{2}(-[0-9]{2})?)$'),
  kind text NOT NULL CHECK (kind IN ('warn','stop','anomaly','projection','summary')),
  scope_id text NOT NULL CHECK (length(scope_id) <= 32),
  detail jsonb,
  attempts integer NOT NULL DEFAULT 0,
  posted_at timestamptz,
  claimed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (period, kind, scope_id)
);

CREATE TABLE spend_overrides (
  id text PRIMARY KEY CHECK (id ~ '^[0-9a-f]{32}$'),
  dept_id text NOT NULL CHECK (dept_id ~ '^[a-z_]{1,32}$'),
  month date NOT NULL CHECK (extract(day FROM month) = 1),
  old_cap_usd numeric(12,6) NOT NULL CHECK (old_cap_usd >= 0),
  new_cap_usd numeric(12,6) NOT NULL CHECK (new_cap_usd > old_cap_usd AND new_cap_usd <= 1000000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  channel_id text NOT NULL,
  message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_by text,
  decided_at timestamptz
);
CREATE UNIQUE INDEX spend_overrides_one_pending ON spend_overrides (dept_id, month) WHERE status = 'pending';
CREATE INDEX spend_overrides_approved_idx ON spend_overrides (dept_id, month) WHERE status = 'approved';

-- Best-effort history: department per UTC day from budget_days (bot + warroom_bot); provider and tool are 'unknown'.
INSERT INTO spend_days (day, dept_id, provider, model, tool, root_id, spent_usd, calls)
SELECT b.day,
       coalesce(CASE WHEN b.scope_id LIKE 'head:%' THEN substr(b.scope_id, 6) END, p.dept_id, '_unattributed') AS dept_id,
       'unknown', '', 'unknown', '', sum(b.spent_usd), 0
FROM budget_days b
LEFT JOIN personas p ON b.scope_id = 'persona:' || p.id
WHERE b.scope IN ('bot', 'warroom_bot') AND b.spent_usd > 0 AND b.day >= current_date - 60
GROUP BY 1, 2;
```
down:
```sql
DROP TABLE IF EXISTS spend_overrides;
DROP TABLE IF EXISTS spend_alerts;
DROP TABLE IF EXISTS spend_days;
DELETE FROM budget_days WHERE scope = 'dept';
```
Rollup upsert in close() ($1..$8 = day, dept, provider, model, tool, root_id or '', usd, calls):
```sql
INSERT INTO spend_days (day, dept_id, provider, model, tool, root_id, spent_usd, calls)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (day, dept_id, provider, model, tool, root_id)
DO UPDATE SET spent_usd = spend_days.spent_usd + EXCLUDED.spent_usd, calls = spend_days.calls + EXCLUDED.calls
```
Trend query (group column from a fixed map, never interpolated):
```sql
SELECT to_char(day,'YYYY-MM-DD') AS day, dept_id AS "deptId", provider, tool, sum(spent_usd)::float8 AS usd, sum(calls)::int AS calls
FROM spend_days WHERE day BETWEEN $1::date AND $2::date
GROUP BY day, dept_id, provider, tool ORDER BY day
```

## Config (all in HANDLER_KEYS, admin/keys.ts:12 — none in ADMIN_CONFIG_KEYS)
spend.deptMonthlyUsd `z.partialRecord(z.enum(DEPT_IDS), usd)` default {} (off); spend.warnPct int 50..99 = 80; spend.anomalyMultiplier 1.5..20 = 3; spend.anomalyMinUsd 0.05..1000 = 0.5; spend.alertsEnabled bool = true; spend.weeklySummary bool = true; spend.weeklySummaryTime `^([01]\d|2[0-3]):[0-5]\d$` = 09:00; spend.overrideStepPct int 5..100 = 25; spend.retentionDays int 90..1830 = 400. Startup assert retentionDays ≥ 35.

## Types / errors
ReserveScope adds 'dept'. core/events.ts:21 governance.paused adds scope 'dept' + dept?: string. budgetText (call.ts:66) 'dept': "The <dept> monthly budget is used up. A Bot Admin can approve a raise in #⚙️-setting." (today falls through to "bot daily budget" — fix required). Media refusal (index.ts:169) dept: "The department's monthly budget is too small to reserve this <kind>; it was not generated." budgetPausedAlert gets dept branch. Grep every `scope ===` consumer.

## Security (Gate 1)
No model path: every spend.* key HANDLER; AdminOp budget_set stays ['daily','bot','task'] (admin/ops.ts:33); no new AdminOp, no dashboard form, no tool; overrides created only by code on a real refusal, decided only by live Bot Admin click in #⚙️-setting. Override bounds: one pending per (dept, month); never decreases; formula-bounded; ≤1e6; expires at earlier of expiry hours / month end; conditional UPDATE (no double win); 128-bit random id, no amount. No overshoot: dept row locked in global order (only media settle above reservation, already booked/reported). Fail closed: meter/rollup error → no call. Missing dept → _unattributed (uncapped by dept, still company/bot/task caps — residual). Posts: amounts, dept, provider, tool, model, task id8 only; no titles/user text; NO_PING; dashboard escapes. Alerts to #🧾-bot-log. Residuals: mid-month timezone change shifts buckets ≤1 day; backfill UTC days + unknown provider/tool; local calls never limited by dept budget (L8).

## Tests
budget.int: dept cap refuses at cap, exactly-at-cap allowed; 30 parallel reserves never overshoot; local skips dept row; warroom layout locks dept row; settle after local midnight books to reserve-time month; rollup matches spent; rollup CHECK failure throws and leaves budget_days unchanged. isAdminConfigKey(k)===false for every spend.* (pattern settings.test.ts:167); AdminOp.safeParse({op:'budget_set',scope:'dept',...}) fails. Override: double click one approval; expired refused; after rejection no new card that month; effective cap = max(config, approved overrides); one pending card under 10 concurrent stops. SpendWatch: anomaly floor with zero median; claims durable across restarts; Monday holiday → Tuesday catch-up; post failure retries 3. /usage trend ≤25 fields and ≤6000 chars. Dashboard /spend needs session.
Existing assertions that change: agents/loop.int.test.ts:116 → `[['bot',0,0.003],['company',0,0.003],['dept',0,0.003],['task',0,0.003]]`; /usage today|week titles gain " (UTC)" (commands.test.ts:512-515 still pass); loop.test.ts:148,333, budget.int.test.ts:54,197,273 stay valid.

## Defaults for open questions
Human-triggered runs not exempt from dept hard stop; projection linear from 7-day mean; anomaly baseline all 7 days + USD floor; backfill budget_days 60 days by dept only; alerts/summary post while halted; praw cappable like any dept, _company report-only.
Coordination: OT-1 (030) USD slice reads budget_days task row (unchanged here). SKILLS-1 (031) redefines admin_cards_kind_check — SPEND-1 does not touch admin_cards.

## Amendments after Gate 1 (binding; S1–S20 in docs/security/2026-11-08-gate1-spend.md win where they differ)
- SP-01: single SPEND_MAX_USD = 999999.99 used by config max, formula clamp and CHECKs (numeric(12,6) limit); cap already at max → alert, no card.
- SP-02: onStop runs on EVERY dept refusal (spawned, not awaited in reserve — SP-13); dedupe only via the DB one-pending index, not the in-memory announce Set.
- SP-03: expire stale pending rows inside the onStop tx; failed card post → row expired.
- SP-04: one dept stop alert path only (no duplicate from scheduler "budget alert"); budgetPausedAlert dept text correct (no "bot (UTC) /budget set bot").
- SP-05: a human /budget dept set or clear supersedes (expires) that month's overrides, audited; reply shows the effective cap.
- SP-06 provider/model allowlist regexes; SP-07 backfill applies dept regex via CASE; SP-08 warn/projection/cap display read the dept row MTD; SP-09 schedule.timezone gets configRisk; SP-10–SP-13 ISO week-year, attempts incremented before post, detail numbers only, code-format ids. SP-14 add classifier smallCall to attribution tools.

# OT-1 — overtime requests (spec)

Owner request 2026-11-08: "work should be able to request OT". On off days bot-to-bot/automated work is held (company/calendar.ts, Scheduler.offDay, OFFDAY-1). WORKDAY-1 lets a Bot Admin open a whole day. OT-1 lets the system REQUEST overtime for one task tree. Open questions resolved with defaults (below). Migration **030_ot_requests** (029 reserved for SPEND-1; renumber if unused).

## Files
agents/scheduler.ts, agents/warroom.ts (WarroomGuard), new governance/ot.ts + db/repos/ot-requests.ts, discord/commands/approval.ts, discord/embeds/approval.ts, tools/builtin/createTask.ts, app.ts, app-start.ts, config/defaults.ts + schema.ts, migration 030.

## Actors / boundary
Raiser: code in the Scheduler on behalf of the root's owner head (NO model tool). Decider: Bot Admin, live role per click, #⚙️-setting only. Beneficiary: one root task tree only (never another tree, warroom, schedules, watches, rhythm, meetings). Decision rests on the ot_requests DB row; customId only points at it; scope from stored root_id.

## Decisions
- D1 Code raises (via noteHeld), not a `request_ot` tool: covers all 3 hold points (owner run, roll-up, bot talk), caps bound requests, prompts untouched, no model free text on the card. `request_ot` deferred.
- D2 New table ot_requests, NOT approvals kind 'ot': resumeApproved / releaseWaiters / blockWaiters skip any task with a pending approvals row (would block tree_cap waiter release); expireOld/decideRow cancel awaiting_approval tasks via WAITS_ON; generic decide() would approve with no grant. Separate table also stays out of batching.
- Raise preconditions (`ot.raise(root, heldSummary)` from noteHeld BEFORE the OFFDAY-1 notice claim): ot.enabled; today off (calendar.isOffDay); not halted; root human-origin with thread (existing noteHeld rule); no pending request; no live grant; no request denied today for this root; today's count < ot.requestsPerRootPerDay. One indexed SELECT (noteHeld runs on every recovery pass).

## Happy path
1. Held start → noteHeld → ot.raise.
2. `INSERT ... ON CONFLICT DO NOTHING RETURNING` with seq = today's count+1, digest = 6 random bytes hex, expires_at = next local midnight in schedule.timezone.
3. If inserted: build card, post as head:hq to CONFIG_CHANNEL_ID, store card_channel_id/card_message_id. Audit ot.request.
4. OFFDAY-1 notice (still once per root per day) keeps ⏸️ prefix + next-workday date; when a request is pending adds the line "ส่งคำขอ OT ให้ Bot Admin แล้ว".
5. Approve OT (tx below). After commit: if halt landed → revoke immediately, reply halted_after_commit. Else emit `ot.approved {rootId}` → scheduler releaseRoot(rootId); edit card "OT approved by <@u> until HH:MM, runs 0/N, up to $M" + Revoke button; plain chat line in root thread "✅ อนุมัติ OT ถึง HH:MM".
6. releaseRoot(rootId): (a) take heldForWorkday entries tagged with rootId and start each via otStart; (b) guard.releaseHeldFor(rootId); (c) onTaskReady(id) for each non-human todo task of the root; (d) settleReview(id, true) for each review task of the root.
7. Each real start consumes one run (SQL below); failed consume → re-held (tagged) + noteHeld.

## Alternate / exception flows
- Deny: status denied, card closed, thread line "งานจะเริ่มวันทำงานถัดไป"; sticky for the rest of the day for that root.
- Approve whole day: only when i.channelId === CONFIG_CHANNEL_ID. Conditional UPDATE pending→workday (claim), then planWorkday(null,false,deps) + applyPlan(p,userId,deps) (same as /holiday workday, same audit). Plan error "already a workday" = success; other error → row back to pending, reply shows error. OffDayWatch releases within 60 s.
- Day became workday otherwise: onWorkday → ot.closeMoot(): pending → moot, cards closed.
- Grant exhausted (runs/USD/time): later starts held again; next noteHeld may raise seq+1 up to daily cap.
- Restart: grants persist; in-memory held items lost (as today); recovery pass sends todo tasks through runOwnerInner (sees live grant); sweepReview → settleReview (per-tree check) → recoverRollup.
- Halted: Approve OT refused `halted`; Approve whole day allowed (same as slash), held work starts after /resume via dayTurned.
- Halt revokes grants: onHalted, onResumed (as G2W-02), at boot while halted, revokeOwed retry after DB fault (paid by next live/consume). Resume never restores.
- Root ended: decision refused root_ended; consume SQL refuses.
- Card post fails: row ends `expired` (counts toward caps), incident. Store fault after a successful post: row stays pending with no buttons (undecidable, counted, lapses at midnight) (OT-C11).
- Midnight: pending rows expire via sweep; grant never crosses local midnight (grant_expires_at ≤ midnight; consume checks local_day).
- Revoke click must be that grant's own card (stored card_message_id); ended grant → "already ended". In-flight consumed run finishes.

## Sites changed (offDay() → per-tree)
Read-only `held(rootId) = offDay() && !(await ot.live(rootId, today))`; consume = otStart.
- scheduler.ts ~397 bot message into non-human task: live grant → otStart(root,start); else hold + notice as today; `guard.hold(key, start, rootId)` (tagged entry).
- ~977 settleReview: load cur first, `if (await held(cur.rootId)) return`.
- ~1044 runOwnerInner: read-only gate first; inside exclusive after todo check and approved(), just before this.run: consume when off day; failed consume → return (task stays todo) + noteHeld.
- ~1097 postHandoff: held flag uses held(child.rootId) (read-only).
- ~1198 orWorkday(start, taskId, rollupOf, rootId) becomes async: workday → start now; live grant → wrap start in consume; else push {rootId, start}. ~1199 noteHeld only when actually held.
- createTask: ToolContext `otUntil?: () => Promise<Date|null>` (loop.ts ~435 next to offDay); with live grant text "It will start now under approved OT (until HH:MM)", else "next workday".
Unchanged: ~513 warroomSay still refused on off days; dayTurned; rhythmHost/meetingHost offDay (~612, ~641); app.ts consumers (schedule runner, watch poller, devjob, selfReview, praw offDay closures).

## Migration 030_ot_requests
```sql
CREATE TABLE ot_requests (
  id bigserial PRIMARY KEY,
  root_id text NOT NULL REFERENCES tasks(id),
  local_day date NOT NULL,
  seq smallint NOT NULL CHECK (seq BETWEEN 1 AND 5),
  requested_by text NOT NULL,
  digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{12}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','workday','expired','moot')),
  card_channel_id text CHECK (card_channel_id IS NULL OR card_channel_id ~ '^[0-9]{17,20}$'),
  card_message_id text CHECK (card_message_id IS NULL OR card_message_id ~ '^[0-9]{17,20}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  decided_by text CHECK (decided_by IS NULL OR decided_by ~ '^[0-9]{17,20}$'),
  decided_at timestamptz,
  grant_expires_at timestamptz,
  max_runs integer CHECK (max_runs IS NULL OR max_runs BETWEEN 1 AND 200),
  runs_used integer NOT NULL DEFAULT 0 CHECK (runs_used >= 0),
  max_usd numeric(10,4) CHECK (max_usd IS NULL OR (max_usd > 0 AND max_usd <= 50)),
  usd_base numeric(12,6) CHECK (usd_base IS NULL OR usd_base >= 0),
  revoked_at timestamptz,
  revoked_by text,
  revoke_reason text CHECK (revoke_reason IS NULL OR revoke_reason IN ('admin','halt','superseded','root_ended')),
  CONSTRAINT ot_requests_day_seq UNIQUE (root_id, local_day, seq),
  CONSTRAINT ot_requests_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '25 hours'),
  CONSTRAINT ot_requests_decided CHECK (status IN ('pending','expired','moot') OR (decided_by IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT ot_requests_grant CHECK ((status = 'approved') = (grant_expires_at IS NOT NULL AND max_runs IS NOT NULL AND max_usd IS NOT NULL AND usd_base IS NOT NULL)),
  CONSTRAINT ot_requests_grant_window CHECK (grant_expires_at IS NULL OR (grant_expires_at > decided_at AND grant_expires_at <= decided_at + interval '12 hours')),
  CONSTRAINT ot_requests_runs_cap CHECK (max_runs IS NULL OR runs_used <= max_runs),
  CONSTRAINT ot_requests_runs_only_grant CHECK (runs_used = 0 OR status = 'approved'),
  CONSTRAINT ot_requests_revoked CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL)),
  CONSTRAINT ot_requests_revoke_only_grant CHECK (revoked_at IS NULL OR status = 'approved')
);
CREATE UNIQUE INDEX ot_requests_one_pending_idx ON ot_requests(root_id) WHERE status = 'pending';
CREATE UNIQUE INDEX ot_requests_one_live_idx ON ot_requests(root_id) WHERE status = 'approved' AND revoked_at IS NULL;
CREATE INDEX ot_requests_card_idx ON ot_requests(card_message_id) WHERE card_message_id IS NOT NULL;
```
Down: `DROP TABLE IF EXISTS ot_requests;`

Consume ($1 root id, $2 today's local date):
```sql
UPDATE ot_requests o SET runs_used = o.runs_used + 1
 WHERE o.root_id = $1 AND o.status = 'approved' AND o.revoked_at IS NULL
   AND o.grant_expires_at > now() AND o.local_day = $2::date AND o.runs_used < o.max_runs
   AND EXISTS (SELECT 1 FROM tasks r WHERE r.id = o.root_id AND r.status NOT IN ('done','cancelled'))
   AND COALESCE((SELECT b.spent_usd + b.reserved_usd FROM budget_days b
                  WHERE b.day = DATE '1970-01-01' AND b.scope = 'task' AND b.scope_id = o.root_id), 0) - o.usd_base < o.max_usd
RETURNING o.id, o.runs_used, o.max_runs, o.grant_expires_at;
```
live(rootId, day) = same WHERE as SELECT without runs/USD terms. Code refuses consume while halt.isHalted() and pays revokeOwed first.

Approve tx (lock root then row, as decide()):
1. `SELECT id, status FROM tasks WHERE id = (SELECT root_id FROM ot_requests WHERE id = $1) FOR UPDATE`
2. `SELECT * FROM ot_requests WHERE id = $1 FOR UPDATE`
3. Gates: digest = stored; messageId = card_message_id; channelId = card_channel_id; status pending; expires_at > now(); root not ended; calendar.isOffDay(now).off; not halted; ot.enabled.
4. Pre-check: refuse `expired` when $midnight <= now() + 1 minute.
5. Supersede: `UPDATE ot_requests SET revoked_at=now(), revoked_by=$u, revoke_reason='superseded' WHERE root_id=$r AND status='approved' AND revoked_at IS NULL`
6. `UPDATE ot_requests SET status='approved', decided_by=$u, decided_at=now(), grant_expires_at=LEAST(now() + $h * interval '1 hour', $midnight::timestamptz), max_runs=$n, max_usd=$m, usd_base=COALESCE((SELECT spent_usd + reserved_usd FROM budget_days WHERE day = DATE '1970-01-01' AND scope='task' AND scope_id=$r), 0) WHERE id=$1 AND status='pending' RETURNING *`
Halt revoke: `UPDATE ot_requests SET revoked_at=now(), revoked_by='system', revoke_reason='halt' WHERE status='approved' AND revoked_at IS NULL`.
Sweep (existing approvals expiry timer in app-start.ts): `UPDATE ... SET status='expired' WHERE status='pending' AND expires_at <= now() RETURNING card_channel_id, card_message_id` → close each card.

customIds (new branch in approvalButton before APPROVAL_ID): `OT_ID = /^approval:ot:(\d{1,15}):([0-9a-f]{12}):(approve|deny|day|revoke)$/` (cannot match APPROVAL_ID / BATCH / REVOKE_ID; revoke reuses id+digest).

Config (zod; unit test that schema bounds stay within DB CHECKs): ot.enabled true (bool); ot.hours 4 (0.5–12); ot.maxRuns 30 (int 1–200); ot.maxUsd 2 (0.01–50); ot.requestsPerRootPerDay 2 (int 1–5). Caps snapshotted per grant. Only ot.enabled gets a /settings write path; caps psql-only (like web.taskGrant).

Card (approval embed, origin governance, code-built): title `OT request #<id>`; fields Task tree (root title via maskReason, ≤100 chars, root id, thread link), Requested by (actorLabel(root.owner)), Why ("Today is an off day (weekly or holiday)" — never holiday name), Held now (count of held tasks + dept names, held roll-ups, held bot talk), Spent so far (tree spend from task row / treeCap(root)), If approved (until min(now+hours, midnight), up to N runs, up to $M). No invented estimate, no pings.

Errors (ephemeral): not_admin "Only Bot Admins can do this."; not_found/wrong_card "That button does not belong to this card."; not_pending "Already decided."; expired "The day this request was for has ended."; halted "The company is halted; approve after /resume."; halted_after_commit "Approved, but a halt landed; OT was revoked."; root_ended "The task tree has ended."; moot "Today is already a workday."; disabled "OT requests are switched off."; wrong_channel (day) "Use this in #⚙️-setting."
Audit: ot.request, ot.approve, ot.deny, ot.workday (+ existing holiday.workday), ot.revoke, ot.expire, ot.moot, ot.exhausted (once when cap hit).

## Tests
Repo int: concurrent consume to cap; USD slice; local_day mismatch; root ended; supersede; halt revokeAll; revokeOwed; unique pending; seq cap; deny sticky. Decision int: digest tamper; wrong message; wrong channel for day; expired at midnight; halted; halted-after-commit; moot; approve vs day race. Scheduler unit: grant releases only that root (second root held); consume at start not at gate (repeated recovery doesn't consume); roll-up and bot talk tagged; warroom_say still refused; rhythm/meetings unchanged; after restart live grant runs todo + recovers roll-ups. Card render ids; approval.test.ts malformed `approval:ot:` shapes; createTask OT text. Existing scheduler.offday.notice.test.ts notices() (:32, :45, :69) still hold (card is type approval; ot dep optional).

## Security (Gate 1)
Approve Bot Admin only, live role per click (commands/index.ts guard); since index.ts:95 also accepts approval: buttons in category rooms, handler checks stored card_channel_id/card_message_id; `day` requires CONFIG_CHANNEL_ID. No model tool; bots cannot click → model cannot raise/approve/widen. Scope from stored root_id only; digest random nonce; one live grant per root; caps snapshotted + conditional UPDATE + row CHECKs. OT never lifts a budget (existing reserve: company, bot, tree cap, local caps, SPEND-1 dept pools); USD slice checked before each start; USD can overshoot by the runs started at once, and local mode is bounded by runs only (OT-C8, owner-accepted residual 2). Halt refused + revoked on every path + resume; revokeOwed. maskReason root title on card/audit; no thread content in logs. Abuse limit requestsPerRootPerDay, person-started roots only. Residual: Approve whole day opens every tree (same power/role as /holiday workday).

## Defaults for open questions
Code raises; card in #⚙️-setting only; caps as above (psql-only except enabled); no working-hours concept (out of scope); no OT for non-person-started trees; warroom_say still refused; whole-day allowed while halted; USD slice reads budget_days task row (follow SPEND-1 if it moves); deny sticky; approve/deny lines posted in root thread.

## Amendments after Gate 1 (binding; OT-C1–OT-C17 in docs/security/2026-11-08-gate1-ot-request.md win where they differ)
- All ot.* keys in HANDLER_KEYS; only ot.enabled gets a handlerSet case (OT-C1).
- Bind otStart by hold point regardless of target task origin — roll-ups via settleReview/recoverRollup/finalRollup, sweepReview and restart recovery consume too (OT-C2, OT-C12). Define usable (caps respected) vs unexpired predicates per call site.
- runOwnerInner: consume BEFORE approved()/runApprovedCalls (OT-C3).
- Boot: OT revokeBeforeHaltedRow like web grants (OT-C4).
- Warroom held entries: tag overwritten with the start, tag = target task's DB rootId, entries without a task never released by releaseRoot; their starts consume (OT-C5).
- Day/claim gates expires_at AND local_day; whole-day uses planWorkday(row.local_day); raise expires stale rows first (OT-C6).
- consume/live read ot.enabled live, fail closed (OT-C7).
- Overshoot text corrected: USD can overshoot by the runs started at once; local mode bounded by runs only. No per-root consume lock (OT-C8 alternative; owner residual 2).
- Global and per-person daily caps; card shows the requesting person (OT-C9).
- Root title through the embed neutraliser (mentions, links, bidi, zero-width; non-global regex) + allowedMentions parse [] (OT-C10).
- Failed card post → terminal state that still counts toward caps; message-id store failure must not repeat cards (OT-C11).
- usd_base uses spent_usd only; budget key taken from budget.ts (OT-C13). expires_at computed on DB clock; raise fault never skips the OFFDAY-1 notice (OT-C14).
- Fail-closed held/consume on DB faults; revokeOwed paid by live/consume; stray ot.approved starts nothing (OT-C15). Handler refuses null messageId/channelId; rootId from RETURNING (OT-C16).
- Whole-day button label/reply states it opens all held work for the day (OT-C17). createTask OT text reworded so it is true after runs run out.

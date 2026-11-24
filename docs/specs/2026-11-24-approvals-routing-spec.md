# Approvals routing, work codes and channel settings — spec (TASK-031)

Status: draft, pending Gate 1 (sa review).
Design (binding input, decisions D1–D5): [2026-11-24-approvals-routing-design.md](2026-11-24-approvals-routing-design.md)
Code anchors are given as file + function. Sections R1–R13 follow the design.

## Contents
R1 Scope and actors
R2 Departments and codes
R3 Schema migration 0002
R4 Routing
R5 AI-head decision path
R6 Human decisions, override, cancel
R7 Cards and required fields
R8 Commands
R9 Settings
R10 Logging
R11 Security notes
R12 Tests
R13 Docs, files, acceptance
R14 Gate 1 conditions applied (T031-01..09)

## Main-thread resolutions

Resolutions of sa open questions (2026-11-24, per sa recommendations):
- OQ-1 YES: Praw may file on behalf of a department via `for_dept` (human-triggered only).
- OQ-2 exactly 10,000 THB → HQ (≥).
- OQ-3 HQ-level-at-creation gets `APR-HQ-`; codes never renumber on escalation.
- OQ-4 prefixes as R2; channel defaults via settings seed: account→Finance 1567005451516772513, hr→HR 1567005110243033228, marketing→Marketing 1567005741003313212, sales→Sales 1567005947287568474, operations→Ops 1567006095526858884, product→R&D 1567005024146554960, dev→Software House 1567004690351128676; all others → hq.
- OQ-5 YES add `/approval cancel`.
- OQ-6 YES approver may override an AI decision until expiry.
- OQ-7 keep 180-day retention sweep (D4 = delete action only).
- OQ-8 other tunables later (separate task).
- OQ-9 no AI task edit/cancel tools now.

## R1 Scope and actors
- Actors: requesting persona (AI); department head persona (decides dept-level only via structured tool); approver-role human AI-Admin (decides anything, overrides AI decisions, changes settings); requester human (`human_user_id` on approval / human creator of task); intake client Praw posts every approval card (`Router._bound` accepts `appr` clicks only on intake-posted cards).
- Trust boundaries: Discord interaction → `actor_from_interaction` (core/discord/approver.py); model output → tool JSON schema → service checks; settings table → per-key validators.
- Non-goals: no hard delete, no reply-gate change, no persona decision on HQ items, no AI-side task edit/cancel.

## R2 Departments and codes
New core/approvals/depts.py (fixed in code). VERBATIM:
```python
DEPT_CODES = {"account": "FIN", "hr": "HR", "marketing": "MKT", "sales": "SAL", "operations": "OPS", "it": "IT",
              "legal": "LEG", "procurement": "PRC", "support": "SUP", "data": "DAT", "design": "DSN",
              "product": "PRD", "dev": "DEV", "exec": "HQ", "praw": "HQ"}
HQ_ONLY = {"exec", "praw"}  # never a head, never dept-level (D1: Mira never decides)
DEFAULT_HEADS = {"account": "mali", "hr": "fahsai", "marketing": "somo", "sales": "bass", "operations": "ploy",
                 "it": "phupha", "legal": "thara", "procurement": "pat", "support": "sai", "data": "kawin",
                 "design": "nicha", "product": "pim", "dev": "tek"}
def code_of(slug: str) -> str: return DEPT_CODES.get(slug, "HQ")
```
- Persona ids from code (Dev QA persona is `qin`).
- Task code `<code_of(assignee.dept)>-<NNNN>`. Approval code `APR-<P>-<NNNN>`, P=`HQ` when level at creation is `hq`, else dept code. Codes never change (incl. escalation). Counters per (kind, dept), monotonic, never reused; `f"{p}-{n:04d}"` (fifth digit after 9999).
- Allocation in the same `pool.transaction()` (BEGIN IMMEDIATE) as the INSERT: `INSERT INTO code_counters(kind,dept,last) VALUES(?1,?2,1) ON CONFLICT(kind,dept) DO UPDATE SET last=last+1 RETURNING last`.
- Lookup input upper-cased, must match `^(APR-[A-Z]{2,4}-[0-9]{4,}|[A-Z]{2,4}-[0-9]{4,}|TASK-[0-9]+)$` (`TASK-n` legacy).

## R3 Schema migration core/migration/versions/0002_approvals_routing.sql
- `approvals` rebuilt (decided_by CHECK allows only discord/cli; decided-status CHECK; code UNIQUE NOT NULL). No FK references approvals → drop+rename safe inside runner BEGIN IMMEDIATE (core/migration/runner.py `migrate`). `tasks` referenced by brainstorm_threads → ADD COLUMN only.
- Probe P-0002a (assumed): ADD COLUMN CHECK vs existing rows (NULL passes); window function in INSERT…SELECT needs SQLite ≥3.25 (VPS 3.46.1, Mac check).

VERBATIM (whole file):
```sql
CREATE TABLE approvals_new (
  id                TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (random() & 3), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))) CHECK (length(id) = 36),
  code              TEXT NOT NULL UNIQUE CHECK (code GLOB 'APR-*-[0-9][0-9][0-9][0-9]*' AND length(code) <= 24),
  level             TEXT NOT NULL CHECK (level IN ('dept','hq')),
  dept              TEXT NOT NULL CHECK (length(dept) BETWEEN 2 AND 4 AND dept NOT GLOB '*[^A-Z]*'),
  kind              TEXT NOT NULL CHECK (kind IN ('generic','artifact_enable','file_write_outside','destructive_cmd','config_change')),
  title             TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 256),
  summary           TEXT NOT NULL CHECK (length(summary) <= 4000),
  access            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(access) AND json_type(access) = 'array'),
  payload           TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  reason            TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 1000),
  value_thb         INTEGER CHECK (value_thb IS NULL OR value_thb BETWEEN 0 AND 1000000000),
  priority          TEXT CHECK (priority IS NULL OR priority IN ('low','normal','high','urgent')),
  due               TEXT CHECK (due IS NULL OR due = date(due)),
  assignee          TEXT CHECK (assignee IS NULL OR (length(assignee) BETWEEN 2 AND 32 AND assignee NOT GLOB '*[^a-z0-9_-]*')),
  other_depts       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(other_depts) AND json_type(other_depts) = 'array'),
  route_reason      TEXT NOT NULL CHECK (route_reason IN ('kind_dangerous','access_requested','value_over_threshold','cross_dept','no_dept','no_head','requester_is_head','ai_disabled','classifier_major','classifier_unavailable','dept_routine','head_escalated','head_no_decision','head_guard_failed','legacy')),
  requested_by      TEXT NOT NULL,
  origin            TEXT NOT NULL CHECK (origin IN ('discord','cli')),
  human_user_id     INTEGER,
  origin_channel_id INTEGER NOT NULL,
  origin_thread_id  INTEGER,
  channel_id        INTEGER,
  message_id        INTEGER,
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired','cancelled')),
  decided_by        TEXT CHECK ((decided_by GLOB 'discord:*' AND length(decided_by) BETWEEN 25 AND 28 AND substr(decided_by, 9) NOT GLOB '*[^0-9]*')
                                OR (decided_by GLOB 'cli:[a-z]*' AND length(decided_by) BETWEEN 5 AND 36 AND substr(decided_by, 5) NOT GLOB '*[^a-z0-9_-]*')
                                OR (decided_by GLOB 'agent:[a-z]*' AND length(decided_by) BETWEEN 8 AND 38 AND substr(decided_by, 7) NOT GLOB '*[^a-z0-9_-]*')),
  decision_reason   TEXT CHECK (decision_reason IS NULL OR length(decision_reason) <= 500),
  overridden_from   TEXT CHECK (overridden_from IS NULL OR overridden_from GLOB 'agent:*'),
  decided_at        TEXT CHECK (decided_at = strftime('%Y-%m-%dT%H:%M:%fZ', decided_at)),
  expires_at        TEXT NOT NULL CHECK (expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', expires_at)),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)),
  CHECK ((status IN ('approved','rejected')) = (decided_by IS NOT NULL)),
  CHECK (decided_by IS NULL OR decided_by NOT GLOB 'agent:*' OR (level = 'dept' AND kind = 'generic' AND access = '[]'))
) STRICT;
INSERT INTO approvals_new (id, code, level, dept, kind, title, summary, access, payload, route_reason, requested_by, origin,
  human_user_id, origin_channel_id, origin_thread_id, channel_id, message_id, status, decided_by, decided_at, expires_at, created_at)
SELECT id, 'APR-HQ-' || printf('%04d', row_number() OVER (ORDER BY created_at, id)), 'hq', 'HQ', kind, title, summary, access,
  payload, 'legacy', requested_by, origin, human_user_id, origin_channel_id, origin_thread_id, channel_id, message_id, status,
  decided_by, decided_at, expires_at, created_at FROM approvals;
DROP TABLE approvals;
ALTER TABLE approvals_new RENAME TO approvals;
CREATE INDEX approvals_pending_idx ON approvals (expires_at) WHERE status = 'pending';
CREATE INDEX approvals_agent_decided_idx ON approvals (decided_by, decided_at) WHERE decided_by GLOB 'agent:*';
CREATE TABLE code_counters (
  kind TEXT NOT NULL CHECK (kind IN ('task','approval')),
  dept TEXT NOT NULL CHECK (length(dept) BETWEEN 2 AND 4 AND dept NOT GLOB '*[^A-Z]*'),
  last INTEGER NOT NULL CHECK (last >= 0),
  PRIMARY KEY (kind, dept)
) STRICT;
INSERT INTO code_counters (kind, dept, last) VALUES ('approval', 'HQ', (SELECT count(*) FROM approvals));
ALTER TABLE tasks ADD COLUMN code TEXT CHECK (code IS NULL OR length(code) BETWEEN 6 AND 16);
ALTER TABLE tasks ADD COLUMN dept TEXT CHECK (dept IS NULL OR (length(dept) BETWEEN 2 AND 4 AND dept NOT GLOB '*[^A-Z]*'));
ALTER TABLE tasks ADD COLUMN priority TEXT CHECK (priority IS NULL OR priority IN ('low','normal','high','urgent'));
ALTER TABLE tasks ADD COLUMN due TEXT CHECK (due IS NULL OR due = date(due));
ALTER TABLE tasks ADD COLUMN value_thb INTEGER CHECK (value_thb IS NULL OR value_thb BETWEEN 0 AND 1000000000);
UPDATE tasks SET code = 'TASK-' || short_id;
CREATE UNIQUE INDEX tasks_code_idx ON tasks (code) WHERE code IS NOT NULL;
CREATE TABLE settings (
  key        TEXT NOT NULL PRIMARY KEY CHECK (length(key) BETWEEN 3 AND 64 AND key NOT GLOB '*[^a-z0-9_.]*'),
  value      TEXT NOT NULL CHECK (length(value) BETWEEN 1 AND 256),
  updated_by TEXT NOT NULL CHECK (updated_by GLOB 'discord:*' OR updated_by GLOB 'cli:*'),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', updated_at))
) STRICT;
CREATE TABLE audit_log (
  id        INTEGER PRIMARY KEY,
  scope     TEXT NOT NULL CHECK (scope IN ('setting','task','approval')),
  ref       TEXT NOT NULL CHECK (length(ref) BETWEEN 1 AND 64),
  action    TEXT NOT NULL CHECK (action IN ('set','reset','edit','cancel','escalate','override','ai_decide')),
  field     TEXT CHECK (field IS NULL OR length(field) <= 64),
  old_value TEXT CHECK (old_value IS NULL OR length(old_value) <= 4000),
  new_value TEXT CHECK (new_value IS NULL OR length(new_value) <= 4000),
  actor     TEXT NOT NULL CHECK (actor GLOB 'discord:*' OR actor GLOB 'cli:*' OR actor GLOB 'agent:*'),
  at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) CHECK (at = strftime('%Y-%m-%dT%H:%M:%fZ', at))
) STRICT;
CREATE INDEX audit_ref_idx ON audit_log (scope, ref, at);
```
- Existing rows: approvals → `level=hq`, `dept=HQ`, `APR-HQ-0001..` by created_at; HQ approval counter seeded to count. Tasks keep `TASK-<short_id>`, new fields NULL (cards show "-"). Task counters start empty.
- Automatic escalations use actor `agent:system` (reserved; no persona may use id `system`).

## R4 Routing (core/approvals/router.py, `route(...) -> (level, dept_code, route_reason)`)
- dept derived server-side from requester persona `dept` (exception `for_dept`, below).
- Rules, first match wins, every match → `hq`:
  1. `kind != 'generic'` → `kind_dangerous`
  2. `access` non-empty → `access_requested`
  3. `value_thb >= approval.hq_threshold_thb` → `value_over_threshold`
  4. `other_depts` contains a slug ≠ own → `cross_dept`
  5. dept slug in HQ_ONLY or unknown → `no_dept`
  6. `approval.head.<code>` = `none`, persona missing or disabled → `no_head`
  7. head == requested_by → `requester_is_head`
  8. `approval.ai_enabled` off → `ai_disabled`
  9. classifier → `classifier_major`, or `classifier_unavailable` on error/timeout/unparsable/GATE budget fallback-stop
- Otherwise `dept` with `route_reason=dept_routine`.
- Classifier: copy reply-gate pattern (core/gate/reply_gate.py `tier2`): `adapter.complete(model=REPLY_TIER2_MODEL, system=prompts/_system/approval-classifier.md, max_output_tokens=8, timeout_s=reply_tier2_timeout_s)`; card text `wrap_untrusted(…, "approval")`; usage `budget.record(GATE_AGENT, …, "approval_classify")`; only exact `routine` → dept; anything else → HQ (fail closed); runs only when rules 1–8 did not match.
- `for_dept`: accepted only when `ctx.agent.id == config.intake_persona` and `ctx.human_user_id` set; value is a slug in DEPT_CODES minus HQ_ONLY and becomes the dept; else tool returns `for_dept_not_allowed`.

## R5 AI-head decision path
- core/interfaces.py: `Trigger` gains `"approval_review"`; `AgentRequest.approval_id: str | None = None`; `ToolContext.approval_id: str | None = None`. Engine (core/agents/engine.py `_run`, `ToolContext(...)`) passes approval_id; `_SOURCE` gains `"approval_review": "approval"`.
- Review run: after a dept-level card is presented, `PgApprovalService` spawns `_review(row)` (tracked in `self._tasks`): `engine.run(AgentRequest(agent_id=head, trigger="approval_review", guild_id=…, channel_id=row.channel_id or origin_channel_id, thread_id=None, human_user_id=None, text=<card as plain fields>, origin=row.origin, sink=ctx.sinks.null(), tools_override=("approval_decide","approval_escalate"), approval_id=row.id, system_extra=<prompts/_system/approval-review.md>, max_output_tokens=400))`. When it returns and row still pending/dept → `escalate(row, "head_no_decision", "agent:system")` (incl. budget stop, error, timeout).
- Tools core/agent_tools/approval.py, in no persona's `tools` (only via tools_override). VERBATIM:
```python
DECIDE = {"type": "object", "additionalProperties": False, "required": ["action", "reason"],
          "properties": {"action": {"enum": ["approve", "reject"]}, "reason": {"type": "string", "minLength": 10, "maxLength": 500}}}
ESCALATE = {"type": "object", "additionalProperties": False, "required": ["reason"],
            "properties": {"reason": {"type": "string", "minLength": 10, "maxLength": 500}}}
```
  Both refuse `not_allowed_here` unless `ctx.trigger == "approval_review" and ctx.approval_id`. No id argument.
- `decide_as_head(approval_id, action, persona, reason)` (separate from `decide()`; Actor = humans only). Pre-checks: `settings.ai_enabled`, `settings.head(code_of(persona.dept)) == persona.id`, `persona.dept not in HQ_ONLY`. Then:
```sql
UPDATE approvals SET status=?2, decided_by='agent:' || ?3, decision_reason=?4, decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
WHERE id=?1 AND status='pending' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND level='dept' AND dept=?5
  AND kind='generic' AND access='[]' AND value_thb IS NOT NULL AND value_thb < ?6 AND requested_by != ?3
  AND (SELECT count(*) FROM approvals WHERE decided_by='agent:' || ?3 AND decided_at > strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day')) < ?7
RETURNING *
```
  ?5=`code_of(persona.dept)`, ?6=threshold, ?7=`approval.ai_daily_max`. Success: audit (approval, code, ai_decide), log `approval.ai_decided`, presenter `show_decision`, generic handler; requester woken "… approved by agent:mali". Not pending → `already_decided`. Other failure → log `approval.ai_denied check=<first failing check by re-reading row>` and escalate `head_guard_failed`; tool returns `escalated`.
- `escalate(row, reason, actor)`: `UPDATE … SET level='hq', route_reason=?2 WHERE id=?1 AND status='pending' AND level='dept' RETURNING *`, audit + log. Presenter `show_request(row)` posts a new HQ card and updates channel_id/message_id (old buttons fail `_bound`); new `show_moved(old_ch, old_msg, row)` edits old card to "Escalated to HQ", no buttons.

## R6 Human decisions, override, cancel
`decide()` keeps surface + fresh `policy.is_approver`. UPDATE becomes:
```sql
UPDATE approvals SET status=?2, decided_by=?3, decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  overridden_from = CASE WHEN status='pending' THEN NULL ELSE decided_by END
WHERE id=?1 AND origin=?4 AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND (status='pending' OR (decided_by GLOB 'agent:*' AND status IN ('approved','rejected') AND status != ?2))
RETURNING *
```
- Override: only before expiry, only over an AI decision; human decisions final; audit `override`, log `approval.overridden`, re-run handler (requester woken again).
- Cancel: `UPDATE … SET status='cancelled' WHERE code=?1 AND status='pending' RETURNING *` (decided_by NULL); canceller in audit_log; card edited "Cancelled", no buttons; handler not run.
- Approvals immutable (no edit; cancel and re-request).

## R7 Cards and required fields
`approval_request` SCHEMA (VERBATIM):
```python
SCHEMA = {"type": "object", "additionalProperties": False, "required": ["title", "summary"], "properties": {
    "title": {"type": "string", "minLength": 1, "maxLength": 256}, "summary": {"type": "string", "maxLength": 4000},
    "reason": {"type": "string", "maxLength": 1000}, "value_thb": {"type": "integer", "minimum": 0, "maximum": 1000000000},
    "priority": {"enum": ["low", "normal", "high", "urgent"]}, "due": {"type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$"},
    "assignee": {"type": "string", "pattern": "^[a-z][a-z0-9_-]{1,31}$"},
    "other_depts": {"type": "array", "maxItems": 15, "uniqueItems": True, "items": {"type": "string", "pattern": "^[a-z][a-z0-9_-]{1,31}$"}},
    "for_dept": {"type": "string", "pattern": "^[a-z][a-z0-9_-]{1,31}$"},
    "access": {"type": "array", "maxItems": 10, "items": {"type": "string", "maxLength": 200}}}}
CARD_REQUIRED = ("reason", "value_thb", "priority", "due")
```
- `task_create` adds priority, due, value_thb (same shapes); `TASK_REQUIRED = ("description", "priority", "due", "value_thb")`.
- Shared validator core/approvals/cards.py `check_card(a, required, tz) -> str | None`. Exact errors: `incomplete_card missing=<comma list in required order>` (absent or blank); `invalid_field field=summary reason=too_short` (summary/description < 20 chars); `invalid_field field=due reason=past|too_far|format` (APP_TIMEZONE, >730 days); `invalid_field field=assignee reason=unknown` (default requester); `invalid_field field=other_depts reason=unknown`; `for_dept_not_allowed`.
- Order in task_create: BLOCKED trigger → `invalid_assignee` → card check (keeps tests/test_tasks.py:134-135).
- Log `approval.incomplete` / `task.incomplete` WARNING (agent, kind=<missing list>).
- Approval embed (core/discord/embeds.py `approval_embed`): title `Approval needed: <code> <title>`; description summary; fields in order: Code, Level (`Department (FIN)` | `HQ`), Department, Requested by, Triggered by, Assignee, Priority, Due, Value (THB) (`f"{v:,} THB"`), Kind, Access, Reason, Routing (route_reason text), Origin, Status, Decision note (AI: "AI decision by <name>: <reason> — approvers may override"), Note. Existing names kept.
- Task embed (core/tasks/service.py `_embed`): title `<code> <title>` (thread name same); fields Code, Department, Requester, Assignee, Priority, Due, Value (THB), Status, Report. Tool content `<code> created`, data `{"task": code, "thread_id": …}`.
- Presenter channel: `hq` → `cfg.approval_channel_id`; `dept` → `settings.approval_channel(code)`; if unset/`hq`/unresolved/fails `gate.channel_ok` → HQ + log `approval.channel_fallback` WARNING. Intake client always posts.

## R8 Commands (intake client, guild-scoped, next to `register_budget`)
- `/task show code`, `/task edit code field(title|description|priority|due|value_thb) value`, `/task cancel code [reason]`, `/approval show code`, `/approval cancel code [reason]`.
- Pipeline: `cmd_gate` → `notifier._origin_ok` pattern + `actor_from_interaction` → code regex → lookup → authorization (requester human: task `created_by_kind='human' AND created_by_id=uid`; approval `human_user_id=uid`; OR fresh `approver_policy.is_approver(actor)`) → action.
- Not found / not allowed → single ephemeral "Not found or not allowed. / ไม่พบหรือไม่มีสิทธิ์".
- `/task edit`: only open/in_progress; R7 validators; `UPDATE … WHERE code=?1 AND status IN ('open','in_progress') RETURNING *`; audit old/new; `threads.edit_embed`; assignee not re-run.
- `/task cancel` and existing Cancel button share new `TaskService.cancel(t, actor_ref)` (moved out of core/discord/threads.py `on_task_click`); button authz changes from cached `user.roles` to fresh `approver_policy.is_approver`.
- Replies ephemeral, `mask_secrets`, ≤2000 chars.

## R9 Settings (core/settings/service.py, ext.py; ctx.settings; EXTENSIONS gets "core.settings.ext" before "core.approvals.ext")
- Read from DB every call (no cache). Effective = DB row → env/config seed → constant.
- Keys (`<code>` = lower-case dept code from DEPT_CODES, excluding hq):

| key | validation | default (seed) |
|---|---|---|
| approval.hq_threshold_thb | int 1..100000000 (commas stripped) | 10000 |
| approval.ttl_h | int 1..168 (new rows only) | env APPROVAL_TTL_H (24) |
| approval.rate_per_day | int 1..100 per requester | 10 |
| approval.ai_enabled | on/off | on |
| approval.ai_daily_max | int 0..200 per head | 20 |
| approval.channel.`<code>` | `hq` or snowflake: guild text channel, `gate.channel_ok`, ≠ ADMIN_NOTIFY_CHANNEL_ID | per OQ-4 seeds above, else hq |
| approval.head.`<code>` | `none` or persona id with `code_of(dept) == code`, not HQ_ONLY, not disabled | DEFAULT_HEADS |

- Commands `/setting view [key]`, `/setting set key value`, `/setting reset key`; each requires `cmd_gate` AND `interaction.channel_id == cfg.settings_channel_id` exactly (no threads) AND fresh `is_approver`.
- Write: upsert/delete row + `audit_log(setting, key, set|reset, old, new, actor)` in one transaction; log `settings.changed` WARNING (id=key, by, status=set|reset); values to file log only; reply ephemeral.
- Errors: unknown key, `invalid_value`, `not_approver`, `wrong_channel`, `settings_channel_unset`.
- .env: new `SETTINGS_CHANNEL_ID` (optional; owner value 1565667791938387969); `_check_discord` refuses equal to ADMIN_NOTIFY_CHANNEL_ID (`admin_channel_shared`); `_intake_ready` refuses `settings_channel_invalid` when set but unresolved/not allowlisted. `APPROVAL_CHANNEL_ID` stays HQ + fallback. `APPROVAL_TTL_H` becomes seed. Other env unchanged.

## R10 Logging
Systems approvals, tasks, settings, commands. Events: approval.requested INFO (id, code, level, kind, reason=route_reason); approval.classify_failed WARNING (error); approval.review_started INFO (code, agent); approval.ai_decided WARNING (code, agent, status); approval.ai_denied WARNING (code, agent, reason=check); approval.escalated WARNING (code, by, reason); approval.overridden WARNING (code, by, status); approval.cancelled INFO (code, by); approval.channel_fallback WARNING (code, reason); approval.incomplete / task.incomplete WARNING (agent, kind); task.created INFO (task=code); task.edited INFO (task, by, kind=field); task.cancelled (task=code); settings.changed WARNING (id, by, status); settings.denied WARNING (id, by, reason); command.denied WARNING (kind=cmd, by, reason). WARNING field names limited to `syslog.FORWARD_KEYS` (spec-locked); no summary/reason prose/setting values at WARNING (if `code` is not in FORWARD_KEYS, the spec must decide: add it via a §12.14 amendment or use `id`).

## R11 Security notes (Gate 1)
- Chat injection: decision tools unreachable from chat (not in persona tools; need trigger approval_review + server-set approval_id; review run human_user_id=None, null sink); chat claims of approval ignored.
- Card-text injection: requester writes summary/reason read by head. Mitigations: wrap untrusted; server SQL guard (level, dept, kind, empty access, value < threshold, requester ≠ decider); dept-level = generic (no permission granted); daily cap per head; human override; kill switch `approval.ai_enabled`.
- Residual: understated `value_thb` (AI-supplied) — classifier backstop, value shown to humans, override.
- DB defence in depth: CHECK forbids `agent:*` deciders on non-dept/non-generic/non-empty-access rows.
- AuthZ: fresh member fetch for every human action (fixes Cancel button); settings need fixed channel + approver role + allowlist; approval clicks bound to intake message.
- Input validation: schema + check_card; code regex; per-key validators; channel ids resolved + `channel_ok`.
- Masking/clamping kept; rate limits (requests/requester/day, one classifier call per request, one review run per approval, AI decisions/head/day); enumeration-safe replies; no hard delete; audit rows kept (retention sweep still deletes terminal tasks after 180 days).

## R12 Tests (fakes only)
- Add: test_approvals_routing.py (rules 1–9; threshold 9999/10000; classifier error → HQ); code allocation (20 concurrent inserts unique sequential; per dept); decide_as_head guards (wrong dept, HQ level, value at threshold, requester=head, kind/access, cap, not_allowed_here from human_message trigger, missing approval_id); head no-decision → escalated, card moved, old buttons inactive; override (AI→human ok, human→human refused, concurrent exactly one); cancel; test_cards.py (missing list, too_short, due past/far/format); test_settings.py (per-key validation; non-approver/wrong channel/unset refused; audit row; reset → env seed); test_discord_commands.py (gate first, enumeration-safe, requester vs approver vs other); migration 0002 on legacy DB (codes backfilled, counters seeded, `PRAGMA foreign_key_check` empty).
- Invalidated: core/migration/tests/test_migration.py:14 TABLES += {code_counters, settings, audit_log}; :35/37/41 `== 1` → `== 2`; tests/test_tasks.py:122 `startswith("TASK-")` → `^[A-Z]{2,4}-\d{4} `; test_tasks.py:138/146/161/245 task_create args gain description(≥20)/priority/due/value_thb; tests/test_cli.py:36,38 and core/cli/fakes.py:51,53; tests/fixtures/cli_smoke.txt:8 and tests/acceptance/scripts/ac2_delegate.txt:5 `TASK-1` → `HR-0001`; tests/acceptance/evidence/*.out regenerate; tests/test_approvals.py fixture needs personas + settings fakes, request() kwargs gain card fields; tests/test_discord_approver.py:126, tests/acceptance_b1/test_b1_approvals.py:20/33/41 re-run.

## R13 Docs, files, acceptance
- Docs: docs/helper/discord-apps.md (dept approval channels + ⚙️-setting allowlisted, Praw View/Send); docs/helper/setup.md §4 (SETTINGS_CHANNEL_ID, APPROVAL_TTL_H seed, /setting commands for dept→channel map); .env.example `# SETTINGS_CHANNEL_ID=`; prompts/_fragments/approval-request.md and delegation.md (new fields, routing, codes, honest value).
- New files: core/migration/versions/0002_approvals_routing.sql; core/approvals/{depts.py,router.py,cards.py}; core/settings/{__init__,service,ext}.py; core/discord/commands.py; prompts/_system/{approval-classifier,approval-review}.md.
- Changed: core/interfaces.py; core/agents/engine.py; core/extensions.py; core/approvals/{service,ext}.py; core/agent_tools/{approval,task}.py; core/tasks/{service,repo}.py; core/discord/{embeds,threads,client}.py; core/cli/{presenter,fakes,script}.py; core/config.py; docs above; docs/specs/_index.md.
- Acceptance: A1 migration 0002 on legacy DB, codes backfilled, version 2; A2 codes unique per dept under concurrency; A3 incomplete AI card refused with exact R7 error, no row; A4 each D2 rule → HQ, routine → dept channel; A5 ≥10,000 → HQ; A6 head decides only own dept routine item; A7 each guard failure escalates; A8 approval_decide from chat run → not_allowed_here; A9 HQ item cannot be agent-decided (service + DB CHECK); A10 human overrides AI once, requester woken; A11 /task show|edit|cancel and /approval show|cancel authz + enumeration-safe; A12 /setting refused outside ⚙️-setting or non-approver, changes audited/logged; A13 bad dept channel → HQ fallback; A14 escalation keeps code, old card inactive; A15 no hard delete; A16 full suite green.

## R14 Gate 1 conditions applied (T031-01..09)
Source: `docs/security/2026-11-24-gate1-task031.md`. Where these differ from R1-R13, R14 wins. Implemented in TASK-031 build; test names are in `tests/`.
- T031-01 `approval_decide` / `approval_escalate` are override-only (`ToolSpec.override_only`): `Registry.for_agent` offers them only when named exactly in `tools_override`, never through `*` or `x_*`. Test: `test_decision_tools_override_only_never_wildcard_T031_01`.
- T031-02 Routing rule 7 `requester_is_head` also fires when the linked task (via `thread_record_id`) was created by the head agent of the routed department; the task uuid is stored in `payload.task` and `decide_as_head` / `escalate_as_head` re-check it (`task_creator`). Test: `test_head_created_task_laundering_routes_hq_and_is_rechecked_T031_02`.
- T031-03 Classifier billing: `budget.record(GATE, ..., "tier2", ref="approval:<id>")`; the approval id is generated before the classifier runs. Test: `test_classifier_bills_tier2_to_gate_with_approval_ref`.
- T031-04 WARNING fields are fixed tokens only: `reason` is a `route_reason` value or a guard-check name, never AI text; `settings.denied` / `command.denied` log `id`/`kind` only for known keys/commands (else `unknown`); `approval.classify_failed` logs `type(e).__name__`. No FORWARD_KEYS change. Tests: `test_forwarded_warning_fields_are_fixed_tokens_T031_04`, `test_denial_logs_carry_only_fixed_tokens_T031_04`.
- T031-05 The per-head daily cap counts `audit_log` rows (`scope='approval' AND action='ai_decide' AND actor='agent:<id>'`) inside the decision UPDATE (same transaction); index `audit_actor_idx (actor, action, at)` added to 0002. Test: `test_daily_cap_counts_audit_rows_not_decided_by_T031_05`.
- T031-06 The persona loader refuses id `system` and dept `system`. Test: `test_persona_loader_refuses_reserved_system_id_and_dept`.
- T031-07 `approval.channel.<code>` refuses `SETTINGS_CHANNEL_ID` and `ADMIN_NOTIFY_CHANNEL_ID`; `core/settings` imports nothing from `core.discord` (the resolver `channel_ok` and `is_disabled` are injected by `core/discord/commands.py`); keys are checked against the fixed list before any DB access. Tests: `test_invalid_values`, `test_unknown_key_refused_before_any_db_access`, `test_settings_service_does_not_import_discord_T031_07`.
- T031-08 Command inputs are bounded (code 24, value 256, reason 200), no autocomplete, the DB requester match precedes `is_approver`, classifier and routing run before `pool.transaction()` (rate-limit pre-check avoids classifier spend), and `core/discord/commands.py` adds no listeners. Tests: `test_commands_are_gate_first_bounded_and_no_autocomplete`, `test_task_show_requester_approver_other_and_enumeration_safe`, `test_only_one_add_listener_call_site`.
- T031-09 Migration 0002 on a populated legacy DB gives `integrity_check = ok` and an empty `foreign_key_check` (migrate with the service stopped). After a restart `PgApprovalService.start()` re-spawns the head review for every `status='pending' AND level='dept'` row (a review that ends without a decision escalates `head_no_decision`). Tests: `test_legacy_db_migrates_with_backfill_counters_and_integrity`, `test_restart_respawns_reviews_for_pending_dept_items_T031_09`.
- Implementation notes: `approval.channel_fallback` is logged only when a configured channel id is unresolved or not allowlisted (`reason=unresolved|not_allowed`); a department set to `hq` posts to HQ silently. `/task cancel` and `/approval cancel` accept an optional reason (max 200) stored in the audit row.

## R15 Gate 2 follow-ups (TASK-031b)
- G2T031-02: `_linked_task` returns the set of agents involved: creators along the parent-task chain (max 10 hops, cycle-safe) plus the linked thread's owner and participants. The router sends `requester_is_head` when the head is in the set; `payload.thread` is stored and `_head_checks` re-derives the set (`task_creator`). Tests: `test_head_laundering_chain_beyond_one_hop_G2T031_02`, `test_head_laundering_depth_bound_and_cycle_safe_G2T031_02`, `test_head_brainstorm_owner_or_participant_routes_hq_and_is_rechecked_G2T031_02`.
- G2T031-03: the classifier gets each field whole up to 4000 chars, else first and last 2000. Test: `test_classifier_sees_whole_summary_or_head_and_tail_G2T031_03`.
- G2T031-04: `_lookup` fails closed when `is_approver` raises (same ephemeral denial, `command.denied reason=approver_check_failed`). Test: `test_is_approver_exception_fails_closed_with_denied_reply_G2T031_04`.
- Deploy item: `test_recover_twice_and_overlapping_spawn_one_review_per_pending_card_G2_deploy`.

## R16 Audit of first human decisions (TASK-031c)
- Migration `0003_audit_decide.sql` rebuilds `audit_log` (rows and both indexes kept) with `decide` added to the `action` CHECK.
- `ApprovalService.decide` writes `scope='approval', ref=<code>, action='decide', field='status', old_value='pending', new_value=<approved|rejected>, actor=<decided_by>` in the same transaction as the UPDATE. A human override of an AI decision still writes `override` only. Refused or already-decided calls write nothing.
- Tests: `test_first_human_decision_is_audited_and_refusals_are_not`, `test_0003_keeps_audit_rows_and_allows_decide`.

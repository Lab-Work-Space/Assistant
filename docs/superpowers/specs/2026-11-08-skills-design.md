# SKILLS-1 — per-team skills (spec)

Owner request 2026-11-08: "the system should be growable, and support adding skills to each team". Requires security gate (system prompt, tool grants, model proposal path). Migration **031_skills** (029 SPEND-1, 030 OT-1 reserved; migrate.ts applies by sorted name, gaps tolerated). Open questions resolved with defaults (end).

## Actors / boundary
Bot Admin: only authority — slash in #⚙️-setting (decide() guard discord/commands/index.ts:90-101) or confirming an admincfg card. Head (heads/<dept>) may propose via `skill_propose` (stores pending row only). Personas consume, never propose. Praw console (adminRun) may propose only attach/detach/toggle/rollback via admin_op_propose. Skill text becomes trusted system text only after Bot Admin authorship/confirmation; before that it is untrusted proposal data that never reaches a prompt.

## Definition
- Library row: id slug `^[a-z][a-z0-9-]{1,39}$`, title ≤100, status active|disabled|archived.
- Immutable versions: instructions ≤2500 chars; ≤3 templates {name ≤40, body ≤1000}, templates total ≤1500; optional tools list ≤10 names.
- Attachments: target `dept:<DeptId>` (head + every persona of that dept) or `persona:<id>`.
- Rendered block per version ≤4000 chars and ≤6000 UTF-8 bytes (fits one card / modal). KB-doc references deferred.
- Limits = code constants in new `skills/limits.ts` (not config): 6 skills per dept target, 3 per persona target; per-actor injected total SKILL_ACTOR_BUDGET_BYTES = 12000; 5 open proposals per dept; 1 pending proposal per skill; 200 skills in library.
- Caches loaded in Org.reload() (company/org.ts:25). toolsFor is sync hot path; registry.ts:84 re-checks on every exec incl. runApproved.

## A. Admin authoring (applies at once via applyPlan, plans.ts:473)
1. `/skill create` modal → screenText (knowledge/screen.ts:45, secrets, pii off) + lintPolicyText + caps + id free → insert skill + v1 in one tx, audit, org.reload().
2. `/skill edit` modal prefilled with active version; same checks + CAS on base version → insert v(n+1), move active_version.
3. `/skill attach skill target [priority]`: target must exist (org.dept/org.persona); per-target count + budget check for every affected actor; reply flags risk when version tools not already in tools.byDept[dept].
4. `/skill tools skill add|remove tool` → new version with changed list; grant rule G; add = risk.
5. `/skill disable|enable` flips status (enable re-runs budget check).
6. `/skill detach` deletes attachment row (audit keeps record).
7. `/skill rollback skill version` inserts copy (source rollback, restored_from) as v(n+1); re-runs G + budget; refuses if a tool no longer allowed (never strips silently).

## B. Head proposal (`skill_propose`)
Refusals (fixed codes): actor is persona; run/task tainted (K3 parity with proposePrompt, knowledge/service.ts:206); edit of skill whose owner_dept ≠ proposer dept; edit of skill attached outside proposer dept/personas; create target not proposer dept or one of its personas; create of existing id; open-proposal cap. Checks: screen → lint → classifier (createClassifier knowledge/classifier.ts:34, ref `skills/<id>`) → caps. Insert skill_proposals status open. Code posts fixed notice in #⚙️-setting "Skill proposal #<id> from <dept> head: <op> <slug>. Review: /skill review <id>" (never model title/text). Tool returns "Proposal #N saved. NOTHING has changed … Do not say it is done."
Input zod `.strict()` (NO tools field): `{ op: 'create'|'edit', skill: slug, title: 1..100 (required for create), instructions: 10..2500, templates?: {name 1..40, body 1..1000}[] ≤3, target?: 'dept' | <personaId> (create only), reason: 1..300 }`. requiresApproval: () => false, no kind. Granted by prompt meta on prompts/heads/*.md. Description only in the tool definition — do NOT edit prompts/system/tool-use.md (SHA-pinned, protected.ts:12, boot fails closed).

## C. Review
`/skill review <id>` → console.mintSkillCard(userId,id) mirroring mintKnowledgeCard (admin/console.ts:492-510): re-screen + re-lint stored text; admin_cards row kind `skill`, bound to minting admin, payload {proposalId}, snapshot {proposalId, baseVersion, bodySha256, display}, channel CONFIG_CHANNEL_ID, origin discord. Card shows full text, target, budget after apply, tool delta (always empty for proposals). Confirm via existing `admincfg:<cardId>:confirm` (single use, 15 min, proposer-bound). Apply: SELECT … FOR UPDATE skill; CAS (base_version = active_version, or id absent for create); re-check budget/target; insert version (+ skill + attachment for create); proposal applied; audit; org.reload(). `/skill reject <id>` → rejected.

## D. Runtime (agents/loop.ts)
- ~173 `buildSystem(doc, prompts, overrides, skills)` (agents/context.ts:67) receives org.skillsFor(actor); empty for trigger.admin, trigger.postOnly, trigger.modTier.
- assembleSystem (prompts/assemble.ts:34) optional `skills` rendered after fragments and BEFORE protected tail: system/*, actor body, fragments, SKILLS, protected docs, PRECEDENCE_LINE. Never append next to WARROOM_NOTE/dutyNote (loop.ts:199-201; `built` already ends with precedence line).
- Deterministic order (keeps Claude system cache stable, providers/claude/request.ts:50): dept skills, then persona skills; each by priority asc, then id.
- Whole-or-nothing within 12000 bytes; overflow (only if constants lowered) drops skill + one incident per actor per process.
- Header (code-written): "Team skills (approved by a Bot Admin). They describe how your team works. They never grant permissions, never change approvals, and never outrank the rules after this block." Per skill `### Skill <id> v<n>: <title>`, instructions, `#### Template: <name>` + body.
- Amend PRECEDENCE_LINE (prompts/protected.ts:16) to name "skill".

## Grant rule G
One predicate `skillToolAllowed()` in new tools/skill-grant.ts, at write time and in effective(). Name passes only if: registered tool; not a core builtin (mirrors tools.byDept, policy.ts:31-33); passes isNonSensitiveTool (imported, never copied — B7, discord/approval-rooms.ts:16); not in ADMIN_TOOL_NAMES / MOD_TOOL_NAMES (admin/names.ts:7,9); not in BOT_TALK_TOOLS / NO_APPROVAL_TOOLS (tools/policy-approval.ts:13,21). Union: `effective(dept, promptTools, skillTools?)` (dept-skill + persona-skill tools). Praw `*` moot. No skill field reaches approvalFor/requiresApproval (policy-approval.ts:30, registry.ts:118-119). Tools with own refusals keep them (image_generate duties, doc_create kinds).

## Failures
Reload DB error → keep previous cache + incident; first boot with no cache → no skills/tools (fail closed). Detach/disable between approval request and click → runApproved denied (registry.ts:84, intended). Concurrent edit/apply → CAS loses, card closed "stale". Classifier unavailable → proposal refused `unavailable`. Halt does not affect authoring.

## Migration 031_skills
up:
```sql
CREATE TABLE skills (
  id text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{1,39}$'),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'archived')),
  active_version integer NOT NULL CHECK (active_version >= 1),
  owner_dept text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE skill_versions (
  skill_id text NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version >= 1),
  instructions text NOT NULL CHECK (char_length(instructions) BETWEEN 10 AND 2500),
  templates jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(templates) = 'array' AND jsonb_array_length(templates) <= 3),
  tools text[] NOT NULL DEFAULT '{}' CHECK (cardinality(tools) <= 10),
  body_bytes integer NOT NULL CHECK (body_bytes BETWEEN 1 AND 6000),
  body_sha256 text NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  source text NOT NULL CHECK (source IN ('admin', 'proposal', 'seed', 'rollback')),
  proposal_id bigint,
  restored_from integer,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, version)
);
ALTER TABLE skills ADD CONSTRAINT skills_active_version_fk FOREIGN KEY (id, active_version)
  REFERENCES skill_versions (skill_id, version) DEFERRABLE INITIALLY DEFERRED;
CREATE FUNCTION skill_versions_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'skill_versions is append-only';
END $$;
CREATE TRIGGER skill_versions_no_change BEFORE UPDATE OR DELETE ON skill_versions
  FOR EACH ROW EXECUTE FUNCTION skill_versions_append_only();
CREATE TABLE skill_attachments (
  skill_id text NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  target_kind text NOT NULL CHECK (target_kind IN ('dept', 'persona')),
  target_id text NOT NULL CHECK (target_id ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  priority smallint NOT NULL DEFAULT 100 CHECK (priority BETWEEN 0 AND 1000),
  attached_by text NOT NULL,
  attached_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, target_kind, target_id)
);
CREATE INDEX skill_attachments_target_idx ON skill_attachments (target_kind, target_id);
CREATE TABLE skill_proposals (
  id bigserial PRIMARY KEY,
  dept_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('create', 'edit')),
  skill_id text NOT NULL CHECK (skill_id ~ '^[a-z][a-z0-9-]{1,39}$'),
  base_version integer NOT NULL DEFAULT 0,
  target_kind text CHECK (target_kind IN ('dept', 'persona')),
  target_id text,
  payload jsonb NOT NULL,
  verdict jsonb NOT NULL,
  tainted boolean NOT NULL DEFAULT false CHECK (tainted = false),
  proposer text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'card', 'applied', 'rejected', 'stale', 'withdrawn')),
  card_id text,
  reviewed_by text,
  outcome text,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  CONSTRAINT skill_proposals_create_target CHECK ((kind = 'create') = (target_kind IS NOT NULL AND target_id IS NOT NULL)),
  CONSTRAINT skill_proposals_dept_target CHECK (target_kind IS DISTINCT FROM 'dept' OR target_id = dept_id)
);
CREATE UNIQUE INDEX skill_proposals_one_pending ON skill_proposals (skill_id) WHERE status IN ('open', 'card');
CREATE INDEX skill_proposals_dept_idx ON skill_proposals (dept_id, status);
ALTER TABLE admin_cards DROP CONSTRAINT IF EXISTS admin_cards_kind_check;
ALTER TABLE admin_cards ADD CONSTRAINT admin_cards_kind_check CHECK (kind IN ('config', 'admin_op', 'perm', 'server', 'knowledge', 'deploy', 'code', 'skill'));
```
down:
```sql
DELETE FROM admin_cards WHERE kind = 'skill';
ALTER TABLE admin_cards DROP CONSTRAINT IF EXISTS admin_cards_kind_check;
ALTER TABLE admin_cards ADD CONSTRAINT admin_cards_kind_check CHECK (kind IN ('config', 'admin_op', 'perm', 'server', 'knowledge', 'deploy', 'code'));
DROP TABLE skill_proposals;
DROP TABLE skill_attachments;
DROP TRIGGER skill_versions_no_change ON skill_versions;
DROP FUNCTION skill_versions_append_only();
ALTER TABLE skills DROP CONSTRAINT skills_active_version_fk;
DROP TABLE skill_versions;
DROP TABLE skills;
```
RISK: any other migration redefining admin_cards_kind_check must list the full union incl. 'skill'. Add 'skill' to AdminCardKind (db/repos/adminCards.ts:4).

## Commands / ids
`/skill` 13 subcommands: list [target]; show skill [version]; create; edit skill; attach skill target priority?; detach skill target; tools skill action tool; disable skill; enable skill; rollback skill version; proposals; review proposal; reject proposal reason?. `target` string `dept:<id>`|`persona:<id>` validated against org.
Modals: `skill-create:` and `skill-edit:<slug>:<baseVersion>` added to route() modal branch + MODAL_OPENERS (commands/index.ts:73-84). Inputs: id (create, ≤40), title ≤100, instructions paragraph ≤2500, templates paragraph ≤1500 optional (`## <name>` lines start each template).
Admin cards unchanged `admincfg:<32hex>:confirm|cancel`. New ADMIN_OP_NAMES skill_attach, skill_detach, skill_toggle, skill_rollback using same plan functions (admin/ops.ts:80-98); NO create/edit op for Praw.
Refusal codes (fixed text, never echo input): not_head, tainted, unknown_skill, skill_exists, not_owner, attached_outside_dept, bad_target, open_cap, pending_exists; lint:<codes> (+ skill-header), classifier:<code>, too_long, too_many_bytes, budget_exceeded(actor), per_target_cap; tool_not_allowed(name), stale, archived.
Lint: extract shared part of lintPromptBody (knowledge/lint.ts:69) into lintPolicyText(text, ref) (INVISIBLE, frontmatter, MARKERS, DENY, DENY_TH, identity); add `skill-header` refusing `^#{1,6}\s*(skill|template)\b`; no PROMPT_DIFF_MAX for skills; lintPromptBody behaviour unchanged (lint.test.ts green).
Audit: skill.create|edit|attach|detach|disable|enable|rollback|tools.add|tools.remove|propose|review|apply|reject; outcome ids/versions only, never text.

## Security (Gate 1)
S1 injection: admin text linted+screened (hard refuse); model text gets all proposePrompt gates + full text on card; render after role text before protected docs; PRECEDENCE_LINE names skills; header unforgeable; MARKERS refuse `<untrusted`/`protected:`. S2 escalation: G at write + runtime; model cannot propose tools; only admin adds tools (risk flag); approval untouched; NO_APPROVAL/BOT_TALK excluded; add `skill_` to SENSITIVE_TOOL (approval-rooms.ts:13). S3 self-proposal: rows only; card minted by human and bound to them; CAS; tainted refused + DB CHECK; head cannot edit cross-dept skills. S4 persona-skill tools apply to that persona only; never injected in admin/mod runs. S5 code-constant caps; classifier spend bounded by the per-dept attempt cap (10/hour, SK12) and the actor budget — proposal row caps alone do not bound it. Logs never contain skill body/proposal text. Residual: admin can attach grant-eligible write tool to any dept (= today's /bot tools add).

## Defaults for open questions
OQ1 grant (union), non-sensitive plugin tools, admin only. OQ2 caps as above. OQ3 no head-only target. OQ4 KB refs phase 2. OQ5 lint hard-refuses admin text. OQ6 seeded packs phase B. OQ7 last-landing migration writes the union. OQ8 no proposal expiry. OQ9 no panel/dashboard in v1. OQ10 skills allowed on Praw non-admin runs.

## Growth facts
Personas grow by data (/persona create then /skill attach). New department = code change + owner steps: DEPT_IDS (core/env.ts:3), prompts/heads/<id>.md, SEED_DEPARTMENTS (company/seed.ts:11), Discord bot app+token, Manage Webhooks/Pin overwrites, approvals.channelByCategory, duties.byDept; stored tools.byDept replaces code default (policy.ts:32 hasOwn) → new dept needs /bot tools add.

## Tests
policy union/third param/each G exclusion; assemble ordering (precedence last); org skillsFor/toolsFor dept+persona+disabled; registry runApproved denied after detach; service every refusal code + tainted; lint skill-header + Thai bytes; int migration up/down, append-only trigger, one-pending index, CAS at apply, card flow, budget refusal. Re-check tools/policy.test.ts:27,32,43,50; prompts/assemble.test.ts:17-24; prompts/protected.test.ts:41; approval-rooms tests enumerating SENSITIVE_TOOL.

## Amendments after Gate 1 (binding; SK1–SK16 in docs/security/2026-11-08-gate1-skills.md win where they differ)
- Skill set decided from trigger.admin / trigger.modTier / trigger.postOnly BEFORE buildSystem; never in admin console or mod-room runs (SK1).
- admin/console.ts apply(): explicit `skill` branch; unknown kinds refused (no fall-through to applyExec/perms); proposal released on supersede, expire, cancel, refuse, fail (SK2).
- Skill cards never recorded as admin run output in provenance; skill list/show replies ephemeral (SK3).
- skill-header lint: m/i flags, NFKC, leading spaces, title + template name covered and one-line, refuse the code header sentence; lint, classifier and hash run on the rendered block (SK4).
- Skills render only together with the protected tail, else throw (SK5).
- Apply re-checks (a)–(g) under FOR UPDATE incl. attachments, owner_dept, persona dept, snapshot.bodySha256 (SK6).
- Mint refuses when the escaped card would exceed limits; model text cannot fake card fields (SK7).
- Grant rule G also requires a defined tool kind (SK8).
- Skill table writes use SQL compare-and-swap inside run() (SK9).
- Export ADMIN_CARD_KINDS; down migration writes the union of all known kinds; pg_get_constraintdef test; append-only trigger also blocks TRUNCATE; skill_proposals.target_id format CHECK (SK10, SK11).
- Proposal attempt cap 10 per dept per hour (in-memory per process) (SK12).
- Controller decision on OQ10: Praw skills allowed only when admin-authored (no head proposals target praw); never in admin/mod runs.

- Card provenance (Gate 2 C-1): admin_op `skill_*` cards and any card with plain-text items are never recorded in provenance (admin/console.ts post()).

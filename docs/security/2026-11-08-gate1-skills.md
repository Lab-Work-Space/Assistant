---
title: "Gate 1 — SKILLS-1 per-team skills"
task_id: SKILLS-1
gate: 1
status: CONDITIONAL_APPROVE
spec: docs/superpowers/specs/2026-11-08-skills-design.md
migration: 031_skills
last_updated: 2026-11-08
---

# Gate 1 — SKILLS-1 (spec review)

**Verdict: CONDITIONAL_APPROVE.** The design is sound in shape:
- A Bot Admin is the only authority.
- Head proposals are rows only, behind the full `proposePrompt` gate set (taint K3, lint, classifier, caps).
- Skill text sits before the protected tail.
- Grant rule G is one predicate used at write time and at run time, and approval is untouched.
- Limits are code constants.

Three defects in how the spec maps onto the current code must be fixed before build:
- **G1-01.** Admin and mod console runs would receive Praw's skill text.
- **G1-02.** A `skill` card falls through `apply()` into `applyExec`.
- **G1-03.** Model-authored card text re-enters the admin console history as clean text.

Conditions SK1 to SK16 bind the build and Gate 2.

Code is cited by file plus function or quoted fragment. Spec line numbers are hints only.

## 1. Findings

| ID | Severity | Evidence | Description | Remediation | Owner |
| :--- | :--- | :--- | :--- | :--- | :--- |
| G1-01 | High | agents/loop.ts `runAgent`: `built = await buildSystem(profile.doc, ...)` runs before `const adminRun = trigger.admin === true`; scheduler `handleAdmin` / mod-room run use `route = { actor: praw }`; spec OQ10 "skills allowed on Praw non-admin runs" | Admin and mod runs resolve the Praw head profile. If `org.skillsFor(actor)` is fed into `buildSystem` at the current call site, Praw-dept skill text lands in the admin console and the mod room, next to the admin tool set (config_propose, perm_propose, code_propose, ...). The spec says "empty for trigger.admin/postOnly/modTier", but the call order makes that easy to miss | SK1 | backend |
| G1-02 | High | admin/console.ts `apply()`: `config` → applyConfig, `admin_op` → applyOp, `knowledge` → applyKnowledge, **everything else** → `applyExec` (port = server/deploy/code, else perms) | A new `skill` kind with no explicit branch reaches `applyExec`, whose port choice ends in `: this.d.perms`, so it is sent to the executor as a permission change (perms port). Release on ending is per kind: knowledge proposals are released in `post` (superseded), `apply` catch, `mintKnowledgeCard` and `sweep`. The Discord cancel path releases nothing. With no matching skill hook, a proposal stuck in status `card` blocks its skill for good through `skill_proposals_one_pending` | SK2 | backend |
| G1-03 | Medium | console `post()`: `provenance?.record(messageId, channelId, p.tainted, p.userId)`; scheduler `adminHistory`: "messages of ours (... hq's cards) that were recorded as this admin's run output" are kept; `skill_proposals.tainted CHECK (tainted = false)` | Skill cards are the first #⚙️-setting Discord cards that show full **model-authored** text, and they would be recorded as untainted output of the minting admin. The next Praw admin console run then reads head-written text as clean history. A head steered by a non-admin user could reach the admin tool set through it | SK3 | backend |
| G1-04 | Medium | spec D "header (code-written)"; spec lint `skill-header` `^#{1,6}\s*(skill|template)\b`; knowledge/lint.ts MARKERS / `protected-text` | Rendered lines are `### Skill <id> v<n>: <title>` and `#### Template: <name>`. As written, the regex has no `m`/`i` flags or NFKC, does not allow 1 to 3 leading spaces, and does not cover title or template name. A newline in the title or name could forge a header. The code header sentence ("Team skills (approved by a Bot Admin) ...") is not refused, so a skill could fake the end of the block. The spec does not say which text is screened, linted and classified (instructions only, or the rendered block) | SK4 | backend |
| G1-05 | Medium | prompts/assemble.ts `assembleSystem`: `tail = input.protectedDocs?.length ? [...] : []` | If skills are added to the array unconditionally, a call without `protectedDocs` puts skill text last, with no protected docs and no precedence line after it | SK5 | backend |
| G1-06 | Medium | spec C "apply: CAS ... re-check budget/target"; spec B refusals `not_owner`, `attached_outside_dept` checked at propose only | TOCTOU between propose and apply. Example: a head proposes an edit of a skill attached only to its own dept, then an admin attaches the skill to another dept, then the card is confirmed. The edited text now reaches a dept whose head could not propose it. The same applies to a persona target that moved or was disabled, and to `owner_dept` changes. Also, the snapshot `bodySha256` must be compared at apply, or it binds nothing | SK6 | backend |
| G1-07 | Medium | admin/card.ts `renderCard` → `escapeCardText(s, 1_000_000, ...)`, then "the real limit is checked on the escaped text" | Reading the full text is the human-review control. A maximum-size version (≤4000 chars, ≤6000 bytes) plus header, target, budget and tool lines can exceed the embed limit once escaped. Mint must refuse, never cut. Model text must not be able to fake card UI (budget line, tool delta, "Confirm") | SK7 | backend |
| G1-08 | Medium | tools/registry.ts `exec`: `const central = tool.kind ? approvalFor(...) : false`; tools/types.ts `kind?: ToolKind` | Rule G does not require a defined kind. A plugin with no `kind` and `requiresApproval: () => false` would run a write with no approval once granted by a skill. Every plugin tool reviewed today has a kind (clickup, jira, ocr, lessons, workspace, forum, pin, music, schedule, watch, reminders, docs, sheets), so this is not exploitable now. It is a latent hole for the next plugin | SK8 | backend |
| G1-09 | Medium | discord/commands/plans.ts `PlanOk.before` + `run()`; console `applyOp` re-plans, compares `before`, then runs `run()` | Skill ops (Praw admin_op attach/detach/toggle/rollback, and the slash path) write to tables, not config. A `before` compare followed by `run()` is check-then-act. The compare-and-swap must happen in SQL inside `run()` | SK9 | backend |
| G1-10 | Low | db/migrations 014/016/017 each rewrite `admin_cards_kind_check` with a full list; spec 031 down restores the 017 list | Concurrent 029 (SPEND-1, no spec on disk) / 030 (OT-1, spec does not touch admin_cards) could add or need kinds. A 031 down that hard-codes the 017 list would drop a kind added by 029/030 | SK10 | backend / database |
| G1-11 | Low | spec migration `skill_versions_no_change BEFORE UPDATE OR DELETE ... FOR EACH ROW` | TRUNCATE bypasses a row trigger. The app role (table owner) can also disable the trigger. This is integrity hygiene, not a boundary. `skill_proposals.target_id` has no format CHECK (attachments have one) | SK10 | database |
| G1-12 | Low | spec S5 "proposal caps bound classifier spend"; service order lint → classifier → insert | Refused proposals insert no row, so the open-proposal cap does not bound classifier calls. The real bound is the actor budget (knowledge/small.ts "metered call core ... reserve, stream, settle") plus turn limits. The claim is inaccurate. Accepted as residual with an attempt counter (SK12) | SK12 | backend |
| G1-13 | Low | spec B refusal codes `unknown_skill` vs `not_owner` / `attached_outside_dept` / `skill_exists` | A head can learn that a slug exists in another department, but not its text. This is an enumeration oracle only | residual | — |
| G1-14 | Low | knowledge/lint.ts `PRAW_NAME` applies when `ref !== 'heads/praw'`; skill ref `skills/<id>` | A Praw-dept skill that names Praw is refused. This is functional, not a security issue; it is noted so nobody adds a bypass keyed on the ref | none | — |
| G1-15 | Info | spec screen `pii: false` | Model-proposed PII (a phone number or ID) would enter the system text of every actor in the dept and go to the provider. The admin sees it on the card. Recommendation only: refuse model proposals where `maskPii(text) !== text` | recommendation | backend |

## 2. Domain checklist

| Domain | Result | Note |
| :--- | :--- | :--- |
| Prompt injection (admin text) | PASS with SK4, SK5 | screenText (secrets) + `lintPolicyText` hard refuse. Placement: after fragments, before the protected docs and PRECEDENCE_LINE. The amended PRECEDENCE_LINE names skills. `protected-text` DENY already refuses "take precedence over", so the precedence line cannot be forged |
| Prompt injection (model proposals) | PASS with SK3, SK4, SK6, SK7 | K3 taint parity (`run.tainted \|\| run.task?.tainted`) + DB CHECK; classifier fails closed (knowledge/classifier.ts STRICT, timeout, unavailable). Proposal text never reaches a prompt before confirm. The fixed #⚙️-setting notice carries the slug only |
| Header forgery | CONDITIONAL → SK4 | |
| Cache stability | PASS with SK11 | Deterministic order (dept skills, then persona; priority, then id); whole-or-nothing overflow |
| Reasoning isolation | N/A | No new client-visible model output path |
| Privilege escalation via tools | CONDITIONAL → SK8, SK13 | G excludes core builtins, SENSITIVE_TOOL (imported, B7), ADMIN_TOOL_NAMES, MOD_TOOL_NAMES, BOT_TALK_TOOLS, NO_APPROVAL_TOOLS. registry `exec` re-checks `ctx.org.toolsFor` on run and runApproved. Approval is untouched (`approvalFor` gets no skill field). G is stricter than today's `planBotTools` (any registered plugin) |
| Self-proposal / card binding | CONDITIONAL → SK2, SK6, SK7 | Card minted by a human, proposer-bound (`consume ... c.proposer_id = $3`, newest pending only), 15 min, single use |
| Cross-dept leakage | PASS with SK6, SK13 | Persona-skill tools apply to that persona only. `/skill list`, `/skill show` and `/skill proposals` are #⚙️-setting-only behind the `decide()` guard; replies must be ephemeral (SK3) |
| Praw admin_op limits | PASS with SK9, SK14 | Only attach/detach/toggle/rollback, no create/edit. Praw can already `bot_tools add` today, so this is no new reach |
| Budget / limits | PASS with SK12 | Code constants in `skills/limits.ts`; `config_propose` cannot raise them |
| Migration 031 | PASS with SK10 | Deferred FK fine (the migration runs in one transaction, db/migrate.ts). One-pending partial index. `tainted CHECK false` |
| Audit / log privacy | PASS with SK15 | Outcomes are ids/versions only. Loop logs `ref` only on a protected-prompt failure |
| Secrets | PASS | screenText refuses secret-shaped text (redaction identity) |
| AuthN/AuthZ | PASS | Slash and modal submit both pass `decide()` (guild, #⚙️-setting, live Bot Admin role). Card click re-checks the role live |
| Native memory, containers, supply chain | N/A | TypeScript only, no new dependency or image |

## 3. Binding conditions (Gate 2 verifies each with the named test)

**SK1 (G1-01). No skills in admin, mod or post-only runs.**
- Compute the skill set **before** `buildSystem` in `runAgent`, from the trigger: `skills = (trigger.admin || trigger.modTier || trigger.postOnly) ? [] : org.skillsFor(actor)`.
- `buildSystem` takes it as an explicit parameter. There is no default that reads org inside context.ts.
- Tests in `agents/loop.int.test.ts`:
  - with a praw-dept skill attached, the system text of an admin run, a mod-room run and a post-only run contains no "Team skills" header and no skill id;
  - a normal Praw run and a normal head run do contain them.

**SK2 (G1-02). Explicit `skill` card dispatch and release on every ending.**
- `apply()` gets a `skill` branch (`applySkill`).
- The final fallback becomes an explicit check for `perm|server|deploy|code` that refuses any other kind (`refuseCard('unknown card kind')`).
- `releaseCard` for skill proposals (`card` → `open`, only when `card_id` matches) runs on: superseded (`post` and mint), expired (`sweep`), cancelled (the Discord cancel path and dashboard cancel), refused (stale/CAS) and failed (`apply` catch).
- `cardKindMinTier('skill')` stays `bot_admin`.
- Skill cards are `origin: 'discord'`, channel `CONFIG_CHANNEL_ID` only. Never dashboard, never the mod room.
- Tests:
  - `admin/console.int.test.ts`: a skill card confirm reaches `applySkill` and never the executor port; an unknown kind is refused;
  - each ending (supersede, expire, cancel, CAS-refuse, throw) leaves the proposal `open` with `card_id` cleared, and a new card can be minted;
  - a mod-room click on a skill card is refused.
  - `discord/tiers.test.ts`: `skill` maps to `bot_admin`.

**SK3 (G1-03). Model text never re-enters admin history as clean.**
- A skill card message is **not** recorded in provenance as the admin's run output. Either do not record it (so `adminHistory` drops it as unrecorded), or record it with `userId: null` and `tainted: true`.
- `/skill show`, `/skill proposals` and `/skill review` replies are ephemeral.
- Tests:
  - `agents/scheduler.admin.test.ts`: after a skill card is posted in #⚙️-setting, `adminHistory` for the minting admin does not contain it;
  - `discord/commands/skill.test.ts` (new): the listing/showing replies are ephemeral.

**SK4 (G1-04). Lint, screen, classifier and hash cover exactly what is injected.**
- Every field is screened and linted: title, instructions, and each template name and body. Title and template name use `screenText(..., { multiline: false })`. The whole **rendered block** (as `skills/render.ts` will emit it, without the code header) goes to `lintPolicyText` and to the classifier (`next` = rendered block, `prev` = rendered active version or `''`).
- `skill-header` matches on NFKC, case-folded text with flags `mu`: `^\s{0,3}#{1,6}\s*(skill|template)\b`.
- Also refused:
  - setext underlines (`^\s{0,3}(=+|-+)\s*$` right after a line starting with `skill`/`template`);
  - on the skeleton, the full code header sentence and the phrase "approved by a bot admin". The bare phrase "team skills" is **not** refused, because ordinary prose uses it.
- Bytes first (global rule 13): the zod length and byte caps run before any screen, lint or regex.
- `body_sha256` and `body_bytes` are computed over the same rendered block.
- `lintPromptBody` behaviour is unchanged.
- Tests in `knowledge/lint.test.ts`:
  - forged headers: indented, fullwidth `＃`, Cyrillic `Ѕkill`, inside a template body, a title with a newline;
  - the header sentence and "approved by a Bot Admin" are refused;
  - negative case: "improve our team skills" in normal prose passes;
  - existing cases still green.
- Tests in `skills/service.test.ts` (new): a title or template name with a newline is refused; a classifier that receives the rendered block sees the template bodies.

**SK5 (G1-05). Skills render only together with the protected tail.**
- `assembleSystem` puts skills only when `protectedDocs` is non-empty, in this order: system/*, actor, fragments, header + skills, protected docs, PRECEDENCE_LINE.
- With skills and no protected docs it throws (fail closed).
- WARROOM_NOTE and dutyNote stay where they are (after `built`). No skill text is appended in loop.ts.
- Tests in `prompts/assemble.test.ts`:
  - order;
  - the output ends with `PRECEDENCE_LINE`;
  - skills with no protected docs throw;
  - an empty skill list gives byte-identical output to today.
- Test in `prompts/protected.test.ts`: the amended line contains "skill".

**SK6 (G1-06). Apply re-checks everything under lock.**
- `applySkill` runs in one transaction with `SELECT ... FOR UPDATE` on the `skills` row (and on the attachment rows of that skill). It refuses (card closed "stale", proposal `stale`) unless all of these hold:
  - (a) `active_version = base_version` (or the id is absent, for create);
  - (b) the rendered payload's sha256 equals `snapshot.bodySha256`, and `proposal.card_id = card.id`;
  - (c) `owner_dept = proposal.dept_id` for edit (NULL fails);
  - (d) every current attachment is `dept:<proposal.dept_id>` or a persona whose **current** `deptId` is the proposal dept;
  - (e) a persona target still exists, is enabled and belongs to the dept;
  - (f) the budget and per-target caps hold for every affected actor;
  - (g) the tool list is unchanged from the base version (proposals carry no tools).
- Tests:
  - `skills/service.int.test.ts` (new): each of (a) to (g) changed between mint and confirm refuses and inserts no version;
  - `owner_dept` NULL refuses an edit proposal at propose and at apply.

**SK7 (G1-07). The card shows the full text or nothing.**
- The skill card uses `renderCard` / `escapeCardText` with no cut. If the escaped card exceeds the limit, mint refuses with `too_long`, and the proposal stays open for `/skill reject`.
- Code writes the target, current attachments, budget after apply, tool delta, proposer (`heads/<dept>`) and the proposer's reason as separate code-labelled items.
- The model text is one item clearly labelled "Proposed text (written by a model)".
- `allowedMentions` parse none, the same as other cards.
- Tests in `admin/card.test.ts`:
  - a maximum-size Thai version (2500 chars of instructions + 3×500-char templates, ~6000 bytes) either renders whole or mint refuses;
  - no ellipsis or cut;
  - text containing "Tool delta: none" or "Confirm" is inside the escaped item, never a code-labelled field.

**SK8 (G1-08). Rule G completeness.**
- `skillToolAllowed(name)` in `tools/skill-grant.ts` returns true only if every one of these holds:
  - the tool is registered, **and has a defined `kind`**;
  - it is not a core builtin;
  - `isNonSensitiveTool(name)` (imported from discord/approval-rooms.ts);
  - it is not in `ADMIN_TOOL_NAMES` or `MOD_TOOL_NAMES`;
  - `!isBotTalk(name)` and `!isNoApproval(name)`.
- Use the exported predicates and arrays, never copies.
- Add `skill_` to `SENSITIVE_TOOL`.
- `effective(dept, promptTools, skillTools)` filters `skillTools` through the same predicate at run time, so a version stored before a rule change is filtered and never trusted.
- Tests in `tools/skill-grant.test.ts`: one case per exclusion, each on a **stub registry** where the name is registered **with a kind** and fails **only** the check under test. Real names alone fall to an earlier check: `config_get`/`server_propose`/`deploy_read` are not in the normal registry and also match SENSITIVE, and `warroom_say`/`skill_propose` are builtins. So deleting one check must turn exactly one test red. Cases:
  - a builtin-only stub (`create_task` in builtins);
  - SENSITIVE: `github_create_branch`, `save_lesson`, `knowledge_propose`, `prompt_propose`, `skill_x` (non-builtin stub, proves the new `skill_` prefix);
  - list check: `discord_read` registered as a non-builtin plugin with a kind. It is in ADMIN and MOD and does not match SENSITIVE, so it is the case that proves the list check is needed;
  - bot talk: `warroom_say` registered as a non-builtin stub;
  - no approval: `diagram_create` (registered, kind write, non-builtin);
  - a kindless plugin;
  - an unregistered name.
  - Positive case: `clickup_create_task`.
  - A mutation check at Gate 2 removes each clause in turn and expects exactly its own test to fail.
- Tests in `tools/policy.test.ts`:
  - union with dept-skill and persona-skill tools;
  - a G-failing name in the stored version is dropped at run time;
  - the existing tests at :27, :32, :43, :50 are still green.
- `discord/approval-rooms.test.ts`: the SENSITIVE_TOOL enumeration includes `skill_propose`.

**SK9 (G1-09). Compare-and-swap in SQL for every skill write.**
- Each skill plan's `run()` performs its writes in one transaction with `FOR UPDATE` and `WHERE active_version = $expected` (or the equivalent attachment-row predicate). A lost race throws a typed stale error that the console maps to `refuseCard('stale')`, and nothing is written.
- The slash `edit` modal re-parses `skill-edit:<slug>:<baseVersion>` strictly: slug regex, `baseVersion` a positive integer.
- Test in `skills/plans.int.test.ts` (new): two concurrent edits on one base version give exactly one new version; detach between plan and run is refused.

**SK10 (G1-10, G1-11). Migration safety.**
- Export `ADMIN_CARD_KINDS` (an `as const` array) from db/repos/adminCards.ts and derive `AdminCardKind` from it.
- The 031 down migration restores the kind list that was in force **before** 031, including any kind added by 029/030 if they land first. Whichever migration lands last writes the full union (OQ7).
- Add a `BEFORE TRUNCATE ... FOR EACH STATEMENT` trigger on `skill_versions`. The trigger function sets `SET search_path = pg_catalog, pg_temp` (global rule 16; it references no table, so this is hygiene).
- Add `CHECK (target_id IS NULL OR target_id ~ '^[a-z0-9][a-z0-9-]{0,63}$')` on `skill_proposals`.
- Tests in `db/migrations.int.test.ts` (or `skills/migration.int.test.ts`):
  - after up, `pg_get_constraintdef(admin_cards_kind_check)` lists exactly `ADMIN_CARD_KINDS`;
  - UPDATE, DELETE and TRUNCATE on `skill_versions` raise;
  - a second open proposal for one skill violates `skill_proposals_one_pending`;
  - inserting a skill row with no version fails at COMMIT (deferred FK);
  - up → down → up leaves the constraint equal to the pre-031 list after down.

**SK11. Deterministic render and overflow.**
- `skillsFor` returns active skills attached to the dept and to the persona (for heads: dept skills only), sorted (dept, then persona; priority asc, then id), with the active version.
- Disabled and archived skills are excluded, as are skills attached to a disabled persona.
- Overflow keeps the skills in that order and drops each one that does not fit whole. At most one incident per actor per process. The incident carries ids only.
- A reload failure keeps the previous cache. Departments, personas, channels and skills are swapped together only after every query succeeded.
- Tests in `company/org.int.test.ts`:
  - order;
  - disabled and archived excluded;
  - the persona sees dept + own skills, a head sees dept skills only, another dept sees none;
  - a failed skills query leaves the earlier cache and tools unchanged;
  - identical input gives a byte-identical rendered block.

**SK12 (G1-12). Attempt cap and correct spend claim.**
- In `skills/limits.ts`, add a per-dept cap of 10 `skill_propose` attempts per rolling hour (the constant). The counter lives in memory, per process, keyed by dept id, in the skills service (one sliding window of timestamps per dept; a restart resets it, which is accepted because the actor budget still bounds spend). Refusals count. Lint refusals stop before the classifier.
- Correct spec S5 to "classifier spend is bounded by the actor budget and the attempt cap".
- Test in `skills/service.test.ts`: the 11th attempt in an hour is refused before screen/classifier (classifier mock not called).

**SK13. Proposal scope and tool path.**
- `skill_propose` zod is `.strict()` with no `tools` field. Its `requiresApproval` is false and it has no kind.
- It is registered as a core builtin, granted by prompt meta on `prompts/heads/*.md` only. The service refuses `actor.kind !== 'head'` (`not_head`) whatever the meta says.
- `prompts/system/tool-use.md` is not edited (SHA pin, protected.ts).
- Tests in `skills/service.test.ts`:
  - every refusal code from spec B;
  - a persona actor is refused;
  - a tainted run and a tainted task are refused;
  - an input with `tools` fails zod;
  - a create target persona of another dept is refused.
- Test in `prompts/protected.test.ts`: tool-use hash unchanged.

**SK14. Praw admin_op skill ops.**
- `skill_attach`, `skill_rollback` and `skill_toggle` (enable) are marked `risk: true` when the effective tool set of any affected actor grows. The card lists the tool delta per affected actor.
- `skill_rollback` shows the full restored text (same rule as SK7: whole or refuse).
- `skill_attach`, `skill_toggle` (enable) and `skill_rollback` recompute rule G and the budget at apply.
- There is no create or edit op. `ADMIN_TOOL_NAMES` and `ADMIN_CONSOLE_NOTE` are unchanged.
- Tests in `admin/ops.test.ts`:
  - the schema accepts exactly the four ops and refuses `skill_create`/`skill_edit`;
  - an attach that adds a tool sets risk;
  - a rollback to a version whose tool now fails G is refused at plan and at apply.

**SK15. Audit and log text.**
- Audit outcomes, incidents and logs for every `skill.*` action carry ids, versions, codes and counts only. Never title, instructions, template text or reason.
- `tool_not_allowed(name)` echoes the name only after it matches `^[a-z0-9_]{1,64}$`.
- The #⚙️-setting proposal notice is the fixed template with the slug and dept id only, with `allowedMentions` none.
- Test in `skills/service.test.ts`: a marker string placed in the instructions, title and reason never appears in captured audit rows, log calls or the notice.

**SK16. Spec text updates before build** (spec owner):
- D: the skill set comes from the trigger, before `buildSystem` (SK1).
- C: list the apply re-checks (SK6) and the release endings (SK2).
- S5 correction (SK12).
- Card provenance rule (SK3).
- Migration additions (SK10).

Gate 2 checks that the spec matches.

## 4. Residual risks (accepted unless the controller rules otherwise)
- **An admin can attach a grant-eligible write tool to any dept.** This is today's `/bot tools add` reach, and the write tool still asks for approval through its kind.
- **A non-admin human in a clean direct chat can steer a head to propose skill text.** The text passes lint and the classifier, and a Bot Admin still reads it in full and confirms. This is the same model as `prompt_propose`.
- **Skills on Praw's normal runs (OQ10).** Praw has `tools: ["*"]`, so a Praw-dept skill steers the most capable non-admin actor. The control is admin confirmation. The controller may restrict Praw skills to admin-authored ones.
- **Cross-dept steering through delegation.** Another dept's head can delegate a task asking head X to propose a skill. The run is not tainted (internal text). The Bot Admin card is the control.
- **Slug enumeration (G1-13)** and the absence of a proposal expiry (OQ8). The open cap is 5 per dept; admins can reject.
- **The append-only trigger is not a boundary** against the app role (table owner).

## 5. Audited files (md5 at review end)
```
24522f0f004821803a2c05a13acabeb5 docs/superpowers/specs/2026-11-08-skills-design.md
3d32dcef3712c9bfe614fc3eb0e7dd1c prompts/assemble.ts
b9e5477683f34ec9e990ec13891c54c9 prompts/protected.ts
164d77195cbe655bffe7106000dc0834 agents/context.ts
e8b6caaa44002b560aedab01e03e947d agents/loop.ts
ea9f469f5c6d329484d1c6dba02219b1 company/org.ts
dd5f0f192296947a4ec9c3b5533d3186 tools/policy.ts
a8654980b62b1751a13ccde3b120d907 tools/policy-approval.ts
0c65caf91cd54c9917b701116e345963 tools/registry.ts
d03ae103c12179d4fc01ac2b011ce0b6 discord/approval-rooms.ts
8c75da68c6d7b24742f869bead319c38 admin/names.ts
e7a2c96e3a201d2e901cd5f43995f678 admin/console.ts
eabd1b1b669b2d01ddee3aae3e03ad5e admin/ops.ts
62d220c4085f21fb1bb1a154d6948475 knowledge/lint.ts
02eb14996f51bd596bd967dce4ae6346 knowledge/screen.ts
e092dcf9bf25e76a46f1f0c7e12b25e8 knowledge/classifier.ts
15efdc802e4e182227a41f19f90f4fc4 knowledge/service.ts
03aa4ebdccb2cff053213df216b31a8c db/repos/adminCards.ts
10368aa78340d7de74eb1cc94946c656 discord/commands/index.ts
6cd098d50db0628822621ff07cacee36 discord/commands/plans.ts
d0230f3e068c0cbec6af044f094abc5b agents/scheduler.ts
056356bf9cb215d74e0f4f0ffecbde58 admin/card.ts
```
Evidence method: static review of the code and spec. No scanners apply (no dependency, image or native change), and no tests were run. No code was edited.

## Owner sign-off (2026-11-08, recorded by controller from the owner's answer in chat)
The owner ACCEPTS residuals (admin can grant non-sensitive write tools via skills = /bot tools add; non-admin can steer a head to propose, Bot Admin card is the control; Praw skills admin-authored only).

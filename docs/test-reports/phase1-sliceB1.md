# Phase 1 Slice B1 acceptance report (TASK-021B-T, text)

Date 2026-11-23. Tester run against FAKES only: no token, no network, `.env.local` / `.env.discord.local` not read. Python 3.14.6, macOS arm64, SQLite via the repo runtime (VPS target 3.45 not exercised).

## 1. Method
- Harness `tests/acceptance_b1/harness.py` drives the REAL product through `core.__main__.amain` (Config, SQLite, 20 personas from `prompts/`, ReplyGate, engine, sinks, button router, approvals, tasks, budget, pulluser). Only two layers are fake: Discord clients (`FClient` on top of `tests/discord_fakes.py`; client i = bot user `9000+i`, app id `1000+i`; shared message ids so authorship is checkable) and the model provider (`Prov`, extends `core.cli.fakes.FakeProv`; counts `stream`/`complete` calls, probe markers in the user text).
- Files: `test_coexist.py` (gate, silence, startup refusals), `test_stream_secrets.py` (streaming, split, secrets), `test_b1_approvals.py` (buttons), `test_threads_pull_budget.py` (delegation, brainstorm, attachment, pull-user, /budget), `test_exploratory.py`, `measure_resources.py`.
- Run: `.venv/bin/python -m pytest -q -p no:cacheprovider tests/acceptance_b1` and `.venv/bin/python -m tests.acceptance_b1.measure_resources 20 400`.
- Mutation check (scratch, not kept): bypassing `Gate.allowed_channel`, `Gate.dm_ok`, `Router._bound` or `DiscordRoleApproverPolicy.is_approver` each made the matching tests FAIL (4 of 4 killed), so the silence/refusal assertions are not vacuous.

## 2. Results
```
$ .venv/bin/python -m pytest -q -p no:cacheprovider tests/acceptance_b1
45 passed, 7 xfailed, 104 warnings in 25.26s
$ .venv/bin/python -m pytest -q -p no:cacheprovider          (full suite, run twice)
401 passed, 7 xfailed, 122 warnings in 40.30s
$ sh tests/acceptance/run.sh <out>                            (Slice A script regression, SQLite)
ac1..ac11 rc=0, selftest_crash failed signal:6, pytest 398 passed 7 xfailed (before 3 tests were added); planted keys only in the script INPUT file
```
The 7 xfailed are strict xfails that encode DEFECT-1 and SPEC-GAP-1 (below); they flip to failures when those change. Spec anchors read: spec-s12 §12.6, §12.7, §12.10, §12.10.1 (S1210-01..10), main spec §3.1.

| Item | Test(s) | Result |
| :-- | :-- | :-- |
| AC-1 addressed reply streams (placeholder `...` then edits, own client per persona, no @everyone) | `test_addressed_reply_streams_by_own_client` | PASS |
| AC-1 silence: unaddressed = 0 provider calls; Tier 1 name = 0 `complete`; reply-to-agent; Tier 2 only for ambiguous names | `test_tier1_clear_calls_still_work_zero_llm`, `test_tier2_*`, `test_two_humans_*` | PASS |
| 12.6 non-allowlisted channel (mention, reply, name): no reply, 0 stream / 0 complete calls, canary text absent from every sent message and the JSON log, the log rows added during the probe are ONLY `gate.outside_allowlist` (non-empty log, set equality; channel id + suppressed count; 50 messages -> 1-2 lines) | `test_non_allowlisted_*`, `test_outside_log_is_rate_limited_*` | PASS |
| Slash command and button click outside allowlist (on praw and tek clients): ephemeral `NOT_ALLOWED`, nothing else | `test_slash_and_button_outside_allowlist_*` | PASS |
| DM from non-approver / non-member in coexist: silence, 0 provider calls, canary not logged; approver DM answered | `test_dm_non_approver_silent_approver_answered` | PASS |
| `app_id_mismatch:praw` -> rc 2, nothing posted; non-intake mismatch -> only that persona disabled, `persona_disabled:tek` line, name call routed to Praw | `test_app_id_mismatch_*` | PASS |
| `token_shared`, `unknown_persona_token:NOBODY`, `use_per_persona_tokens`, `allowlist_empty`, `channel_not_allowlisted` (TASKS/ADMIN/APPROVAL outside allowlist), `allowlist_unresolved`, `cli_flag_in_discord_mode`: rc 2, code only on stderr, no token echoed | `test_token_shared_*`, `test_empty_allowlist_*`, `test_dev_cli_flag_*` | PASS |
| Foreign guild left at startup, logged per client | `test_other_guild_is_left_at_startup` | PASS |
| S1210-05/06: non-intake clients have Guilds intent only (no message content, members, DM), `AllowedMentions.none()` on all, only `on_interaction`+`on_ready` listeners; intake alone has `on_message` | `test_intents_and_listeners_*` | PASS |
| AC-9 bot level: queued `selftest_crash` job fails `signal:*`, bot keeps answering, exits 0 | `test_bot_level_crashing_job_*` | PASS |
| AC-4 card posted with Approve/Reject; AI-Admin approves -> ephemeral `APPROVED`, row `approved decided_by=discord:<id>`, card edited, buttons removed, agent resumes in channel; 2nd click refused; reject path; non-admin / wrong role / forged `roles` on the interaction -> ephemeral `NOT_APPROVER`, status unchanged | `test_b1_approvals.py` (5 tests) | PASS |
| Forged button: right custom_id on another message, on another persona's message, delivered to the wrong client, no message, malformed ids, bot user, wrong guild, click outside allowlist -> `BUTTON_INACTIVE`/refusal, approval stays pending | `test_forged_*`, `test_reject_by_admin_and_card_outside_*` | PASS |
| Streaming split keeps Thai and fences: odd 37-char chunks, >2 messages, each <=2000, fence-balanced, no message starts on a combining mark, Thai char sequence identical, 150 code lines intact; oversize -> `TRUNCATED` marker within `STREAM_MAX_MESSAGES` | `test_long_thai_and_code_fence_split`, `test_oversize_*` | PASS |
| AC-10 secret planted in a model reply (exact persona token split across chunks + `sk-ant-` pattern split) never in any sent message, ANY intermediate edit, embed, or app log; human-typed key not echoed to channel or log | `test_secret_planted_*`, `test_secret_typed_by_human_*` | PASS |
| AC-2 delegation: thread under allowlisted channel, task embed by delegator's client, assignee replies via its own client | `test_delegation_thread_embed_and_own_identity` | PASS |
| AC-3 brainstorm: alternating clients, `closed/turn_limit`, 3 turns, summary + "Brainstorm closed" embed | `test_brainstorm_turn_limit_*` | PASS |
| AC-6 image attachment: one file, sanitised `.png` name, no mentions | `test_image_attachment_*` | PASS |
| AC-8 pull-user (thread/DM): plain member -> thread mention of that user only, no DM in coexist; approver -> DM invite with Join button; bot / self / non-member refused | `test_pull_user_*` | PASS |
| `/budget` view (21 lines incl. `_gate`, ephemeral), set by non-approver refused, by approver applied, bad amounts/unknown agent rejected, forged origin (component, bot, other guild) refused and limit unchanged; 80% notice goes to admin channel pinging the approver role only | `test_budget_*` | PASS |
| Exploratory: task thread with 12 human messages -> `turn_limit`, 3 provider calls, closed, 0 after close | `test_task_thread_human_spam_*` | PASS |
| Exploratory: two humans in one channel: window is per (channel, user); B stays silent while A talks to praw; B addressing tek does not move A; A mentioning human B inside A's window is silent; A's window expires at 301 s | `test_two_humans_*`, `test_window_expires_*` | PASS |
| Exploratory: per-user hourly cap (3) drops with `gate.dropped user_rate`, 0 provider calls; busy queue = 1 running + 3 waiting, 4 dropped `busy`; Tier-2 per-channel cap (2 of 5) with `gate.tier2_skipped rate`; bad classifier output (`yes:evil`, injected newline, non-candidate) -> silence | `test_per_user_*`, `test_busy_*`, `test_tier2_*` | PASS |
| Exploratory: 429 on an intermediate edit recovers | `test_429_on_intermediate_edit_recovers` | PASS |
| Exploratory: Thai Tier 1, persona name at the start of a longer word | `test_tier1_name_inside_longer_word_*` | 6 FAIL-as-xfail (SPEC-GAP-1, spec-conformant); 3 controls PASS |
| Exploratory: 429 on the FINAL edit | `test_429_on_final_edit_*` | FAIL-as-xfail (DEFECT-1) |

## 3. Defects
- **DEFECT-1 (Low-Medium, owner TASK-008)**: `core/discord/streaming.py` `finish()` does one final `flush`; if that edit gets a 429 it returns without retry and the message keeps the previous partial text. Repro: `--runxfail` on `test_429_on_final_edit_*` gives history `['...', '[fake] reply from ']` vs expected `[fake] reply from gemini-3.8-flash`. py-cord normally absorbs 429 internally, so exposure is low; no error is logged to the user.
- **SPEC-GAP-1 (Medium, owner sa/pm decision, then TASK-009)**: the code matches spec §3.1 ("Thai aliases match as substrings"; a hit at the start of the text is a vocative), but the rule produces replies with no LLM gate on ordinary Thai sentences starting with a persona name: `เทคโนโลยี...` (tek), `ฝนตก...` (fon), `คิวยาว...` (qin), `เบสบอล...` (bass), `ปิ่นโต...` (pim), `พลอยสีแดง...` (ploy). Effect: spurious replies and token spend in shared channels (bounded by the 30/h user cap). Needs a policy choice (word-boundary check or Tier 2 for prefixes of longer Thai words); the 6 strict xfails are the regression set.
- **OBS-1 (Low, TASK-008)**: an @mention of a persona whose client was disabled (app id mismatch) is silent: it never enters `persona_by_user_id` because `_common_ready` raises first. Only name calls reach the "route to Praw" path.
- **OBS-3 (Low, spec-conformant, TASK-009)**: the 5-minute window is per user, not per addressee: A's plain line meant for human B (no @mention) inside A's window is still answered by the persona. Only an @mention of another non-bot user skips the window.
- **OBS-2 (Low)**: a button click from user id 0 (not a snowflake) ends in `button.handler_failed ValueError` and the generic "Something went wrong" ephemeral. Fail-closed, unreachable on real Discord.
- Note: log warnings `extension.missing core.voice.ext` / `core.agent_tools.voice` are expected until B2.

## 4. Resources (S1210-09: MemoryMax=1G, TasksMax=100)
Command: `.venv/bin/python -m tests.acceptance_b1.measure_resources 20 400` (one process, one loop, `amain` with 20 fake clients, 400 addressed messages in waves of 20 concurrent, each a full gate + engine + stream-edit cycle; 400 replies, 400 provider calls).

| Point | RSS | Threads |
| :-- | :-- | :-- |
| imports only | 68.5 MB | 1 |
| after start, 20 clients ready | 74.6 MB | 3 |
| after 400 messages | 75.9 MB (peak 75.9) | 3 (`MainThread`, `emp-db`, `asyncio`) |
| after stop | 75.8 MB | 2 |
| 20 real `discord.Bot` objects, not logged in | +1.3 MB | 2 |

Headroom: about 7% of MemoryMax; 3 of 100 tasks. RSS grew 1.3 MB across 400 messages (no leak signal at this size).
Limits of the measurement: fake clients hold no websocket, aiohttp session, gateway caches or TLS buffers; the real `discord.Bot` objects were never connected. py-cord's gateway uses one `KeepAliveHandler` thread per connected client (`discord/gateway.py:126`), so expect 20 more threads live, plus up to the default executor size for DNS (min(32, cpus+4)): estimate 25-60 threads, not measured; DAVE/voice, ffmpeg workers and job subprocesses (B2/jobs) are excluded. RSS is macOS `ps` plus `ru_maxrss`, Python 3.14; Linux/3.12-3.14 on the VPS will differ. A live measurement on the VPS during B1-ENABLE (`systemctl show employee -p MemoryCurrent -p TasksCurrent`) is still needed.

## 5. ACCEPTANCE vs original request: partially met (B1 text scope, against fakes)
Met with evidence: reply only when addressed (mention/reply/name/context), streamed edits, own identity per persona, task/brainstorm threads with turn limit and summary, admin-only approval buttons with ephemeral refusal and forged-click protection, `/budget`, pull-user into thread/DM, coexistence via allowlist (silence, zero provider calls, no content in logs, refusals at start), no secret in Discord output or logs. Not met or not verifiable here: SPEC-GAP-1 (reply precision on Thai names), DEFECT-1 (final-edit 429), real py-cord/Discord wire behaviour (View serialization, real permissions, real rate limits, real gateway threads), B1-SMOKE items, voice (B2), VPS deploy. No Critical/High defects.

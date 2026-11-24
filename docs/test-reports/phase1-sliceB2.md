---
title: "Phase 1 Slice B2 (voice) Test Report"
owner: tester
task: TASK-021B-V
last_updated: 2026-11-23
---

# Slice B2 test report (fakes only)

Subject: commit 90162a6 plus the uncommitted working-tree follow-ups in `core/voice/{ext,session}.py` and `core/knowledge/store.py`. Spec 12.12.18, conditions 12.12.22.
Tests: `tests/acceptance_b2/test_b2_*.py` (fake world from `tests/voice/vfakes.py`; real budget Guard + SQLite where marked). No product code changed.

## 1. Runs
| Command | Result |
| :-- | :-- |
| `.venv/bin/python -m pytest -q -p no:cacheprovider tests core/migration` | 568 passed |
| `.venv/bin/python -m pytest -q -p no:cacheprovider tests/acceptance_b2` | 69 passed (commit 90162a6 exported alone: 68 pass, 1 FAIL = DEFECT-1) |
| Mutation: `VoiceSession.is_allowed` forced True | `test_optout_between_dequeue_and_request_is_rechecked` FAILS (guard is what the test checks) |

## 2. Acceptance items
| Item | Result | Evidence (test) |
| :-- | :-- | :-- |
| Notice before any capture | PASS | `test_notice_posted_before_any_capture`: notice already sent when `start_recording` is called |
| Opted-out user absent (buffers, segments, note) | PASS | `test_opted_out_user_absent_*`, `test_optedout_user_leaving_and_rejoining_*` (no re-admit) |
| Opt-out mid-session, chunk queued (S1212-02) | PASS | `test_optout_mid_session_with_inflight_and_queued_chunk`: queued chunk dropped, 2 STT calls not 3, note lacks id; `..._between_dequeue_and_request_is_rechecked` |
| consent_gap present / unreadable -> refusal + re-ask, rate limit | PASS | 3 refusals, 1 re-ask; new re-ask after 601 s; `PermissionError` on lstat -> refusal |
| Late joiner: full-text mention + delay | PASS | mention is `users=[uid]` only, full disclosure text; not buffered before delay, buffered after |
| Failed notice post -> no capture (start and late joiner) | PASS | `test_failed_notice_post_*`, `test_late_joiner_post_failure_*` |
| No file created during a session | PASS | audit hook on every `open()` in-process: zero writes while capturing/transcribing; at stop only the note under knowledge dir; `VOICE_TMP_DIR` empty. Not scanned: the whole OS temp tree (flaky); the audit hook covers in-process opens, not `sqlite3` C writes |
| Note members-only, index `(restricted)` | PASS | `test_members_only_and_index_restricted` |
| erase_user removes every trace incl. frontmatter, nested Decisions/Action items | PASS (working tree) / FAIL (90162a6) | see DEFECT-1; erasing both members leaves `members:` empty, never public |
| `## ` injection via name or model output (S1212-04) | PASS | 11 separators (`\r \n \x0b \x0c \x1c-\x1e \x85    `) x name and model output; heading list stays fixed, forged lines gone after erase |
| TTS: voice channel own chat only, never DM (S1212-03) | PASS | DM (None), other channel, other guild, user not in voice -> nothing synthesised |
| TTS rate allowlist, size cap, text cap, queue cap | PASS | 8k..48k accepted; 11025/44100/96000/0 refused; PCM > 6,000,000 B not played; text <= `TTS_MAX_CHARS`; burst of 12 -> <= 6 calls |
| mask_secrets before TTS | PASS | Google-style key removed from spoken text |
| Budget stop refuses STT and TTS (real Guard) | PASS | limit 1000 micro-USD exceeded: no TTS call, no STT call, `record_start` -> `budget_exhausted` |
| usage rows prefix-less keys | PASS | rows `stt/gemini-3.8-flash`, `tts/gemini-3.8-flash-tts`, cost = units x known price, no `unknown_model` warning |
| DAVE guard 60 s | PASS | 59 s: still recording; 60 s: capture disabled, admin line, channel notice, next start -> `live_capture_disabled`; no trip when frames arrive |
| Only one session | PASS | second start/join -> `voice_busy` |
| Voice exception never kills intake | PASS | STT, engine, start_recording, connect, TTS adapter raising: no exception out; command handler still answers |
| pull_user voice | PASS | invite link to voice channel in thread/DM, mention of target only; `move_to`/`edit` never called |
| grep ffmpeg | PASS | `core deploy tools pyproject.toml` hold only "no/without ffmpeg" comments; `core/voice` has no subprocess/tempfile |

## 3. Exploratory
- 42 allowed speakers, 3 x 40 s each without ticks: held bytes <= `total_cap` (31 x 0.96 MB = 29.8 MB), each buffer <= user cap, overflow flagged; after a tick pending <= 6.
- Max length (5 min and 120 min settings): no stop at limit-1 s, stop at limit; note kept; Praw stays connected for TTS.
- Thai: Thai text, marks kept; ZWJ/NUL/U+2028 removed or folded; forged `[id]:` token in Thai text cannot form; erase removes the Thai line, keeps others.
- Probe (Low, documented): another user's display name equal to the erased user's digits keeps those digits (`- <digits> [other]` lines). Needs a hostile name equal to a victim's id; erase scope is the bracket token.

## 4. Resources (fakes)
Command: `.venv/bin/python -m tests.acceptance_b2.measure_resources 5 10`. 5 speakers talking continuously (worst case), 20 ms 48 kHz stereo packets through `ConsentSink.write`, 30 s chunks, fake STT, fake clock: 3000 s of audio.
Result: RSS 69.7 -> 82.6 MB (growth 12.9 MB, flat after minute 4), threads 2 -> 2 (max 2), 100 STT chunks (96 MB total passed through, none retained), pending 0, no temp files, CPU 0.35 s.
Limits: macOS, Python 3.14, no real Opus decode, no packet-router thread, no network/TLS/Gemini client, no discord gateway, no real 5-minute STT latency; fake STT returns instantly so the backlog path is not exercised here (covered by the 42-speaker test). The MemoryMax 1G / TasksMax 100 check (item 9) and CPU on the VPS remain live-only.

## 5. Defects
- DEFECT-1 (High, owner backend): at 90162a6 `erase_user` leaves the user id in `## Contents` when a model heading contains it (`### Decision by <id>`). Repro: `test_model_heading_with_user_id_does_not_survive_in_contents` against the committed tree. The uncommitted `store.py` change (skip `Contents`) fixes it; it must be committed.
- Note: working tree also carries uncommitted S1212-02 retry re-check and in-memory-first opt-out; tests pass on both trees.

## 6. Live-only (owner's DAVE probe / VPS)
Receive path decode under DAVE (garbage vs speech), real Opus load of `libopus.so.0`, TTS audible without ffmpeg (`dpkg -l ffmpeg` not installed), VPS `find` after a session, MemoryMax/TasksMax and CPU with 5 real speakers, real Gemini STT/TTS format and cost, Discord permissions (Connect/Speak only, no Move), button clicks and mention rendering, AC-10 grep of real logs/chat for transcript text, dpkg scan (item 8), S1212-12/13/14.

# S11 assumed-behaviour probes (spec §11.14.3)

## Contents
- Environment
- Verdicts (P1-P7)
- VPS commands
- Notes

## Environment
macOS, Python 3.14.6, SQLite 3.53.4 (`sqlite3.sqlite_version`). No Python 3.12/3.13 locally (no pyenv/uv). Target VPS: Py 3.12, SQLite 3.45.
Script: `tests/probes/s11/probe_s11.py`; run `.venv/bin/python -W error::DeprecationWarning tests/probes/s11/probe_s11.py`. Throwaway; no product code touched.

## Verdicts
| P | Verdict | Evidence (real output) |
|---|---|---|
| P1 | CONFIRMED on 3.14 only; 3.12/3.13 needs VPS run | `P1 CONFIRMED (py3.14 only) [('x',)]` with `?1`/`?2`, tuple, reused `?1`, under `-W error::DeprecationWarning`. Control `:a` + tuple raises `ProgrammingError` (so mismatched styles are not silently tolerated). The 3.12 DeprecationWarning concerns named params with sequences, not `?N`; unverified here. |
| P2 | CONFIRMED | ts `...00.123Z` accepted; `2026-11-23 10:00:00`, `...+00:00`, `...00.1234Z` rejected. `DEFAULT (strftime(..'now'))` passes its own CHECK (`2026-11-23T08:18:23.170Z`). `day=date(day)`: `2026-11-23` ok, `2026-11-23T00:00:00` rejected. Discord 17 and 20 digits ok; 16, 21, 16+`x` rejected. All lines `OK`. |
| P3 | CONFIRMED | `cli:a-b`, `cli:a-b_1`, `cli:`+a*32 accepted; `cli:Admin`, `cli:1a`, a*33, `cli:`, `cli:a b`, `cli:a.b` rejected. |
| P4 | CONFIRMED | `VACUUM INTO` onto pre-created empty 0600 file: ok, mode `0o600`, integrity `ok`, rows 1. Control: nonexistent path under umask 022 gives `0o644` (so pre-creating is required, as the spec does). |
| P5 | CONFIRMED on macOS | umask 077 and umask 022 with db 0600: `-wal` and `-shm` both `0o600`. Linux behaviour (SQLite copies the DB file's mode) should match; re-check on VPS. |
| P6 | CONFIRMED, with a case caveat | arg1 = `wal_checkpoint` for `PRAGMA wal_checkpoint(TRUNCATE)` and bare form (arg2 = `TRUNCATE`/None). arg1 keeps the caller's case (`WAL_CHECKPOINT` when typed upper), so `.lower()` in `_authorizer` is required and present. `PRAGMA journal_mode` -> `journal_mode` (denied by the rule). |
| P7 | NEEDS VPS PROBE | systemd only. |

## VPS commands
P1 (3.12, also 3.13 if present): `python3.12 -W error::DeprecationWarning tests/probes/s11/probe_s11.py` (check P1 line; also prints `sqlite_version`, expect 3.45.x; all P2/P3 lines must say OK, no MISMATCH).
P5/P4/P6: same script on the VPS (Linux).
P7: 
```
printf 'PROBE_V=from_envfile\n' > /tmp/p7.env
systemd-run --user --wait --collect -p EnvironmentFile=/tmp/p7.env -p Environment=PROBE_V=from_unit -p PassEnvironment= sh -c 'echo PROBE_V=$PROBE_V' ; journalctl --user -n 5 --no-pager | grep PROBE_V
```
Use `-P` / `--pipe` if available (`systemd-run --user -P ...`). If the output is `from_envfile`, the claim holds (EnvironmentFile wins) and the grep guard is redundant-but-safe; `from_unit` means the claim is refuted and the guard is still correct. Also run the guard: `printf 'DATABASE_PATH=/x\n' | grep -Eq '^[[:space:]]*(export[[:space:]]+)?(EMP_CLI_DEV|DATABASE_PATH|KNOWLEDGE_DIR|LOG_DIR|VOICE_TMP_DIR)[[:space:]]*=' && echo refused`.
Per systemd.exec docs, the order is unit `Environment=` first, then `EnvironmentFile=`, later wins; the doc claim supports P7 but is not run evidence.

## Notes
- Script prints unclosed-connection ResourceWarnings at exit (probe hygiene only).
- Not probed (not in §11.14.3): the full DDL in §11.5 (TASK-006 AC1 covers it).

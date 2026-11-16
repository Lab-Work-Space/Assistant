# Local mode setup

Local mode runs the whole service on the owner's Mac. Set it up once, then use [First run](first-run.md) to start it.

## Local mode (owner's Mac)

Local mode runs the whole service on the owner's Mac. The `claude-code-local` provider spawns the owner's logged-in `claude` CLI (subscription, no API key) with tools, MCP, slash commands and setting sources disabled. It exists only on macOS: the guard refuses to register it in a container, on Linux, or when `ALLOW_LOCAL_PROVIDERS=1` is missing from the real process environment. Design: `docs/superpowers/specs/` (parent repo, §4-5) and `docs/security/2026-10-31-gate1-assistant-local-mode.md` (parent repo, rows L1 to L14).

The env file that holds the local secrets is described in [Env file](env-file.md). The provider on/off switch is in [Providers and models](../configuration/providers-and-models.md).

## Setup (once)

```bash
npm ci
bash scripts/set-tokens.sh --local        # or: npm run tokens:local
```

The script asks for each bot token (hidden input; Enter skips a key and keeps the one already stored), then creates the dir/file with `umask 077` and replaces the file atomically. If missing it also generates `CONFIG_MASTER_KEY`, a database password and the local `DATABASE_URL` (`127.0.0.1:54330`), and never prints them. It does not ask for `ANTHROPIC_API_KEY`, because the local CLI provider does not use one. If the Claude API is your provider on this Mac, add `ANTHROPIC_API_KEY` to `~/.config/assistant/env.local` yourself (mode 0600), or enter it through the dashboard's write-only env-entry route (`dashboard/envEntry.ts`); the value is never printed. The steps are repeated in [Providers and models](../configuration/providers-and-models.md#claude-api-default). It does ask for `GEMINI_API_KEY` (Praw's provider; full run or when `PRAW` is named). Run `bash scripts/set-tokens.sh --local HQ` to change a single department.

Then the **probe step** (Gate 1 L3), once per Mac and again after every `claude` upgrade:

```bash
claude                                    # make sure you are logged in
bash scripts/probe-local-cli.sh           # or: npm run probe:local
```

Read the warning first: the probe **spends one subscription call**, and you should **close all other Claude Code sessions** while it runs (about a minute). It plants canary strings in your real `~/.claude` (CLAUDE.md, a memory file, a user hook in `settings.json`, and a skill, command and agent standing in for a plugin; real plugins load through settings, which the hook canary covers), runs the exact argv the provider uses, and passes only if no canary shows up in the output, the hook did not run, no tool ran, the CLI made no web request (a local loopback server is offered as a WebFetch target), no new session transcript (`*.jsonl`) appeared under `~/.claude/projects`, and the provider's own parser accepts the real `stream-json` output (the init event must show only the structured-output tool, no MCP server and no probe-planted name). It prints the CLI version, the event types and the result field names, never the CLI's own output or stderr. It removes only what it added, on every exit path; edits you make to `CLAUDE.md` or `settings.json` meanwhile are kept, a lock stops two runs at once, and after a hard kill the next run recovers first. The argv it runs includes `--safe-mode` (added 2026-11-07, because CLI 2.1.319 injected auto-memory without it), and `buildArgs` is the same function the provider uses, so the probe tests that flag. `--also-restricted` adds one more call with `--restricted`, to see whether it would fix a failure (the default run is a single call). `--also-safe-mode` is no longer needed: `--safe-mode` is already in the argv.

**Version pin (R-L9).** On PASS the probe writes `~/.config/assistant/probe-ok` (mode 0600) recording `version=<claude --version>`, `realpath=` (the resolved `claude` binary) and `sha256=` (of that file) and `argv_sha256=` (STREAM-1: a digest of the provider's fixed CLI arguments, so any change to them needs a new probe). The service registers the local provider only while that file is owner-only and all four match the `claude` found on PATH now, so a different binary printing the same version is refused; an old pin without `argv_sha256` is refused too (run `npm run build`, then `bash scripts/probe-local-cli.sh --yes`, then restart). After a CLI upgrade or reinstall the provider is absent until you re-run the probe. The owner can override with `ASSISTANT_SKIP_PROBE_PIN=1 npm run dev` typed on the command line (a warning is logged); it is refused if it appears in the env file. If the probe fails, do not use local mode; send the output (it names the canaries, not your data) so `--restricted` can be evaluated.

**Loopback only (L10).** In local mode `DATABASE_URL` must point at `127.0.0.1`, `::1` or `localhost`, (including any `host=`/`hostaddr=` query parameter; socket paths are refused), and `HEALTH_HOST` (if set) at exactly `127.0.0.1`; the launcher and the service both refuse otherwise.

Back to the [documentation index](../_index.md).

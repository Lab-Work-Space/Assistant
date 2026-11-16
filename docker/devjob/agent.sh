#!/bin/bash
# The coding or reviewing agent. The argv of the CLI is FIXED here (Gate 1 self-code X6); nothing from the request chooses a flag. stdin is the brief.
set -eu
umask 077
export HOME=/home/agent GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 CLAUDE_CODE_MAX_OUTPUT_TOKENS=8000
COMMON=(-p --output-format=json --setting-sources= --strict-mcp-config '--mcp-config={"mcpServers":{}}' --disable-slash-commands --no-session-persistence)
DENY='WebFetch,WebSearch,NotebookEdit,Task,TodoWrite,SlashCommand,KillShell,BashOutput,ExitPlanMode'
case "${ROLE:-}" in
  coder)
    : "${BASE:?}"
    cd /work/repo
    git -c core.hooksPath=/dev/null checkout -q -b job
    # permission-mode bypassPermissions: the container is the boundary (no network but the model proxy, read-only root, no capabilities, no secrets).
    claude "${COMMON[@]}" --model claude-sonnet-5-5 --tools "Read,Edit,Write,Bash" --disallowed-tools "$DENY" --permission-mode bypassPermissions --max-budget-usd 2 || { echo "agent exited non-zero" >&2; exit 1; }
    git -c core.hooksPath=/dev/null add -A
    # the committer identity is fixed: the executor flags commits made by dev jobs (X9)
    GIT_AUTHOR_NAME=dev-job GIT_AUTHOR_EMAIL=devjob@assistant.invalid GIT_COMMITTER_NAME=dev-job GIT_COMMITTER_EMAIL=devjob@assistant.invalid git -c core.hooksPath=/dev/null commit -q -m "dev job change" --allow-empty-message || { echo "nothing to commit" >&2; exit 1; }
    ;;
  review-code|review-security)
    cd /tmp
    claude "${COMMON[@]}" --model claude-sonnet-5-5 --tools "" --disallowed-tools "$DENY,Bash,Edit,Write,Read,Grep,Glob" --permission-mode default --max-budget-usd 1
    ;;
  *) echo "bad ROLE" >&2; exit 2;;
esac

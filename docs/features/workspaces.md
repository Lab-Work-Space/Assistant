# Workspaces

The project workspace tools that write files and run commands inside a sandbox.

## Why the ws_* write tools need no approval (Gate 1 WS-C18)

The project workspace tools that write (`ws_write`, `ws_run` and the other ws_* write tools) are in `NO_APPROVAL_TOOLS` on purpose. Their writes stay inside the sandbox: files under the per-project workspace root (no-follow I/O, quotas), and commands that run in a hardened per-run container with no secrets, `--network none` (or only the registry proxy for `npm ci` and `npm install`). Nothing outward-facing happens inside a ws_* write. Anything that leaves the sandbox still goes through an existing gate: the zip export posts into the company's own Discord, and a GitHub push uses the existing approved tools. Untrusted-content taint still applies to ws_* outputs, so a tainted file or command output cannot be used to unlock an approval-gated action.

Praw's own file workspace is configured with `PRAW_WORKSPACE_DIR` (see [Environment variables](../configuration/environment-variables.md)).

Related: [Tools and plugins](tools-and-plugins.md), [Governance and approvals](governance-and-approvals.md).

Back to the [documentation index](../_index.md).

# VPS deploy from Discord

Asking Praw to put a website on the company VPS through a Bot Admin card.

## VPS deploy from Discord (programme part 3, Gate 1 `docs/security/2026-11-02-gate1-vps-deploy.md`)

A Bot Admin can ask Praw in `#setting` to put a website on the company VPS: `deploy_propose` (a `Lab-Work-Space` GitHub repo as `<name>.labworkspace.net` or `api.labworkspace.net/<name>/`, a redeploy, a removal, or a `<name>--<branch>` preview that removes itself after 72 h by default and 7 days at most) and `site_publish_static` (a folder Praw built in her workspace; **apps only**, `<name>.labworkspace.net`: no assistant-made JS on the shared `api.labworkspace.net` origin; a repo `add` may still use category `api`, and previews are always `apps`). `deploy_read` shows status and logs of the apps she deployed. Every change is a card (**Bot Admin only**, no Manager or Moderator) that shows the exact operation, the **commit sha** and the URL; only that sha is built (`AUTO=0`, no auto-redeploy on push). The owner's own sites (main, aurora, vernisos, ...) can never be touched through this path. The result of a build is posted back in `#setting` when it finishes.

How it is built: the executor "LW Admin" holds the deploy key and sends `ssh -p 2223 assistantdeploy@72.60.196.53 request` (host, port and a pinned host key are constants/files, not env). The VPS side is `infra/vps/81-assistant-deploy.sh` (own sshd, relay, sandboxed receiver, root worker; see `infra/OPERATIONS.md` section 19). `deploy_*` cards never reach the main application's process: it only forwards card ids. Every deploy operation also needs the second confirmation described in [Governance and approvals](../features/governance-and-approvals.md#second-confirmation-by-lw-admin-itself-gate-2-od-g2-1-g2vd-03).

The executor's Mac setup, including the VPS key line and host key pinning, is in [The executor under its own macOS user](../operations/executor.md).

**Owner steps on the VPS (as root, after `80-team.sh`):** see `infra/OPERATIONS.md` section 19 (summary: confirm that the admin session cookies are host-only, run `13-firewall.sh` then `--confirm`, put the key line into `/var/lib/assistantdeploy/.ssh/authorized_keys`, `LW_ASSISTANT_V20_VERIFIED=yes bash infra/vps/81-assistant-deploy.sh`, `bash infra/vps/tests/p10-assistant-deploy-check.sh`, write the host key with `cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub`).

Back to the [documentation index](../_index.md).

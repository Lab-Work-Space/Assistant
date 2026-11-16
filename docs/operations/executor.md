# The executor (LW Admin)

The separate process that performs every Discord server write, and how it runs under its own macOS user.

## The executor under its own macOS user (OD-1; closes G2SM-01 on the Mac)

The executor runs under launchd as the hidden user `_lwadmin`. Its env file (bot token, database URL of the least-privilege role `lw_executor`) and the deploy key are `0600` under `/var/lwadmin/private`, **unreadable by your own uid**; the code it runs is a root-owned copy in `/usr/local/lib/lwadmin`. The main app reaches it through `/var/lwadmin/run/executor.sock` (group `_lwadmin_ipc`, mode 0660; you are added to that group). Node has no `getpeereid`, so the kernel's group check is the only peer check: any process of your account can talk to the socket, but it can only name card ids, and the executor re-checks every card, tier and limit itself. What this does NOT close: code running as your uid can still write to the database as the main app and forge a confirmed deploy card. It would still be limited by the executor's re-validation, the card and rate rules, and (on the VPS) the V9 caps; it cannot read the key or the token.

The job is the system launchd daemon `net.labworkspace.lwadmin` (plist in `/Library/LaunchDaemons/`, managed by `scripts/executor-service.sh`). What the executor does, and the server operations it covers, are in [Admin console and server management](../features/admin-console-and-server-management.md).

Owner steps on the Mac, in order:

1. `npm run build`, then `npm run migrate` (or start the app once: migration 016 must exist before the grants can name its tables; re-run `executor-role` after any later migration that adds an executor table). Create the database role: `node --env-file="$HOME/.config/assistant/env.local" dist/scripts/executor-role.js --out "$HOME/.config/assistant/.lwadmin-db-url"` (own DATABASE_URL, loopback; prints nothing secret).
2. `sudo bash scripts/executor-service.sh install` (Node must be system-wide, e.g. `/usr/local/bin/node`). It moves `env.admin` out of your home, makes the user, the key and the job, and prints the **VPS key line** (copy it). Then **log out and in once** so your shell is in the group `_lwadmin_ipc` (`bash scripts/executor-service.sh status` tells).
3. Rotate `BOT_TOKEN_ADMIN` in the Discord developer portal (the old file was readable by your uid) and run `sudo bash scripts/executor-service.sh set-token`.
4. On the VPS (see [VPS deploy from Discord](../deployment/vps-deploy-from-discord.md)) read the host key and bring it back: `sudo bash scripts/executor-service.sh install --host-key-file host.pub` pins it. Until then deploy stays off and says so.
5. The job runs a **copy** of the code in `/usr/local/lib/lwadmin`: after every `npm run build` or update run `sudo bash scripts/executor-service.sh install` again (idempotent: it refreshes the copy and keeps the key and `env.admin`), or the app and the executor drift apart.
6. `npm run dev` now starts **no** executor (it only points the app at the socket). `bash scripts/executor-service.sh status`, `sudo ... rotate-key` (new key, add the new line on the VPS), `sudo ... uninstall [--purge]`.

Back to the [documentation index](../_index.md).

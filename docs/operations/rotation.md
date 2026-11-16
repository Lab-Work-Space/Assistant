# Key and token rotation

Rotating bot tokens, provider keys and the master key after a leak, and recovering after a lost or compromised Mac.

## Keys, tokens and recovery

### Rotation (any leak in a channel or a log means rotate immediately)

Bot token: Developer Portal, application, Bot, Reset Token; then `lw env set apps/assistant BOT_TOKEN_<DEPT>` and `lw restart apps/assistant`. Rotate all 10 if you cannot tell which leaked. `BOT_TOKEN_ADMIN` (LW Admin): Developer Portal, application "LW Admin", Bot, Reset Token; then `bash scripts/set-tokens.sh --local ADMIN` and restart `npm run dev`. It lives only in `env.admin`; rotate it first if the app or its logs may have leaked.

`GEMINI_API_KEY` (Praw): create a new key in a billing-enabled Google Cloud project, `lw env set apps/assistant GEMINI_API_KEY`, `lw restart apps/assistant`, then delete the old key in the Cloud console. A key added with `/provider add gemini` is re-added the same way as the other provider keys. `BOT_TOKEN_PRAW` rotates like any bot token (above).

`CLICKUP_API_TOKEN` (M3): create a new personal token in ClickUp (Settings, Apps), `lw env set apps/assistant CLICKUP_API_TOKEN`, `lw restart apps/assistant`, then regenerate/remove the old token in ClickUp. Do not reuse the old bot's token. The token is masked in logs (`pk_<digits>_<32 chars>`) and never appears in tool results.

`GOOGLE_SHEETS_WEBAPP_SECRET` (M4): redeploy a new Apps Script web app version with a new secret, `lw env set apps/assistant GOOGLE_SHEETS_WEBAPP_SECRET` (and `..._URL` if the deployment id changed), `lw restart apps/assistant`. The secret is masked in logs and never appears in tool results, audit rows or embeds.

`GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_PRIVATE_KEY_PATH` (M3): in the GitHub App settings generate a new private key, save it as a file with `chmod 600`, point `GITHUB_APP_PRIVATE_KEY_PATH` at it (`lw env set apps/assistant ...` or `bash scripts/set-tokens.sh GITHUB`), `lw restart apps/assistant`, then delete the old key in the App settings. Do not reuse the old bot's App or key. Install the App on selected repositories only, with no `workflows` and no `administration` permission. Read tokens are minted per call, read-only and scoped to one repository (repo-less reads: metadata only); the key, the App JWT and `ghs_`/`ghp_` tokens are masked in logs and never appear in tool results.

Milestone 2 adds no new secret. `PRAW_WORKSPACE_DIR` is a path, not a secret, so there is nothing to rotate for it.

`ANTHROPIC_API_KEY`: create a new key in the Anthropic console, `lw env set apps/assistant ANTHROPIC_API_KEY`, `lw restart apps/assistant`, then revoke the old key. Provider keys added through `/provider add` are stored encrypted in the database: re-add them with `/provider add` (new key) and revoke the old ones at the provider.

`CONFIG_MASTER_KEY` (re-encrypts the `provider_keys` table, AES-256-GCM with the provider id as AAD):

1. Stop the service: `docker stop <container>` so nothing writes `provider_keys` meanwhile.
2. Run this as root on the VPS in **bash** (the block starts its own `bash`, so it works from any login shell; `</dev/tty` makes the prompts read the terminal, not the heredoc). The values are typed at hidden prompts (`read -rs`), never on a command line or in shell history; the temporary env file is mode 0600 and is shredded on every outcome (success, failure or Ctrl-C) by the `trap`. The re-encrypt script runs in one transaction (if any row fails to decrypt, nothing is changed) and prints `re-encrypted N provider key(s)`, never key material. The new key is stored only after the script succeeded.
   ```bash
   bash <<'ROTATE'
     set -euo pipefail
     umask 077
     trap 'shred -u /root/rotate.env 2>/dev/null || true' EXIT HUP INT TERM
     read -rs -p 'DATABASE_URL: ' DATABASE_URL </dev/tty; echo
     read -rs -p 'Current CONFIG_MASTER_KEY: ' OLD </dev/tty; echo
     NEW="$(openssl rand -base64 32)"
     printf 'DATABASE_URL=%s\nOLD_CONFIG_MASTER_KEY=%s\nNEW_CONFIG_MASTER_KEY=%s\n' "$DATABASE_URL" "$OLD" "$NEW" > /root/rotate.env
     docker run --rm --env-file /root/rotate.env --add-host host.docker.internal:host-gateway --user 1000:1000 --read-only \
       lw-local/apps-assistant:<IMAGE_TAG> node dist/scripts/rotate-master-key.js
     printf '%s\n' "$NEW" | lw env set apps/assistant CONFIG_MASTER_KEY   # value from stdin
   ROTATE
   ```
   If `lw env set` fails after the script succeeded, the new key is lost with the shredded file: re-add the provider keys with `/provider add` after the restart.
3. `lw restart apps/assistant` and confirm health.

Database password: in `psql` as a superuser run `\password assistant` (prompts without echo; never put the password in a statement), then `lw env set apps/assistant DATABASE_URL` (value from stdin) and `lw restart apps/assistant`.

Jira (removed): the Jira integration is gone from the code. Removing the code does not retire the credential: revoke the Jira API token at id.atlassian.com and delete the `JIRA_*` lines from `env.local` (owner action R-1 in [docs/security/2026-11-16-gate2-localoff-api400.md](../security/2026-11-16-gate2-localoff-api400.md)).

Praw's own keys are listed in [Praw](../features/praw.md#rotation-of-praws-keys).

## If the Mac is lost or compromised (D22)

Treat everything in `~/.config/assistant/env.local` as leaked. In order: reset **all 9 bot tokens** in the Developer Portal (Bot > Reset Token); revoke the Claude login (claude.ai > Settings, log out all sessions) and rotate the Claude account password; remove the Mac from your Apple/GitHub/Discord sessions; then set the new tokens wherever the service runs next (`set-tokens.sh`). The database and `CONFIG_MASTER_KEY` on the Mac held only local data; stored provider keys (`/provider add`) must be re-issued at the provider.

Back to the [documentation index](../_index.md).

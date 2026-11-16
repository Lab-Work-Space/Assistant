# Before moving to the VPS

Checks to run before the local Mac setup is moved to the VPS.

## Before moving to the VPS

1. **Stop local first** (`Ctrl-C`, `npm run local:db:down`). Never run local and the VPS at the same time with the same bot tokens: a second gateway session on the same token means both copies see and answer every message. Never keep the same tokens in two places: after the move, delete `~/.config/assistant/env.local` (or at least its `BOT_TOKEN_*` lines), or rotate the tokens.
2. **The VPS needs `ANTHROPIC_API_KEY`.** The local provider does not exist there (no `claude` login, no `ALLOW_LOCAL_PROVIDERS`), so without an API key the service has no provider: it boots idle (alert, health `unavailable`) and the bots do nothing. Activation still requires `ANTHROPIC_API_KEY`. Set the key first (`bash scripts/set-tokens.sh` without `--local`), verify `lw env keys apps/assistant` lists it, and only then activate.
3. Data in the local database does not move by itself. Dump and restore it (`pg_dump`/`psql`) if you want to keep it, or start the VPS fresh. Local backups are described in [Backups and restore](../operations/backups-and-restore.md).

Next: [VPS deploy with lw-git](vps-deploy-lw-git.md) and [VPS deploy from Discord](vps-deploy-from-discord.md). The media sidecar steps are in [Media sidecar live checks](../operations/media-sidecar-live-checks.md).

Back to the [documentation index](../_index.md).

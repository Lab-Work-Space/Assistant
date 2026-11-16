# First run

Start the local stack in the right order, then the app.

## Run

```bash
npm run local:db     # PostgreSQL 17 on 127.0.0.1:54330, compose project assistant-local, volume assistant_local_pgdata (docker-compose.local.yml)
npm run local:chrome # Chrome + guard proxy containers (docker-compose.chrome.yml, compose project assistant-chrome); waits until healthy
npm run local:media  # media sidecar container and host relay (docker-compose.media.yml)
npm run local:render # document renderer and its DevTools forwarder (docker-compose.render.yml)
npm run dev          # checks the env file, builds, starts node --env-file=~/.config/assistant/env.local dist/main.js
```

The Chrome, media and renderer containers are described in [Web reading and Chrome](../features/web-and-chrome.md), [Media, music and voice](../features/media-music-voice.md) and [Documents and diagrams](../features/documents-and-receipts.md).

Start in this order: `local:db`, `local:chrome`, `local:media`, `local:render`, then `dev`. Without the Chrome container the web tools are off, and without the renderer the document tools are off; `#🧾-bot-log` says why.

On the first boot where the local provider is available and no default was ever set, the default becomes `claude-code-local` with `local/claude-sonnet-5-5`. With the local-provider-off marker present, this first-boot seed is skipped and the code default `claude/claude-sonnet-5-5` applies (see [Providers and models](../configuration/providers-and-models.md)). Migrations run on boot. The service logs nothing special when the local provider registers; if it does not, the log has `claude-code-local not registered` with a reason (flag, platform, probe pin, loopback check), and with no provider ready (no `ANTHROPIC_API_KEY` and no registered local provider) the service stays up but idle (a governance alert in `#🧾-bot-log`, `/healthz` reports `provider: "unavailable"`, no agent runs) until a provider registers or `provider.default` is changed. Confirm with `/provider` in `#⚙️-setting` and check that the heads come online in Discord.

If something does not come up, see [Troubleshooting](../operations/troubleshooting.md). To run the app as a background agent on the Mac, see [Start, stop and restart](../operations/start-stop-restart.md).

Back to the [documentation index](../_index.md).

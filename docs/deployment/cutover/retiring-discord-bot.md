# Retiring Discord_bot

The ordered steps for switching off the old Python bot once Praw has taken over.

## Retiring Discord_bot

Retire the old Python bot only after the M5 live checks in [Media, music and voice](../../features/media-music-voice.md) pass. Everything here is an owner or devops step, in this order.

1. **Deploy** the M5 image (`lw-git status`, container `healthy`, "Tool groups disabled" alert empty or understood). If a `media.ytHostAllowlist` is stored, run `/media allowlist action:add host:m.youtube.com` first.
2. **Verify AC12 and AC13 live** in the server (the "Voice and music" live check in [Media, music and voice](../../features/media-music-voice.md)), including DAVE readiness with Praw alone in a channel and the YouTube/cookies check.
3. **Stop the Python bot** (its container or process). Check that nothing in the server still answers as the old bot, and that Praw handles music, voice, reminders, watches and OCR (the old features proven off in the earlier cutovers).
4. **Remove the old Discord application from the server** (owner: kick the bot, then delete the application in the Developer Portal when nothing needs it).
5. **Archive `Discord_bot`** (read-only archive of the repo; keep the SQLite file only until the M2 import is confirmed).
6. **Reset the old bot's Discord token** (Developer Portal > Bot > Reset Token) even though the application is gone or the process stopped, so a leaked copy is dead (P23).
7. **Revoke the old bot's credentials (P23).** Remove its **GitHub App installation** (the app's own settings and the installation under the organisation). Revoke its **Gemini**, **ClickUp** and **Sheets** keys (the Apps Script secret and deployment) and **rotate** any key it shared with Praw or the Assistant, then update the new keys with `lw env set apps/assistant KEY` and redeploy. Remove the old bot's role and any channel overwrites it needed. Update `infra/OPERATIONS.md` if it still references the old bot.
8. **Gate 2 supply-chain scan (P22)** on the final image: a binary-aware SBOM scan that covers `/opt/yt-dlp/_internal`, ffmpeg's `libav*` libraries and `node_modules`, run first against a **positive control** (an image or file with a known HIGH vulnerability, to prove the scanner sees the bundled yt-dlp libraries), then `npm audit --omit=dev` over `@google/genai`, the voice libraries (`@discordjs/voice`, `@snazzah/davey`, `opusscript`) and the Edge TTS package (`msedge-tts`). It passes only with no unpatched HIGH or CRITICAL finding. Any finding is fixed by the pinned bump procedure ([Media binaries (P22)](../../operations/media-binaries.md)), never by an auto-update.

Rollback: until step 6, re-enable the old bot; after step 6 the old bot cannot come back without a new token, which is the point.

Back to the [documentation index](../../_index.md).

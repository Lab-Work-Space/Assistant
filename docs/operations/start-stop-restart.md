# Start, stop and restart

Running the Assistant on the owner's Mac: as a launchd agent, or by hand with `npm run dev`.

## Run under launchd (net.labworkspace.assistant)

On the owner's Mac the app can run as a per-user launchd agent with the label `net.labworkspace.assistant`. It starts at login and restarts if it stops. `bash scripts/app-service.sh install` writes `~/Library/LaunchAgents/net.labworkspace.assistant.plist` and prints the `launchctl` lines to run; the script never calls `launchctl` itself and never uses sudo. The agent runs as you, with the same rights as `npm run dev`; the plist holds no secret, because `dev.sh` reads `~/.config/assistant/env.local` itself.

| Task | Command |
| :--- | :--- |
| Install (write the plist, print the start line) | `bash scripts/app-service.sh install` |
| Status (plist, launchd state, last log lines) | `bash scripts/app-service.sh status` |
| Restart | `launchctl kickstart -k gui/$UID/net.labworkspace.assistant` |
| Stop | `launchctl bootout gui/$(id -u)/net.labworkspace.assistant` (the line `uninstall` prints) |
| Uninstall (prints the stop line, moves the plist to the Trash) | `bash scripts/app-service.sh uninstall` |

Logs: `~/Library/Logs/assistant/app.log` (standard output) and `~/Library/Logs/assistant/app.err.log` (standard error). The directory is created with mode 0700.

The executor "LW Admin" is a separate launchd **system** job (`net.labworkspace.lwadmin`, as user `_lwadmin`); see [The executor under its own macOS user](executor.md).

## Stop (local mode)

`Ctrl-C` in the `npm run dev` terminal: the service stops gracefully on SIGINT (tasks that were `doing` are recovered on the next start). Optional: `/halt` in `#⚙️-setting` first. `npm run local:chrome:down` stops Chrome. `npm run local:media:down` and `npm run local:render:down` stop the media and renderer containers. `npm run local:db:down` stops the database (compose project `assistant-local`, separate from `docker-compose.test.yml`); the volume `assistant_local_pgdata` keeps the data (`docker volume rm assistant_local_pgdata` deletes it).

For an out-of-band stop (Discord or the bot unreachable), see [Halt and resume](halt-and-resume.md).

## Docker Desktop images

Never delete `assistant-*` images in Docker Desktop. The `ws` runner image shows as Unused there, which is expected. (Owner instruction for this documentation set; not stated elsewhere in the repository.)

Back to the [documentation index](../_index.md).

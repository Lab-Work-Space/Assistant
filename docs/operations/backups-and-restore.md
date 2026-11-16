# Backups and restore

What a Docker reset does to the local database, and how to take and restore a backup.

## After a Docker reset: restore list

On 2026-11-07 a reboot reset the Docker data. The local database volume `assistant_local_pgdata` was recreated empty, so every `/settings` value was lost, and there is no backup. Re-set these after a reset (the code default is in brackets): `approvals.channelByCategory` (`{}`), `rhythm.dailyGoalChannelId` (`null`), `dashboard.channelId` (`null`), `schedule.offDays` (`[0, 6]`), `company.profile` (`null`), `roles.managerId`, `roles.moderatorId` and `roles.modRoomId` (`null`). Channel maps live in the `channel_map` table, not in config: re-add the Praw appointments room with `/channel map channel:#📅-appointments dept:praw work:true`. With no stored `tools.byDept` override the code defaults apply, which already include the media grants.

## Backups and restore

Backups: `npm run dev` dumps the local database to `~/.config/assistant/backups/assistant-<date>.dump` before it starts (skipped when a dump younger than 6 hours exists; newest 14 kept; files 0600). Take one by hand with `bash scripts/dev.sh db backup`. To restore after a reset, stop the app, start the database with `npm run local:db`, then run `docker exec -i assistant-local-postgres-1 pg_restore -U assistant -d assistant --clean --if-exists < ~/.config/assistant/backups/<file>.dump` and start the app again.

Back to the [documentation index](../_index.md).

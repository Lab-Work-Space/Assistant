# Health and logs

How to check that the service is alive and where its logs are.

## Health and logs

- Health: `docker exec <container> node -e "fetch('http://127.0.0.1:8080/healthz').then(async r=>console.log(r.status, await r.text()))"` returns 200 with `{db, clients, halted, provider, offDay}`, or 503 when the database is unreachable.
- Logs: `docker logs -f --tail 200 <container>`. Structured JSON; tokens, keys, webhook URLs and database passwords are masked.

For the launchd agent on the Mac, the logs are the files named in [Start, stop and restart](start-stop-restart.md). Incident messages are described in [Incidents and #🧾-bot-log](incidents-and-bot-log.md).

Back to the [documentation index](../_index.md).

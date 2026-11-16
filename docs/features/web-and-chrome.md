# Web reading and Chrome

How the web tools read pages in local mode, the open-source search fallback, and the task-level web reading grant.

## Chrome for the web tools

In local mode `web_search`, `fetch_page` and url/topic watches read the web through **headless Chrome only** (no HTTP fallback). Chrome never runs as your user and never sees your env file: it runs in a container (Gate 1 Part C, `docs/security/2026-11-01-gate1-praw-admin-console.md` (parent repo); details in [`docker/chrome/README.md`](../../docker/chrome/README.md)).

**`web_search` open-source fallback (SEARCH-1).** When DuckDuckGo refuses the bot (bot check) or returns nothing, `web_search` falls back to Wikipedia (en, and th for Thai queries), Hacker News, Stack Overflow, npm and GitHub, with no API key, over the same web path (Chrome in local mode). `web.search.openSources` is **on by default** (owner decision, Gate 1 SR-C9/SR-C10): one approved query can therefore be sent to up to **6 third parties** (DuckDuckGo plus 5 operators; the approval reason says so). Set `/settings web.search.openSources false` to get the old DuckDuckGo-only behaviour; the key is read on every call. The optional `source` input searches one open source only (and is refused while the switch is off).

```bash
npm run local:chrome        # builds the proxy image from dist/, starts both containers, waits until healthy (no env file is read or passed)
npm run chrome:smoke        # optional probe: one search, one page, and the refusals (loopback, 169.254.169.254, a name that resolves to loopback)
npm run local:chrome:down
```

Start it **before** `npm run dev`. `npm run dev` sets `CHROME_CDP_URL=http://127.0.0.1:9222` and `CHROME_PROXY_CONTROL_URL=http://127.0.0.1:9223` for the node child only. If Chrome or the proxy does not answer at boot (or Chrome is older than `CHROME_MIN_VERSION`, default: the pinned build 157.0.8103.27; the env can raise it, never lower it), the `web` tool group is off and the startup alert in `#🧾-bot-log` says why; start the containers and restart the app. The VPS is unchanged: without `CHROME_CDP_URL` the web group keeps the guarded HTTP fetch.

Chrome's image is pinned by digest in `docker-compose.chrome.yml` (`chromedp/headless-shell`, Chromium 157 at pin time). Bump the digest with each Chrome security release, then `npm run local:chrome`.

## Web reading grant (WEBGRANT-1, `docs/security/2026-11-08-gate1-web-grant.md`)

- After a run has read outside content, `fetch_page` asks per URL it has not seen. A per-URL card (or a batch card whose members are all `fetch_page`) now has a button "Allow web reading for this task tree" (batch: "Approve all + allow web reading"). One Bot Admin click approves that card and lets every department in the task tree read pages with no further cards, for `web.taskGrant.hours` (4 h), up to `web.taskGrant.maxFetches` (20) pages on `web.taskGrant.maxHosts` (5) hosts and `web.taskGrant.maxUrlChars` (4000) characters of path + query summed over the pages. Only `fetch_page`; writing, sending, deploying and `web_search` still ask every time.
- The button appears only when the card shows the whole URL and the URL looks like a plain page address (https, no port, no userinfo, short words, no tokens, IDs, hex or credential shapes). Any other URL still gets its card with `web grant not applied: <rule>` in the reason.
- A tricked bot can send up to about `maxUrlChars` characters of what it read in the task tree to sites it picks, without asking. The card says so. Revoke with the "Revoke web reading" button on the card. `/halt`, a psql halt, a read fault and a boot after a halt all revoke every grant; resume does not restore them. `web.taskGrant.enabled = false` stops live grants at once. These keys are owner-only (not writable by the admin console); the boot refuses `maxHosts > maxFetches`.
- Kill switch from psql (the row may not exist yet, so upsert it; the `pg_notify` makes it live without a restart; the value must be the JSON boolean `false`, an invalid value is ignored and the switch stays on):

```sql
INSERT INTO config (key, value, updated_by) VALUES ('web.taskGrant.enabled', 'false'::jsonb, 'ops-psql')
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, version = config.version + 1, updated_by = EXCLUDED.updated_by, updated_at = now();
SELECT pg_notify('config_changed', 'public:web.taskGrant.enabled');
```

  From Discord, `/halt` (revokes every grant) and the per-card "Revoke web reading" button are the stops.

Related: [Halt and resume](../operations/halt-and-resume.md), [Security notes](../reference/security-notes.md).

Back to the [documentation index](../_index.md).

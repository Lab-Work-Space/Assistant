# Documents, diagrams and receipts

The document renderer, diagram pictures, and receipt reading with the optional Google Sheets export.

## Documents and diagrams (renderer container)

- **Renderer (`npm run local:render`):** draws `doc_create` PDFs and `diagram_create` pictures. It is Chrome with no route to any network, behind a forwarder on `127.0.0.1:9224` that needs a per-boot token. The token is never written to a file. The Mermaid bundle is `vendor/mermaid/mermaid.min.js`, checked against `vendor/mermaid/SHA256SUMS` before each draw. Diagrams live in memory per task (at most 20 per task) and are lost on restart. Diagrams need no approval; documents follow their kind's rules (money, tax and offer documents are watermarked DRAFT and always need approval).

Start it with `npm run local:render` (see [First run](../getting-started/first-run.md)). If the renderer is unreachable or crashed, the incident in `#🧾-bot-log` says to run that command again (see [Incidents and #🧾-bot-log](../operations/incidents-and-bot-log.md)).

## Receipts and Google Sheets (M4, Task 33)

`extract_receipt` (a read) reads a receipt attached to the message that asked, posts a markdown table with a CSV file (UTF-8 BOM, RFC 4180; string cells that start with `= + - @`, their full-width forms, white space before them, or a tab, CR or LF get a leading `'`) and returns the row it found. It never exports. When both `GOOGLE_SHEETS_WEBAPP_URL` and `GOOGLE_SHEETS_WEBAPP_SECRET` are set (`bash scripts/set-tokens.sh SHEETS`) a second tool, `sheets_append_receipt` (a write), appends the row `[date, merchant, currency, subtotal, tax, total]`; without them that tool does not exist. The URL must be `https://script.google.com/macros/s/<id>/exec` and still passes the SSRF guard. The request is `POST {secret, worksheet:"Sheet1", rows}` (JSON, secret in the body only). The secret must match `[A-Za-z0-9._~+=-]{16,200}` (the `set-tokens.sh` check); pick an Apps Script property value in that alphabet. Google answers a web-app POST with a redirect to `script.googleusercontent.com` after `doPost` ran (Content service docs, "Redirects"); Praw treats a 302 to exactly that host as accepted and never follows it, so a script-level rejection (for example a wrong secret) is not visible to Praw: check the sheet after setup. The write asks approval for a delegated, voice, scheduled or tainted run (a run that has just read a receipt is tainted, so an export after a receipt read always asks); the approval card and stored call hold the whole row (merchant included), so approving needs no attachment and no second model call. Receipt contents are never logged or audited. Rotation: change the secret in the Apps Script properties and `lw env set apps/assistant GOOGLE_SHEETS_WEBAPP_SECRET`, then restart; use a new web app, never the old bot's (P23).

The Apps Script source is in [`docs/sheets-webapp.gs`](../sheets-webapp.gs). The cutover steps for receipts are in [Cutover to Praw (M4)](../deployment/cutover/m4.md).

Back to the [documentation index](../_index.md).

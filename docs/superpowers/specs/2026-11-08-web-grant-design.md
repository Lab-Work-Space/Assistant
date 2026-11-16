# WEBGRANT-1 (TASKWEB-1) — task-scoped read-only web grant (spec)

Owner request 2026-11-08: after a run is tainted, every fetch_page to a URL not seen in the run needs its own approval. Owner chose: approve ONCE per task — bot may read web pages until the task ends (read-only, count/time caps, anti-exfiltration); write/send/deploy tools still ask every time. Open questions resolved with spec defaults (OQ1 yes shared caps; OQ2 web_search not covered; OQ3 4 h / 40 fetches / 10 hosts; OQ4 no auto-approve of other solo cards).

Root cause: `knownUrls` is per run (tools/types.ts `knownUrls: new Set()`); a resumed run starts tainted (agents/loop.ts "approved tool output ... so the run starts tainted") with empty knownUrls, so every new URL raises a card.

## Files
tools/plugins/web/fetchPage.ts (requiresApproval reason; add async `precheck`), new tools/plugins/web/grant-url.ts (pure heuristics), new db/repos/web-grants.ts, governance/approvals.ts (decideGrant; batch variant), discord/embeds/approval.ts (approvalRow, batchCustomId, parseBatchCustomId), discord/commands/approval.ts (APPROVAL_ID), config/schema.ts + defaults.ts, app.ts (wiring, halt listener), tools/types.ts (optional ToolContext.webGrants), migration 027.

## Actors / boundary
Bot Admin grants/revokes; task-owner actor requests (I1 registry "approval_not_owner" unchanged); model untrusted after taint; remote host and DNS resolver are exfil sinks (checkUrl resolves before address checks, net/fetch.ts createCheckTarget). Grant decision rests only on DB row + stored approval row, never model text or customId.

## Decisions
- D1 Covers fetch_page ONLY. web_search, watch_add, every write/destructive tool still ask when tainted. approvalFor unchanged; grant cannot remove a central approval.
- D2 Scope root tree: key tasks.root_id of the approval's task. Children inherit taint (createTask.ts G2-04). Caps shared across tree (like treeCap/localCap).
- D3 Live iff revoked_at IS NULL AND now() < expires_at AND used < max_fetches AND root status not done/cancelled. No write at task end.
- D4 Config (snapshotted into row at creation): web.taskGrant.enabled bool true; web.taskGrant.hours number 4 (0.25..24); web.taskGrant.maxFetches int 40 (1..200); web.taskGrant.maxHosts int 10 (1..50). Startup refusal unless maxHosts <= maxFetches.
- D5 No separate card: a per-URL fetch_page card gets 4th button "Allow web reading for this task" customId `approval:<id>:grant`, rendered only when row kind='tool' AND tool_name='fetch_page' AND grantUrlCheck(stored input.url) passes AND enabled. Batch card shows `approval:b:<batchId>:<digest12>:grant` ("Approve all + allow web reading") only when every member qualifies (≤ ~45 chars).
- D6 decideGrant(id, user) one tx: admin check; lock root FOR UPDATE; lock approval row; re-check kind/tool/pending/not expired/input sha matches/heuristics on stored input/root live; decideRow(...,'approved') exactly as decide (URL replays via runApproved); supersede existing live grant (revoked_at=now(), reason 'superseded'); INSERT grant; COMMIT; emit. Batch variant: decideBatch with stored digest + per-member re-checks (B6), then supersede+insert. Approved replays never consume (approvedToolContext gets no webGrants port). Other solo fetch_page cards NOT auto-approved.
- D7 Consume in tainted run via fetch_page `precheck`: (1) null if !ctx.tainted() or urlKey in run.knownUrls or no ctx.task or no ctx.webGrants; (2) grantUrlCheck fail → null (card follows); (3) ctx.webGrants.consume({rootId, host}) ok → add key to run.knownUrls so sync requiresApproval returns false; (4) otherwise null → card. consume catches its own errors → `web_grant`/`consume` incident, returns 'error'; never throws (a precheck throw becomes a refusal, registry "could not be checked").
  Atomic consume:
  ```sql
  UPDATE web_grants g SET used = used + 1,
    hosts = CASE WHEN $2 = ANY(hosts) THEN hosts ELSE array_append(hosts, $2) END
  FROM tasks r WHERE g.root_id = $1 AND r.id = g.root_id AND r.status NOT IN ('done','cancelled')
    AND g.revoked_at IS NULL AND g.expires_at > now() AND g.used < g.max_fetches
    AND ($2 = ANY(g.hosts) OR cardinality(g.hosts) < g.max_hosts)
  RETURNING g.id, g.used, g.max_fetches;
  ```
  Zero rows → second read classifies miss for audit only (none|revoked|expired|cap_fetches|cap_hosts|root_ended).
- D8 Fallback card reason: `fetch_page after untrusted content, url not seen in this run (web grant not applied: <rule|cap_fetches|cap_hosts|none>): <key>` (redactText, 300-char cap).
- D9 grantUrlCheck(raw): pure, sync, no network, runs before DNS; `{ok:true, host}|{ok:false, rule}`; failure → per-URL card, never silent allow/refuse.
  E1 https only. E2 no userinfo. E3 u.port===''. E4 DNS name (isIP==0, ≥1 dot, no trailing dot, ASCII, xn-- ok). E5 host ≤64 chars, ≤5 labels, label ≤24 chars with ≤3 digits. E6 raw ≤256; pathname ≤160 and ≤8 segments; query ≤100 and ≤4 params; hash empty; ≤6 %XX. E7 split host labels, path segments, query keys/values on `[-._~+,;=&/]`; fail if any token ≥24 chars, or all-hex ≥16 chars containing a digit, or ≥10 digits. E8 redactText(raw)===raw. E9 no HIDDEN code points (reuse webSearch.ts export).
  Existing guards kept (private/IP ranges, port, userinfo, per-redirect-hop recheck). Residual R1 (W-C10): if a page tricks the bot, it can send up to about `max_url_chars` characters (owner default 4000) of what it has read in this task tree to sites it picks, without asking; bounded by maxFetches and maxHosts too. R2 redirect targets server-chosen, not counted as hosts.
- D10 Revocation: on grant success card closes with "Web reading allowed for this task tree until <ts>, up to N pages / M sites" + button `approval:g:<grantId>:revoke` (existing approval: router). Revoke admin-only `UPDATE ... SET revoked_at=now(), revoked_by=$u, revoke_reason='admin' WHERE id=$1 AND revoked_at IS NULL`, button removed. halt.changed halted:true → revokeAll('halt'); resume does not restore. A fetch whose consume committed may complete.
- D11 fetch_page stays batchable (grant is extra action, B1–B14 unchanged). Halt/turn/budget gates run before every provider call. fetch_page costs $0.

## Migration 027_web_grants
```sql
CREATE TABLE web_grants (
  id bigserial PRIMARY KEY,
  root_id text NOT NULL REFERENCES tasks(id),
  approval_id bigint NOT NULL UNIQUE REFERENCES approvals(id),
  granted_by text NOT NULL CHECK (granted_by ~ '^[0-9]{17,20}$'),
  requested_by text NOT NULL,
  max_fetches integer NOT NULL CHECK (max_fetches BETWEEN 1 AND 200),
  max_hosts integer NOT NULL CHECK (max_hosts BETWEEN 1 AND 50),
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0),
  hosts text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by text,
  revoke_reason text CHECK (revoke_reason IS NULL OR revoke_reason IN ('admin','halt','superseded')),
  CONSTRAINT web_grants_used_cap CHECK (used <= max_fetches),
  CONSTRAINT web_grants_hosts_cap CHECK (cardinality(hosts) <= max_hosts),
  CONSTRAINT web_grants_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '24 hours'),
  CONSTRAINT web_grants_revoked CHECK ((revoked_at IS NULL) = (revoke_reason IS NULL))
);
CREATE UNIQUE INDEX web_grants_one_live_idx ON web_grants(root_id) WHERE revoked_at IS NULL;
```
Down: `DROP TABLE web_grants;`. No new approvals kind.

## Contracts
Repo: consume({rootId, host}) → {ok:true;grantId;used;max} | {ok:false; why:'none'|'revoked'|'expired'|'cap_fetches'|'cap_hosts'|'root_ended'|'error'}; revoke(id, by, reason); revokeAll(reason); live(rootId).
decideGrant → {ok:true; approval; grant:{id, expiresAt, maxFetches, maxHosts}} | {ok:false; error:'not_admin'|'not_pending'|'expired'|'not_grantable'|'root_ended'}.
Replies: not_grantable "Web reading can't be allowed for this card; decide it with Approve or Reject."; root_ended "The task has ended."; revoke twice "Already revoked."
Regex: APPROVAL_ID `^approval:(\d{1,15}):(approve|reject|ask|grant)$`; batch parser action set + grant; new `^approval:g:(\d{1,15}):revoke$`.
Audit: approval.grant outcome `ok #<approvalId> grant #<gid>`; web_grant.consume outcome `ok #<gid> <used>/<max>` | miss reason | `url:<rule>`; web_grant.revoke outcome `admin|halt|superseded #<gid>`. Host only in audit, never full URL. #bot-log incidents only for consume/decide faults.

## Invariants (Gate 1)
W1 only fetch_page affected (write tool under live grant still asks). W2 no consume without taint + task; any error → card. W3 heuristics before DNS/network; safeFetch checks every hop. W4 eligibility recomputed from stored tool_input at render and click. W5 atomic consume + row CHECKs. W6 runApproved never consumes. W7 halt revokes, resume doesn't restore. W8 config snapshot. W9 no full URL in audit/logs. W10 admin-only grant/revoke (guard + decideGrant).

## Tests
grant-url.test E1–E9 pass+fail fixtures (UUID path, 10-digit id, base64 token, IP host, long data subdomain, secret-shaped query); web-grants int: concurrent consume to cap, host cap, expiry, root ended, supersede, halt revokeAll; decideGrant int: tampered sha, non-fetch_page, expired, mixed batch rejected; registry: write tool asks under grant, runApproved leaves used unchanged; card render grant button present/absent. Revisit: fetchPage.test.ts reason infix; approval.test.ts malformed-id list.

## Amendments after Gate 1 (binding; Gate 1 W-C1–W-C14 in docs/security/2026-11-08-gate1-web-grant.md win where they differ)
- Owner choice: defaults maxFetches 20 (1..200), maxHosts 5 (1..50), hours 4; new `web.taskGrant.maxUrlChars` int 4000 (500..20000) snapshotted into the row as `max_url_chars`, with `url_chars_used`; consume adds len(pathname+search) atomically and refuses (`cap_chars`) when it would exceed. Migration 027 gains these two columns + CHECK url_chars_used <= max_url_chars.
- D10 halt: consume refuses live while isHalted(); revokeAll on halt(), on the cfg.watch('halted') path and at boot (revoke grants created before the halted row's updated_at); decideGrant returns 'halted' while halted (W-C3).
- Precheck consumes only when sameActor(ctx.task.owner, ctx.actor) (W-C1) and never on the approved/runApproved path (W-C2).
- Grant button only when the card shows the URL uncut (W-C4). Use the non-global HIDDEN regex (W-C5). Checks on the raw input and the parsed URL (W-C6). `enabled` read live in consume (W-C7). Supersede every unrevoked row (W-C8).
- Wording: button "Allow web reading for this task tree"; closing text names the task tree and states honestly that up to ~4 KB of task content could leak through URLs (W-C9, W-C10).

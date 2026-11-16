# Gate 2 Security Audit: SEARCH-1 (keyless open-source fallback for web_search)

- Date: 2026-11-10
- Scope: `git diff 5694e8f fa61fa0` (15 files); Chrome guard proxy policy (`net/proxy.ts`, `net/proxy-main.ts`, `tools/plugins/web/chrome.ts`, `docker-compose.chrome.yml`, `docker/chrome/proxy.Dockerfile`), read in code only, no network.
- Gate 1 ref: `docs/security/2026-11-10-gate1-search.md`
- Tests: `npx vitest run tools/plugins/web discord/commands/settings.opensearch.test.ts admin/keys.opensearch.test.ts` -> 8 files passed, 122 passed / 5 skipped (net tests skipped).

## Verdict: APPROVED

No findings of Medium or higher. No new dependencies (supply chain N/A). No native code (N/A).

## SR-C status

| ID | Status | Evidence |
| :--- | :--- | :--- |
| C1 host pinning | PASS | `openSearch.ts` fetchStream passes `allowHosts:[s.host]`; `net/fetch.ts:162-165` checks every hop; Chrome path checks `finalUrl` hostname `===` host. Test `openSearch.test.ts:130`. |
| C2 URL building | PASS | `qs()` via URLSearchParams; `n` clamped 1-10; regex-validated `objectID`/`question_id`/`name`/`full_name`; Wikipedia `encodeURIComponent`; HN url only via `urlKey` (http/https). Test `:38-42` (javascript:, data:, ftp:, file:). |
| C3 size caps | PASS | `MAX_BYTES` 512 KiB, `truncated` fails; `gunzipSync`/`inflateSync` with `maxOutputLength` 1 MiB inside try. Test `:136`. |
| C4 output caps | PASS | title `fold` + slice 200 incl. prefix; snippet `fold`/`flat` + slice 400. |
| C5 logging | PASS | No log/console in `openSearch.ts` (test `:399`); tool output fixed texts T1/T2/T4 only. |
| C6 approval/taint | PASS | `requiresApproval` unchanged logic, reason now names destinations; `source` is `z.enum`; taint tests green. |
| C7 limiter/cool-down | PASS | `Limiter.take` never waits; `secondsToMs` and reset clamp to 24 h, junk/past -> 60 s. Test `:216`. |
| C8 concurrency | PASS | `BROWSER_PARALLEL=2`, 20 s overall, 8 s race, `closed` drops late results. Test `:260-268` peak 2. |
| C9 kill switch | PASS | `index.ts` reads key live, error -> off; `searchChain` off -> plain `ddg.search`; key in HANDLER_KEYS; `planOpenSourcesEnabled` `risk: v === true`. |
| C10 disclosure | PASS | README section "web_search open-source fallback (SEARCH-1)". |
| C11 headers | PASS | only `user-agent`, `accept`, `x-github-api-version`; no token; Chrome path sends none. |
| C12 parsing | PASS | JSON.parse in try; zod envelope throws inside fetchStream try -> stream fails; per-item `safeParse`; no eval or merge. |

## Rulings on backend notes

1. `SourceOff` defined in `webSearch.ts` and re-exported from `openSearch.ts`: ACCEPTED (avoids a circular import; one class identity so `instanceof` works).
2. `fold` strips Cf/Co/tag/variation selectors, which removes ZWJ/ZWNJ from titles: ACCEPTED. Same set as the existing `HIDDEN` in `webSearch.ts`; small display cost for some scripts and emoji, which is better than letting invisible text through to the model.
3. HN/SE plain-text titles keep a literal `<script>` as text: ACCEPTED. The output is plain text that the registry wraps as untrusted (`untrustedOutput: true`) and is never rendered as HTML; HTML-escaping it would corrupt real titles. Wikipedia snippets (which are HTML) go through `flat`.
4. DDG 0 hits and every open stream failing -> T2: ACCEPTED. T1 ("do not retry") is right only when DDG refused; T2 gives fixed text and leaks nothing.
5. Live probe (all 5 sources 200, SE quota_max 300, `accept-encoding: identity` honoured): consistent with LIMITS (SE 250/day under 300). Gzip handling stays as defence in depth.

## Chrome guard proxy and the six hosts

No finding. The guard has no host allowlist or denylist: `net/proxy.ts:113` and `:155` call `o.check` (the shared `checkUrl`: scheme, port, host name syntax, resolved address must be public). The only other limits are per-session caps (`net/proxy-main.ts:38`, compose `CAP_BYTES` 8 MiB / `CAP_REQUESTS` 200). `chrome.ts:192` pre-checks with the same `checkUrl`. en/th.wikipedia.org, hn.algolia.com, api.stackexchange.com, registry.npmjs.org and api.github.com are public names on port 443, so they pass. Note (not security): Chrome sends its own `accept`/UA, so GitHub may answer with its default media type; parsing still works.

## Low / informational

- INFO-1: `slice(0, 200/400)` may split a surrogate pair at the cut, leaving one lone surrogate. Cosmetic; no fix required.

## Fixed in this audit

None.

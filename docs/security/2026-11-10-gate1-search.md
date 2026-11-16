# Gate 1 - SEARCH-1 keyless open-source fallback for web_search

Date: 2026-11-10. Inputs: `docs/superpowers/specs/2026-11-10-open-search-design.md` + binding SA brief (Amendment SA-1).

## Verdict: CONDITIONAL_APPROVE

The design adds no new trust path. Every fetch goes through the existing `readPage` port (Chrome plus guard proxy in local mode, `safeFetch` on VPS and in tests). Output stays `untrustedOutput`, so taint and knownUrls handling are unchanged (`registry.ts:22,221-228`). URLs are built by code from zod-validated fields.

## Rulings on the SA questions

1. **Chrome redirect residual: ACCEPTED.** A redirect hop inside Chrome still goes through the guard proxy (`chrome.ts` header comment: "the proxy is the control"), so it cannot reach private or SSRF targets. What is left: one GET to a public host chosen by a first-party API, followed by the final-host post-check. That is the same exposure DDG has today.
2. **`default true`: ACCEPTED**, because the owner directed it and the hosts are fixed. Conditions SR-C9 and SR-C10 apply.
3. **Reason wording: ACCEPTED as written** (SA brief §5). It names every third party and keeps "N results".

## Conditions (each must be testable at Gate 2)

- **SR-C1** Host pinning. On the HTTP path, every stream call passes `allowHosts:[host]` with exactly one host. Test: a cross-host redirect fails (brief §9 BE3). On the Chrome path, a `finalUrl` hostname that is not `===` host fails the stream. Test: a fake WebBrowser returns a mismatched host.
- **SR-C2** URL building. `q` is added only through `URLSearchParams`, and `n` is clamped to 1-10. Item URLs are built from the regex-validated `name` / `full_name` / `question_id` / `objectID`, and `encodeURIComponent(title)` for Wikipedia. The HN upstream `url` is accepted only when the protocol is exactly `http:` or `https:` (after `new URL`). Otherwise the HN item URL is used. Test: a `javascript:` and a `data:` HN url each produce the item URL.
- **SR-C3** Size caps. 512 KiB per response, and `truncated` means the stream fails. Gunzip and inflate use `maxOutputLength: 1048576`, and the thrown error means the stream fails without crashing the process. Test: a gzip bomb (more than 1 MiB of output) fails only that stream.
- **SR-C4** Output caps. Title is at most 200 including the `[Label] ` prefix, snippet at most 400, both after `fold`/`flat`, so no control characters or HTML survive. Test with fixtures that contain `\u0000`, `‮`, `<script>` and entities.
- **SR-C5** Logging. No new log lines. The query, upstream bodies, upstream error text and response headers are never logged or put into tool output. Fixed texts only: T1, T2, T4. Grep test: no `log`/`console` in `openSearch.ts`.
- **SR-C6** Approval and taint unchanged. `requiresApproval` still runs for every call, including with `source`. The AI-approver `query_heuristic` (`governance/ai-approver.ts:115-116`) still applies. `source` is a zod enum, so it cannot carry free text. The existing taint block in `webSearch.test.ts:63-122` passes unchanged.
- **SR-C7** Limiter and cool-down. They never wait or sleep, and a limited stream is skipped. State is per-process and in memory. Cool-downs are capped: `x-ratelimit-reset` and `backoff` are clamped to at most 24 h, and a value that is non-numeric, negative or in the past falls back to 60 s. Test: an absurd reset value is clamped.
- **SR-C8** Concurrency. In Chrome mode there are at most 2 parallel streams per call and a 20 s overall deadline. Every stream has an 8 s race. A late Chrome result after the race is discarded and never merged. Test: a fake browser counts peak concurrency at 2 or less.
- **SR-C9** Kill switch. `web.search.openSources` is read live on every call, and a read error counts as off. When it is off, the behaviour is byte-identical to today's DDG path (the existing tests stay green). The key is in HANDLER_KEYS, and the plan sets `risk: v === true`, so enabling it is flagged.
- **SR-C10** Disclosure. The README or the Book records that the default is on, and that one approved query can go to up to 6 third parties (DDG plus 5 operators).
- **SR-C11** Headers. The only headers sent are `user-agent`, `accept` and `x-github-api-version`. No credential, cookie or token header goes to any stream (`safeFetch` strips credential headers anyway). No GitHub token is added.
- **SR-C12** Parsing. JSON.parse and the zod envelope run inside try/catch, and any failure means the stream fails. Unknown fields are ignored. No `eval`, no prototype-polluting merge.

## Residual risks (accepted)

- Query privacy: an approved query can reach up to 6 outside services (instead of 1 today). The approval card says so.
- Chrome redirect: an intermediate hop is not host-allowlisted, but it goes through the proxy and the final host is checked.
- Default on: the open sources work without the owner turning anything on. Mitigated by the kill switch and the approval step.
- Content: upstream text is untrusted (it can carry prompt injection). It is handled the same way as DDG results (taint wrapper, caps).
- Assumed upstream facts (SE gzip, quota) are checked by the opt-in probe. They are not part of the security design.

## Owner sign-off

Residual risks accepted on 2026-11-10 under the owner's standing instruction in chat ("OK, just do it, don't wait for me to order"). Build may proceed under SR-C1 to SR-C12.

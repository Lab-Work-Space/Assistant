# Vendored Mermaid (RFMD P4, Gate 1 RF23-RF26)

- Bundle: `mermaid.min.js` from the npm package `mermaid@12.2.0` (`package/dist/mermaid.min.js`), MIT licence (`LICENSE`, copied from the same tarball).
- Obtained with `npm pack mermaid@12.2.0`; the tarball matched the registry integrity
  `sha512-w7nr/SFrLO7BaVTs3dQTvYSV6nYSBj0Yy9DjBhsIJtAcHqRzXSq4Pg32ujHZ/AdWsAMNEvvhbm5dt9E2tOiHzw==` (`npm view mermaid@12.2.0 dist.integrity`).
- sha256 of the bundle (pinned in `tools/plugins/docs/mermaid.ts`, listed in `SHA256SUMS`): `a8a6a6f805b074a8261a2825c86f99c8054acb3b35f50bb7e24a4f9f2c3c3b9f`.
- 12.2.0 was the `latest` dist-tag on 2026-11-03 (>= 11.10.0, so CVE-2025-54880 / GHSA-8gwm-58g9-j8pw is fixed). The bundle sets `globalThis.mermaid`.
- It is injected into the render page from the host after a sha256 check at every load; it is never loaded from a CDN. A test fails when the file differs from the pin.

## Scan at pin time (RF25) - 2026-11-03, osv-scanner was NOT installed; the OSV API (api.osv.dev/v1/query) was queried instead
- `mermaid@12.2.0`: no advisories.
- Bundled `dompurify@3.4.12` (inlined; mermaid 12.2.0 depends on `^3.4.12` and there is no newer mermaid): 5 advisories, fixed in 3.4.13 to 3.4.17:
  GHSA-cg2g-xh64-v4q7 (CRITICAL, SAFE_FOR_TEMPLATES with DOM output modes), GHSA-mrv2-3pqr-j5jr (HIGH, IN_PLACE), GHSA-55q2-fjhq-7xh7 (MODERATE, IN_PLACE),
  GHSA-6688-9rhm-gjv2 (LOW, IN_PLACE), GHSA-c6gr-qvv4-5v3f (LOW, xhtml parser).
  Reachability: mermaid calls `DOMPurify.sanitize(string, {...})` for string output only; it uses none of IN_PLACE, SAFE_FOR_TEMPLATES, RETURN_DOM or an xhtml
  parser (grep of the bundle shows each name only in DOMPurify's own code). The page also has no network, scripts only from the pinned bundle, strict mode, and the
  only thing that leaves it is a PNG screenshot. RF25 says HIGH or CRITICAL is a REJECT, so this is a recorded deviation for Gate 2 to accept or refuse. Bump this
  file the day a mermaid release bundles dompurify >= 3.4.17.

## Bump procedure
`npm pack mermaid@<v>`, compare the tarball sha512 with `npm view mermaid@<v> dist.integrity`, copy `dist/mermaid.min.js` and `LICENSE`, update the version and
sha256 in `tools/plugins/docs/mermaid.ts` and `SHA256SUMS`, re-run the OSV query for mermaid and the bundled dompurify, run `npm test`.

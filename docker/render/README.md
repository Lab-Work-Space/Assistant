# Document renderer (RFMD P3, Gate 1 RF15/RF16)

`doc_create` renders business documents (money, tax, HR) to PDF in a Chrome that is **not** the web-browsing Chrome and has **no route anywhere**.

```
host (app) --127.0.0.1:9224 + bearer token--> [renderfwd] --internal net, no gateway--> [renderer]
```

- `renderer`: same pinned `chromedp/headless-shell` digest, seccomp profile and hardening as `docker-compose.chrome.yml` (nobody, read-only, no capabilities, tmpfs only, no env, no mounts). Its only network is `internal` (`internal: true`, subnet 10.88.78.0/24); there is no proxy container and its proxy flags point at a dead loopback port.
- `renderfwd`: runs `net/forwarder-main.ts` only (`createForwarder`): it forwards the DevTools connection after the per-boot bearer token and refuses callers from the renderer's own network. It sits on a second, dedicated bridge (`hostside`) only because Docker cannot publish a port from an internal network.
- Start: `npm run local:render` (builds, mints `RENDER_ACCESS_TOKEN` for this boot in memory, never a file). Stop: `npm run local:render:down`. Then start the app with `npm run dev`, which reads the token back from the running container and sets `RENDER_CDP_URL=http://127.0.0.1:9224` for the node child only.
- Without it (the VPS, tests) the `docs` tool group is off with a fixed message; there is no fallback renderer.
- The renderer Chrome is recycled every 2 hours once idle and after a context that would not close. Bump the image digest together with `docker-compose.chrome.yml`.
- Fonts: `vendor/fonts` (Sarabun Regular and Bold, SIL OFL), sha256-pinned in `tools/plugins/docs/fonts.ts`, embedded as `data:` URLs. No web fonts, no CDN.
- Optional real-render smoke: after `npm run local:render` and `npm run build`, run a small script that builds a document with `dist/tools/plugins/docs/templates.js` and renders it with `ChromeRenderer` from `dist/tools/plugins/docs/render.js` against `http://127.0.0.1:9224` with the token from `docker inspect assistant-render-renderfwd-1`.
- Department documents are kept under `DOCS_DIR` (absolute) or `data/documents` (git- and docker-ignored with `data/`). The root is refused when it is `$HOME` or directly under it, under `~/Documents`, `~/Desktop`, `~/Library/Mobile Documents` or `~/Library/CloudStorage` (explicit values), or when it is, contains or lies inside Praw's workspace root; the docs group is then off.

## Diagrams and slide decks (RFMD P4, Gate 1 RF23-RF27)

The same renderer also draws `diagram_create` (Mermaid text to PNG) and prints `doc_create` kind `slides` (landscape deck) and `plan`.

- **Diagrams** run Mermaid in a page of their own: the vendored bundle (`vendor/mermaid`, pinned by version and sha256 in `tools/plugins/docs/mermaid.ts`, checked at every load, never a CDN) is the only script, allowed by a CSP hash; scripts are ON for that page only. The Mermaid text goes in as an `evaluate` argument, `securityLevel: 'strict'`, no network (every request is aborted and counted as in documents), 15 s limit, the PNG is capped at 768 KB. Output is PNG only (no SVG leaves the page, RF26).
- **Decks and plans** stay scripts-OFF. A diagram is embedded as a `data:image/png` the code stored when `diagram_create` made it; ids resolve only inside the same task tree.
- The Mermaid source is checked in code first (at most 20 KB, type keyword on the first line, no `%%{`, front matter, click/call/href, scripts or HTML other than `<br>`) and masked with `redactText`.
- A bundle bump: see `vendor/mermaid/README.md` (npm pack, registry integrity, sha256, OSV query of mermaid and the bundled dompurify).
- No new setup: `npm run local:render` is unchanged. The deployed (VPS) app has no renderer, so both tools stay off there.

# Chrome container (Gate 1 Part C)

```
host app --127.0.0.1:9222 (DevTools)--\
host app --127.0.0.1:9223 (control)----+--> guardproxy --internal net (10.88.77.0/24, no gateway)--> chrome
                                        \--> egress net --> internet (public addresses only)
chrome --proxy http://10.88.77.2:3128 --> guardproxy
```

- **chrome**: `chromedp/headless-shell` pinned by digest, user nobody, read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, tmpfs `/tmp` only, no env except `HOME`, nothing published, pids/memory limits. Its only network is `internal` (no gateway): there is no route except the proxy (`Network is unreachable` for anything else, WebRTC and QUIC included). Flags: `--proxy-server`, `--proxy-bypass-list=<-loopback>`, `--disable-quic`, WebRTC non-proxied UDP off, `--use-mock-keychain --password-store=basic`, no extensions/sync/background networking.
- **guardproxy** (`net/proxy.ts`): the only container on `egress`. For each plain request and each CONNECT it runs the SSRF target check (scheme, port 80/443, host, every resolved address), then connects to the checked IP. Redirects are followed by Chrome, so every hop is a new checked request. Each call mints a credential (`POST :9223/session`), which also carries the per-call caps (8 MiB, 200 requests) and is ended after the call. The control port and the DevTools forwarder refuse callers on the internal network, so a page cannot mint a session or drive Chrome.
- **Sandbox stays on.** `seccomp.json` is Docker's default profile plus `clone`, `clone3`, `unshare`, `setns` and `chroot` allowed without CAP_SYS_ADMIN, which is what Chrome's user-namespace sandbox needs. Nothing runs with `--no-sandbox`.
- A fresh browser context per call; downloads denied, popups closed, dialogs dismissed, service workers bypassed, only http(s) requests, no images/media/fonts.

Residual risks (accepted, recorded in the report): the DevTools port is TCP on `127.0.0.1:9222`, not a pipe (the container boundary forbids a pipe), so a local process on the Mac can drive this secret-free Chrome, and Chrome itself rejects DNS-rebound Host headers; Chrome shares the guard proxy's network namespace neighbours only through the internal net; a Chrome renderer plus kernel escape would land in the container (nobody, no caps, no secrets), not on the host user.

**Access token (G2C-03).** `npm run local:chrome` makes a random token for this boot, hands it to the proxy container (`ACCESS_TOKEN`) and nowhere else; `npm run dev` reads it back from the running container into the app's child env (`CHROME_ACCESS_TOKEN`). The control API and the DevTools forwarder answer 401 without `Authorization: Bearer <token>`, so another container (through `host.docker.internal`) or a local process cannot mint sessions or drive Chrome. Only `/healthz` is open. Restarting the stack makes a new token; restart the app too.

**Recycle (C27/C30).** One Chrome serves all calls (a fresh context each). To limit what a compromised browser process could see, the app tells Chrome to exit every 6 hours once idle (and after contexts that would not close); the container's restart policy brings up a fresh process and an empty profile. Calls made in that window wait for it.

**Scan.** `npm run chrome:scan` runs `grype --fail-on high --only-fixed` on both images (proxy image: clean; Chrome image: the Debian HIGHs have no fix upstream, owner-accepted, re-scan on every pin bump). Raise `CHROME_PIN` in `tools/plugins/web/chrome.ts` together with the digest; older builds are refused at boot.

Bump the Chrome pin: pull the new `chromedp/headless-shell` tag, copy the index digest from `docker image inspect --format '{{index .RepoDigests 0}}'` into `docker-compose.chrome.yml`, then `npm run local:chrome && npm run chrome:smoke`.

Tests: `npm test` (compose and driver unit checks), `npx vitest run --project net` (proxy over real sockets), `npm run chrome:smoke` (real Chrome, internet), `npm run chrome:e2e` (throwaway stack with a hostile origin: redirects to private targets, iframe/fetch/WebSocket probes, endless body, 10,000 subrequests, infinite loop; stops and restores the normal stack).

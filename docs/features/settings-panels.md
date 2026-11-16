# Settings panels

Two ways to change settings without talking to Praw: the Discord panel and the local web dashboard.

## Settings panels: Discord panel and local web dashboard

Two ways to change settings without talking to Praw. Both build the **same** structured ops and the **same** confirmation card as the natural-language and slash flows (`admin/settings.ts` -> `AdminConsole`); neither has a write path of its own. Server-management sections (welcome and default roles, AutoMod, server settings and events, moderation shortcuts) answer "available after server management is enabled" until that feature is merged and registers its family.

### Discord panel (`#⚙️-setting`)

hq posts and pins one panel message at boot (the id is stored in the `panel_state` table; a deleted message is re-posted once, at most once per 10 minutes, and the old message's buttons are refused). Pick an action from the select menus, fill the form, confirm the card. Only Bot Admins (role id from the interaction payload) can use it. Live values refresh after every apply. Owner step: give hq **Pin Messages** in `#⚙️-setting` if you want it pinned (a missing permission is logged, the panel works unpinned).

### Local web dashboard (local mode only)

- Start: runs inside the local app when `ALLOW_LOCAL_PROVIDERS=1` is in the real process env and the process is not in a container. It binds the literal `127.0.0.1` on `DASHBOARD_PORT` (default 8787, process env only). It never starts in the VPS image, and `deploy/` publishes no dashboard port (a test checks both).
- Sign in: a Bot Admin runs `/dashboard` in `#⚙️-setting`; hq replies privately with a link that works **once** within **5 minutes**. Opening it shows a "Continue" button; the click signs you in (a GET alone consumes nothing). Session cookie `lw_dash_sid`: HttpOnly, SameSite=Strict, host-only, idle 8 h, absolute 24 h; Logout and "Revoke all sessions" delete it server-side. The cookie is not marked `Secure` (Safari refuses Secure cookies on `http://127.0.0.1`).
- Pages: status, config (read only, `ADMIN_READ_KEYS`), pending cards with the stored diff and Apply/Cancel (only for cards you proposed in the dashboard; Discord cards are read only), change forms, audit (filter and sort), members (needs server management), channels (protected channels shown only as a count).
- Guards: exact `Host` (`127.0.0.1:<port>` or `localhost:<port>`, one header), exact `Origin` on every POST, a per-session CSRF token in the form (cookies and SameSite ignore ports, so another local service cannot forge a write), live Bot Admin re-check on every write (removed role = all sessions deleted), CSP `frame-ancestors 'none'`, no CORS.
- **Containers can reach the port** (Docker Desktop routes `host.docker.internal` to host loopback), and so can any local process. The `Host` check only stops a browser-style request with a foreign name; a client that forges `Host: 127.0.0.1:<port>` gets through. The protection is therefore not network isolation but the one-time login token, the per-session CSRF token and the exact Origin check. The web tools and the Chrome proxy cannot be pointed at it (the net guard refuses loopback and private addresses; `dashboard/boot.test.ts`). Gate 2 live probes: from a container, `curl -i -H 'Host: evil.example' http://host.docker.internal:8787/` expects 421; an unauthenticated request with a correct `Host` expects 401.
- Not remote: exposing it beyond the Mac needs its own spec (Caddy plus auth).

Related: [Admin console and server management](admin-console-and-server-management.md), [Security notes](../reference/security-notes.md).

Back to the [documentation index](../_index.md).

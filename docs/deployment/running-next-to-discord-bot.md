# Running next to Discord_bot

What must be true before the Assistant shares a Discord server with the old Gemini `Discord_bot`.

## Running next to Discord_bot (Gemini assistant)

The Gemini `Discord_bot` has GitHub write tools and reads channel history through MCP, so it must not share the server with Assistant until the owner has done these steps (Gate 1 L12 to L14). They are server and GitHub settings, not code, and they are not enforced by this repo.

- **L12, role allowlist.** Give Discord_bot a dedicated role with View Channel only on its own channels. Deny View Channel on `#🔑-system-credentials`, `#moderator-only` and every company/department channel (its chat history is reachable through MCP). No Administrator, no Manage *, no Mention Everyone, no Server Members intent unless its welcome cog needs it. Set the application to Private; use Integrations to restrict its slash commands and AI to a role. Check: the channel list visible to its account contains none of the denied ids.
- **L13, GitHub App.** Before inviting it, install its GitHub App on **selected repositories only**, excluding `Lab-Work-Space/Assistant`, the infra repo and every lw-git deploy source (lw-git deploys `Assistant` `main` to the VPS, so a write there is code on the VPS). Branch protection is **not available** on the free private org (the API returns HTTP 403), so the repo selection is the only control: if you cannot guarantee the exclusion, set `PLUGINS_DISABLED=github` for Discord_bot instead.
- **L14, Team MCP and stored state.** Keep Team MCP disabled: its port is not published and `lsof -iTCP -sTCP:LISTEN` shows no MCP port. If it is ever enabled, bind it to 127.0.0.1 with auth. Restrict its "lessons" store (self-written guardrails) and its watches (URLs chosen by users, an injection and SSRF risk) to admins.

The step-by-step move of features from the old bot is in [Cutover to Praw (M2)](cutover/m2.md), [M3](cutover/m3.md) and [M4](cutover/m4.md).

Back to the [documentation index](../_index.md).

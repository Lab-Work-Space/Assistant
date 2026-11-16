# Growth roadmap (GROWTH-1)

Date: 2026-11-12. Status: proposed to the owner for ONE approval; after that each item runs through the team pipeline without further owner approval, except release steps (R5 defines the release card; until then "release" = deploy to the live bot and any switch that security says must stay off).

Owner request (translated): "Check and develop everything so it is flexible and supports growth, including Skills, Plugins, MCP and others; it should grow and learn from its mistakes; propose the big work once, do the rest alone, approve only at release."

## Audit findings (2026-11-12, code + live DB)

- Skills: 0 skills, 0 proposals. Nothing tells a head to propose except the weekly retro (first run Friday 16:00); no seed skills; no on-demand retro.
- Learning loop is open: reflect writes notes only for `done` tasks (failures leave nothing durable); lessons are written by Praw only and read by heads only when confirmed (0 lessons); **all 96 department notes are stored as tainted**, and any tainted/UNVERIFIED text in a head's context taints the run, which makes `skill_propose`, `tool_request` and prompt proposals refuse.
- Plugins: adding one tool touches the plugin folder, a hard-coded group array, deps, app wiring, two golden tests and up to seven scattered name lists; sensitivity is a name-prefix regex (a new prefix is "non-sensitive" by default).
- MCP: none bot-side; the local CLI provider is forced to zero MCP servers by design (probe-checked).
- Self-development: dev jobs need a paid key and were never set up; WS-1 workspaces can build and test code; `tool_idea` tickets have no consumer.
- Autonomy: "propose once" (project card) and "run without approvals" (company autopilot, live) exist; there is no single release object.
- Operations: a rejected Claude quota fails calls and blocks tasks (no hold-until-reset); non-conversation `review` tasks never close on their own and count toward the open-task cap (12/20 open today, 11 in review); no fallback provider.

## Roadmap

| id | title | what the owner gets | size | depends | security gate |
| :--- | :--- | :--- | :--- | :--- | :--- |
| R1 OPS-HOLD | Quota hold + stale-review sweep | Work pauses on a rejected quota and resumes at reset (nothing marked failed); old reviews close themselves; cap usage in the digest | S-M | none | no |
| R2 LEARN-LOOP | Learn from mistakes + taint hygiene | Blocked/failed/cancelled tasks become code-built facts and notes; tainted notes leave the default prompt (still searchable) so heads can propose skills again; `/retro run` on demand; lessons reach heads | M | R1 | yes |
| R3 SKILL-SEED | Seed skills + AI skill judge on | Each department starts with 1-2 skills; retros improve them without the owner | S | R2 | yes |
| R4 PLUGIN-MANIFEST | One manifest per tool | A new tool = one folder + one line; policy lists and golden tests derived from the manifest; no name-prefix hole | M | none | yes |
| R5 RELEASE-1 | Release card | One approval bundling artefact hash, test log and summary, tied to the project; the only owner step after the project start | M | R4 | yes |
| R6 MCP-1 | Bot-side MCP client | A Bot Admin allowlists MCP servers; their tools run sandboxed, untrusted, classed by the allowlist | L | R4 | yes |
| R7 PLUGIN-FORGE | Bots build their own tools | `tool_idea` → project → software team builds an MCP-server plugin in a workspace → release card → installed | L | R5, R6 | yes |
| R8 PROV-FALLBACK | Fallback provider per department | Chosen departments continue on Gemini when Claude is rejected | M | R1 | yes |

Order: R1, R2, R3 first (they make what is already built produce skills and learning), then R4, R5, R6, R7; R8 when wanted.

## Owner steps under this roadmap

1. Approve this roadmap once.
2. Approve each release step when it is ready (deploys that change live behaviour, turning on a switch security keeps off, installing an MCP server or a bot-built plugin).

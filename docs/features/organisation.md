# Organisation: heads, personas and tasks

The Assistant runs an AI "company" inside one Discord server.

## Heads, personas and tasks

- A Node 22 / TypeScript service that runs an AI "company" inside one Discord server: 9 department head bots (one Discord application each, hq/CEO, rnd, software, it, marketing, sales, hr, finance, ops) plus webhook personas (members) that speak under their own name and avatar. Praw is the tenth Discord application (see [Praw](praw.md)).
- Heads delegate tasks to each other and to personas, and every task gets a thread. Budgets and limits are enforced before each LLM call (see [Budgets and quotas](../configuration/budgets-and-quotas.md)).
- An admin can change configuration live with slash commands (see [Slash commands](../reference/slash-commands.md) and the [admin console](admin-console-and-server-management.md)).
- State lives in PostgreSQL. The service only makes outbound connections (Discord, Anthropic, PostgreSQL) and publishes no port.
- Personas speak only in their own direct room under the 🤖 BOT category, never in a work channel or the war room. Naming a persona anywhere else is answered by the department head instead; a persona without a direct room cannot be given tasks (assign the head).
- Heads also talk to each other in the bot-to-bot war room (`#💬-ai-warroom`); the room and its audience are set up in the [owner setup checklist](../deployment/owner-setup-checklist.md).

Design and decisions: `docs/superpowers/specs/2026-10-31-discord-ai-company-core-design.md` (parent repo). Security review: `docs/security/2026-10-31-gate1-discord-ai-company-core.md` (parent repo, rows D1 to D24).

Related: [Governance and approvals](governance-and-approvals.md), [Tools and plugins](tools-and-plugins.md), [Workspaces](workspaces.md).

Back to the [documentation index](../_index.md).

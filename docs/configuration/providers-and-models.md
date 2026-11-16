# Providers and models

Which model provider the Assistant uses, which keys it needs, and how to switch the optional local provider on or off.

## Providers and models

The Assistant can call three providers. The Claude API is the default.

| Provider | Model (default) | Needs | Used by |
| :--- | :--- | :--- | :--- |
| Claude API (`claude`) | `claude/claude-sonnet-5-5` | `ANTHROPIC_API_KEY`, optional `ANTHROPIC_WORKSPACE_ID` | every head bot |
| Gemini (`gemini`) | `gemini-3.8-flash` | `GEMINI_API_KEY` | Praw (see [Praw](../features/praw.md)) |
| Local CLI (`claude-code-local`), optional | `local/claude-sonnet-5-5` | the logged-in `claude` CLI on macOS, no API key | local mode only |

### Claude API (default)

The default provider is the Claude API: `claude/claude-sonnet-5-5` (the code default in `config/defaults.ts`). It needs `ANTHROPIC_API_KEY`. `ANTHROPIC_WORKSPACE_ID` (a `wrkspc_...` id) is sent as `anthropic-workspace-id`; it is needed for organization-scoped API keys, and an invalid value refuses boot. Provider keys added with `/provider add` are stored encrypted in the database (see [Key and token rotation](../operations/rotation.md)).

To use the Claude API on a Mac, add `ANTHROPIC_API_KEY` to `~/.config/assistant/env.local` (mode 0600) by hand, or enter it through the dashboard's write-only env-entry route (`dashboard/envEntry.ts`); the value is never printed. On a Mac where the local provider is available and no default was stored, the first boot sets `claude-code-local` as the default. The local-provider marker below keeps the Claude API in place.

With no provider ready (no `ANTHROPIC_API_KEY` and no registered local provider) the service stays up but idle. See [First run](../getting-started/first-run.md).

### Gemini (Praw)

Praw runs on Google Gemini (`gemini-3.8-flash`) with `GEMINI_API_KEY`. The key must come from a billing-enabled project and the pricing row must include the model. Both are covered in [Praw](../features/praw.md).

### Local provider (optional): claude-code-local

Local mode only. The provider spawns the owner's logged-in `claude` CLI (subscription, no API key). It registers only on macOS, with `ALLOW_LOCAL_PROVIDERS=1` in the real process environment, and only while the probe pin matches the `claude` binary on PATH. Setup and the probe are in [Local mode setup](../getting-started/local-mode-setup.md). Local calls cost USD 0 and are counted instead (see [Budgets and quotas](budgets-and-quotas.md)).

### Turning the local provider off (use the Claude API instead)

**Turning the local provider off (use the Claude API instead).** `touch ~/.config/assistant/local-provider-off`, then restart (`npm run dev` / the launchd job). `scripts/dev.sh` then sets `ASSISTANT_LOCAL_PROVIDER_OFF=1` for the node child only: `claude-code-local` does not register (no `claude` spawn, no refusal incident, no subscription use), while local mode itself (Chrome web tools, dashboard) stays on. Set `provider.default` to a `claude` model first (it is not changed for you; with the marker on and no stored default the code default `claude/claude-sonnet-5-5` applies). To turn it back on: `rm ~/.config/assistant/local-provider-off` and restart. Any profile or override still pinned to `claude-code-local` shows "Unavailable" until repointed.

Back to the [documentation index](../_index.md).

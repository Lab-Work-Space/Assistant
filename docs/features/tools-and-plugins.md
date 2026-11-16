# Tools and plugins

How tools declare their safety class, how to add a plugin, and the GitHub write tools.

## Adding a tool/plugin (R4 PLUGIN-MANIFEST)

Every tool declares its class (kind, sensitivity, approval, department limit, tree grant, autopilot, AI review) in a checked-in manifest. The lists that used to be literals (`TREE_GRANT_TOOLS`, `NO_APPROVAL_TOOLS`, `BOT_TALK_TOOLS`, `AUTOPILOT_OWN_WAIVE`, `AUTOPILOT_ALWAYS_CARD`, `MONEY_DOC_TOOLS`, `COST_OR_LASTING_TOOLS`, `DEPT_ONLY`) are frozen views of the manifests. A name nobody declared is fail-closed: sensitive, always a card, hard-denied by the AI reviewer. Steps for a new plugin `x`:

1. Make the folder `tools/plugins/x/` with `index.ts` (the factory, group id `x`) and `manifest.ts` (`defineManifest('x', { x_read: { ...READ, sensitive: false }, x_write: { ...WRITE, sensitive: false } })`). A manifest imports only `tools/manifest/types.js`. `sensitive` is required in every entry; `sensitive: false` is a reviewed grant, so use `true` unless the tool must be batchable, skill-grantable and AI-judgeable.
2. Add one line in `pluginGroups` (`tools/plugins/index.ts`) and one line in `tools/manifest/catalog.ts` (import the manifest, add it to the `buildCatalog([...])` list). A completeness test names whichever line is missing; boot refuses a tool whose manifest entry is missing, or whose group or kind differs from what it registers.
3. Only when an entry is not a plain preset (a `treeGrant`, `no_approval` or `bot_talk` approval, `own_waive` or `always_card` autopilot, `money_doc` or `cost_or_lasting` AI review, or a `deptOnly`), also edit `tools/manifest/privileged.json` in the same diff. A test compares every derived list with that file, and `sensitive: false` entries are listed in its `sensitiveFalse`. The manifests, the goldens and `privileged.json` are protected from bot self-modification (`devjob/paths.ts`), so a human reviews that diff.
4. Optional: a new dependency is one `PluginDeps` field (`tools/plugins/deps.ts`) plus its wiring next to `registerGroups` in `app.ts`.
5. Optional and deliberate: grant the tool to a department in `tools.byDept` (`config/defaults.ts`, or the settings panel). A new tool is never granted automatically.

If a decision golden changes on purpose, regenerate it with `GOLDEN_UPDATE=1 npx vitest run <file>` (refused when `CI`, `DEVJOB` or `DEVJOB_SANDBOX` is set; the run fails after writing so you read the diff). The files are `tools/__golden__/autopilot-classes.json` and `tools/__golden__/decision-matrix.json`. The catalog digest (`CATALOG_DIGEST`) changes with any declared class.

For the plugin forge, which lets bots build plugins themselves, see [MCP and plugin forge](mcp-and-forge.md).

## GitHub write tools (AC10)

- `github_create_branch`, `github_create_or_update_file` and `github_create_pull_request` always need a Bot Admin's approval. They write only to `praw/<name>` branches the bot creates from the default branch, never to the default branch, never under `.github/`, and open pull requests into the default branch (people merge).
- A repository is writable only after `/github allow action:add repo:<owner/repo>` in #⚙️-setting (Bot Admin). The bot resolves it through the App and stores its id; `action:remove` takes it off. Each call (before the approval card and again when the approved call runs) re-resolves the id and canonical name, requires the installation account as owner, and refuses the hard denylist: every lw-git `REPO=` source, `Lab-Work-Space/labworkspace-infra`, `Assistant`, `Discord_bot`, and any name matching `infra|deploy|secrets`.
- The denylist is `tools/plugins/github/deploy-repos.json`. After `lw add` or any `infra/vps/files/lw-git/apps/*/app.conf` change, run `node scripts/gen-deploy-denylist.ts` (reads `LW_INFRA_DIR`, default `../infra`) and commit it together with `tests/fixtures/lw-git-repos.txt`. This is a second layer: L13 (selected-repository installation) still applies.

Related: [Governance and approvals](governance-and-approvals.md), [Workspaces](workspaces.md).

Back to the [documentation index](../_index.md).

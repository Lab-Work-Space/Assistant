# Env file

Where the local secrets live, and what must never go into them.

## Env file location

All local secrets live in **`~/.config/assistant/env.local`** (directory mode 0700, file mode 0600, owned by you, not a symlink). The launcher refuses to start if any of these is wrong. Do not keep it under `~/Desktop`, `~/Documents` or any iCloud Drive folder: with "Desktop & Documents Folders" turned on, macOS syncs those to iCloud, which would copy your bot tokens and master key to Apple's servers and to your other devices. It is also never inside the repo, so it cannot be committed (`.env*` and `.env.local` are git-ignored as a second line of defence).

`ALLOW_LOCAL_PROVIDERS` is **never** written to that file. `npm run dev` sets it for the node child process only, and the guard refuses to enable the provider if any env file defines it.

To switch the local provider off, see [Providers and models](../configuration/providers-and-models.md#turning-the-local-provider-off-use-the-claude-api-instead).

Related: [Local mode setup](local-mode-setup.md), [Environment variables](../configuration/environment-variables.md), [Key and token rotation](../operations/rotation.md).

Back to the [documentation index](../_index.md).

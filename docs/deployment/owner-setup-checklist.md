# Owner setup checklist

The one-time manual steps in the Discord Developer Portal, on the Discord server, and on the VPS.

## Owner setup checklist (manual, once)

These steps are done by the owner in the Discord Developer Portal, the Discord server and on the VPS. They are not automated.

### 1. Discord applications (9, one per department)

1. Create 9 applications in the Developer Portal and a bot user for each.
2. Intents: enable only **Guilds** (non-privileged, always on), **Guild Messages** (non-privileged) and **Message Content** (privileged toggle). Do NOT enable Server Members or Presence, and no voice intents in Core (Gate 1 D19; this overrides the older note in spec §16).
3. Set every application to **Private** (turn Public Bot off) and do not require a code grant.
4. Invite each bot with the `bot` and `applications.commands` scopes (Praw needs `applications.commands` in particular: her `/ask` and later user commands are registered on her own application) and **no** guild-wide permissions beyond the basics. Never grant Administrator. Do not grant Attach Files guild-wide (Praw gets it per channel from M4, see Discord permissions). Do not grant Manage Webhooks guild-wide: the service checks this at boot and disables a department client that has it (fail closed).
5. Per-channel permission overwrites for each bot, only on its own department channels (these are the `REQUIRED_CHANNEL_PERMISSIONS` the service verifies in `discord/perm/permissions.ts`):

| Permission | Why |
| :--- | :--- |
| View Channel | read the department channels |
| Send Messages | post replies |
| Send Messages in Threads | post in task threads |
| Create Public Threads | open a thread per task |
| Read Message History | short-term context |
| Embed Links | embed replies |
| Manage Webhooks | persona webhook; **channel overwrite only**, never guild-wide, and only where that department's personas speak |

   Also needed: Use Application Commands (the CEO/hq bot registers the slash commands).
   Two more channels need the same overwrites (View, Send, Send in Threads, Create Public Threads, Read History, Embed Links):
   - **`#💬-ai-warroom`** (`1566366032094961705`) for **every department head bot**, including Praw. It is the bot-to-bot room: heads also post there with `warroom_say` and @mention each other by handle. Delegation threads open in the asking channel's category when the bots can post there, and fall back to this room otherwise; the run is told to answer tersely in English. Audience (owner ruling 2026-11-03): only the Founder and Bot Admin roles, the bot roles (Assistant, LW Bots, AI Employee) and the bot members may view it; any other View overwrite makes `warroom_say` fail closed. Messages people post there are ignored; it cannot be mapped with `/channel map`. Tasks a person gives a head directly stay in the channel where they were given.
   - **`#🧾-bot-log`** (`1566454343820124352`, Logs category) for the **hq** bot. What is posted there, and how to read an incident, is in [Incidents and #🧾-bot-log](../operations/incidents-and-bot-log.md). Messages in it are never routed and it cannot be mapped.

   **Personas** (the AI employees) speak only in their own direct room under the 🤖 BOT category, never in a work channel or the war room. Naming a persona anywhere else is answered by the department head instead; a persona without a direct room cannot be given tasks (assign the head).
6. Explicitly **deny** every bot View Channel on the two denied channels: `#🔑-system-credentials` (`1565715069969502310`) and `#moderator-only` (`1565649677280485457`). The ids are also hard-coded in `company/denylist.ts`; a bot that can see either channel is disabled at boot and an alert is posted.

### 2. Admin role

Create the role `Bot Admin`, assign it to the owners, and put its **role id** (not its name) in `BOT_ADMIN_ROLE_ID`. Admin is always identified by id. Slash commands work only in `#⚙️-setting` from holders of that role.

### 3. Database (devops, on the shared PostgreSQL)

The `assistant` role and database are isolated from the other apps (Gate 1 D17). This is an infra/devops step; it is documented here and not scripted in this repo.

```sql
CREATE ROLE assistant LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8 PASSWORD '<generated>';
CREATE DATABASE assistant OWNER assistant;
REVOKE CONNECT ON DATABASE "Labworkspace" FROM PUBLIC;
REVOKE CONNECT ON DATABASE assistant FROM PUBLIC;
GRANT CONNECT ON DATABASE assistant TO assistant;
REVOKE TEMPORARY ON DATABASE assistant FROM assistant;
```

`pg_hba.conf`: add exactly this line, with no `hostssl` public line and nothing broader:

```text
host    assistant    assistant    172.30.0.0/16    scram-sha-256
```

Checks: `psql -U assistant -d Labworkspace` is rejected; a connection from a public IP is rejected. The app pool is at most 6 connections plus 1 dedicated LISTEN connection, below the role's limit of 8.

### 4. Secrets on the VPS

Secrets live only in the platform's `shared/.env` for the app: mode 0600, owner root, outside every File Browser root, never in the repo and never in the image (`.dockerignore` excludes `.env*` except `.env.example`). Set them one at a time so values stay out of shell history and argv:

```bash
ssh root@72.60.196.53 "lw env set apps/assistant BOT_TOKEN_HQ"     # value read from stdin
ssh root@72.60.196.53 "lw env keys apps/assistant"                  # key names only
```

Verify mode and ownership: `stat -c '%a %U' /srv/labworkspace/apps/assistant/shared/.env` must print `600 root`.

Back to the [documentation index](../_index.md).

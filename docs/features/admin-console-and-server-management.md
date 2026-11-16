# Admin console and server management

Changing settings by talking to Praw, and the separate executor that manages the Discord server.

## Admin console and Discord permission ops (Praw in `#⚙️-setting`)

A Bot Admin can now change settings by talking to Praw in `#⚙️-setting` (top-level messages only, not threads). Praw reads and **proposes**; hq posts a confirmation card (Confirm / Cancel); only the admin who asked can press it, once, within 15 minutes. The change is applied by code from the stored proposal, never by the model. Everything is audited as `user:<id> via praw` (`config.set`, `admin.<op>`, `perm.<op>`, `admin.card`).

What Praw can do there: read and change the config keys the console allows (`halted` is never one; `/halt` and `/resume` stay slash-only), the admin operations behind the slash commands (holidays, channel map, bots, personas, budget, limits, approval threshold, ClickUp and auto-OCR channels, music hosts, GitHub write allowlist, default provider), and Discord permissions (below). It cannot read or set secrets. If you paste a token or key there, Praw replies with a fixed warning and does not read it: delete the message and rotate the secret.

### Server management: the separate executor "LW Admin" (phase 2, Gate 1 S1-S37)

Praw now manages the whole server (channels, members, moderation, AutoMod, server settings, events, roles and overwrites) by proposing; **Praw's own client holds no management permission**. Every Discord write runs in a **separate process**, the executor "LW Admin" (`executor/main.ts`), which holds the only copy of `BOT_TOKEN_ADMIN`, in its own env file. The main application refuses to start if that token is in its environment. How the executor runs on the Mac is in [The executor under its own macOS user](../operations/executor.md).

- **Automatic, no card:** the welcome message plus default roles for a new member, and Discord's own AutoMod enforcement. Everything else, including creating or changing an AutoMod rule, needs a Confirm.
- **How a change happens:** Praw proposes (`perm_propose` for roles and overwrites, `server_propose` for the rest) -> the executor validates it against its own live reads -> hq posts the card -> the proposing admin presses Confirm -> the main application sends **only the card id** over a local Unix socket (`~/.config/assistant/executor.sock`, mode 0600 in a 0700 directory) -> the executor claims the confirmed row (once), **re-runs every hard limit itself** and applies it. A card row forged in the database can only get operations that pass the hard limits, at most 20 ops per admin per 10 minutes, 40 in total, and 10 destructive ones (ban, kick, bulk delete, channel delete, AutoMod disable or delete) per hour.
- **Not built yet:** images (server icon, banner, emoji, stickers; Gate 1 S24, S27) and Onboarding.

#### Owner steps (once, in this order)

Server operations stay **off** (and hq says why in `#🧾-bot-log`) until every step is done.

1. **Create the app.** Developer Portal: a new application "LW Admin". Turn **Public Bot off** and leave Requires OAuth2 Code Grant off. Turn on **2FA** on the account that owns it (with a server MFA requirement, moderation calls fail without it).
2. **Intents.** On the Bot page turn on **Server Members Intent only**. Presence and Message Content stay off.
3. **Invite with exactly this permission integer, `1125684159671`,** and the `bot` scope only (no `applications.commands`). It is these bits: Manage Channels, Manage Roles, Manage Server, Kick Members, Ban Members, Moderate Members, Manage Nicknames, Manage Messages, Manage Threads, Manage Events, View Audit Log, Create Invite, View Channels, Read Message History. **Never** Administrator, Manage Webhooks guild-wide or Mention Everyone. (Send Messages is not needed: it never posts; it may arrive through `@everyone`, which the boot check allows.)
4. **Place the role.** Drag the LW Admin role **below Founder, Bot Admin and every `PRIVILEGED_ROLE_IDS` role**, and **above** the roles you will use as welcome default roles.
5. **Hide the DENIED channels.** LW Admin must not be able to view `#🔑-system-credentials` and `#moderator-only`; the boot check disables the executor if it can.
6. **Create the category `📦 Archive`** (exactly one, exact name) if you want channel archiving. Fill in the owner constants in `company/denylist.ts` if you have not (`FOUNDER_ROLE_ID`, `PRIVILEGED_ROLE_IDS`, `DENIED_CATEGORY_IDS`); the rules channel and the Logs category are read live from the server.
7. **Revoke Praw's phase-1 grant, before deploying this release:** remove **Manage Roles and Manage Channels from the Praw integration role** in Discord. From that moment role/overwrite changes through Praw stop, and they come back through LW Admin after step 8. (Gate 1 suggested keeping Praw's old allowlist for one release; this release moves the phase-1 executor to LW Admin at once, so there is nothing to keep. If you deploy first, the boot check disables Praw until you remove the grant: it fails closed, but it is an outage.) The boot check flags Praw if she ever holds either bit again.
8. **Set the token, locally:** `bash scripts/set-tokens.sh --local ADMIN` (pasted hidden; it writes `~/.config/assistant/env.admin`, mode 0600, with the token, the loopback `DATABASE_URL` copied from `env.local`, and the Bot Admin role id; it never touches `env.local`). `npm run dev` then starts the app **and** the executor, each with its own clean environment. The assistant never handles the token. **On the VPS** the executor service is not deployed yet: do **not** put `BOT_TOKEN_ADMIN` into `apps/assistant` (the app refuses it); the VPS deployment needs its own service, its own env and a socket mounted read-write only in the executor (devops, not part of this release).
9. **Check:** `node dist/scripts/dump-bot-permissions.js` (the ten bots print `OK`), then start the app and check `#🧾-bot-log` for "Server management is off". Then run `node --env-file=$HOME/.config/assistant/env.admin dist/scripts/dump-bot-permissions.js --admin` and confirm `admin: ... OK` (11 clients in total: the ten and LW Admin).
10. **Record** the Gate 1 S2 decision (option A, taken 2026-11-02) and that the phase-1 acceptance of the Praw-token blast radius (the earlier phase-1 note that used to stand in this section) no longer applies: a stolen Praw token can no longer change anything on the server.

#### Welcome and default roles

Configure through Praw (`admin_op_propose` `welcome_set`) or later the panel: `welcome.enabled`, `welcome.roleIds` (up to 5 roles that are safe-bit-only, unmanaged, not privileged, not held by a bot and below LW Admin), `welcome.message` (up to 500 characters; `{user}` is the only placeholder; no links, invites or other mentions), `welcome.channelId` (not a DENIED or system channel; Praw must be able to send there), `welcome.raidPerMinute` (3-30, default 10). Each default role is re-checked against live data on **every** join; a role edited to carry power is not assigned and the flow pauses with an alert. More joins than the limit in a sliding minute (bots count) pause both roles and posts until a Bot Admin confirms `welcome.resume`; the pause survives a restart. A bot that joins gets nothing, and a user id is welcomed once per 24 hours.

Hard limits (propose **and** apply, in the executor): the phase-1 list for roles, overwrites and channel creation, plus: no DENIED or system channel, the Logs category or the rules channel is ever edited, moved, archived or deleted; mapped work channels are never archived or deleted; a channel is deleted only if empty, or archived by LW Admin at least 7 days ago and still in `📦 Archive`; ban and kick targets must be named by the admin by mention or id, at most 5 per card; never the server owner, a bot, LW Admin or Praw, Founder, Bot Admin or other privileged holders, or anyone whose top role is at or above LW Admin's; ban delete-window at most 1 day (loud warning); timeout at most 28 days; bulk delete picks its messages by code at propose time (max 100, newer than 14 days, no pinned, no protected authors) and deletes exactly that list; guild edits only name, description, system and rules channels; event locations must be `https`; invites last 1 hour to 7 days with 1 to 25 uses and the link is shown only to the confirming admin; AutoMod alerts always go to `#🧾-bot-log`, timeouts are at most 1 day, and weakening a rule is flagged on the card.

### Delegated tiers: Moderator, Manager and more Bot Admins (Gate 1 delta T1-T24)

More people than the owner can look after the server. Authority comes **only through Praw and the confirmation card**; the tier roles carry no Discord management bits. The panel, the dashboard and `#⚙️-setting` stay **Bot Admin only**; Moderators and Managers use the **mod room**.

| Tier | Holders | May propose and confirm (limits in code) |
|---|---|---|
| Bot Admin | `BOT_ADMIN_ROLE_ID` (unchanged) | everything |
| Manager | `roles.managerId` | everything a Moderator can, plus: kick (named, max 5), timeout up to 28 days, nickname set/clear, invites create/revoke, channel create/rename/topic/slowmode/move/archive (not system, mapped, DENIED, mod-room or overwrite-sensitive channels), thread unlock, scheduled events |
| Moderator | `roles.moderatorId` | delete one message (by id), bulk delete (code picks the messages, max 50), pin/unpin, timeout up to 1 day (named), end a timeout, thread archive/lock |

Bot Admin only: ban/unban, roles and overwrites, server settings, AutoMod, welcome, bot config and admin ops, channel delete, thread delete. The single op-to-tier table is `MIN_TIER` in `discord/tiers.ts` (an unknown op is Bot Admin only; a test keeps it exhaustive).

How it is enforced: a tier proposal goes to the executor, which fetches the proposer **and** the decider live and derives their tiers from its **own** config read (`roles.*`, `BOT_ADMIN_ROLE_ID`) at propose and again at apply, before any write. A tier is never read from a card. The tier roles are re-validated at every apply (exists, not managed, not `@everyone`, not Founder/Bot Admin/privileged, below LW Admin, not held by a bot, safe bits only, two different roles, not a welcome default role); if one fails, all Manager and Moderator cards are refused and an alert goes to `#🧾-bot-log`, while Bot Admin cards keep working. An actor never targets their own tier or higher, themself, a bot or the owner (live roles); a Moderator's bulk delete leaves out messages by members at their tier or above. Moderators have a 10 / 5 destructive per hour budget, Managers 20 / 10, in their own buckets (so a Moderator raid cannot use up the Bot Admin budget); the global 40 per 10 minutes stays. Cards in the mod room are confirmable **only by their proposer**, only in the mod room (and a Bot Admin may cancel). Every audit row carries `tier:<bot_admin|manager|moderator>` at the end of the actor.

#### Owner steps (once)

1. **Create two roles** in Discord, for example `Moderator` and `Manager`, with **no management permissions at all** (safe bits only: view, send, read history, connect, speak and the like; never Manage Messages, Kick, Timeout, Manage Channels/Roles/Server, Mention Everyone, Administrator, Manage Webhooks/Threads/Events, View Audit Log). Place them **below LW Admin's role**, not under Founder/Bot Admin, and do not use them as welcome default roles. Praw cannot grant these roles (nor Bot Admin); **you assign them in Discord**.
2. **Create `🛡️-mod-room`**, in its own category (a category that holds the mod room is out of reach for a Manager's channel moves), visible to Moderator, Manager, Bot Admin, Praw (the bot), hq and LW Admin, and to nobody else. Praw and hq need View, Send and Read History there, and **LW Admin needs View Channel** there too (it judges every Manager/Moderator card against the room, its name and its category; with no view of it, `roles.modRoomId` is refused and all tier cards are refused).
3. **Set the three keys with a Bot Admin card** in `#⚙️-setting` (ask Praw: "set roles.moderatorId to <role id>, roles.managerId to <role id>, roles.modRoomId to <channel id>"). They are high risk and checked live by the executor; they cannot be set from the mod room. Until `roles.modRoomId` and a tier role are set, the mod room does nothing.
4. **More Bot Admins:** give the Bot Admin role in Discord to trusted people. No code change; Praw and LW Admin can never grant it. Each extra Bot Admin widens the trust base of every security condition, so **record every holder here** (who, date) and remove the row when the role is taken away:

| Bot Admin holder | Added on | Added by |
|---|---|---|
| (owner) | | |

Notes: use the mod room by writing normally; Praw answers there for a Moderator or Manager only (bots, webhooks, people without a tier role, threads and edits are ignored). Name every member you act on by mention or id in your own message, and give the message id (or reply to the message) for a single delete or pin. Praw there reads only your own earlier words and her own recorded replies, so other people's messages never steer a card.

Related: [Governance and approvals](governance-and-approvals.md) (second confirmation for deploy and destructive operations), [Settings panels](settings-panels.md), [Owner setup checklist](../deployment/owner-setup-checklist.md).

Back to the [documentation index](../_index.md).

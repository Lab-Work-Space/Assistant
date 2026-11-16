# Praw (น้องพราว)

Praw is the tenth Discord application: a Gemini-backed head that also runs the admin console and the receipt, OCR and music features.

## Praw (น้องพราว)

Praw is the tenth Discord application (department `praw`). She chats on Google Gemini (default model `gemini-3.8-flash`), can hand work to the other heads and be handed work by them, and has her own `/ask` command. The old bot (the Python "Discord_bot" assistant) keeps running next to her: its messages are mapped to `foreign_bot`, so they never trigger Praw and never count as a human requester (P16e). Switch off the old bot's matching features only when a later milestone says so.

### Owner steps (once, in this order)

1. **Create the Discord application** in the Developer Portal and keep it **Private**. Steps that worked for the other 9 heads: Installation > Install Link = **None** first; then Bot > **Public Bot off**, **Message Content Intent on**, Save. No Server Members and no Presence intent are needed, and no voice intents until M5.
2. **Invite** her with the `bot` and `applications.commands` scopes and the Core permissions (see the table in [Owner setup checklist](../deployment/owner-setup-checklist.md), section 1: View Channel, Send Messages, Send Messages in Threads, Create Public Threads, Read Message History, Embed Links, and Manage Webhooks only as a channel overwrite). Never Administrator.
3. **Pin Messages** (for `pin_message`, M2) only as a **per-channel** overwrite on Praw's mapped channels, never guild-wide. Discord has a dedicated Pin Messages permission (bit `1 << 51`, required by the pin/unpin endpoints; verified 2026-11-01), so Praw never needs **Manage Messages**: do not grant it. The startup check flags a guild-wide Manage Messages on the `praw` client and disables it (P17). `pin_message` pins only in the channel or thread the request came from. Attach Files (needed from M4: `extract_receipt` posts its CSV as a file; without it the table and CSV are not posted, the tool says so and returns the table in its result), Connect and Speak are likewise per-channel or per-category grants and are not needed before M2/M4/M5 (`PRAW_EXTRA_PERMISSIONS` in `discord/perm/permissions.ts`).
4. **Set the secrets** on the service: `BOT_TOKEN_PRAW` and `GEMINI_API_KEY` (`lw env set apps/assistant BOT_TOKEN_PRAW`, `lw env set apps/assistant GEMINI_API_KEY`, value from stdin; locally `bash scripts/set-tokens.sh --local PRAW`). Without a key she stays unavailable and says so; the other bots are unaffected.
5. **Deploy**, then map her channel: `/channel map <#channel> praw work:true`. Without a work channel other heads cannot assign her tasks (`praw has no work channel`).
6. **Pricing row.** A deployment that already has a stored `pricing` config row must add `gemini-3.8-flash` to it; otherwise Praw refuses to run with the "no price" alert (D4), because a model without a price is never called. Gemini prices were verified on 2026-10-31 (Standard paid tier): 0.75 in / 3.75 out / 0.075 cached per MTok through 2026-12-31, and 1.50 / 7.50 / 0.15 from 2027-01-01. The shipped defaults use the 2027 rates so the budget guard never under-counts; output includes thinking tokens.

### Gemini data terms (P12)

`GEMINI_API_KEY` **must** come from a billing-enabled (paid) Google Cloud project. The unpaid tier's terms allow Google to use prompts and responses for product improvement; the paid terms do not. **The owner confirms** this once for the key in use. Everything Praw is shown goes to Google: chat text and the context around it, images, receipts and, from M5, voice audio. Retention follows the terms of the Cloud project's tier (paid-tier abuse-monitoring retention applies; check the current Gemini API terms before relying on a specific period). Do not map Praw to channels whose content must not leave the company.

### Rotation of Praw's keys

`BOT_TOKEN_PRAW` and `GEMINI_API_KEY` are listed in [Key and token rotation](../operations/rotation.md). Each later milestone that adds a key adds it there (P24). The full procedure is in [Key and token rotation](../operations/rotation.md).

Related: [Admin console and server management](admin-console-and-server-management.md), [Cutover to Praw (M2)](../deployment/cutover/m2.md), [Cutover to Praw (M4)](../deployment/cutover/m4.md).

Back to the [documentation index](../_index.md).

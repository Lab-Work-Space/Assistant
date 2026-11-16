import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { CONFIRM_PREFIX, type ConfirmPort, type SecondConfirm } from './confirm.js';

/**
 * discord.js side of the second confirmation, on LW Admin's OWN client. The only listener it adds is a button handler for ids that start with
 * `lwadmin2:` followed by 32 hex characters (the executor still has no MessageCreate listener and no slash commands). DMs need no intent.
 */
interface Sendable { send(o: unknown): Promise<unknown> }
export interface ConfirmClient {
  users: { fetch(id: string): Promise<Sendable> };
  channels: { fetch(id: string): Promise<unknown> };
  on(event: string, fn: (...a: never[]) => void): unknown;
}

const row = (token: string) => new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId(`${CONFIRM_PREFIX}${token}`).setLabel('Confirm (LW Admin)').setStyle(ButtonStyle.Danger));
const defang = (s: string): string => s.replace(/@/g, '@​');

export function discordConfirmPort(client: () => ConfirmClient | undefined): ConfirmPort {
  return {
    async send({ userId, channelId, token, text }) {
      const c = client();
      if (!c) return null;
      const body = defang(text);
      try {
        const u = await c.users.fetch(userId);
        await u.send({ content: body, components: [row(token)], allowedMentions: { parse: [] } });
        return 'dm';
      } catch { /* DMs closed or the user cannot be reached: fall back to the card's channel */ }
      try {
        const ch = (await c.channels.fetch(channelId)) as (Sendable & { isTextBased?: () => boolean }) | null;
        if (!ch || typeof ch.send !== 'function' || ch.isTextBased?.() === false) return null;
        await ch.send({ content: `<@${userId}> ${body}`, components: [row(token)], allowedMentions: { parse: [], users: [userId] } });
        return 'channel';
      } catch {
        return null;
      }
    },
  };
}

interface ButtonInteraction {
  customId: string;
  user: { id: string };
  isButton(): boolean;
  deferUpdate(): Promise<unknown>;
  editReply(o: unknown): Promise<unknown>;
  followUp(o: unknown): Promise<unknown>;
}

/** Attaches the click handler to LW Admin's client. */
export function attachConfirmListener(client: Pick<ConfirmClient, 'on'>, confirm: Pick<SecondConfirm, 'onClick'>, log: { error(o: unknown, m?: string): void }): void {
  client.on('interactionCreate', ((i: ButtonInteraction) => {
    if (typeof i?.isButton !== 'function' || !i.isButton() || typeof i.customId !== 'string' || !i.customId.startsWith(CONFIRM_PREFIX)) return;
    void (async () => {
      try {
        await i.deferUpdate();
        const r = await confirm.onClick({ token: i.customId.slice(CONFIRM_PREFIX.length), userId: i.user.id });
        if (r.final) await i.editReply({ content: defang(r.text), components: [], allowedMentions: { parse: [] } });
        else await i.followUp({ content: defang(r.text), ephemeral: true, allowedMentions: { parse: [] } });
      } catch (err) {
        log.error({ err: err instanceof Error ? err.name : 'error' }, 'second confirmation click failed');
      }
    })();
  }) as never);
}

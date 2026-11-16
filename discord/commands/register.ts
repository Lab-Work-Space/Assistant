import type { Client, Interaction } from 'discord.js';
import { sanitize } from '../../core/logger.js';
import { COMMANDS } from './definitions.js';
import type { InteractionLike, ModalSpec, Reply } from './types.js';
import { ActionRowBuilder, MessageFlags, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';

/** Guild commands on the hq client (network; kept tiny, untested). */
export async function registerCommands(hq: Client, guildId: string): Promise<void> {
  if (!hq.application) throw new Error('hq client not ready');
  await hq.application.commands.set(COMMANDS, guildId);
}

function toModal(m: ModalSpec): ModalBuilder {
  return new ModalBuilder().setCustomId(m.customId).setTitle(m.title).addComponents(
    ...m.inputs.map((x) =>
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        (() => {
          const b = new TextInputBuilder().setCustomId(x.id).setLabel(x.label).setRequired(x.required).setMaxLength(x.maxLength)
            .setMinLength(x.minLength ?? 0).setStyle(x.style === 'short' ? TextInputStyle.Short : TextInputStyle.Paragraph);
          return x.value !== undefined && x.value.length <= x.maxLength ? b.setValue(x.value) : b;
        })(),
      ),
    ),
  );
}

/** P24: every interaction reply is masked (patterns + the literal secret list) before it leaves the process; buttons are left alone. */
const masked = (r: Reply, secrets: readonly string[]): Reply => (secrets.length ? { ...r, ...sanitize({ content: r.content, embeds: r.embeds }, secrets) } : r);
const toPayload = (r: Reply) => ({ content: r.content, embeds: r.embeds, allowedMentions: r.allowedMentions, ...(r.components ? { components: r.components } : {}), ...(r.ephemeral || r.suppressEmbeds ? { flags: ((r.ephemeral ? 64 : 0) | (r.suppressEmbeds ? 4 : 0)) as 64 } : {}) });

/** Maps a discord.js interaction to the structural type the handler uses. */
export function toInteractionLike(i: Interaction, secrets: readonly string[] = []): InteractionLike | null {
  if (!i.isChatInputCommand() && !i.isButton() && !i.isModalSubmit() && !i.isStringSelectMenu()) return null;
  const roles = i.member && 'cache' in i.member.roles ? [...i.member.roles.cache.keys()] : Array.isArray(i.member?.roles) ? i.member.roles : [];
  const cmd = i.isChatInputCommand() ? i : null;
  return {
    guildId: i.guildId,
    channelId: i.channelId,
    userId: i.user.id,
    id: i.id,
    userName: i.user.username,
    userIsBot: i.user.bot,
    parentChannelId: i.channel?.isThread() ? i.channel.parentId : null,
    memberRoleIds: roles,
    // S37b: a component, and a modal opened from one, carries the message it sits on; a slash command and a bare modal have none.
    messageId: i.isButton() || i.isStringSelectMenu() ? i.message.id : i.isModalSubmit() && i.isFromMessage() ? i.message.id : null,
    messageAuthorId: i.isButton() || i.isStringSelectMenu() ? i.message.author.id : i.isModalSubmit() && i.isFromMessage() ? i.message.author.id : null,
    isChatInputCommand: () => i.isChatInputCommand(),
    isButton: () => i.isButton(),
    isModalSubmit: () => i.isModalSubmit(),
    isStringSelectMenu: () => i.isStringSelectMenu(),
    values: i.isStringSelectMenu() ? [...i.values] : [],
    commandName: cmd?.commandName ?? '',
    subcommand: cmd?.options.getSubcommand(false) ?? null,
    options: {
      string: (n) => cmd?.options.getString(n) ?? null,
      number: (n) => cmd?.options.getNumber(n) ?? null,
      integer: (n) => cmd?.options.getInteger(n) ?? null,
      boolean: (n) => cmd?.options.getBoolean(n) ?? null,
      channel: (n) => {
        const c = cmd?.options.getChannel(n);
        return c ? { id: c.id, parentId: 'parentId' in c ? (c.parentId ?? null) : null, type: c.type } : null;
      },
      attachment: (n) => {
        const a = cmd?.options.getAttachment(n);
        return a ? { url: a.url, name: a.name, size: a.size, contentType: a.contentType ?? null } : null;
      },
    },
    customId: i.isButton() || i.isModalSubmit() || i.isStringSelectMenu() ? i.customId : '',
    field: (id) => (i.isModalSubmit() ? i.fields.getTextInputValue(id) : null),
    reply: (r) => (i.isChatInputCommand() || i.isButton() || i.isModalSubmit() || i.isStringSelectMenu() ? i.reply(toPayload(masked(r, secrets))) : Promise.resolve()),
    deferReply: (o) => (i.isRepliable() ? i.deferReply(o.ephemeral ? { flags: 64 } : {}) : Promise.resolve()),
    editReply: (r) => (i.isRepliable() ? i.editReply((({ content, embeds, allowedMentions, components, suppressEmbeds }: Reply) => ({ content, embeds, allowedMentions, ...(components ? { components } : {}), ...(suppressEmbeds ? { flags: MessageFlags.SuppressEmbeds as const } : {}) }))(masked(r, secrets))) : Promise.resolve()),
    followUp: (r) => (i.isRepliable() ? i.followUp(toPayload(masked(r, secrets))) : Promise.resolve()),
    deleteReply: () => (i.isRepliable() ? i.deleteReply() : Promise.resolve()),
    showModal: (m) => (i.isChatInputCommand() || i.isButton() || i.isStringSelectMenu() ? i.showModal(toModal(m)) : Promise.resolve()),
  };
}

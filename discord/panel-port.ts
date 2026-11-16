import { DiscordAPIError, type APIActionRowComponent, type APIComponentInMessageActionRow, type APIEmbed, type Client } from 'discord.js';

export interface PanelPayload {
  embeds: APIEmbed[];
  components: APIActionRowComponent<APIComponentInMessageActionRow>[];
}

/** The panel message on hq's own client (Gate 1 S37b/S37e). Kept apart from DiscordPort: its payload carries components and it edits one stored message. */
export interface PanelPort {
  /** 'missing': the message is gone (Unknown Message / Unknown Channel). 'error': anything else; the caller must not re-post on it. */
  fetch(channelId: string, messageId: string): Promise<{ state: 'ok'; authorId: string } | { state: 'missing' | 'error' }>;
  post(channelId: string, p: PanelPayload): Promise<string>;
  edit(channelId: string, messageId: string, p: PanelPayload): Promise<void>;
  pin(channelId: string, messageId: string): Promise<void>;
}

const NO_PING = { parse: [] as [] };
const GONE = new Set([10003, 10008]);

/** Network edge, untested like registerCommands: thin wrappers over discord.js. */
export function createPanelPort(client: () => Client | undefined): PanelPort {
  const channel = async (id: string) => {
    const c = client();
    if (!c) throw new Error('hq client not ready');
    const ch = await c.channels.fetch(id);
    if (!ch || !ch.isTextBased() || ch.isDMBased()) throw new Error('not a guild text channel');
    return ch;
  };
  return {
    async fetch(channelId, messageId) {
      try {
        const ch = await channel(channelId);
        const m = await ch.messages.fetch(messageId);
        return { state: 'ok', authorId: m.author.id };
      } catch (e) {
        return { state: e instanceof DiscordAPIError && GONE.has(Number(e.code)) ? 'missing' : 'error' };
      }
    },
    async post(channelId, p) {
      const ch = await channel(channelId);
      return (await ch.send({ ...p, allowedMentions: NO_PING })).id;
    },
    async edit(channelId, messageId, p) {
      const ch = await channel(channelId);
      await (await ch.messages.fetch(messageId)).edit({ ...p, allowedMentions: NO_PING });
    },
    async pin(channelId, messageId) {
      const ch = await channel(channelId);
      await (await ch.messages.fetch(messageId)).pin();
    },
  };
}

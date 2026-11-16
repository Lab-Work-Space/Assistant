import { describe, expect, it, vi } from 'vitest';
import type { Interaction } from 'discord.js';
import { toInteractionLike } from './register.js';

const SECRET = 'sheets-secret-PLANTED-Zq81xK_77';
const fake = () => {
  const sent: { how: string; payload: unknown }[] = [];
  const i = {
    guildId: 'g', channelId: 'c', user: { id: 'u1', username: 'u', bot: false }, member: { roles: [] }, channel: null, id: '1', commandName: 'x',
    isChatInputCommand: () => true, isButton: () => false, isModalSubmit: () => false, isStringSelectMenu: () => false, isFromMessage: () => false, isRepliable: () => true,
    options: { getSubcommand: () => null },
    reply: vi.fn(async (p: unknown) => void sent.push({ how: 'reply', payload: p })),
    editReply: vi.fn(async (p: unknown) => void sent.push({ how: 'editReply', payload: p })),
    followUp: vi.fn(async (p: unknown) => void sent.push({ how: 'followUp', payload: p })),
  };
  return { i: i as unknown as Interaction, sent };
};

describe('interaction replies mask literal secrets (P24)', () => {
  it('reply, editReply and followUp: content and embeds are masked; buttons and flags are kept', async () => {
    const { i, sent } = fake();
    const like = toInteractionLike(i, [SECRET])!;
    const r = { content: `c ${SECRET}`, embeds: [{ title: `t ${SECRET}`, description: `d ${SECRET}`, fields: [{ name: 'n', value: `v ${SECRET}` }] }], components: [{ type: 1, components: [{ type: 2, custom_id: 'voice:optin:x', label: 'ok', style: 1 }] }] as never, ephemeral: true, allowedMentions: { parse: [] as [] } };
    await like.reply(r);
    await like.editReply(r);
    await like.followUp!(r);
    expect(sent.map((s) => s.how)).toEqual(['reply', 'editReply', 'followUp']);
    for (const s of sent) {
      expect(JSON.stringify(s.payload), s.how).not.toContain('PLANTED');
      expect(JSON.stringify(s.payload), s.how).toContain('[REDACTED]');
      expect(JSON.stringify(s.payload), s.how).toContain('voice:optin:x');
    }
    expect((sent[0]!.payload as { flags?: number }).flags).toBe(64);
  });

  it('without a list the reply is unchanged', async () => {
    const { i, sent } = fake();
    await toInteractionLike(i)!.reply({ content: `c ${SECRET}`, ephemeral: false, allowedMentions: { parse: [] } });
    expect(JSON.stringify(sent[0]!.payload)).toContain(SECRET);
  });
});

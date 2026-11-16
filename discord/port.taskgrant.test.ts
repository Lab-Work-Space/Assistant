import { describe, expect, it } from 'vitest';
import type { Client, Message } from 'discord.js';
import type { DeptId } from '../core/index.js';
import type { Department } from '../db/repos/index.js';
import { fakeChannel, fakeRestClient, type FakeChannel } from '../tests/fakes/discordClient.js';
import { createDiscordPort, DeniedChannelError, type PortOrg } from './port.js';
import { WebhookSender, type WebhookRepo } from './webhooks.js';

/** TREEGRANT-1 through the REAL port: the task revoke row on closeCard, and noteCard (content only). The fake port bypasses both. */
const hq: Department = { id: 'hq', name: 'HQ', categoryNamePattern: 'hq', workChannelId: 'ch-hq', color: 0x111111, model: null, provider: null, enabled: true };
const org: PortOrg = { dept: (id) => (id === 'hq' ? hq : null), persona: () => null };
const repo: WebhookRepo = { getByChannel: async () => null, getByWebhookId: async () => null, upsert: async () => undefined };
type Edit = Record<string, unknown>;
type Msg = { author: string; edits: Edit[]; fail?: unknown };

function world(ch: FakeChannel, secrets: readonly string[] = []) {
  const client = fakeRestClient('app-hq', [ch]);
  const clients: Partial<Record<DeptId, Client>> = { hq: client };
  return createDiscordPort({ client: (d) => clients[d] }, new WebhookSender(repo), org, {
    guildId: '1565649426943442944', adminRoleId: '1565000000000000001', inbound: async (m: Message) => ({ id: m.id }) as never, secrets,
  });
}
const withMessages = (ch: FakeChannel, msgs: Record<string, Msg>) => {
  (ch as unknown as { messages: unknown }).messages = {
    fetch: async (id: string) => {
      const m = msgs[id];
      if (!m) throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      return { author: { id: m.author }, edit: async (o: Edit) => { if (m.fail) throw m.fail; m.edits.push(o); } };
    },
  };
};
const rowIds = (e: Edit) => (e['components'] as { components: { custom_id: string; label: string }[] }[]).flatMap((r) => r.components.map((c) => c.custom_id));

describe('DiscordPort.closeCard with a revoke row', () => {
  it('{task: 9} renders ONE button approval:t:9:revoke; a number still renders approval:g:9:revoke; no argument strips everything', async () => {
    const ch = fakeChannel('ch-hq');
    const msgs = { card: { author: 'app-hq', edits: [] as Edit[] } };
    withMessages(ch, msgs);
    const port = world(ch);
    await port.closeCard('ch-hq', 'card', 'task note', { task: 9 });
    await port.closeCard('ch-hq', 'card', 'web note', 9);
    await port.closeCard('ch-hq', 'card', 'plain');
    expect(rowIds(msgs.card.edits[0]!)).toEqual(['approval:t:9:revoke']);
    expect(rowIds(msgs.card.edits[1]!)).toEqual(['approval:g:9:revoke']);
    expect(msgs.card.edits[2]).toMatchObject({ components: [] });
    expect(msgs.card.edits[0]).toMatchObject({ content: 'task note', allowedMentions: { parse: [] } });
  });
});

describe('DiscordPort.noteCard (TG-C17 usage line)', () => {
  it('edits only the content of hq\'s own message: no components key, no embeds key, masked text, no ping', async () => {
    const ch = fakeChannel('ch-hq');
    const msgs = { card: { author: 'app-hq', edits: [] as Edit[] }, other: { author: 'someone', edits: [] as Edit[] } };
    withMessages(ch, msgs);
    const port = world(ch, ['literal-secret-value-123']);
    await port.noteCard!('ch-hq', 'card', 'Used 3/40 literal-secret-value-123');
    expect(msgs.card.edits).toEqual([{ content: 'Used 3/40 [REDACTED]', allowedMentions: { parse: [] } }]);
    expect(Object.keys(msgs.card.edits[0]!)).not.toContain('components');
    expect(Object.keys(msgs.card.edits[0]!)).not.toContain('embeds');
    await port.noteCard!('ch-hq', 'other', 'x');
    expect(msgs.other.edits).toEqual([]); // someone else's message is left alone
  });

  it('cuts the content at Discord\'s limit; a gone message (10008) is not an error; any other error rethrows; a denied channel is refused', async () => {
    const ch = fakeChannel('ch-hq');
    const msgs = { card: { author: 'app-hq', edits: [] as Edit[] }, broken: { author: 'app-hq', edits: [] as Edit[], fail: Object.assign(new Error('boom'), { code: 50013 }) } };
    withMessages(ch, msgs);
    const port = world(ch);
    await port.noteCard!('ch-hq', 'card', 'y'.repeat(5000));
    expect((msgs.card.edits[0]!['content'] as string).length).toBeLessThanOrEqual(2000);
    await expect(port.noteCard!('ch-hq', 'missing', 'x')).resolves.toBeUndefined();
    await expect(port.noteCard!('ch-hq', 'broken', 'x')).rejects.toThrow('boom');
    await expect(port.noteCard!('1565715069969502310', 'card', 'x')).rejects.toBeInstanceOf(DeniedChannelError);
  });
});

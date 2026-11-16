import { describe, expect, it } from 'vitest';
import type { Client, Message } from 'discord.js';
import type { DeptId } from '../core/index.js';
import type { Department } from '../db/repos/index.js';
import { fakeChannel, fakeRestClient, type FakeChannel } from '../tests/fakes/discordClient.js';
import { otGrantedPayload, otRequestPayload, type OtCardView } from './embeds/approval.js';
import { createDiscordPort, type PortOrg } from './port.js';
import { WebhookSender, type WebhookRepo } from './webhooks.js';

/** OT-1 through the REAL port (compose -> outbound -> redactPayload -> buildMessage), not the fake: the buttons and the single embed must survive it. */
const hq: Department = { id: 'hq', name: 'HQ', categoryNamePattern: 'hq', workChannelId: 'ch-hq', color: 0x111111, model: null, provider: null, enabled: true };
const org: PortOrg = { dept: (id) => (id === 'hq' ? hq : null), persona: () => null };
const repo: WebhookRepo = { getByChannel: async () => null, getByWebhookId: async () => null, upsert: async () => undefined };
const hqA = { kind: 'head' as const, dept: 'hq' as DeptId };
const view: OtCardView = {
  id: 7, digest: 'abcdef012345', rootId: 'task-1', rootTitle: 'Quarterly report', threadId: '1570000000000000009', requestedBy: '123456789012345678',
  held: { tasks: 2, depts: ['Software'], rollups: 0, botTalk: 0 }, spentUsd: 0, until: new Date('2026-11-07T10:00:00Z'), maxRuns: 30, maxUsd: 2,
};
type Edit = Record<string, unknown>;

function world(ch: FakeChannel, secrets: readonly string[] = []) {
  const client = fakeRestClient('app-hq', [ch]);
  const clients: Partial<Record<DeptId, Client>> = { hq: client };
  return createDiscordPort({ client: (d) => clients[d] }, new WebhookSender(repo), org, {
    guildId: '1565649426943442944', adminRoleId: '1565000000000000001', inbound: async (m: Message) => ({ id: m.id }) as never, secrets,
  });
}
const ids = (rows: unknown) => (rows as { components: { custom_id: string }[] }[]).flatMap((r) => r.components.map((c) => c.custom_id));

describe('OT-1 card through the real DiscordPort', () => {
  it('post: ONE message, ONE embed, the three approval:ot: buttons, no content, no mention parse; the returned id is that message', async () => {
    const ch = fakeChannel('ch-hq');
    const id = await world(ch).post(hqA, { channelId: 'ch-hq' }, otRequestPayload(view, []));
    expect(ch.sent).toHaveLength(1);
    expect(id).toBe('cm-ch-hq-1');
    const m = ch.sent[0] as unknown as { embeds: { title: string; fields: { name: string }[] }[]; components: unknown; content?: string; allowedMentions: unknown };
    expect(m.embeds).toHaveLength(1);
    expect(m.embeds[0]!.title).toBe('OT request #7');
    expect(m.embeds[0]!.fields.map((f) => f.name)).toEqual(['Task tree', 'Requested by', 'Why', 'Held now', 'Spent so far', 'If approved']);
    expect(ids(m.components)).toEqual(['approval:ot:7:abcdef012345:approve', 'approval:ot:7:abcdef012345:deny', 'approval:ot:7:abcdef012345:day']);
    expect(m.content ?? '').toBe('');
    expect(m.allowedMentions).toEqual({ parse: [] });
  });

  it('post: a secret in the root title is redacted by the port\'s own pass as well', async () => {
    const ch = fakeChannel('ch-hq');
    await world(ch, ['literal-secret-value-123']).post(hqA, { channelId: 'ch-hq' }, { ...otRequestPayload(view, []), body: 'x literal-secret-value-123' });
    expect(JSON.stringify(ch.sent)).not.toContain('literal-secret-value-123');
  });

  it('updateCard with the granted card: one embed, only the Revoke button, the grant as the message content, no ping', async () => {
    const ch = fakeChannel('ch-hq');
    const edits: Edit[] = [];
    (ch as unknown as { messages: unknown }).messages = { fetch: async () => ({ author: { id: 'app-hq' }, edit: async (o: Edit) => void edits.push(o) }) };
    const granted = otGrantedPayload(view, { by: '123456789012345678', until: new Date('2026-11-07T10:00:00Z'), runsUsed: 0, maxRuns: 30, maxUsd: 2 });
    expect(await world(ch).updateCard('ch-hq', 'card', granted)).toBe(true);
    const e = edits[0] as { content: string; embeds: unknown[]; components: unknown; allowedMentions: unknown };
    expect(e.embeds).toHaveLength(1);
    expect(ids(e.components)).toEqual(['approval:ot:7:abcdef012345:revoke']);
    expect(e.content).toMatch(/^OT approved by <@123456789012345678> until <t:\d+:t>, runs 0\/30, up to \$2\.00\.$/);
    expect(e.allowedMentions).toEqual({ parse: [] });
  });

  it('closeCard strips the buttons and writes the note (the deny, revoke, expire and moot endings)', async () => {
    const ch = fakeChannel('ch-hq');
    const edits: Edit[] = [];
    (ch as unknown as { messages: unknown }).messages = { fetch: async () => ({ author: { id: 'app-hq' }, edit: async (o: Edit) => void edits.push(o) }) };
    await world(ch).closeCard('ch-hq', 'card', 'OT request #7 denied by <@123456789012345678>.');
    expect(edits[0]).toMatchObject({ components: [], allowedMentions: { parse: [] } });
  });
});

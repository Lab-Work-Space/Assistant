import type { Message } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { DeptId } from '../core/index.js';
import type { Task } from '../db/repos/index.js';
import { CH, PERSONA, roundTrip } from '../tests/fakes/roundtrip.js';
import { toIncoming, type InboundCtx } from './inbound.js';

const GUILD = '1565649426943442944';
const SW_BOT = '1565000000000000100';
const ctx: InboundCtx = {
  guildId: GUILD, adminRoleId: '1565000000000000001', botUserIds: new Map<string, DeptId>([[SW_BOT, 'software']]), webhooks: new Map(),
  personaByName: () => null,
};
const msg = (content: string, bot: boolean): Message =>
  ({
    id: 'm1', guildId: GUILD, channelId: 'c1', channel: { id: 'c1', isThread: () => false, parentId: 'cat' },
    author: bot ? { id: SW_BOT, username: 'CTO', bot: true, globalName: null } : { id: 'u1', username: 'ann', bot: false, globalName: null },
    member: null, webhookId: null, applicationId: null, content, mentions: { users: new Map() }, attachments: new Map(), embeds: [], system: false, reference: null,
  }) as unknown as Message;

describe('TW8 inbound handles', () => {
  it('a head\'s @handle (outside code) becomes mentionedHeads', () => {
    expect(toIncoming(msg('@CEO and @R&D: `@IT` a@HR.com', true), ctx)?.mentionedHeads).toEqual(['hq', 'rnd']);
  });
  it('a human writing a handle routes nothing (no new human trigger path)', () => {
    expect(toIncoming(msg('@CEO @CTO please', false), ctx)?.mentionedHeads).toEqual([]);
  });
});

describe('TEAMTALK T1 round trip: posted message -> toIncoming -> route() = []', () => {
  const parent = { id: 'p1', owner: { kind: 'head', dept: 'software' }, requester: { kind: 'human', userId: 'u1' }, deptId: 'software', parentId: null, rootId: 'p1', depth: 0, status: 'doing', threadId: CH.thread, channelId: null, origin: 'chat', tainted: false } as unknown as Task;
  const dirty = { title: 'Subtask done', body: 'head of finance finished "review @CFO plan": @CFO says @CEO and @CTO @R&D `@IT` https://x.test/@Ops <@1565000000000000555>', fields: [{ name: '@Sales', value: '@HR' }] };

  it('control: the same text as a model chat post (no noHandles) DOES route to another head (this is F-1)', async () => {
    const r = await roundTrip({ kind: 'head', dept: 'software' }, { channelId: CH.work, threadId: CH.thread }, { type: 'chat', ...dirty }, { task: parent });
    expect(r.routes.length).toBeGreaterThan(0);
  });

  it('H3 from the parent head in the parent thread: zero routes, and the incoming text names no head', async () => {
    const r = await roundTrip({ kind: 'head', dept: 'software' }, { channelId: CH.work, threadId: CH.thread }, { type: 'chat', noHandles: true, ...dirty }, { task: parent });
    expect(r.routes).toEqual([]);
    expect(r.incoming.mentionedHeads).toEqual([]);
  });

  it('a room line from a persona webhook at the room top level: zero routes', async () => {
    const r = await roundTrip({ kind: 'persona', personaId: PERSONA.id }, { channelId: CH.room }, { type: 'chat', noHandles: true, body: '✅ Done: @CFO review: @CEO please @CTO see https://x.test/@IT' });
    expect(r.incoming.author.kind).toBe('persona');
    expect(r.routes).toEqual([]);
  });

  it('the governance task card (title, description, Done when) with handles: zero routes', async () => {
    const r = await roundTrip({ kind: 'head', dept: 'software' }, { channelId: CH.work, threadId: CH.thread }, {
      type: 'task', origin: 'governance', title: '@CFO plan', body: 'ask @CTO', fields: [{ name: 'Done when', value: '@CEO agrees' }, { name: 'Owner', value: 'head of software' }],
    }, { task: parent });
    expect(r.routes).toEqual([]);
  });
});

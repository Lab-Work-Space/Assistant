import type { Message } from 'discord.js';
import { describe, expect, it } from 'vitest';
import type { DeptId } from '../core/index.js';
import { historyTaints } from '../agents/context.js';
import { completeChannel, createInboundMapper, EMBED_TEXT_MAX, toIncoming, type InboundCtx } from './inbound.js';
import { route } from '../company/router.js';

const GUILD = '1565649426943442944';
const ADMIN_ROLE = '1565000000000000001';
const SW_BOT = '1565000000000000100';
const SW_APP = '1565000000000000100';
const PERSONA_HOOK = '1565000000000000200';

const ctx: InboundCtx = {
  guildId: GUILD,
  adminRoleId: ADMIN_ROLE,
  botUserIds: new Map<string, DeptId>([[SW_BOT, 'software']]),
  webhooks: new Map([[PERSONA_HOOK, { applicationId: SW_APP, deptId: 'software' as DeptId }]]),
  personaByName: (dept, name) => (dept === 'software' && name === 'System Analyst' ? 'system-analyst' : null),
};

type FakeMsg = {
  id?: string; guildId?: string | null; channelId?: string; thread?: { parentId: string } | null;
  author?: { id: string; username: string; bot?: boolean; globalName?: string | null };
  roles?: string[]; displayName?: string; noMember?: boolean;
  webhookId?: string | null; applicationId?: string | null; content?: string; mentions?: string[];
  attachments?: { id: string; name: string; url: string; size: number }[];
  system?: boolean; replyTo?: string; replyGuild?: string; replyChannel?: string; repliedUser?: string; everyone?: boolean;
  forward?: { channelId: string; messageId: string; text: string; attachments?: { id: string; name: string; url: string; size: number; contentType?: string }[] };
  embeds?: { title?: string | null; description?: string | null; fields?: { name: string; value: string }[] }[];
};

function fake(o: FakeMsg = {}): Message {
  const channelId = o.channelId ?? 'ch-sw';
  return {
    id: o.id ?? 'm1',
    guildId: o.guildId === undefined ? GUILD : o.guildId,
    channelId,
    channel: o.thread ? { id: channelId, isThread: () => true, parentId: o.thread.parentId } : { id: channelId, isThread: () => false, parentId: 'cat-1' },
    author: { bot: false, globalName: null, ...(o.author ?? { id: 'u1', username: 'ann' }) },
    member: o.noMember ? null : { displayName: o.displayName ?? 'Ann', roles: { cache: new Map((o.roles ?? []).map((r) => [r, { id: r, name: r === ADMIN_ROLE ? 'Bot Admin' : 'Other' }])) } },
    webhookId: o.webhookId ?? null,
    applicationId: o.applicationId ?? null,
    content: o.content ?? 'hello',
    mentions: { users: new Map((o.mentions ?? []).map((id) => [id, { id }])), repliedUser: o.repliedUser ? { id: o.repliedUser } : null, everyone: o.everyone ?? false, roles: new Map() },
    attachments: new Map((o.attachments ?? []).map((a) => [a.id, a])),
    embeds: o.embeds ?? [],
    system: o.system ?? false,
    reference: o.forward ? { type: 1, guildId: GUILD, channelId: o.forward.channelId, messageId: o.forward.messageId } : o.replyTo ? { type: 0, messageId: o.replyTo, guildId: o.replyGuild ?? GUILD, channelId: o.replyChannel ?? channelId } : null,
    messageSnapshots: { first: () => (o.forward ? { content: o.forward.text, embeds: [], attachments: new Map((o.forward.attachments ?? []).map((a) => [a.id, a])) } : undefined) },
  } as unknown as Message;
}

const HQ_BOT = '1565000000000000101';
const ctxHq: InboundCtx = { ...ctx, botUserIds: new Map<string, DeptId>([[SW_BOT, 'software'], [HQ_BOT, 'hq']]) };

describe('toIncoming embed content (R30)', () => {
  const embeds = [
    { title: 'Plan', description: `<@${HQ_BOT}> please review`, fields: [{ name: 'Owner', value: 'cto' }] },
    { description: 'part two', fields: [] },
  ];

  it('a head bot post with empty content reads its embeds as content', () => {
    const m = toIncoming(fake({ noMember: true, content: '', embeds, author: { id: SW_BOT, username: 'CTO', bot: true } }), ctxHq);
    expect(m?.content).toBe(`Plan\n<@${HQ_BOT}> please review\nOwner: cto\npart two`);
  });

  it('head mentions inside embed text become mentionedHeads', () => {
    const m = toIncoming(fake({ noMember: true, content: '', embeds, author: { id: SW_BOT, username: 'CTO', bot: true } }), ctxHq);
    expect(m?.mentionedHeads).toEqual(['hq']);
  });

  it('a persona webhook post reads its embeds as content', () => {
    const m = toIncoming(
      fake({ webhookId: PERSONA_HOOK, applicationId: SW_APP, noMember: true, content: '', embeds: [{ title: 'Spec', description: 'done' }], author: { id: PERSONA_HOOK, username: 'System Analyst', bot: true } }),
      ctx,
    );
    expect(m?.author.kind).toBe('persona');
    expect(m?.content).toBe('Spec\ndone');
  });

  it('a governance ping keeps its content and still adds the embed text', () => {
    const m = toIncoming(fake({ noMember: true, content: '<@&1565000000000000001>', embeds: [{ description: 'Budget used up' }], author: { id: HQ_BOT, username: 'CEO', bot: true } }), ctxHq);
    expect(m?.content).toBe('<@&1565000000000000001>\nBudget used up');
  });

  it('derived content is capped at 8000 chars', () => {
    const big = Array.from({ length: 3 }, () => ({ description: 'x'.repeat(4096) }));
    const m = toIncoming(fake({ noMember: true, content: '', embeds: big, author: { id: SW_BOT, username: 'CTO', bot: true } }), ctxHq);
    expect(m!.content.length).toBe(8000);
  });

  it('the 8000-char cut never splits a surrogate pair', () => {
    const m = toIncoming(fake({ noMember: true, content: '', embeds: [{ description: 'x'.repeat(7999) + '😀😀' }], author: { id: SW_BOT, username: 'CTO', bot: true } }), ctxHq);
    expect(m!.content).toBe('x'.repeat(7999));
    expect(m!.content).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('a head answering in plain content routes the <@id> markup it wrote, even with allowedMentions empty', () => {
    const m = toIncoming(fake({ noMember: true, content: `<@${HQ_BOT}> please summarise`, embeds: [], author: { id: SW_BOT, username: 'CTO', bot: true } }), ctxHq);
    expect(m?.content).toBe(`<@${HQ_BOT}> please summarise`);
    expect(m?.mentionedHeads).toContain('hq');
  });

  it('humans keep their own content and embeds are ignored', () => {
    const m = toIncoming(fake({ content: 'hi', embeds: [{ description: `<@${HQ_BOT}> link preview` }] }), ctxHq);
    expect(m?.content).toBe('hi');
    expect(m?.mentionedHeads).toEqual([]);
  });
});

describe('toIncoming', () => {
  it('webhook id of persona maps author kind persona', () => {
    const m = toIncoming(fake({ webhookId: PERSONA_HOOK, applicationId: SW_APP, noMember: true, author: { id: PERSONA_HOOK, username: 'System Analyst', bot: true } }), ctx);
    expect(m?.author).toEqual({ id: PERSONA_HOOK, name: 'System Analyst', kind: 'persona', actor: { kind: 'persona', personaId: 'system-analyst' } });
    expect(m?.isAdmin).toBe(false);
  });

  it('author in botUserIds maps to head', () => {
    const m = toIncoming(fake({ noMember: true, author: { id: SW_BOT, username: 'Software Head', bot: true } }), ctx);
    expect(m?.author.kind).toBe('head');
    expect(m?.author.actor).toEqual({ kind: 'head', dept: 'software' });
  });

  it('unknown bot is foreign_bot', () => {
    const m = toIncoming(fake({ author: { id: '999', username: 'OtherBot', bot: true } }), ctx);
    expect(m?.author.kind).toBe('foreign_bot');
    expect(m?.author.actor).toBeUndefined();
  });

  it('member with Bot Admin role sets isAdmin', () => {
    expect(toIncoming(fake({ roles: [ADMIN_ROLE] }), ctx)?.isAdmin).toBe(true);
    expect(toIncoming(fake({ roles: [] }), ctx)?.isAdmin).toBe(false);
  });

  it('T13: the live member role ids travel with a human message; a bot, a webhook, a missing member and a system message carry none', () => {
    expect(toIncoming(fake({ roles: ['r1', 'r2'] }), ctx)?.memberRoleIds).toEqual(['r1', 'r2']);
    expect(toIncoming(fake({ noMember: true }), ctx)).not.toHaveProperty('memberRoleIds');
    expect(toIncoming(fake({ roles: ['r1'], system: true }), ctx)).not.toHaveProperty('memberRoleIds');
    expect(toIncoming(fake({ noMember: true, author: { id: SW_BOT, username: 'Software Head', bot: true } }), ctx)).not.toHaveProperty('memberRoleIds');
    expect(toIncoming(fake({ roles: ['r1'], author: { id: '999', username: 'OtherBot', bot: true } }), ctx)).not.toHaveProperty('memberRoleIds');
  });

  it('RF1: a forward carries no replyToId, keeps the snapshot apart from content and mentions, and is capped', () => {
    const m = toIncoming(fake({ content: '', forward: { channelId: '700000000000000009', messageId: '700000000000000008', text: `@CTO <@${SW_BOT}> ${'x'.repeat(9000)}` } }), ctx)!;
    expect(m).not.toHaveProperty('replyToId');
    expect(m.content).toBe('');
    expect(m.mentionedHeads).toEqual([]);
    expect(m.attachments).toEqual([]);
    expect(m.forward?.sourceChannelId).toBe('700000000000000009');
    expect(m.forward!.text.length).toBeLessThanOrEqual(EMBED_TEXT_MAX);
  });
  it('RF13: a forward snapshot\'s attachment objects ride on forward.attachments, never on attachments, and are capped at 10', () => {
    const atts = Array.from({ length: 12 }, (_, i) => ({ id: `a${i}`, name: `p${i}.png`, url: `https://cdn.discordapp.com/attachments/1/2/p${i}.png`, size: 5, contentType: 'image/png' }));
    const m = toIncoming(fake({ content: '', forward: { channelId: '700000000000000009', messageId: '700000000000000008', text: 't', attachments: atts } }), ctx)!;
    expect(m.attachments).toEqual([]);
    expect(m.forward).toMatchObject({ attachmentCount: 12 });
    expect(m.forward!.attachments).toHaveLength(10);
    expect(m.forward!.attachments![0]).toEqual({ name: 'p0.png', url: atts[0]!.url, size: 5, contentType: 'image/png' });
  });
  it('RF1: a reply to a message in another channel or guild is not a reply', () => {
    expect(toIncoming(fake({ replyTo: '700000000000000002', replyChannel: 'other' }), ctx)).not.toHaveProperty('replyToId');
    expect(toIncoming(fake({ replyTo: '700000000000000002', replyGuild: 'g2' }), ctx)).not.toHaveProperty('replyToId');
  });
  it('RF7: a forward from another guild has no source channel', () => {
    const f = fake({ content: '', forward: { channelId: '700000000000000009', messageId: '700000000000000008', text: 't' } });
    (f.reference as { guildId: string }).guildId = 'g2';
    expect(toIncoming(f, ctx)?.forward?.sourceChannelId).toBeNull();
  });
  it('VULN-006: repliedDept names our bot that wrote the replied-to message; a human or unknown author sets none', () => {
    expect(toIncoming(fake({ replyTo: '700000000000000002', repliedUser: SW_BOT }), ctx)!.repliedDept).toBe('software');
    expect(toIncoming(fake({ replyTo: '700000000000000002', repliedUser: 'u2' }), ctx)).not.toHaveProperty('repliedDept');
    expect(toIncoming(fake({}), ctx)).not.toHaveProperty('repliedDept');
  });
  it('P1-B: the implicit reply ping is not a mention, but a typed mention is; other mentions are flagged', () => {
    const typed = toIncoming(fake({ replyTo: '700000000000000002', mentions: [SW_BOT], repliedUser: SW_BOT, content: `<@${SW_BOT}> hi` }), ctx)!;
    expect(typed.mentionedHeads).toEqual(['software']);
    const ping = toIncoming(fake({ replyTo: '700000000000000002', mentions: [SW_BOT], repliedUser: SW_BOT }), ctx)!;
    expect(ping.mentionedHeads).toEqual([]);
    expect(ping).not.toHaveProperty('otherMentions');
    const pingHuman = toIncoming(fake({ replyTo: '700000000000000002', mentions: ['u2'], repliedUser: 'u2' }), ctx)!;
    expect(pingHuman).not.toHaveProperty('otherMentions');
    expect(toIncoming(fake({ mentions: ['u2'], content: '<@u2> hi' }), ctx)?.otherMentions).toBe(true);
    expect(toIncoming(fake({ everyone: true }), ctx)?.otherMentions).toBe(true);
    expect(toIncoming(fake({ mentions: [SW_BOT] }), ctx)).not.toHaveProperty('otherMentions');
  });
  it('T15: a Discord reply carries the replied-to message id', () => {
    expect(toIncoming(fake({ replyTo: '700000000000000002' }), ctx)?.replyToId).toBe('700000000000000002');
    expect(toIncoming(fake({}), ctx)).not.toHaveProperty('replyToId');
  });

  it('role named Bot Admin with other id is not admin', () => {
    const m = fake();
    (m as unknown as { member: { roles: { cache: Map<string, unknown> } } }).member.roles.cache = new Map([['1565000000000000999', { id: '1565000000000000999', name: 'Bot Admin' }]]);
    expect(toIncoming(m, ctx)?.isAdmin).toBe(false);
  });

  it('thread message carries parentChannelId', () => {
    const m = toIncoming(fake({ channelId: 'th-1', thread: { parentId: 'ch-sw' } }), ctx);
    expect(m).toMatchObject({ channelId: 'th-1', threadId: 'th-1', parentChannelId: 'ch-sw' });
    const top = toIncoming(fake({ channelId: 'ch-sw' }), ctx);
    expect(top).toMatchObject({ channelId: 'ch-sw', threadId: null, parentChannelId: null });
  });

  it('human-created webhook named system-analyst is not a persona', () => {
    const m = toIncoming(fake({ webhookId: '1565000000000000777', applicationId: null, noMember: true, author: { id: '1565000000000000777', username: 'System Analyst', bot: true } }), ctx);
    expect(m?.author.kind).toBe('foreign_bot');
    expect(m?.author.actor).toBeUndefined();
  });

  it('G2-04: a webhook posing under the trigger user\'s display name is foreign_bot and taints the run', async () => {
    const user = toIncoming(fake({ id: 'm-user', author: { id: '42', username: 'owner', bot: false } }), ctx)!;
    const hook = toIncoming(fake({ id: 'm-hook', webhookId: '1565000000000000777', applicationId: null, noMember: true, author: { id: '1565000000000000777', username: 'owner', bot: true } }), ctx)!;
    expect(hook.author).toMatchObject({ kind: 'foreign_bot', name: 'owner' });
    expect(await historyTaints([hook], { exclude: user.id, own: user.author.id })).toBe(true);
  });

  it('webhook with foreign applicationId is foreign_bot', () => {
    const m = toIncoming(fake({ webhookId: PERSONA_HOOK, applicationId: '1565000000000000888', noMember: true, author: { id: PERSONA_HOOK, username: 'System Analyst', bot: true } }), ctx);
    expect(m?.author.kind).toBe('foreign_bot');
  });

  it('our webhook with a name that is no persona of its dept is foreign_bot', () => {
    const m = toIncoming(fake({ webhookId: PERSONA_HOOK, applicationId: SW_APP, noMember: true, author: { id: PERSONA_HOOK, username: 'CEO', bot: true } }), ctx);
    expect(m?.author.kind).toBe('foreign_bot');
  });

  it('message from another guild or a DM is dropped', () => {
    expect(toIncoming(fake({ guildId: '1565649426943442000' }), ctx)).toBeNull();
    expect(toIncoming(fake({ guildId: null }), ctx)).toBeNull();
  });

  it('maps mentioned head bots, attachments and human display name', () => {
    const m = toIncoming(fake({ mentions: [SW_BOT, 'u2'], content: `<@${SW_BOT}> hi`, attachments: [{ id: 'a1', name: 'x.txt', url: 'https://cdn/x.txt', size: 3 }] }), ctx);
    expect(m).toMatchObject({ mentionedHeads: ['software'], content: `<@${SW_BOT}> hi`, attachments: [{ name: 'x.txt', url: 'https://cdn/x.txt', size: 3 }] });
    expect(m?.author).toEqual({ id: 'u1', name: 'Ann', kind: 'human' });
  });

  it('mapper resolves a persisted persona webhook after a restart', async () => {
    const looked: string[] = [];
    const map = createInboundMapper({
      guildId: GUILD, adminRoleId: ADMIN_ROLE, botUserIds: () => ctx.botUserIds,
      webhooks: { lookup: async (id) => { looked.push(id); return id === PERSONA_HOOK ? { applicationId: SW_APP, deptId: 'software' } : null; } },
      org: { personaByName: (d, n) => (d === 'software' && n === 'System Analyst' ? { id: 'system-analyst' } : null) },
    });
    const ours = await map(fake({ webhookId: PERSONA_HOOK, applicationId: SW_APP, noMember: true, author: { id: PERSONA_HOOK, username: 'System Analyst', bot: true } }));
    expect(ours?.author.actor).toEqual({ kind: 'persona', personaId: 'system-analyst' });
    const stranger = await map(fake({ webhookId: '1565000000000000777', applicationId: SW_APP, noMember: true, author: { id: '1565000000000000777', username: 'System Analyst', bot: true } }));
    expect(stranger?.author.kind).toBe('foreign_bot');
    expect(await map(fake({ guildId: '1' }))).toBeNull();
    expect(looked).toEqual([PERSONA_HOOK, '1565000000000000777']);
  });
});

describe('P16e old bot', () => {
  const OLD_BOT = '1565000000000000999';
  const PRAW_BOT = '1565000000000000300';

  it('old bot message is foreign_bot, never triggers praw or counts as a human requester', async () => {
    const praw: InboundCtx = { ...ctx, botUserIds: new Map<string, DeptId>([[SW_BOT, 'software'], [PRAW_BOT, 'praw']]) };
    const m = toIncoming(fake({ author: { id: OLD_BOT, username: 'น้องพราว (old)', bot: true }, noMember: true, mentions: [PRAW_BOT], content: `<@${PRAW_BOT}> hi` }), praw)!;
    expect(m.author).toEqual({ id: OLD_BOT, name: expect.any(String), kind: 'foreign_bot' });
    expect(m.isAdmin).toBe(false);
    const { route } = await import('../company/router.js');
    const org = { dept: () => ({ enabled: true }), persona: () => null, personaByDirectChannel: () => null, deptByChannel: () => 'praw' } as never;
    expect(await route(m, { org, taskByThread: async () => null })).toEqual([]);
  });
});


describe('TW11 partial channels fail closed', () => {
  const deps = { guildId: GUILD, adminRoleId: ADMIN_ROLE, botUserIds: () => new Map<string, DeptId>(), webhooks: { lookup: async () => null }, org: { personaByName: () => null } };
  type Ch = { id: string; partial: boolean; parentId: string | null; isThread: () => boolean; fetch: () => Promise<unknown> };
  /** A message whose channel is a partial thread; `fetch` fills in the parent (as discord.js does through the cache) or throws. */
  function partial(parent: string | null, fetch: 'fills' | 'throws' | 'stays', over: Partial<Message> = {}) {
    const ch: Ch = {
      id: 'th1', partial: true, parentId: null, isThread: () => true,
      fetch: async () => {
        if (fetch === 'throws') throw new Error('Missing Access');
        if (fetch === 'fills') { ch.partial = false; ch.parentId = parent; }
        return ch;
      },
    };
    const m = fake({ channelId: 'th1', thread: { parentId: 'x' }, content: 'do the thing' });
    return { m: Object.assign(m, { channel: ch }, over) as Message, ch };
  }

  it('toIncoming refuses a thread without a parent and any partial channel', () => {
    expect(toIncoming(partial(null, 'stays').m, ctx)).toBeNull();
    const noParent = fake({ channelId: 'th1', thread: { parentId: '' } });
    (noParent.channel as unknown as { parentId: string | null }).parentId = null;
    expect(toIncoming(noParent, ctx)).toBeNull();
  });

  it('fetches the partial thread first and maps it with its parent', async () => {
    const { m, ch } = partial('ch-sw', 'fills');
    const inc = await createInboundMapper(deps)(m);
    expect(ch.partial).toBe(false);
    expect(inc).toMatchObject({ threadId: 'th1', parentChannelId: 'ch-sw' });
  });

  it('drops the message when the fetch fails, and logs no content', async () => {
    const logs: object[] = [];
    const { m } = partial('ch-sw', 'throws');
    expect(await createInboundMapper({ ...deps, log: { debug: (o) => void logs.push(o) } })(m)).toBeNull();
    expect(JSON.stringify(logs)).not.toContain('do the thing');
    expect(logs).toHaveLength(1);
  });

  it('drops the message when the parent is still unknown after the fetch', async () => {
    expect(await createInboundMapper(deps)(partial('ch-sw', 'stays').m)).toBeNull();
    expect(await completeChannel(partial('ch-sw', 'stays').m)).toBe(false);
  });

  it('a partial thread under a DENIED channel is dropped (fetch fails) or routed to nothing (fetch shows the denied parent)', async () => {
    const DENIED = '1565715069969502310';
    expect(await createInboundMapper(deps)(partial(DENIED, 'throws').m)).toBeNull();
    const inc = await createInboundMapper(deps)(partial(DENIED, 'fills').m);
    expect(inc).not.toBeNull();
    const org = { dept: () => ({ id: 'software', enabled: true }), persona: () => null, personasOf: () => [], deptOfChannel: () => 'software' as DeptId, personaByDirectChannel: () => null };
    expect(await route({ ...inc!, mentionedHeads: ['software'] }, { org, taskByThread: async () => null })).toEqual([]);
  });

  it('a partial warroom thread with a human mention routes nowhere', async () => {
    const WARROOM = '1566366032094961705';
    const org = { dept: () => ({ id: 'software', enabled: true }), persona: () => null, personasOf: () => [], deptOfChannel: () => null, personaByDirectChannel: () => null };
    const inc = await createInboundMapper(deps)(partial(WARROOM, 'fills').m);
    expect(await route({ ...inc!, mentionedHeads: ['software'] }, { org, taskByThread: async () => null })).toEqual([]);
    expect(await createInboundMapper(deps)(partial(WARROOM, 'throws').m)).toBeNull();
  });
});

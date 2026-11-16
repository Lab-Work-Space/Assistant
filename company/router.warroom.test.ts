import { describe, expect, it } from 'vitest';
import { AI_WARROOM_CHANNEL_ID } from './channels.js';
import { route, type RouterCtx } from './router.js';
import type { ActorRef, IncomingMessage } from './types.js';
import { seededOrg, humanMsg } from '../agents/test-helpers.js';
import type { Task } from '../db/repos/tasks.js';

const HQ: ActorRef = { kind: 'head', dept: 'hq' };
const CTO: ActorRef = { kind: 'head', dept: 'software' };
const SA: ActorRef = { kind: 'persona', personaId: 'system-analyst' };

const bot = (from: ActorRef, mentioned: string[], over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: `m-${Math.random()}`, channelId: AI_WARROOM_CHANNEL_ID, parentChannelId: null, threadId: null,
  author: { id: 'b1', name: 'bot', kind: 'head', actor: from }, content: 'x', mentionedHeads: mentioned as never, isAdmin: false, attachments: [], origin: 'chat', ...over,
});
const inThread = (from: ActorRef, mentioned: string[]) => bot(from, mentioned, { channelId: 'th-1', parentChannelId: AI_WARROOM_CHANNEL_ID, threadId: 'th-1' });

async function ctx(over: Partial<RouterCtx> = {}, task: Task | null = null): Promise<RouterCtx> {
  return { org: await seededOrg(), taskByThread: async () => task, ...over };
}
const actors = (rs: { actor: ActorRef }[]) => rs.map((r) => (r.actor.kind === 'head' ? r.actor.dept : r.actor.personaId));

describe('warroom routing (Teamwork C)', () => {
  it('a head mention in the warroom routes to the mentioned head, at the top level and in a thread', async () => {
    expect(actors(await route(bot(HQ, ['software']), await ctx()))).toEqual(['software']);
    expect(actors(await route(inThread(HQ, ['software']), await ctx()))).toEqual(['software']);
  });

  it('TW2: at most 3 mentions per post (the CEO 5), counted after de-duplication and never the author', async () => {
    const many = ['software', 'rnd', 'it', 'sales', 'hr', 'ops'];
    expect(await route(bot(CTO, ['rnd', 'it', 'sales', 'hr', 'ops']), await ctx())).toHaveLength(3);
    expect(await route(bot(HQ, many), await ctx())).toHaveLength(5);
    expect(actors(await route(bot(CTO, ['rnd', 'rnd', 'software', 'it']), await ctx()))).toEqual(['rnd', 'it']);
  });

  it('a top-level post with no mention routes to no one; a thread post goes to the ONE continuation target', async () => {
    expect(await route(bot(HQ, []), await ctx({ continuation: () => CTO }))).toEqual([]);
    expect(actors(await route(inThread(HQ, []), await ctx({ continuation: () => CTO })))).toEqual(['software']);
    expect(await route(inThread(HQ, []), await ctx())).toEqual([]);
    expect(actors(await route(inThread(HQ, ['rnd']), await ctx({ continuation: () => CTO })))).toEqual(['rnd']); // a mention wins; no extra target
  });

  it('a human in the warroom commands no one; a persona is not routed in the warroom', async () => {
    expect(await route(humanMsg('<@1> hi', { channelId: AI_WARROOM_CHANNEL_ID, mentionedHeads: ['software'] }), await ctx())).toEqual([]);
    expect(await route(bot(SA, ['software']), await ctx())).toEqual([{ actor: CTO, reason: 'warroom' }]);
  });

  it('W2: a bot head mention routes in a department room and in a thread under it (the scheduler guard bounds it); no mention = no route', async () => {
    const m = bot(HQ, ['software'], { channelId: '1565682159375749161' });
    expect(actors(await route(m, await ctx()))).toEqual(['software']);
    expect(actors(await route({ ...m, channelId: 'th-9', threadId: 'th-9', parentChannelId: '1565682159375749161' }, await ctx()))).toEqual(['software']);
    expect(await route({ ...m, mentionedHeads: [] }, await ctx())).toEqual([]);
  });
});

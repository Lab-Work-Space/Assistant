import { describe, expect, it } from 'vitest';
import { route, type RouterOrg } from './router.js';
import type { ActorRef, IncomingMessage } from './types.js';
import type { Task } from '../db/repos/tasks.js';

const CH = { opsGeneral: 'ch-ops', swWork: 'ch-sw', saDirect: 'ch-sa-direct', credentials: '1565715069969502310' };
const depts = [
  { id: 'ops', enabled: true, workChannelId: CH.opsGeneral },
  { id: 'software', enabled: true, workChannelId: CH.swWork },
  { id: 'hr', enabled: false, workChannelId: 'ch-hr' },
  { id: 'hq', enabled: true, workChannelId: 'ch-hq' },
  { id: 'praw', enabled: true, workChannelId: null },
];
/** channel_map: a channel an admin mapped to a department (`/channel map`). */
const MAPPED = { 'ch-praw-map': 'praw', 'forum-sw': 'software' } as Record<string, string>;
const personas = [
  { id: 'system-analyst', deptId: 'software', name: 'System Analyst', directChannelId: CH.saDirect, enabled: true },
  { id: 'dba', deptId: 'software', name: 'DBA', directChannelId: null, enabled: false },
  { id: 'recruiter', deptId: 'hr', name: 'Recruiter', directChannelId: 'ch-rec', enabled: true },
  { id: 'ops-clerk', deptId: 'ops', name: 'Clerk', directChannelId: null, enabled: true },
];
const org: RouterOrg = {
  dept: (id) => depts.find((d) => d.id === id) ?? null,
  persona: (id) => personas.find((p) => p.id === id) ?? null,
  personasOf: (d) => personas.filter((p) => p.deptId === d),
  deptOfChannel: (c) =>
    (MAPPED[c] as never) ??
    ((depts.find((d) => d.workChannelId === c)?.id ?? personas.find((p) => p.directChannelId === c)?.deptId) as never) ?? null,
  personaByDirectChannel: (c) => personas.find((p) => p.directChannelId === c) ?? null,
};

const human = { id: 'u1', name: 'Ann', kind: 'human' as const };
const msg = (o: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: 'm1', channelId: CH.opsGeneral, parentChannelId: null, threadId: null, author: human,
  content: 'hello', mentionedHeads: [], isAdmin: false, attachments: [], origin: 'chat', ...o,
});
const task = (o: Partial<Task> = {}): Task => ({
  id: 't1', title: 't', description: '', deptId: 'software', owner: { kind: 'head', dept: 'software' },
  requester: { kind: 'human', userId: 'u1' }, parentId: null, rootId: 't1', depth: 0, status: 'doing',
  threadId: 'th1', turnsUsed: 0, costUsd: 0, estCostUsd: null, blockedReason: null, origin: 'chat', channelId: null, sourceUserId: null, tainted: false, ...o,
});
const run = (m: IncomingMessage, t: Task | null = null) => route(m, { org, taskByThread: async () => t });
const actors = (r: { actor: ActorRef }[]) => r.map((x) => x.actor);
const head = (d: string) => ({ kind: 'head', dept: d }) as ActorRef;
const persona = (p: string) => ({ kind: 'persona', personaId: p }) as ActorRef;
const botHead = (d: string) => ({ id: `bot-${d}`, name: d, kind: 'head' as const, actor: head(d) });

const GOALS_TEXT = '1565651009076985956';
const GOALS_FORUM = '1565652418383847514';

describe('router goal channels (R29)', () => {
  it('human post in #🎯-company-goals routes to the CEO as a goal', async () => {
    expect(await run(msg({ channelId: GOALS_TEXT }))).toEqual([{ actor: head('hq'), reason: 'goal_channel' }]);
  });
  it('the starter post of a goals forum thread routes to the CEO as a goal', async () => {
    const r = await run(msg({ id: 'th-g', channelId: 'th-g', threadId: 'th-g', parentChannelId: GOALS_FORUM }));
    expect(r).toEqual([{ actor: head('hq'), reason: 'goal_channel' }]);
  });
  it('a reply inside a goals forum thread is not a new goal', async () => {
    const r = await run(msg({ id: 'm9', channelId: 'th-g', threadId: 'th-g', parentChannelId: GOALS_FORUM }));
    expect(r.filter((x) => x.reason === 'goal_channel')).toEqual([]);
  });
  it('a bot post in the goals channel is not a goal', async () => {
    expect(await run(msg({ channelId: GOALS_TEXT, author: botHead('software') }))).toEqual([]);
  });
  it('@CTO in the goals channel goes to the CTO only', async () => {
    expect(actors(await run(msg({ channelId: GOALS_TEXT, mentionedHeads: ['software'] })))).toEqual([head('software')]);
  });
  it('a disabled hq routes no goal', async () => {
    const off: RouterOrg = { ...org, dept: (id) => (id === 'hq' ? { id: 'hq', enabled: false } : org.dept(id)) };
    expect(await route(msg({ channelId: GOALS_TEXT }), { org: off, taskByThread: async () => null })).toEqual([]);
  });
});

describe('router', () => {
  it('human in #💬-ops-general without mention routes to ops head', async () => {
    expect(await run(msg())).toEqual([{ actor: head('ops'), reason: 'dept_channel' }]);
  });
  it('@CTO system-analyst in the persona direct room routes to persona system-analyst', async () => {
    const r = await run(msg({ channelId: CH.saDirect, content: '<@123> system-analyst draft a spec', mentionedHeads: ['software'] }));
    expect(r).toEqual([{ actor: persona('system-analyst'), reason: 'persona_mention' }]);
  });
  it('persona selected by display name, case-insensitive', async () => {
    const r = await run(msg({ channelId: CH.saDirect, content: '<@!123>   System Analyst please', mentionedHeads: ['software'] }));
    expect(actors(r)).toEqual([persona('system-analyst')]);
  });
  it('persona of another department is not selectable via a head mention', async () => {
    const r = await run(msg({ channelId: CH.swWork, content: '<@123> recruiter hi', mentionedHeads: ['software'] }));
    expect(r).toEqual([{ actor: head('software'), reason: 'mention' }]);
  });
  it('disabled persona and disabled department are never routed to', async () => {
    expect(actors(await run(msg({ channelId: CH.swWork, content: '<@123> dba x', mentionedHeads: ['software'] })))).toEqual([head('software')]);
    expect(await run(msg({ channelId: 'ch-hr' }))).toEqual([]);
    expect(await run(msg({ channelId: 'ch-rec' }))).toEqual([]);
    expect(await run(msg({ mentionedHeads: ['hr'] }))).toEqual([]);
  });
  it('human in persona direct channel routes to that persona only', async () => {
    expect(await run(msg({ channelId: CH.saDirect }))).toEqual([{ actor: persona('system-analyst'), reason: 'direct_channel' }]);
  });
  it('bot message in dept channel without mention routes nowhere', async () => {
    expect(await run(msg({ author: botHead('software') }))).toEqual([]);
  });
  it('W2: a bot head mentioning another head in a department channel routes to it, never to itself', async () => {
    const m = msg({ author: botHead('software'), mentionedHeads: ['ops', 'software'] });
    expect(await run(m)).toEqual([{ actor: head('ops'), reason: 'mention' }]);
  });
  it('W2: a bot head mention in a thread with no task routes too', async () => {
    const m = msg({ channelId: 'th9', parentChannelId: CH.opsGeneral, threadId: 'th9', author: botHead('software'), mentionedHeads: ['ops'] });
    expect(await run(m, null)).toEqual([{ actor: head('ops'), reason: 'mention' }]);
  });
  it('R31: bot head mentioning another head inside a task thread reaches it with the task, never itself', async () => {
    const m = msg({ channelId: 'th1', parentChannelId: CH.swWork, threadId: 'th1', author: botHead('software'), mentionedHeads: ['ops', 'software'] });
    expect(await run(m, task({ requester: head('ops') }))).toEqual([{ actor: head('ops'), reason: 'mention', taskId: 't1' }]);
  });
  it('R31: a human mention outside a thread is unchanged', async () => {
    expect(actors(await run(msg({ mentionedHeads: ['software'] })))).toEqual([head('software')]);
  });
  it('webhook message from persona is attributed to persona and does not trigger other bots', async () => {
    const author = { id: 'wh1', name: 'System Analyst', kind: 'persona' as const, actor: persona('system-analyst') };
    expect(await run(msg({ channelId: CH.swWork, author }))).toEqual([]);
    expect(await run(msg({ channelId: CH.saDirect, author }))).toEqual([]);
  });
  it('W2: a persona mentioning a head reaches it anywhere (the guard bounds it)', async () => {
    const author = { id: 'wh1', name: 'System Analyst', kind: 'persona' as const, actor: persona('system-analyst') };
    expect(actors(await run(msg({ author, mentionedHeads: ['ops'] })))).toEqual([head('ops')]);
    const inThread = msg({ channelId: 'th1', parentChannelId: CH.swWork, threadId: 'th1', author, mentionedHeads: ['ops'] });
    expect(actors(await run(inThread, task({ owner: persona('system-analyst'), requester: head('software') })))).toEqual([head('ops')]);
  });
  it('human reply in task thread routes to task owner', async () => {
    const m = msg({ channelId: 'th1', parentChannelId: CH.swWork, threadId: 'th1' });
    expect(await run(m, task())).toEqual([{ actor: head('software'), reason: 'task_owner', taskId: 't1' }]);
  });
  it('task owner persona gets thread reply; no duplicate with mention', async () => {
    const t = task({ owner: persona('system-analyst') });
    const m = msg({ channelId: 'th1', parentChannelId: CH.saDirect, threadId: 'th1', content: '<@123> system-analyst', mentionedHeads: ['software'] });
    const r = await run(m, t);
    expect(actors(r)).toEqual([persona('system-analyst')]);
  });
  it('a persona-owned task thread outside the persona direct room does not route to the persona', async () => {
    const m = msg({ channelId: 'th1', parentChannelId: CH.swWork, threadId: 'th1' });
    expect(await run(m, task({ owner: persona('system-analyst') }))).toEqual([]);
  });
  it('owner replying in own task thread is not routed to itself', async () => {
    const m = msg({ channelId: 'th1', parentChannelId: CH.swWork, threadId: 'th1', author: botHead('software') });
    expect(await run(m, task({ requester: head('software') }))).toEqual([]);
  });
  it('bot requester reaches task owner in thread; unrelated bot does not', async () => {
    const base = { channelId: 'th1', parentChannelId: CH.swWork, threadId: 'th1' };
    const t = task({ requester: head('ops') });
    expect(actors(await run(msg({ ...base, author: botHead('ops') }), t))).toEqual([head('software')]);
    expect(await run(msg({ ...base, author: botHead('hr') }), t)).toEqual([]);
  });
  it('bot owner replying reaches requester only when mentioned', async () => {
    const base = { channelId: 'th1', parentChannelId: CH.swWork, threadId: 'th1', author: botHead('software') };
    const t = task({ requester: head('ops') });
    expect(await run(msg(base), t)).toEqual([]);
    expect(actors(await run(msg({ ...base, mentionedHeads: ['ops'] }), t))).toEqual([head('ops')]);
  });
  it('thread in dept channel uses parent for department mapping', async () => {
    const m = msg({ channelId: 'th9', parentChannelId: CH.opsGeneral, threadId: 'th9' });
    expect(actors(await run(m))).toEqual([head('ops')]);
  });
  it('foreign bot is ignored', async () => {
    const author = { id: 'x', name: 'x', kind: 'foreign_bot' as const };
    expect(await run(msg({ author, mentionedHeads: ['ops'] }))).toEqual([]);
  });
  it('denied channel and thread of denied parent route nowhere', async () => {
    expect(await run(msg({ channelId: CH.credentials, mentionedHeads: ['ops'] }))).toEqual([]);
    expect(await run(msg({ channelId: 'th', parentChannelId: CH.credentials, threadId: 'th', mentionedHeads: ['ops'] }), task())).toEqual([]);
  });
  it('human post in #📋-tasks routes nowhere', async () => {
    expect(await run(msg({ channelId: '1565671253803794494', mentionedHeads: ['ops'] }))).toEqual([]);
  });
  it('human post in #🔁-direct and #⚙️-setting routes nowhere, also via thread parent', async () => {
    expect(await run(msg({ channelId: '1565671325597700157', mentionedHeads: ['ops'] }))).toEqual([]);
    expect(await run(msg({ channelId: '1565667791938387969', mentionedHeads: ['ops'] }))).toEqual([]);
    expect(await run(msg({ channelId: 'th', parentChannelId: '1565671253803794494', threadId: 'th' }), task())).toEqual([]);
  });
});

describe('router positional persona + fail closed', () => {
  const sw = (content: string) => run(msg({ channelId: CH.swWork, content, mentionedHeads: ['software'] }));
  it('persona must be first token after mention markup', async () => {
    expect(actors(await sw('<@123> please ask the system analyst'))).toEqual([head('software')]);
    expect(actors(await run(msg({ channelId: CH.saDirect, content: '<@1><@!2> system-analyst go', mentionedHeads: ['software'] })))).toEqual([persona('system-analyst')]);
    expect(actors(await sw('<@123> system-analystic go'))).toEqual([head('software')]);
  });
  it('blank persona name is never selected', async () => {
    personas.push({ id: 'blank', deptId: 'software', name: '  ', directChannelId: null, enabled: true });
    try {
      expect(actors(await sw('<@123>  hello'))).toEqual([head('software')]);
    } finally {
      personas.pop();
    }
  });
  it('head/persona author without actor routes nowhere', async () => {
    const author = { id: 'b', name: 'b', kind: 'head' as const };
    expect(await run(msg({ author, mentionedHeads: ['ops'] }))).toEqual([]);
    expect(await run(msg({ author: { ...author, kind: 'persona' as const }, mentionedHeads: ['ops'] }))).toEqual([]);
  });
});

describe('router types', () => {
  it('real Org satisfies RouterOrg', () => {
    const check = (o: import('./org.js').Org): RouterOrg => o;
    expect(check).toBeTypeOf('function');
  });
});

describe('router: offline departments (final #5)', () => {
  const offline = (down: string[]) => (m: IncomingMessage, t: Task | null = null) =>
    route(m, { org, taskByThread: async () => t, online: (d) => !down.includes(d) });
  it('an enabled head whose client is offline gets no route', async () => {
    expect(await offline(['ops'])(msg())).toEqual([]);
    expect(actors(await offline(['ops'])(msg({ mentionedHeads: ['software', 'ops'] })))).toEqual([head('software')]);
  });
  it('a persona of an offline department gets no route', async () => {
    expect(await offline(['software'])(msg({ channelId: CH.saDirect }))).toEqual([]);
  });
  it('without an online predicate every enabled department counts as online', async () => {
    expect(await run(msg())).toEqual([{ actor: head('ops'), reason: 'dept_channel' }]);
  });
});

describe('router: personas stay in their own direct room', () => {
  const say = (channelId: string) => run(msg({ channelId, content: '<@123> system-analyst draft a spec', mentionedHeads: ['software'] }));
  it('naming a persona in another department channel goes to that department head instead', async () => {
    expect(await say(CH.opsGeneral)).toEqual([{ actor: head('software'), reason: 'mention' }]);
  });
  it('naming a persona in a channel of no department goes to the head', async () => {
    expect(await say('ch-unmapped')).toEqual([{ actor: head('software'), reason: 'mention' }]);
  });
  it('naming a persona in its own department work channel goes to the head', async () => {
    expect(await say(CH.swWork)).toEqual([{ actor: head('software'), reason: 'mention' }]);
  });
  it('naming it in its own direct room routes to the persona', async () => {
    expect(await say(CH.saDirect)).toEqual([{ actor: persona('system-analyst'), reason: 'persona_mention' }]);
  });
  it('a persona without a direct room is never routed', async () => {
    expect(await run(msg({ channelId: CH.opsGeneral, content: '<@1> ops-clerk hi', mentionedHeads: ['ops'] }))).toEqual([{ actor: head('ops'), reason: 'mention' }]);
  });
});

describe('router: #💬-ai-warroom and #🧾-bot-log', () => {
  const WAR = '1566366032094961705';
  const LOG = '1566454343820124352';
  it('a human message in the war room routes nowhere, mention or not', async () => {
    expect(await run(msg({ channelId: WAR, mentionedHeads: ['ops'] }))).toEqual([]);
    expect(await run(msg({ channelId: 'th1', parentChannelId: WAR, threadId: 'th1' }, ), task({ channelId: WAR }))).toEqual([]);
  });
  it('a bot requester reporting in a war room task thread still reaches the owner', async () => {
    const m = msg({ channelId: 'th1', parentChannelId: WAR, threadId: 'th1', author: botHead('software') });
    const t = task({ owner: head('ops'), requester: head('software'), channelId: WAR });
    expect(await run(m, t)).toEqual([{ actor: head('ops'), reason: 'task_owner', taskId: 't1' }]);
  });
  it('a bot head mentioning another head inside a war room task thread is routed', async () => {
    const m = msg({ channelId: 'th1', parentChannelId: WAR, threadId: 'th1', author: botHead('software'), mentionedHeads: ['ops'] });
    expect(actors(await run(m, task({ owner: head('software'), requester: head('ops'), channelId: WAR })))).toEqual([head('ops')]);
  });
  it('foreign bots stay ignored in the war room', async () => {
    expect(await run(msg({ channelId: WAR, author: { id: 'x', name: 'x', kind: 'foreign_bot' } }))).toEqual([]);
  });
  it('the bot log channel is never routed, for humans or bots', async () => {
    expect(await run(msg({ channelId: LOG, mentionedHeads: ['ops'] }))).toEqual([]);
    expect(await run(msg({ channelId: LOG, author: botHead('ops'), mentionedHeads: ['software'] }))).toEqual([]);
  });
});

describe('router: Praw (R8, P15)', () => {
  it('human @praw in any channel routes to praw', async () => {
    expect(actors(await run(msg({ channelId: CH.opsGeneral, mentionedHeads: ['praw'] })))).toEqual([head('praw')]);
    expect(actors(await run(msg({ channelId: 'ch-anywhere', mentionedHeads: ['praw'] })))).toEqual([head('praw')]);
  });
  it('human message in a channel mapped to praw routes to praw; unmapped channel does not', async () => {
    expect(actors(await run(msg({ channelId: 'ch-praw-map' })))).toEqual([head('praw')]);
    expect(await run(msg({ channelId: 'ch-unmapped' }))).toEqual([]);
  });
  it('praw mention in a denied channel or its thread routes nowhere', async () => {
    expect(await run(msg({ channelId: CH.credentials, mentionedHeads: ['praw'] }))).toEqual([]);
    expect(await run(msg({ channelId: 'th', parentChannelId: CH.credentials, threadId: 'th', mentionedHeads: ['praw'] }), task())).toEqual([]);
  });
  it('praw mention beside software mention routes both', async () => {
    const r = actors(await run(msg({ channelId: CH.swWork, mentionedHeads: ['praw', 'software'] })));
    expect(r).toHaveLength(2);
    expect(r).toEqual(expect.arrayContaining([head('praw'), head('software')]));
  });
  it('W2: a bot message mentioning praw outside a task thread routes to her', async () => {
    expect(await run(msg({ author: botHead('ops'), mentionedHeads: ['praw'] }))).toEqual([{ actor: head('praw'), reason: 'mention' }]);
  });
});

describe('router forums (Teamwork D)', () => {
  const post = (o: Partial<IncomingMessage> = {}) => msg({ channelId: 'post-1', parentChannelId: 'forum-sw', threadId: 'post-1', ...o });

  it('a human starter post in a mapped forum routes to that department head', async () => {
    expect(await run(post({ id: 'post-1' }))).toEqual([{ actor: head('software'), reason: 'dept_channel' }]);
  });
  it('a human reply in the post routes to the head too', async () => {
    expect(await run(post({ id: 'm9' }))).toEqual([{ actor: head('software'), reason: 'dept_channel' }]);
  });
  it('a reply in a post that has a task goes to the task owner with the task id', async () => {
    const r = await run(post({ id: 'm9' }), task({ threadId: 'post-1', channelId: 'forum-sw' }));
    expect(r).toEqual([{ actor: head('software'), reason: 'task_owner', taskId: 't1' }]);
  });
  it('a follow-up in a goals forum post reaches the goal task (not a new goal)', async () => {
    const goal = task({ deptId: 'hq', owner: head('hq'), threadId: 'gp1', channelId: GOALS_FORUM, origin: 'slash' });
    const r = await run(msg({ id: 'm2', channelId: 'gp1', parentChannelId: GOALS_FORUM, threadId: 'gp1' }), goal);
    expect(r).toEqual([{ actor: head('hq'), reason: 'task_owner', taskId: 't1' }]);
  });
  it('an unmapped forum routes nothing', async () => {
    expect(await run(post({ parentChannelId: 'forum-other' }))).toEqual([]);
  });
  it('TW11: a thread whose parent is unknown (partial channel) routes nothing', async () => {
    expect(await run(msg({ channelId: 'th9', threadId: 'th9', parentChannelId: null, mentionedHeads: ['software'] }))).toEqual([]);
  });
  it('TW11: a human mention inside a warroom thread routes nowhere, with or without the parent', async () => {
    const WARROOM = '1566366032094961705';
    expect(await run(msg({ channelId: 'th9', threadId: 'th9', parentChannelId: WARROOM, mentionedHeads: ['software'] }))).toEqual([]);
    expect(await run(msg({ channelId: 'th9', threadId: 'th9', parentChannelId: null, mentionedHeads: ['software'] }))).toEqual([]);
  });
  it('TW11: a post under a denied channel routes nothing', async () => {
    expect(await run(post({ parentChannelId: CH.credentials, mentionedHeads: ['software'] }))).toEqual([]);
  });

  it('WS11: nothing in the daily-goal channel (or a thread under it) routes, whoever wrote it and whatever it mentions', async () => {
    const DAILY = '1570000000000000444';
    const live = () => ({ postOnly: [DAILY] });
    const bot = { id: 'b1', name: 'CEO', kind: 'head' as const, actor: { kind: 'head', dept: 'hq' } as ActorRef };
    expect((await route(msg({ channelId: CH.opsGeneral }), { org, taskByThread: async () => null })).length).toBeGreaterThan(0); // control: the same room routes when it is not post-only
    expect(await route(msg({ channelId: CH.opsGeneral }), { org, taskByThread: async () => null, live: () => ({ postOnly: [CH.opsGeneral] }) })).toEqual([]);
    for (const author of [bot, human]) {
      expect(await route(msg({ channelId: DAILY, author, content: 'create a task for @CTO', mentionedHeads: ['software'] }), { org, taskByThread: async () => null, live })).toEqual([]);
      expect(await route(msg({ channelId: 'th-d', threadId: 'th-d', parentChannelId: DAILY, author, mentionedHeads: ['software'] }), { org, taskByThread: async () => null, live })).toEqual([]);
    }
  });
});

describe('P1 reply routing and addressing rules (RF1-RF6, P1-B)', () => {
  const answer = async () => true;
  const rrun = (m: IncomingMessage, t: Task | null = null, isAnswer: ((id: string) => Promise<boolean>) | null = answer) =>
    route(m, { org, taskByThread: async () => t, ...(isAnswer ? { isAnswer } : {}) });
  const replied = (a: ReturnType<typeof botHead> | typeof human, id = 'r1') => ({ id, author: a, content: 'earlier', attachmentCount: 0 });
  const reply = (a: ReturnType<typeof botHead> | typeof human, o: Partial<IncomingMessage> = {}) => msg({ replyToId: 'r1', replied: replied(a), ...o });

  it('RF3: a reply to a bot goes to that bot, even in a channel mapped to another department, and suppresses the dept head', async () => {
    expect(await rrun(reply(botHead('software')))).toEqual([{ actor: head('software'), reason: 'reply' }]);
  });
  it('RF2: a bot author never routes by reply', async () => {
    const r = await rrun(msg({ author: botHead('ops'), replyToId: 'r1', replied: replied(botHead('software')) }));
    expect(actors(r)).not.toContainEqual(head('software'));
  });
  it('RF4: a reply to a message that is not a recorded answer, or with no lookup, does not route', async () => {
    expect(await rrun(reply(botHead('software')), null, async () => false)).toEqual([]);
    expect(await rrun(reply(botHead('software')), null, null)).toEqual([]);
    expect(await rrun(reply(botHead('software')), null, async () => { throw new Error('x'); })).toEqual([]);
  });
  it('RF3: a reply to a persona outside its direct room goes nowhere (no head fallback)', async () => {
    expect(await rrun(reply({ id: 'w', name: 'SA', kind: 'persona' as never, actor: persona('system-analyst') } as never))).toEqual([]);
  });
  it('RF3: the exclusions still win (denied channel, warroom, foreign bot, WS13 task thread)', async () => {
    expect(await rrun(reply(botHead('software'), { channelId: CH.credentials }))).toEqual([]);
    expect(await rrun(reply(botHead('software'), { threadId: 'th1', channelId: 'th1', parentChannelId: CH.swWork, author: { id: 'u9', name: 'Eve', kind: 'human' } }), task({ requester: { kind: 'human', userId: 'u1' } }))).toEqual([]);
  });
  it('RF1: a forward never routes by reply', async () => {
    const r = await rrun(msg({ replyToId: 'r1', replied: replied(botHead('software')), forward: { sourceChannelId: 'x', sourceMessageId: null, text: 't', attachmentCount: 0 } }));
    expect(actors(r)).toEqual([head('ops')]);
  });
  it('P1-B: mention of a human is silent', async () => {
    expect(await rrun(msg({ otherMentions: true }))).toEqual([]);
  });
  it('P1-B: mention of another bot -> only that bot answers', async () => {
    expect(actors(await rrun(msg({ mentionedHeads: ['software'] })))).toEqual([head('software')]);
  });
  it('P1-B: reply to a human is silent', async () => {
    expect(await rrun(reply(human))).toEqual([]);
  });
  it('P1-B: reply to a human plus a bot mention -> that bot answers', async () => {
    expect(actors(await rrun(reply(human, { mentionedHeads: ['software'] })))).toEqual([head('software')]);
  });
  it('P1-B: reply to bot A plus a mention of bot B -> A and B answer', async () => {
    expect(actors(await rrun(reply(botHead('software'), { mentionedHeads: ['hq'] })))).toEqual([head('hq'), head('software')]);
  });
  it('P1-B: a mention of a person alongside our bot still reaches the bot', async () => {
    expect(actors(await rrun(msg({ otherMentions: true, mentionedHeads: ['software'] })))).toEqual([head('software')]);
  });
  it('P1-B: no mention, not a reply -> the dept head answers', async () => {
    expect(actors(await rrun(msg()))).toEqual([head('ops')]);
  });
  it('RF6: a reply and an @mention of the same bot give the same actor and queue slot', async () => {
    const a = await rrun(reply(botHead('software')));
    const b = await rrun(msg({ mentionedHeads: ['software'] }));
    expect(actors(a)).toEqual(actors(b));
  });

  it('TEAMTALK T1: a plain relay (no mention markup, no handle) by a persona at its room top level, or by a head in a task thread, routes nowhere', async () => {
    const SA = { kind: 'persona' as const, personaId: 'system-analyst' };
    const sw = { kind: 'head' as const, dept: 'software' as const };
    const room = msg({ channelId: CH.saDirect, author: { id: 'wh', name: 'System Analyst', kind: 'persona', actor: SA }, content: '✅ Done: x: y · https://discord.com/channels/1/2/3' });
    expect(await route(room, { org, taskByThread: async () => null })).toEqual([]);
    const th = task({ owner: sw, requester: { kind: 'human', userId: 'u1' } });
    const inThread = msg({ channelId: 'th1', parentChannelId: CH.swWork, threadId: 'th1', author: { id: 'b', name: 'CTO', kind: 'head', actor: sw }, content: 'Subtask done: "x" finished' });
    expect(await route(inThread, { org, taskByThread: async () => th })).toEqual([]);
  });

  it('REROUTE-1 RR-C7: a bot post with no mention in a warroom thread routes to the continuation target with reason warroom and names no head, so the reroute never treats it as a mention', async () => {
    const WARROOM = '1566366032094961705';
    const sw = { kind: 'head' as const, dept: 'software' as const };
    const m = msg({ channelId: 'wth', parentChannelId: WARROOM, threadId: 'wth', author: { id: 'b', name: 'CEO', kind: 'head', actor: { kind: 'head', dept: 'hq' } }, content: 'no mention at all', mentionedHeads: [] });
    const routes = await route(m, { org, taskByThread: async () => null, continuation: () => sw });
    expect(routes).toEqual([{ actor: sw, reason: 'warroom' }]);
    expect(m.mentionedHeads).toEqual([]);
  });
});

describe('ASKBACK-1 routing (AB7, AB9)', () => {
  const sw = { kind: 'head' as const, dept: 'software' as const };
  const hqh = { kind: 'head' as const, dept: 'hq' as const };
  const owner = (a: ActorRef) => ({ id: `b-${a.kind === 'head' ? a.dept : 'p'}`, name: 'bot', kind: 'head' as const, actor: a });
  const inThread = (author: ReturnType<typeof owner>, content: string) => msg({ channelId: 'th1', parentChannelId: CH.swWork, threadId: 'th1', author, content });

  it('AB9: the ⏳ line (by the child owner) and the ❓ line (by the parent owner) route nowhere', async () => {
    const child = task({ owner: sw, requester: hqh, parentId: 'p1', rootId: 'p1' });
    expect(await route(inThread(owner(sw), '⏳ Asked head of hq (question 1/2): which env?'), { org, taskByThread: async () => child })).toEqual([]);
    const parent = task({ id: 'p1', owner: hqh, requester: { kind: 'human', userId: 'u1' } });
    expect(await route(msg({ channelId: 'th2', parentChannelId: 'ch-hq', threadId: 'th2', author: owner(hqh), content: '❓ Question 1/2 from head of software (handoff #abc): which env?' }), { org, taskByThread: async () => parent })).toEqual([]);
  });

  it('AB3 alternative: the 💬 line is authored by the child owner, so it routes nowhere (the owner is resumed by code, not by an echo)', async () => {
    const child = task({ owner: sw, requester: hqh, parentId: 'p1', rootId: 'p1' });
    expect(await route(inThread(owner(sw), '💬 Answer from head of hq (question 1/2): staging'), { org, taskByThread: async () => child })).toEqual([]);
  });

  it('AB7: a person replying (Discord reply) to the ❓ line, recorded as an answer, reaches the task owner; recorded as a non-answer it would route nowhere', async () => {
    const root = task({ owner: hqh, requester: { kind: 'human', userId: 'u1' }, deptId: 'hq' });
    const asked = { id: 'q1', author: owner(hqh), content: '❓ has a question for you', attachmentCount: 0 };
    const m = msg({ channelId: 'th1', parentChannelId: 'ch-hq', threadId: 'th1', replyToId: 'q1', replied: asked, content: 'staging please' });
    expect(await route(m, { org, taskByThread: async () => root, isAnswer: async (id) => id === 'q1' })).toEqual([{ actor: hqh, reason: 'reply', taskId: 't1' }]);
    expect(await route(m, { org, taskByThread: async () => root, isAnswer: async () => false })).toEqual([]);
    // a plain message in the thread (no reply) still reaches the owner as the root requester
    expect(await route(msg({ channelId: 'th1', parentChannelId: 'ch-hq', threadId: 'th1', content: 'staging' }), { org, taskByThread: async () => root })).toEqual([{ actor: hqh, reason: 'task_owner', taskId: 't1' }]);
  });
});

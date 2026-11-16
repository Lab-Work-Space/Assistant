import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import {
  ActorProvider, AI_WARROOM, CEO, CTO, HQ_WORK, SA, SOFTWARE_WORK, TestPort, boot, botMsg, gatewayEcho, humanMsg, mentionOf, resetDb, respond, taskIdOf, turn,
} from './helpers.js';

const SA_DIRECT = '1565670817646256178'; // #🤖-ai-system-analyst
let db: TestDb;
let app: App | null = null;

beforeAll(async () => {
  db = await freshDb();
});
afterEach(async () => {
  await app?.stop();
  app = null;
  await resetDb(db.pool);
});
afterAll(async () => {
  await db.close();
});

/** update_task done and the respond report in one round: a turn ends once its task is done (final #7). */
const done = (summary: string, report: ReturnType<typeof respond>, notes?: string[]) => (req: Parameters<typeof taskIdOf>[0]) =>
  turn({ name: 'update_task', input: { taskId: taskIdOf(req), status: 'done', summary, ...(notes ? { notes } : {}) } }, report);

describe('delegation', () => {
  it('goal to @CEO creates task, CEO delegates to software head, CTO delegates to system-analyst, persona reports done, roll-up reaches CEO report', async () => {
    const provider = new ActorProvider({
      'heads/hq': [
        turn({ name: 'create_task', input: { title: 'Build the MVP', description: 'Plan the MVP and report back.', assignee: { kind: 'head', dept: 'software' }, estCostUsd: 0.1 } }),
        turn(respond('chat', 'Delegated to the CTO.')),
        done('The MVP plan is ready.', respond('report', 'Final report: the MVP plan is ready.')),
      ],
      'heads/software': [
        turn({ name: 'create_task', input: { title: 'Write the MVP spec', description: 'Write the requirements spec.', assignee: { kind: 'persona', personaId: 'system-analyst' }, estCostUsd: 0.05 } }),
        turn(respond('chat', 'Asked the system analyst.')),
        done('Spec reviewed; plan ready.', respond('report', 'MVP plan done.')),
      ],
      'members/system-analyst': [
        done('Spec written.', respond('report', 'The MVP spec is written.'), ['MVP spec v1 agreed']),
      ],
    });
    const port = new TestPort();
    const t = await boot(db.pool, { provider, port });
    app = t.app;
    const { scheduler } = t.app.services;
    // gateway loopback: every bot post in a thread comes back as a message (after the REST reply, like Discord)
    port.onPosted = (p) => {
      if (!p.target.threadId) return;
      for (const echo of gatewayEcho(p, t.app.services)) {
        echoed.push(echo);
        echoes.push(new Promise<void>((resolve) => setImmediate(() => void scheduler.onMessage(echo).then(resolve))));
      }
    };
    const echoes: Promise<void>[] = [];
    const echoed: { content: string }[] = [];
    const settle = async () => {
      for (let n = -1; n !== echoes.length; ) {
        n = echoes.length;
        await Promise.all(echoes);
        await scheduler.idle();
      }
    };

    await scheduler.onMessage(humanMsg('<@100> Launch an MVP for our product', { channelId: HQ_WORK, mentionedHeads: ['hq'] }));
    await settle();

    // R30: embed-only bot and persona posts still reach agents with their text
    expect(echoed.length).toBeGreaterThan(0);
    expect(echoed.filter((e) => e.content.trim() === '')).toEqual([]);

    const rows = (await db.pool.query('SELECT id, parent_id, depth, owner, requester, status, thread_id FROM tasks ORDER BY depth')).rows;
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.owner)).toEqual([CEO, CTO, SA]);
    expect(rows.map((r) => r.requester)).toEqual([{ kind: 'human', userId: '42' }, CEO, CTO]);
    expect(rows[1].parent_id).toBe(rows[0].id);
    expect(rows[2].parent_id).toBe(rows[1].id);
    expect(rows.map((r) => r.status)).toEqual(['done', 'done', 'done']);
    expect(provider.remaining()).toEqual({ 'heads/hq': 0, 'heads/software': 0, 'members/system-analyst': 0 });

    // three threads named "#<short id> <title>"
    expect(t.port.threads.map((x) => [x.dept, x.channelId])).toEqual([['hq', HQ_WORK], ['software', AI_WARROOM], ['software', SA_DIRECT]]); // hq work channel; cross-department delegation in the war room; the persona in its direct room
    expect(t.port.threads[0]!.name).toBe(`#${rows[0].id.slice(0, 8)} Launch an MVP for our product`);
    expect(rows.map((r) => r.thread_id)).toEqual(t.port.threads.map((x) => x.id));

    expect(t.port.directs.length).toBeGreaterThanOrEqual(2);
    expect(t.port.directs).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: CEO, to: CTO }),
      expect.objectContaining({ from: CTO, to: SA }),
      expect.objectContaining({ from: SA, to: CTO }),
      expect.objectContaining({ from: CTO, to: CEO }),
    ]));

    // persona speaks as itself (webhook path) in its task thread, with model footer; Haiku for the persona
    // TEAMTALK-1: the persona's room now also gets top-level lines ("New", "Done") before its report, so the report is the persona post inside the task thread.
    const saPost = t.port.posts.find((p) => p.actor.kind === 'persona' && p.payload.type !== 'task' && p.target.threadId !== undefined);
    expect(t.port.posts.filter((p) => p.actor.kind === 'persona' && p.target.threadId === undefined).map((p) => p.payload.body.slice(0, 8))).toEqual(expect.arrayContaining(['📥 New: ', '✅ Done: ']));
    expect(t.port.posts.filter((p) => p.payload.body.startsWith('➜ Handoff #'))).toHaveLength(2); // CEO -> CTO and CTO -> system analyst
    expect(saPost).toMatchObject({ actor: SA, target: { channelId: SA_DIRECT, threadId: rows[2].thread_id }, payload: { type: 'report' } });
    expect(saPost!.payload.footer?.model).toBe('claude-sonnet-5-5'); // 2026-11-08: personas default to Sonnet (Haiku broke the local structured-output contract)
    expect(new Set(provider.callsOf('heads/hq').map((r) => r.model))).toEqual(new Set(['claude-sonnet-5-5']));

    // roll-up: the CEO's own run posts the final report in the goal thread
    const rootPosts = t.port.posts.filter((p) => p.target.threadId === rows[0].thread_id);
    expect(rootPosts.at(-1)).toMatchObject({ actor: CEO, payload: { type: 'report', body: 'Final report: the MVP plan is ready.' } });
    expect(t.port.posts.filter((p) => p.actor.kind === 'head' && p.actor.dept === 'hq').at(-1)!.payload.type).toBe('report');

    // every task change mirrored to #📋-tasks; notes stored for the department
    expect(t.port.tasks.filter((x) => x.status === 'done').map((x) => x.id).sort()).toEqual(rows.map((r) => r.id).sort());
    expect((await db.pool.query("SELECT body FROM dept_notes WHERE dept_id = 'software'")).rows).toEqual([{ body: 'MVP spec v1 agreed' }]);
  });

  it('scripted ping-pong between two heads stops at 20 turns with task blocked', async () => {
    const many = (text: string) => Array.from({ length: 30 }, (_, i) => turn(respond('chat', `${text} ${i}`)));
    const provider = new ActorProvider({ 'heads/hq': many(`${mentionOf('software')} what about`), 'heads/software': many(`${mentionOf('hq')} how about`) });
    const port = new TestPort();
    const t = await boot(db.pool, { provider, port });
    app = t.app;
    const { scheduler, tasks } = t.app.services;
    // This test is about the per-task turn limit (R31); the stall guard (WS2/WS3) would stop the loop at its own threshold, so it is set out of the way here.
    await t.app.services.cfg.set('warroom.stallTurns', 200, 'test');
    const task = await tasks.create({ title: 'Agree on pricing', deptId: 'software', owner: CTO, requester: CEO, origin: 'delegated', threadId: 'thread-pp' });

    // gateway loopback through the real embed builder and inbound mapping: mentions come from the embed text
    port.onPosted = (p) => {
      if (p.target.threadId !== 'thread-pp') return;
      for (const echo of gatewayEcho(p, t.app.services)) void scheduler.onMessage(echo);
    };

    await scheduler.onMessage(botMsg(CEO, `${mentionOf('software')} what price should we set?`, { channelId: 'thread-pp', threadId: 'thread-pp', parentChannelId: SOFTWARE_WORK, mentionedHeads: ['software'] }));
    await scheduler.idle();

    const after = (await tasks.get(task.id))!;
    expect(after.turnsUsed).toBe(20);
    expect(after.status).toBe('blocked');
    expect(provider.calls).toHaveLength(20);
    expect(t.port.posts.at(-1)).toMatchObject({ actor: CTO, payload: { type: 'alert', title: 'Turn limit' } });
  });

  it('a human post in #🎯-company-goals becomes a CEO-owned root task without a mention', async () => {
    const provider = new ActorProvider({ 'heads/hq': [turn(respond('chat', 'On it.')), turn(respond('chat', 'On it.'))] });
    const t = await boot(db.pool, { provider });
    app = t.app;
    const { scheduler } = t.app.services;
    await scheduler.onMessage(humanMsg('Open an office in Chiang Mai', { channelId: '1565651009076985956' }));
    await scheduler.onMessage(humanMsg('Hire two engineers', { id: 'th-goal', channelId: 'th-goal', threadId: 'th-goal', parentChannelId: '1565652418383847514' }));
    await scheduler.idle();
    const rows = (await db.pool.query('SELECT title, owner, depth, dept_id FROM tasks ORDER BY title')).rows;
    expect(rows).toEqual([
      { title: 'Hire two engineers', owner: CEO, depth: 0, dept_id: 'hq' },
      { title: 'Open an office in Chiang Mai', owner: CEO, depth: 0, dept_id: 'hq' },
    ]);
    // Teamwork D: the text-channel goal gets a thread in the hq work channel; the forum goal uses its own post as the thread
    expect(t.port.threads.map((x) => x.channelId)).toEqual([HQ_WORK]);
    const forumGoal = (await db.pool.query(`SELECT thread_id, channel_id FROM tasks WHERE title = 'Hire two engineers'`)).rows;
    expect(forumGoal).toEqual([{ thread_id: 'th-goal', channel_id: '1565652418383847514' }]);
  });

  it('W2: a head embed mentioning another head in a department room reaches it (under the guard)', async () => {
    const provider = new ActorProvider({ 'heads/hq': [turn(respond('chat', 'NO_REPLY'))] });
    const t = await boot(db.pool, { provider });
    app = t.app;
    const { scheduler } = t.app.services;
    const post = { actor: CTO, target: { channelId: SOFTWARE_WORK }, payload: { type: 'chat' as const, body: `${mentionOf('hq')} please weigh in` }, id: '1569000000000000001' };
    const [echo] = gatewayEcho(post, t.app.services);
    expect(echo!.mentionedHeads).toEqual(['hq']); // the mention is seen (R30) ...
    await scheduler.onMessage(echo!);
    await scheduler.idle();
    expect(provider.calls).toHaveLength(1); // ... and since the work-style change a bot's @handle routes in every readable channel, with the guard on
  });
});

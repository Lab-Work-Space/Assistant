import { PermissionFlagsBits } from 'discord.js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../../app.js';
import { ConfigStore } from '../../config/index.js';
import { DEPT_IDS, EventBus, type AppEvents } from '../../core/index.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { handleInteraction } from '../../discord/index.js';
import { interaction } from '../../discord/commands/test-helpers.js';
import type { ChatChunk, ChatRequest, LLMProvider } from '../../providers/index.js';
import { fakeClient, fakeGuild } from '../fakes/discordClient.js';
import {
  ActorProvider, BOT_LOG_CHANNEL, CONFIG_CHANNEL, CTO, MARKETING_WORK, RND_WORK, SA, SOFTWARE_WORK, SlowProvider, TestPort, boot, humanMsg, migrateUp, resetDb, respond, taskIdOf, turn,
} from './helpers.js';

let db: TestDb;
let app: App | null = null;
const quiet = { error: () => undefined };

beforeAll(async () => {
  db = await freshDb();
  await migrateUp(db.pool);
});
afterEach(async () => {
  await app?.stop();
  app = null;
  await resetDb(db.pool);
});
afterAll(async () => {
  await db.close();
});

const toCto = (content = 'status?', over = {}) => humanMsg(`<@101> ${content}`, { mentionedHeads: ['software'], ...over });
const configPosts = <P extends { target: { channelId: string } }>(posts: P[]): P[] => posts.filter((p) => p.target.channelId === CONFIG_CHANNEL);
/** System alerts go to #🧾-bot-log (approval cards stay in #⚙️-setting). */
const isBoot = (p: { payload: { title?: string; body: string } }, stage: string, needle: string): boolean => String(p.payload.title).startsWith('Incident ') && p.payload.body.includes(`where: boot · ${stage}`) && p.payload.body.includes(needle); // BOTLOG-1
const logPosts = <P extends { target: { channelId: string } }>(posts: P[]): P[] => posts.filter((p) => p.target.channelId === BOT_LOG_CHANNEL);

describe('governance', () => {
  it('company budget exhausted pauses all and posts alert', async () => {
    const provider = new ActorProvider({ 'heads/software': [turn(respond('chat', 'never'))], 'heads/rnd': [turn(respond('chat', 'never'))] });
    const t = await boot(db.pool, { provider });
    app = t.app;
    const { scheduler, cfg } = t.app.services;
    await cfg.set('budget.companyDailyUsd', 0.000001, 'test');

    await scheduler.onMessage(toCto('build it'));
    await scheduler.onMessage(humanMsg('<@102> research it', { channelId: RND_WORK, mentionedHeads: ['rnd'], author: { id: '43', name: 'o2', kind: 'human' } }));
    await scheduler.idle();

    expect(provider.calls).toHaveLength(0);
    const alerts = logPosts(t.port.posts).filter((p) => p.payload.title === 'Budget used up');
    expect(alerts).toHaveLength(1); // announced once per scope per day
    expect(alerts[0]).toMatchObject({ actor: { kind: 'head', dept: 'hq' }, payload: { type: 'alert', origin: 'governance' } });
    expect(alerts[0]!.payload.body).toContain('All bots are paused');
    // each refused run tells its channel why
    expect(t.port.posts.filter((p) => p.payload.title === 'Budget').map((p) => p.target.channelId).sort()).toEqual([RND_WORK, SOFTWARE_WORK].sort());
  });

  it('task with estCostUsd 2 waits; admin approve resumes it', async () => {
    const provider = new ActorProvider({
      'heads/software': [
        turn({ name: 'create_task', input: { title: 'Big research', description: 'Large job', assignee: SA, estCostUsd: 2 } }),
        turn(respond('chat', 'Waiting for approval.')),
      ],
      'members/system-analyst': [turn(respond('report', 'Research done.'))],
    });
    const t = await boot(db.pool, { provider });
    app = t.app;
    const { scheduler, tasks, commands } = t.app.services;

    await scheduler.onMessage(toCto('do the big research'));
    await scheduler.idle();
    const child = (await db.pool.query<{ id: string }>("SELECT id FROM tasks WHERE owner->>'personaId' = 'system-analyst'")).rows[0]!;
    expect((await tasks.get(child.id))!.status).toBe('awaiting_approval');
    expect(provider.callsOf('members/system-analyst')).toHaveLength(0);
    const card = configPosts(t.port.posts).find((p) => p.payload.type === 'approval');
    expect(card).toMatchObject({ actor: { kind: 'head', dept: 'hq' }, payload: { origin: 'governance', buttons: { approvalId: expect.any(String) } } });
    expect(t.port.threads).toHaveLength(1); // the waiting task already has its thread
    const approvalId = card!.payload.buttons!.approvalId;

    const stranger = interaction({ kind: 'button', customId: `approval:${approvalId}:approve`, roles: ['999'], userId: 'u2' });
    await handleInteraction(stranger, commands);
    expect(JSON.stringify(stranger.replies)).toContain('Only Bot Admins');
    await scheduler.idle();
    expect((await tasks.get(child.id))!.status).toBe('awaiting_approval');

    await handleInteraction(interaction({ kind: 'button', customId: `approval:${approvalId}:approve`, userId: 'admin1' }), commands);
    await scheduler.idle();
    expect(provider.callsOf('members/system-analyst')).toHaveLength(1);
    expect((await tasks.get(child.id))!.status).toBe('doing');
    expect(t.port.posts.at(-1)).toMatchObject({ actor: SA, target: { threadId: t.port.threads[0]!.id }, payload: { type: 'report' } });
  });

  it('/halt during a slow FakeProvider stream aborts within 2000 ms', async () => {
    const provider = new SlowProvider();
    const t = await boot(db.pool, { provider });
    app = t.app;
    const { scheduler, tasks, commands, cfg } = t.app.services;
    const task = await tasks.create({ title: 'Long job', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'thread-h' });

    await scheduler.onMessage(humanMsg('go on', { channelId: 'thread-h', threadId: 'thread-h', parentChannelId: SOFTWARE_WORK }));
    await provider.started;
    expect((await tasks.get(task.id))!.status).toBe('doing');
    const before = t.port.posts.length;
    const t0 = performance.now();
    await handleInteraction(interaction({ commandName: 'halt', userId: 'admin1' }), commands);
    await scheduler.idle();
    expect(performance.now() - t0).toBeLessThan(2000);

    expect(cfg.get('halted')).toBe(true);
    expect((await tasks.get(task.id))!.status).toBe('blocked');
    expect(t.port.posts.slice(before).filter((p) => p.target.threadId === 'thread-h')).toEqual([]);
    // nothing runs while halted
    await scheduler.onMessage(toCto('hello?'));
    await scheduler.idle();
    expect(provider.calls).toBe(1);
  });

  it('work running at halt time is blocked for the halt and re-run after /resume; other blocks stay (R35)', async () => {
    // First call streams until the halt aborts it; the re-run after /resume answers.
    const slow = new SlowProvider();
    let calls = 0;
    const provider: LLMProvider = {
      id: 'claude',
      async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatChunk> {
        if (++calls === 1) {
          yield* slow.chat(req, signal);
          return;
        }
        yield { type: 'tool_use', id: `tu${calls}`, name: 'respond', input: { type: 'chat', body: 'Resumed after the halt.' } };
        yield { type: 'usage', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
        yield { type: 'stop', reason: 'tool_use' };
      },
    };
    const t = await boot(db.pool, { provider });
    app = t.app;
    const { scheduler, tasks, commands } = t.app.services;
    const task = await tasks.create({ title: 'Long job', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'thread-h' });
    const stuck = await tasks.create({ title: 'Out of turns', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'thread-t', status: 'blocked' });
    await tasks.update(stuck.id, { blockedReason: 'turns' });

    await scheduler.onMessage(humanMsg('go on', { channelId: 'thread-h', threadId: 'thread-h', parentChannelId: SOFTWARE_WORK }));
    await slow.started;
    await handleInteraction(interaction({ commandName: 'halt', userId: 'admin1' }), commands);
    await scheduler.idle();
    expect(await tasks.get(task.id)).toMatchObject({ status: 'blocked', blockedReason: 'halt' });
    expect(t.port.tasks.filter((x) => x.id === task.id).map((x) => x.status)).toContain('blocked'); // mirrored

    await handleInteraction(interaction({ commandName: 'resume', userId: 'admin1' }), commands);
    await scheduler.idle();
    expect(calls).toBe(2);
    expect(await tasks.get(task.id)).toMatchObject({ status: 'doing', blockedReason: null });
    expect(t.port.posts.at(-1)).toMatchObject({ actor: CTO, target: { threadId: 'thread-h' }, payload: { body: 'Resumed after the halt.' } });
    expect(await tasks.get(stuck.id)).toMatchObject({ status: 'blocked', blockedReason: 'turns' });
  });

  it('config change visible to scheduler within 1000 ms without restart', async () => {
    const provider = new ActorProvider({ 'heads/software': [turn(respond('chat', 'one')), turn(respond('chat', 'two'))] });
    const t = await boot(db.pool, { provider });
    app = t.app;
    const { scheduler, cfg, commands } = t.app.services;

    // a write through another ConfigStore (NOTIFY path, like another process)
    const other = await ConfigStore.open(db.pool, new EventBus<AppEvents>(quiet), quiet);
    try {
      const t0 = performance.now();
      await other.set('context.messages', 7, 'other-process');
      await vi.waitFor(() => expect(cfg.get('context.messages')).toBe(7), { timeout: 1000, interval: 5 });
      expect(performance.now() - t0).toBeLessThan(1000);
    } finally {
      await other.close();
    }
    await scheduler.onMessage(toCto());
    await scheduler.idle();
    expect(t.port.historyLimits.at(-1)).toBe(7);

    // /bot disable takes effect for the next message
    await handleInteraction(interaction({ commandName: 'bot', subcommand: 'disable', strings: { dept: 'software' }, userId: 'admin1' }), commands);
    await scheduler.onMessage(toCto('still there?'));
    await scheduler.idle();
    expect(provider.callsOf('heads/software')).toHaveLength(1);
  });

  it('shutdown is not a halt: no further provider call, reservations released, task status kept', async () => {
    // Shutdown starts while update_task runs, i.e. between two provider calls of the same run.
    let stopping: Promise<void> | null = null;
    let calls = 0;
    const provider: LLMProvider = {
      id: 'claude',
      async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
        calls++;
        yield { type: 'tool_use', id: `tu${calls}`, name: 'update_task', input: { taskId: taskIdOf(req), status: 'review' } };
        yield { type: 'usage', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
        yield { type: 'stop', reason: 'tool_use' };
      },
    };
    const port = new TestPort();
    port.onLogTask = (task) => {
      if (task.status === 'review') stopping ??= app!.stop();
    };
    const t = await boot(db.pool, { provider, port });
    app = t.app;
    const { scheduler, tasks } = t.app.services;
    const task = await tasks.create({ title: 'Long job', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'thread-s' });
    await scheduler.onMessage(humanMsg('go on', { channelId: 'thread-s', threadId: 'thread-s', parentChannelId: SOFTWARE_WORK }));
    await vi.waitFor(() => expect(stopping).not.toBeNull());
    await stopping;
    app = null;

    expect(calls).toBe(1);
    expect((await db.pool.query("SELECT value FROM config WHERE key = 'halted'")).rows).toEqual([]);
    expect((await db.pool.query('SELECT coalesce(sum(reserved_usd), 0)::float AS r FROM budget_days')).rows[0].r).toBe(0);
    expect((await tasks.get(task.id))!.status).toBe('review');
    expect(t.port.posts.filter((p) => p.target.threadId === 'thread-s')).toEqual([]);
  });

  it('stop during start waits for start, then leaves nothing running; start after stop is refused', async () => {
    const t = await boot(db.pool, { start: false });
    app = t.app;
    const starting = t.app.start();
    await t.app.stop();
    await starting;
    app = null;
    expect(t.app.services.clients.online()).toEqual([]);
    expect(t.clients.hq!.destroyed).toBe(true);
    const url = t.app.services.healthUrl();
    expect(url).not.toBeNull();
    await expect(fetch(`${url}/healthz`)).rejects.toThrow();
    await expect(t.app.start()).rejects.toThrow(/stopped/);
  });

  it('crash recovery: doing task becomes todo and is re-run on start', async () => {
    const provider = new ActorProvider({ 'heads/software': [turn(respond('chat', 'Picking up where I left off.'))] });
    const t = await boot(db.pool, { provider, start: false });
    app = t.app;
    const { scheduler, tasks } = t.app.services;
    const task = await tasks.create({ title: 'Interrupted', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat', status: 'doing', threadId: 'thread-r' });

    await t.app.start();
    await scheduler.idle();
    expect(provider.callsOf('heads/software')).toHaveLength(1);
    expect((await tasks.get(task.id))!.status).toBe('doing');
    expect(t.port.posts.at(-1)).toMatchObject({ actor: CTO, target: { channelId: SOFTWARE_WORK, threadId: 'thread-r' }, payload: { body: 'Picking up where I left off.' } });
  });

  it('halted on boot re-runs no tasks', async () => {
    const provider = new ActorProvider({ 'heads/software': [turn(respond('chat', 'resumed'))] });
    // halted by an earlier process: the row exists before this one opens its config store
    await db.pool.query(`INSERT INTO config (key, value, updated_by) VALUES ('halted', 'true'::jsonb, 'earlier')`);
    const t = await boot(db.pool, { provider, start: false });
    app = t.app;
    const { scheduler, tasks, commands } = t.app.services;
    const task = await tasks.create({ title: 'Interrupted', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat', status: 'doing', threadId: 'thread-r' });

    await t.app.start();
    await scheduler.idle();
    expect(provider.calls).toHaveLength(0);
    expect((await tasks.get(task.id))!.status).toBe('doing'); // recovery did nothing while halted (D9)

    await handleInteraction(interaction({ commandName: 'resume', userId: 'admin1' }), commands);
    await scheduler.idle();
    expect(provider.callsOf('heads/software')).toHaveLength(1);
  });

  it('hq offline pauses loops', async () => {
    let now = Date.now();
    const provider = new ActorProvider({ 'heads/software': [turn(respond('chat', 'back'))] });
    const t = await boot(db.pool, { provider, now: () => now });
    app = t.app;
    const { scheduler } = t.app.services;

    t.clients.hq!.fire('shardDisconnect');
    now += 61_000;
    await scheduler.onMessage(toCto('anyone?'));
    await scheduler.idle();
    expect(provider.calls).toHaveLength(0);

    t.clients.hq!.fire('shardResume');
    await scheduler.onMessage(toCto('now?'));
    await scheduler.idle();
    expect(provider.calls).toHaveLength(1);
  });

  it('hq going offline mid-run stops the loop before its next provider call; the task re-runs when hq is back (D9, final #1)', async () => {
    let now = Date.now();
    let calls = 0;
    let t!: Awaited<ReturnType<typeof boot>>;
    const provider: LLMProvider = {
      id: 'claude',
      async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
        if (++calls === 1) {
          // hq drops while this call streams and stays away past the grace period
          t.clients.hq!.fire('shardDisconnect');
          now += 61_000;
          yield { type: 'tool_use', id: 'tu1', name: 'update_task', input: { taskId: taskIdOf(req), status: 'nope' } };
        } else {
          yield { type: 'tool_use', id: `tu${calls}`, name: 'respond', input: { type: 'chat', body: 'Back on it.' } };
        }
        yield { type: 'usage', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
        yield { type: 'stop', reason: 'tool_use' };
      },
    };
    t = await boot(db.pool, { provider, now: () => now });
    app = t.app;
    const { scheduler, tasks } = t.app.services;
    const task = await tasks.create({ title: 'Long job', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'thread-p' });

    await scheduler.onMessage(humanMsg('go on', { channelId: 'thread-p', threadId: 'thread-p', parentChannelId: SOFTWARE_WORK }));
    await scheduler.idle();
    expect(calls).toBe(1);
    expect((await tasks.get(task.id))!.status).toBe('todo'); // parked for recovery, not left doing
    expect(t.port.posts.filter((p) => p.target.threadId === 'thread-p')).toEqual([]);

    t.clients.hq!.fire('shardResume');
    await vi.waitFor(() => expect(calls).toBe(2));
    await scheduler.idle();
    expect(t.port.posts.at(-1)).toMatchObject({ actor: CTO, target: { threadId: 'thread-p' }, payload: { body: 'Back on it.' } });
  });

  it('missing BOT_TOKEN_SALES still starts others', async () => {
    const provider = new ActorProvider({ 'heads/marketing': [turn(respond('chat', 'Marketing here.'))] });
    const depts = DEPT_IDS.filter((d) => d !== 'sales');
    const t = await boot(db.pool, { provider, depts, clients: { it: fakeClient({ userId: 'bot-it', failLogin: true }) } });
    app = t.app;
    const { scheduler, clients } = t.app.services;

    expect(clients.online().sort()).toEqual(DEPT_IDS.filter((d) => d !== 'sales' && d !== 'it').sort());
    expect(t.clients.hq!.listenerCount('interactionCreate')).toBe(1);
    const offline = logPosts(t.port.posts).find((p) => isBoot(p, 'discord clients', 'did not start'));
    expect(offline?.payload.body).toMatch(/sales/);
    expect(offline?.payload.body).toMatch(/it \(/);

    const health = await fetch(`${t.app.services.healthUrl()}/healthz`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as { db: string; clients: string[]; halted: boolean };
    expect(body).toMatchObject({ db: 'ok', halted: false });
    expect(body.clients).not.toContain('sales');

    await scheduler.onMessage(humanMsg('<@103> plan a campaign', { channelId: MARKETING_WORK, mentionedHeads: ['marketing'] }));
    await scheduler.idle();
    expect(provider.callsOf('heads/marketing')).toHaveLength(1);

    // final #5: IT is enabled but its client failed to log in, so it gets no route and no model run
    await scheduler.onMessage(humanMsg('<@104> fix the printer', { channelId: MARKETING_WORK, mentionedHeads: ['it'] }));
    await scheduler.idle();
    expect(provider.calls.filter((c) => c.actor === 'heads/it')).toEqual([]);
  });

  it('missing BOT_TOKEN_PRAW starts the others and posts one offline alert', async () => {
    const depts = DEPT_IDS.filter((d) => d !== 'praw');
    const t = await boot(db.pool, { depts });
    app = t.app;
    expect(t.app.services.clients.online().sort()).toEqual(depts.slice().sort());
    const alerts = logPosts(t.port.posts).filter((p) => isBoot(p, 'discord clients', 'did not start'));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload.body).toContain('praw');
    expect(alerts[0]!.payload.body).toContain('BOT_TOKEN_PRAW');
  });

  it('D8 startup check covers the praw client (no Administrator, cannot view denied channels) (P16c)', async () => {
    const admin = fakeClient({ userId: 'bot-praw', guild: fakeGuild({ guildWide: [PermissionFlagsBits.Administrator] }) });
    const t = await boot(db.pool, { clients: { praw: admin } });
    app = t.app;
    expect(t.app.services.clients.online()).not.toContain('praw');
    const alert = logPosts(t.port.posts).find((p) => isBoot(p, 'executor client', 'praw') || isBoot(p, 'discord clients', 'praw bot was turned off'));
    expect(alert!.payload.body).toContain('Administrator');
  });

  it('D8 startup check disables a praw client that can view a denied channel (P16c)', async () => {
    const viewer = fakeClient({ userId: 'bot-praw', guild: fakeGuild({ viewable: ['1565715069969502310'] }) });
    const t2 = await boot(db.pool, { clients: { praw: viewer } });
    app = t2.app;
    expect(t2.app.services.clients.online()).not.toContain('praw');
    const alert2 = logPosts(t2.port.posts).find((p) => isBoot(p, 'executor client', 'praw') || isBoot(p, 'discord clients', 'praw bot was turned off'));
    expect(alert2!.payload.body).toContain('1565715069969502310');
  });

  it('a client with unsafe permissions is disabled and an alert is posted', async () => {
    const finance = fakeClient({ userId: 'bot-finance', guild: fakeGuild({ guildWide: [PermissionFlagsBits.Administrator] }) });
    const t = await boot(db.pool, { clients: { finance } });
    app = t.app;
    expect(t.app.services.clients.online()).not.toContain('finance');
    const alert = logPosts(t.port.posts).find((p) => isBoot(p, 'discord clients', 'finance bot was turned off'));
    expect(alert).toMatchObject({ actor: { kind: 'head', dept: 'hq' }, payload: { type: 'alert' } });
    expect(alert!.payload.origin).toBe('governance'); // G2BL-07: a security incident keeps the @Bot Admin ping
    expect(alert!.payload.body).toContain('Administrator');
  });
});

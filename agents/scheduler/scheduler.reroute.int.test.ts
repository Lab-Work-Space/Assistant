import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCalendar } from '../../company/calendar.js';
import { Org, seed } from '../../company/index.js';
import type { ActorRef, IncomingMessage } from '../../company/types.js';
import { BotMessageRepo, ChannelMapRepo, DepartmentRepo, PersonaRepo, TaskRepo } from '../../db/index.js';
import { migrate } from '../../db/migrate.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeDiscordPort } from '../../tests/fakes/discordPort.js';
import { createConversation } from '../conversation.js';
import type { AgentDeps, AgentOutcome } from '../loop/loop.js';
import type { OutboundPayload } from '../loop/payload.js';
import { Scheduler } from './scheduler.js';
import { newBus, noApprovedTools, prompts } from '../test-helpers.js';

// REROUTE-1 tester e2e: the real Scheduler, Conversation, TaskRepo (real SQL) and BotMessageRepo (real provenance) over a fake Discord port.
const LOUNGE = '1565652686341152778';
const GUILD = '1565649426943442944';
const SALES_WORK = '1565713910085058742';
const RND_WORK = '1565651357845692466';
const OWNER_MSG = '1570000000000000001';
const MON = Date.parse('2026-11-09T03:00:00Z');
const SAT = Date.parse('2026-11-07T03:00:00Z');
const HQ: ActorRef = { kind: 'head', dept: 'hq' };
let seq = 1570000000000000100n;
const nid = (): string => String(++seq);

class Port extends FakeDiscordPort {
  override snowflakes = true;
  override async post(actor: ActorRef, target: { channelId: string; threadId?: string }, payload: OutboundPayload, opts?: Parameters<FakeDiscordPort['post']>[3]): Promise<string> {
    const id = await super.post(actor, target, payload, opts);
    opts?.onSent?.([id]);
    return id;
  }
}

let db: TestDb;
let org: Org;
let tasks: TaskRepo;
let provRepo: BotMessageRepo;

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations'), 'up');
  const repos = { departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) };
  await seed(repos, prompts);
  org = await Org.load(repos, prompts);
  tasks = new TaskRepo(db.pool);
  provRepo = new BotMessageRepo(db.pool);
});
afterAll(async () => db.close());
beforeEach(async () => {
  await db.pool.query('DELETE FROM tasks');
  await db.pool.query('DELETE FROM bot_messages');
});

async function mk(o: { now?: number; cfg?: FakeConfig; asWired?: boolean } = {}) {
  const cfg = o.cfg ?? new FakeConfig({ 'schedule.offDays': [0, 6] });
  const now = o.now ?? MON;
  const port = new Port();
  const bus = newBus();
  const limits = new Limits(cfg, tasks);
  const halted = { v: false };
  const log = { error: vi.fn((..._a: unknown[]) => undefined), warn: vi.fn((..._a: unknown[]) => undefined) };
  const incidents = { report: vi.fn(() => '') };
  const run = vi.fn(async (..._a: unknown[]): Promise<AgentOutcome> => ({ payload: { type: 'chat', body: 'ok' }, costUsd: 0, turns: 1 }));
  const conversation = createConversation({ tasks, port, limits, bus });
  const s = new Scheduler({
    agent: { limits, botRoots: { acquire: async () => () => undefined } } as unknown as AgentDeps,
    approvedTools: noApprovedTools, run, port, org, tasks, limits, halt: { isHalted: () => halted.v }, cfg, bus, log, incidents, now: () => now,
    calendar: createCalendar(cfg), conversation,
    // app.ts hands the BotMessageRepo INSTANCE to the Scheduler (asWired); the other tests bind lookup so the rest of the feature can be exercised past DEFECT-001.
    provenance: o.asWired ? provRepo : { record: (...a: Parameters<BotMessageRepo['record']>) => provRepo.record(...a), lookup: (ids: string[]) => provRepo.lookup(ids) }, guildId: GUILD, rerouteProvPollMs: 5,
  } as never);
  s.attach();
  const send = async (m: IncomingMessage) => { await s.onMessage(m); await s.idle(); };
  return { s, port, bus, run, halted, log, incidents, conversation, cfg, send };
}
type H = Awaited<ReturnType<typeof mk>>;

const ownerMessage = (): IncomingMessage => ({ id: OWNER_MSG, channelId: LOUNGE, parentChannelId: null, threadId: null, author: { id: '42', name: 'Boss', kind: 'human' }, content: 'PRIVATE owner words', mentionedHeads: [], isAdmin: false, attachments: [], origin: 'chat' });
const ceoMsg = (o: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: nid(), channelId: LOUNGE, parentChannelId: null, threadId: null, author: { id: 'bot-hq', name: 'bot', kind: 'head', actor: HQ },
  content: 'ขอให้ @Sales และ @R&D ช่วยดู', mentionedHeads: ['sales', 'rnd'], isAdmin: false, attachments: [], origin: 'chat', replyToId: OWNER_MSG, ...o,
});
const person = (o: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: nid(), channelId: LOUNGE, parentChannelId: null, threadId: null, author: { id: '42', name: 'Boss', kind: 'human' }, content: '@Sales please look', mentionedHeads: ['sales'], isAdmin: false, attachments: [], origin: 'chat', ...o,
});
async function ceo(o: Partial<IncomingMessage> = {}, row = { tainted: false, userId: '42', answer: true }): Promise<IncomingMessage> {
  const m = ceoMsg(o);
  await provRepo.record(m.id, m.channelId, row.tainted, row.userId, row.answer);
  return m;
}
const lounge = (t: H, deny: string[] = ['sales', 'rnd']) => {
  for (const d of deny) t.port.workDenied.add(`${d}|${LOUNGE}`);
  t.port.fetchable.set(`${LOUNGE}|${OWNER_MSG}`, ownerMessage());
};
const all = async () => (await db.pool.query<{ id: string }>('SELECT id FROM tasks ORDER BY created_at')).rows.map((r) => r.id);
const row = async (id: string) => (await tasks.get(id))!;
const rerouted = async () => (await Promise.all((await all()).map(row))).filter((x) => x.rerouteSourceId);
const convs = async () => (await Promise.all((await all()).map(row))).filter((x) => x.conversation);
const body = (p: { payload: OutboundPayload }) => p.payload.body;
const loungePosts = (t: H) => t.port.posts.filter((p) => p.target.channelId === LOUNGE && !p.target.threadId);
const notices = (t: H) => loungePosts(t).filter((p) => body(p).startsWith('➜'));
const ranIn = (t: H, dept: string) => t.run.mock.calls.some((c) => JSON.stringify(c[0]).includes(`"dept":"${dept}"`) && JSON.stringify(c[0]).includes('task_owner'));

describe('REROUTE-1 tester e2e (real SQL)', () => {
  it('DEFECT-001: the BotMessageRepo instance exactly as app.ts wires it (unbound lookup) still reroutes the CEO mention', async () => {
    const t = await mk({ asWired: true });
    lounge(t);
    await t.send(await ceo());
    expect(await rerouted()).toHaveLength(2);
    expect(t.log.warn.mock.calls.map((c) => String(c[1])).filter((x) => x.includes('no provenance row'))).toHaveLength(0);
  });

  it('(a) owner lounge scenario: fresh CEO post mentioning @Sales and @R&D -> two child tasks, two notices replying to the CEO post, roll-up replies to the owner message, no incident', async () => {
    const t = await mk();
    lounge(t);
    const m = await ceo();
    await t.send(m);
    const [conv] = await convs();
    expect(conv).toMatchObject({ deptId: 'hq', conversation: true, requester: { kind: 'human', userId: '42' }, originMessageId: OWNER_MSG, threadId: LOUNGE });
    const kids = await rerouted();
    expect(kids.map((k) => k.deptId).sort()).toEqual(['rnd', 'sales']);
    for (const k of kids) {
      expect(k).toMatchObject({ parentId: conv!.id, rootId: conv!.id, depth: 1, status: expect.stringMatching(/todo|doing|review|done/), origin: 'delegated', requester: HQ, rerouteWhere: LOUNGE, rerouteSourceId: m.id });
      expect(k.channelId).toBe(k.deptId === 'sales' ? SALES_WORK : RND_WORK);
      expect(k.threadId).toBeTruthy();
      expect(k.title).toBe('Rerouted mention (from hq)');
    }
    expect(ranIn(t, 'sales') && ranIn(t, 'rnd')).toBe(true);
    const ns = notices(t);
    expect(ns).toHaveLength(2);
    for (const n of ns) { expect(n.opts?.replyToId).toBe(m.id); expect(body(n)).toMatch(/^➜ ส่งต่อให้ .+ ในห้องงานของแผนก: https:\/\/discord\.com\/channels\//); expect(n.payload).toMatchObject({ noHandles: true }); }
    expect((await row(conv!.id)).status).toBe('review');
    expect(t.incidents.report).not.toHaveBeenCalled();
    expect(t.log.error).not.toHaveBeenCalled();
    // results roll back through the CEO to the owner
    for (const k of kids) {
      const done = await tasks.update(k.id, { status: 'done' });
      await t.bus.emit('task.changed', { task: done!, from: 'doing', to: 'done', summary: `${k.deptId} answer` });
    }
    await t.s.idle();
    const replies = loungePosts(t).filter((p) => !body(p).startsWith('➜'));
    expect(replies.at(-1)!.actor).toEqual(HQ);
    expect(replies.at(-1)!.opts?.replyToId).toBe(OWNER_MSG);
    expect(loungePosts(t).some((p) => body(p).includes('Subtask done'))).toBe(false);
    expect((await row(conv!.id)).status).toBe('done');
    expect(t.incidents.report).not.toHaveBeenCalled();
  });

  it('(b) accessible channel: nothing is rerouted, the head runs in the source as today', async () => {
    const t = await mk();
    t.port.fetchable.set(`${LOUNGE}|${OWNER_MSG}`, ownerMessage());
    await t.send(await ceo());
    expect(await rerouted()).toHaveLength(0);
    expect(await convs()).toHaveLength(0);
    expect(notices(t)).toHaveLength(0);
  });

  it('(c) transient error -> unknown -> today\'s route, no task, not cached', async () => {
    const t = await mk();
    lounge(t, []);
    t.port.workUnknown.add(`sales|${LOUNGE}`);
    await t.send(await ceo({ mentionedHeads: ['sales'] }));
    await t.send(await ceo({ mentionedHeads: ['sales'] }));
    expect(await rerouted()).toHaveLength(0);
    expect(t.port.workCalls.filter((c) => c.dept === 'sales' && c.id === LOUNGE).length).toBeGreaterThanOrEqual(2); // asked again each time
    expect(t.run.mock.calls.some((c) => JSON.stringify(c[0]).includes('"mention"'))).toBe(true); // ran as a mention route in the lounge
  });

  it('(d) human view-only (cannot post in the work room) is refused; a human who can post gets a root', async () => {
    const t = await mk();
    t.port.workDenied.add(`sales|${LOUNGE}`);
    t.port.memberPost.set(`42|${SALES_WORK}`, false);
    await t.send(person());
    expect(await rerouted()).toHaveLength(0);
    expect(notices(t).map(body)[0]).toContain('ส่งต่อให้');
    expect(notices(t).map(body)[0]).toContain('ไม่ได้');
    const t2 = await mk();
    t2.port.workDenied.add(`sales|${LOUNGE}`);
    await t2.send(person());
    const [k] = await rerouted();
    expect(k).toMatchObject({ deptId: 'sales', origin: 'chat', requester: { kind: 'human', userId: '42' }, parentId: null, title: 'Rerouted mention (from member)' });
  });

  it('(e) duplicate chunks, same dept twice in one message, and a redelivery make one task', async () => {
    const t = await mk({ now: SAT }); // off day: the children stay open (todo), as a long-running child would be when the next chunk arrives
    lounge(t, ['sales']);
    const first = await ceo({ mentionedHeads: ['sales', 'sales'] });
    await t.send(first);
    await t.send(first); // gateway redelivery
    const chunk2 = await ceo({ replyToId: undefined, mentionedHeads: ['sales'] }, { tainted: false, userId: '42', answer: true });
    await t.send(chunk2);
    expect((await rerouted()).filter((k) => k.deptId === 'sales')).toHaveLength(1);
    expect(await convs()).toHaveLength(1);
    expect(notices(t)).toHaveLength(1);
  });

  it('(f) parent closes before the echo: a new conversation is adopted, the done one is never attached to', async () => {
    const t = await mk();
    lounge(t, ['sales']);
    const old = await t.conversation.adopt!({ actor: HQ, userId: '42', channelId: LOUNGE, originMessageId: OWNER_MSG, tainted: false, categoryId: null });
    await tasks.update(old.id, { status: 'done' });
    await t.send(await ceo({ mentionedHeads: ['sales'] }));
    const cs = await convs();
    expect(cs).toHaveLength(2);
    const [kid] = await rerouted();
    expect(kid!.parentId).not.toBe(old.id);
    expect((await row(old.id)).status).toBe('done');
    expect((await Promise.all((await all()).map(row))).filter((x) => x.parentId === old.id)).toHaveLength(0);
    expect((await row(kid!.parentId!)).status).toMatch(/doing|review/);
  });

  it('(g) off day: child is held (todo, not run), notice carries the suffix; person root still runs', async () => {
    const t = await mk({ now: SAT });
    lounge(t, ['sales']);
    await t.send(await ceo({ mentionedHeads: ['sales'] }));
    const [kid] = await rerouted();
    expect(kid!.status).toBe('todo');
    expect(ranIn(t, 'sales')).toBe(false);
    expect(body(notices(t)[0]!)).toContain('(เริ่มวันทำงานถัดไป)');
  });

  it('(h) reroute.enabled false: dropped, no task, no run, no notice', async () => {
    const t = await mk({ cfg: new FakeConfig({ 'schedule.offDays': [0, 6], 'reroute.enabled': false }) });
    lounge(t);
    await t.send(await ceo());
    expect(await rerouted()).toHaveLength(0);
    expect(await convs()).toHaveLength(0);
    expect(notices(t)).toHaveLength(0);
    expect(ranIn(t, 'sales')).toBe(false);
  });

  it('(i) halt: nothing is created, run or posted', async () => {
    const t = await mk();
    lounge(t);
    t.halted.v = true;
    await t.send(await ceo());
    expect(await all()).toHaveLength(0);
    expect(t.port.posts).toHaveLength(0);
  });

  it('(j) the posted notice fed back as a bot message does nothing (no task, no run, no post)', async () => {
    const t = await mk();
    lounge(t, ['sales']);
    await t.send(await ceo({ mentionedHeads: ['sales'] }));
    const n = notices(t)[0]!;
    const before = { tasks: (await all()).length, runs: t.run.mock.calls.length, posts: t.port.posts.length };
    await provRepo.record(n.id, LOUNGE, false, '42', false);
    await t.send({ id: n.id, channelId: LOUNGE, parentChannelId: null, threadId: null, author: { id: 'bot-hq', name: 'bot', kind: 'head', actor: HQ }, content: body(n), mentionedHeads: [], isAdmin: false, attachments: [], origin: 'chat', replyToId: m0(n) });
    expect((await all()).length).toBe(before.tasks);
    expect(t.run.mock.calls.length).toBe(before.runs);
    expect(t.port.posts.length).toBe(before.posts);
  });
});
const m0 = (n: { opts?: { replyToId?: string } }) => n.opts?.replyToId;

import { describe, expect, it, vi } from 'vitest';
import { ADMIN_CONFIG_KEYS, HANDLER_KEYS } from '../../admin/keys.js';
import { createCalendar } from '../../company/calendar.js';
import { AI_WARROOM_CHANNEL_ID } from '../../company/channels.js';
import { handlesIn } from '../../company/handles.js';
import { route } from '../../company/router.js';
import type { ActorRef, IncomingMessage } from '../../company/types.js';
import type { Org } from '../../company/org.js';
import { DEPT_IDS, type DeptId } from '../../core/index.js';
import { toIncoming, type InboundCtx } from '../../discord/inbound.js';
import type { Task } from '../../db/repos/tasks.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeDiscordPort } from '../../tests/fakes/discordPort.js';
import { createConversation } from '../conversation.js';
import type { KeyedLock } from './jobs.js';
import type { AgentDeps, AgentOutcome } from '../loop/loop.js';
import type { OutboundPayload } from '../loop/payload.js';
import { Scheduler } from './scheduler.js';
import { CTO, MemTasks, newBus, noApprovedTools, seededOrg } from '../test-helpers.js';

// REROUTE-1 [S]: RR-C1 to RR-C20 (docs/security/2026-11-08-gate1-mention-reroute.md).
const LOUNGE = '1565652686341152778';
const GUILD = '1565649426943442944';
const SALES_WORK = '1565713910085058742';
const RND_WORK = '1565651357845692466';
const OWNER_MSG = '1570000000000000001';
const MON = Date.parse('2026-11-09T03:00:00Z');
const SAT = Date.parse('2026-11-07T03:00:00Z');
const HQ: ActorRef = { kind: 'head', dept: 'hq' };
const SALES: ActorRef = { kind: 'head', dept: 'sales' };
const PRAW: ActorRef = { kind: 'head', dept: 'praw' };
const SA: ActorRef = { kind: 'persona', personaId: 'system-analyst' };
let seq = 1570000000000000100n;
const nid = (): string => String(++seq);

type Row = { tainted: boolean; userId: string | null; answer?: boolean };
class Prov {
  rows = new Map<string, Row>();
  recorded: { id: string; where: string; tainted: boolean; userId: string | null; answer: boolean }[] = [];
  /** the row of `id` appears only from this poll on (1 = at once) */
  appearAt = new Map<string, number>();
  calls = new Map<string, number>();
  failLookup = false;
  async lookup(ids: string[]): Promise<Map<string, Row>> {
    if (this.failLookup) throw new Error('db down');
    const out = new Map<string, Row>();
    for (const id of ids) {
      const n = (this.calls.get(id) ?? 0) + 1;
      this.calls.set(id, n);
      const row = this.rows.get(id);
      if (row && n >= (this.appearAt.get(id) ?? 1)) out.set(id, row);
    }
    return out;
  }
  async record(id: string, where: string, tainted: boolean, userId: string | null, answer = false): Promise<void> {
    this.recorded.push({ id, where, tainted, userId, answer });
    this.rows.set(id, { tainted, userId, answer });
  }
}

/** Like the real port, a send reports its ids through onSent (provenance). */
class Port extends FakeDiscordPort {
  override snowflakes = true;
  override async post(actor: ActorRef, target: { channelId: string; threadId?: string }, payload: OutboundPayload, opts?: Parameters<FakeDiscordPort['post']>[3]): Promise<string> {
    const id = await super.post(actor, target, payload, opts);
    opts?.onSent?.([id]);
    return id;
  }
}

const chat = (body: string): AgentOutcome => ({ payload: { type: 'chat', body }, costUsd: 0, turns: 1 });

async function mk(o: { tasks?: MemTasks; cfg?: FakeConfig; now?: number; org?: Org; secrets?: string[]; rootCap?: number; teamtalk?: boolean; prov?: Prov; port?: Port } = {}) {
  const cfg = o.cfg ?? new FakeConfig({ 'schedule.offDays': [0, 6] });
  const tasks = o.tasks ?? new MemTasks();
  const now = o.now ?? MON;
  tasks.clock = () => now;
  const port = o.port ?? new Port();
  const prov = o.prov ?? new Prov();
  const bus = newBus();
  const limits = new Limits(cfg, tasks);
  const halted = { v: false };
  const roots = { taken: 0, cap: o.rootCap ?? 100 };
  const log = { error: vi.fn(), warn: vi.fn() };
  const incidents = { report: vi.fn(() => '') };
  const run = vi.fn(async () => chat('ok'));
  const conversation = createConversation({ tasks, port, limits, bus });
  const org = o.org ?? (await seededOrg());
  const tt = o.teamtalk
    ? ({ enabled: () => true, bind: () => undefined, stop: () => undefined, handoffPayload: () => ({ type: 'chat', body: 'handoff' }), assigned: async () => undefined, touchBoard: () => undefined, backLink: () => null, final: () => undefined, resultLink: () => null, ended: async () => undefined, notes: async () => undefined } as never)
    : undefined;
  const s = new Scheduler({
    agent: { limits, botRoots: { acquire: async () => (roots.taken < roots.cap ? (roots.taken++, () => undefined) : null) } } as unknown as AgentDeps,
    approvedTools: noApprovedTools, run, port, org, tasks, limits, halt: { isHalted: () => halted.v }, cfg, bus, log, incidents, now: () => now,
    calendar: createCalendar(cfg), conversation, provenance: prov, guildId: GUILD, rerouteProvPollMs: 1, ...(o.secrets ? { secrets: o.secrets } : {}), ...(tt ? { teamtalk: tt } : {}),
  });
  s.attach();
  const send = async (m: IncomingMessage) => {
    await s.onMessage(m);
    await s.idle();
  };
  return { s, port, tasks, bus, run, prov, halted, roots, log, incidents, conversation, cfg, send };
}
type H = Awaited<ReturnType<typeof mk>>;

const bot = (actor: ActorRef, o: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: nid(), channelId: LOUNGE, parentChannelId: null, threadId: null, author: { id: 'bot-' + (actor.kind === 'head' ? actor.dept : actor.personaId), name: 'bot', kind: actor.kind, actor },
  content: 'Please @Sales look at this', mentionedHeads: ['sales'], isAdmin: false, attachments: [], origin: 'chat', replyToId: OWNER_MSG, ...o,
});
const person = (o: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: nid(), channelId: LOUNGE, parentChannelId: null, threadId: null, author: { id: '42', name: 'Boss', kind: 'human' }, content: '@Sales please look', mentionedHeads: ['sales'],
  isAdmin: false, attachments: [], origin: 'chat', ...o,
});
const ownerMessage = (over: Partial<IncomingMessage> = {}): IncomingMessage => ({
  id: OWNER_MSG, channelId: LOUNGE, parentChannelId: null, threadId: null, author: { id: '42', name: 'Boss', kind: 'human' }, content: 'PRIVATE owner words', mentionedHeads: [], isAdmin: false, attachments: [], origin: 'chat', ...over,
});

/** Lounge world: sales and rnd cannot work in the lounge; the owner's message is fetchable; the CEO's post has an answer row for the owner. */
function lounge(t: H, depts: string[] = ['sales']) {
  for (const d of depts) t.port.workDenied.add(`${d}|${LOUNGE}`);
  t.port.fetchable.set(`${LOUNGE}|${OWNER_MSG}`, ownerMessage());
}
const ceo = (t: H, o: Partial<IncomingMessage> = {}, row: Row = { tainted: false, userId: '42', answer: true }): IncomingMessage => {
  const m = bot(HQ, o);
  t.prov.rows.set(m.id, row);
  return m;
};
const all = (t: H): Task[] => [...t.tasks.rows.values()];
const kids = (t: H, dept?: string): Task[] => all(t).filter((x) => !!x.rerouteSourceId && (!dept || x.deptId === dept));
const convs = (t: H): Task[] => all(t).filter((x) => x.conversation);
const loungePosts = (t: H) => t.port.posts.filter((p) => p.target.channelId === LOUNGE && !p.target.threadId);
const bodyOf = (p: { payload: OutboundPayload }): string => p.payload.body;
const notices = (t: H) => loungePosts(t).filter((p) => bodyOf(p).startsWith('➜'));

describe('RR-C1 reply target from the live reference, and the lounge happy path', () => {
  it('the CEO\'s reply that mentions @Sales adopts a conversation; Sales gets a task in its own room; the roll-up answers the owner\'s message', async () => {
    const t = await mk();
    lounge(t);
    await t.send(ceo(t));
    const [conv] = convs(t);
    expect(conv).toMatchObject({ deptId: 'hq', conversation: true, origin: 'chat', requester: { kind: 'human', userId: '42' }, threadId: LOUNGE, originMessageId: OWNER_MSG });
    const [kid] = kids(t, 'sales');
    expect(kid).toMatchObject({ parentId: conv!.id, owner: SALES, requester: HQ, origin: 'delegated', channelId: SALES_WORK, title: 'Rerouted mention (from hq)', estCostUsd: 0 });
    expect(kid!.threadId).toBeTruthy();
    expect(t.port.threads.find((x) => x.id === kid!.threadId)).toMatchObject({ dept: 'sales', channelId: SALES_WORK, name: expect.stringContaining('Rerouted mention (from hq)') });
    expect(t.run).toHaveBeenCalledWith(expect.objectContaining({ route: expect.objectContaining({ actor: SALES, reason: 'task_owner' }) }), expect.anything()); // the head ran in its own room, not in the lounge
    expect(notices(t)).toHaveLength(1);
    expect(bodyOf(notices(t)[0]!)).toContain(`https://discord.com/channels/${GUILD}/${kid!.threadId}`);
    expect(notices(t)[0]!.opts?.replyToId).toBeTruthy();
    // the result rolls back through the CEO: H1 is skipped, the report line is quiet, the roll-up replies to the owner's own message
    const done = await t.tasks.update(kid!.id, { status: 'done' });
    await t.bus.emit('task.changed', { task: done!, from: 'doing', to: 'done', summary: 'sales answer' });
    await t.s.idle();
    const reply = loungePosts(t).filter((p) => !bodyOf(p).startsWith('➜')).at(-1)!;
    expect(reply.actor).toEqual(HQ);
    expect(reply.opts?.replyToId).toBe(OWNER_MSG);
    expect(loungePosts(t).some((p) => bodyOf(p).includes('Subtask done'))).toBe(false); // H3 quiet for done
    expect((await t.tasks.get(conv!.id))!.status).toBe('done');
  });

  it('a reply to another person\'s message, to a bot message, or a failed fetch: no adoption (the TW6 slot path), no conversation', async () => {
    for (const setup of ['other person', 'bot message', 'fetch fails'] as const) {
      const t = await mk();
      t.port.workDenied.add(`sales|${LOUNGE}`);
      if (setup === 'other person') t.port.fetchable.set(`${LOUNGE}|${OWNER_MSG}`, ownerMessage({ author: { id: '99', name: 'x', kind: 'human' } }));
      if (setup === 'bot message') t.port.fetchable.set(`${LOUNGE}|${OWNER_MSG}`, ownerMessage({ author: { id: 'b', name: 'b', kind: 'head', actor: SALES } }));
      await t.send(ceo(t));
      expect(convs(t), setup).toHaveLength(0);
      expect(kids(t, 'sales'), setup).toHaveLength(1);
      expect(kids(t, 'sales')[0], setup).toMatchObject({ parentId: null, requester: HQ, origin: 'delegated' });
      expect(t.roots.taken, setup).toBe(1);
    }
  });
});

describe('RR-C2 provenance or nothing', () => {
  it('a row that lands after a few polls still makes one task', async () => {
    const t = await mk();
    lounge(t);
    const m = ceo(t);
    t.prov.appearAt.set(m.id, 4);
    await t.send(m);
    expect(kids(t, 'sales')).toHaveLength(1);
    expect(t.prov.calls.get(m.id)).toBe(4);
  });
  it('no row after the poll: zero tasks, zero notices, one warning; a lookup that throws: zero tasks', async () => {
    const t = await mk();
    lounge(t);
    await t.send(bot(HQ)); // no row
    expect(all(t)).toHaveLength(0);
    expect(t.port.posts).toHaveLength(0);
    expect(t.prov.calls.size).toBe(1);
    expect(t.log.warn).toHaveBeenCalledTimes(1);
    expect(t.run).not.toHaveBeenCalled();
    t.prov.failLookup = true;
    await t.send(ceo(t));
    expect(all(t)).toHaveLength(0);
    expect(t.port.posts).toHaveLength(0);
  });
});

describe('RR-C3 adoption gate', () => {
  it('a goal-task report or a bot-talk turn (answer=false, inherited user) is never adopted', async () => {
    const t = await mk();
    lounge(t);
    await t.send(ceo(t, {}, { tainted: false, userId: '42', answer: false }));
    expect(convs(t)).toHaveLength(0);
    expect(kids(t, 'sales')).toHaveLength(1);
    expect(kids(t, 'sales')[0]!.parentId).toBeNull();
  });
  it('the CEO\'s person cannot view the target room: refusal not_allowed, no task, no conversation', async () => {
    const t = await mk();
    lounge(t);
    t.port.view.set(`42|${SALES_WORK}`, false);
    await t.send(ceo(t));
    expect(all(t)).toHaveLength(0);
    expect(notices(t).map(bodyOf)).toEqual([expect.stringContaining('ส่งต่อให้ Sales & Pipeline ไม่ได้')]);
  });
  it('Praw as the mentioner: the person it acts for must be able to view the room; no person at all is a refusal too', async () => {
    const t = await mk();
    t.port.workDenied.add(`sales|${LOUNGE}`);
    t.port.view.set(`42|${SALES_WORK}`, false);
    const a = bot(PRAW, { replyToId: undefined });
    t.prov.rows.set(a.id, { tainted: false, userId: '42', answer: true });
    await t.send(a);
    const b = bot(PRAW, { replyToId: undefined });
    t.prov.rows.set(b.id, { tainted: false, userId: null, answer: false });
    await t.send(b);
    expect(all(t)).toHaveLength(0);
    expect(t.port.posts.filter((p) => bodyOf(p).startsWith('➜'))).toHaveLength(1); // one refusal per (source, dept) per 10 minutes
  });
});

describe('RR-C4 one conversation per key', () => {
  it('two chunks of one reply, both mentioning @Sales (the second has no reply reference): one conversation, one child, no root', async () => {
    const t = await mk();
    lounge(t);
    await t.send(ceo(t));
    await t.send(ceo(t, { replyToId: undefined }));
    expect(convs(t)).toHaveLength(1);
    expect(kids(t, 'sales')).toHaveLength(1);
    expect(all(t).filter((x) => !x.parentId && !x.conversation)).toHaveLength(0);
  });
  it('two CEO posts 10 ms apart share one conversation', async () => {
    const t = await mk();
    lounge(t, ['sales', 'rnd']);
    const a = ceo(t);
    const b = ceo(t, { mentionedHeads: ['rnd'], content: 'and @R&D' });
    await Promise.all([t.s.onMessage(a), new Promise((r) => setTimeout(r, 10)).then(() => t.s.onMessage(b))]);
    await t.s.idle();
    expect(convs(t)).toHaveLength(1);
    expect(kids(t)).toHaveLength(2);
  });
  it('adopting races the CEO\'s own conversation opening: still one conversation', async () => {
    const t = await mk();
    lounge(t);
    const owner = ownerMessage({ content: 'to the CEO' });
    await Promise.all([t.s.onMessage(ceo(t)), t.conversation.open({ actor: HQ, msg: owner, tainted: false, reason: 'mention' })]);
    await t.s.idle();
    expect(convs(t)).toHaveLength(1);
    expect(kids(t, 'sales')).toHaveLength(1);
    expect(kids(t, 'sales')[0]!.parentId).toBe(convs(t)[0]!.id);
  });
  it('a conversation that is already open is reused and its reply target is not touched', async () => {
    const t = await mk();
    lounge(t);
    const open = await t.conversation.open({ actor: HQ, msg: ownerMessage({ id: '1570000000000000002' }), tainted: false, reason: 'mention' });
    await t.tasks.update(open.id, { status: 'review' });
    await t.send(ceo(t));
    expect(convs(t)).toHaveLength(1);
    expect(kids(t, 'sales')[0]!.parentId).toBe(open.id);
    expect((await t.tasks.get(open.id))!.originMessageId).toBe('1570000000000000002');
    expect((await t.tasks.get(open.id))!.status).toBe('review');
  });
});

describe('RR-C5 atomic attach and cleanup', () => {
  it('a conversation that was done before the echo is never attached to: a new one is adopted', async () => {
    const t = await mk();
    lounge(t);
    const old = await t.conversation.open({ actor: HQ, msg: ownerMessage({ id: '1570000000000000002' }), tainted: false, reason: 'mention' });
    await t.tasks.update(old.id, { status: 'done' });
    await t.send(ceo(t));
    expect(convs(t)).toHaveLength(2);
    const kid = kids(t, 'sales')[0]!;
    expect(kid.parentId).not.toBe(old.id);
    expect((await t.tasks.get(kid.parentId!))!.status).not.toBe('done');
  });
  it('settleReview closing the conversation at the same moment: the child never ends under a done or cancelled parent (a new conversation is adopted)', async () => {
    const t = await mk();
    lounge(t);
    const open = await t.conversation.open({ actor: HQ, msg: ownerMessage({ id: '1570000000000000002' }), tainted: false, reason: 'mention' });
    await t.tasks.update(open.id, { status: 'review' });
    // settleReview has counted zero children and is about to close the conversation: hold its closing update until the reroute is waiting
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const update = t.tasks.update.bind(t.tasks);
    vi.spyOn(t.tasks, 'update').mockImplementation(async (id, patch, expected) => {
      if (id === open.id && patch.status === 'done' && expected === 'review') await gate;
      return update(id, patch, expected);
    });
    const sweep = t.s.sweepReview();
    await vi.waitFor(() => expect(vi.mocked(t.tasks.update).mock.calls.some((c) => c[0] === open.id && c[1].status === 'done')).toBe(true));
    const m = ceo(t);
    const sent = t.s.onMessage(m);
    await vi.waitFor(() => expect(t.prov.calls.get(m.id)).toBeGreaterThan(0)); // the reroute is past the poll and queued behind settleReview
    await new Promise((r) => setTimeout(r, 20));
    expect(kids(t)).toHaveLength(0);
    release();
    await sweep;
    await sent;
    await t.s.idle();
    expect((await t.tasks.get(open.id))!.status).toBe('done');
    const kid = kids(t, 'sales')[0]!;
    expect(kid.parentId).not.toBe(open.id);
    expect(['doing', 'review']).toContain((await t.tasks.get(kid.parentId!))!.status);
  });
  it('the child attached first: settleReview then sees an open child and does not close the conversation', async () => {
    const t = await mk();
    lounge(t);
    const open = await t.conversation.open({ actor: HQ, msg: ownerMessage({ id: '1570000000000000002' }), tainted: false, reason: 'mention' });
    await t.tasks.update(open.id, { status: 'review' });
    await t.send(ceo(t));
    await t.s.sweepReview();
    expect((await t.tasks.get(open.id))!.status).toBe('review');
    expect(kids(t, 'sales')[0]!.parentId).toBe(open.id);
  });
  it('the child insert failing after an adopt ends the adopted conversation cancelled (no orphan doing)', async () => {
    const t = await mk();
    lounge(t);
    vi.spyOn(t.tasks, 'createUnderOpenParent').mockRejectedValueOnce(new Error('insert failed'));
    await t.send(ceo(t));
    expect(convs(t)).toHaveLength(1);
    expect(convs(t)[0]!.status).toBe('cancelled');
    expect(kids(t)).toHaveLength(0);
    expect(t.incidents.report).toHaveBeenCalledWith(expect.objectContaining({ stage: 'reroute create sales' }));
  });
  it('a refusal runs before the adoption: no conversation is made when the open-task cap is full', async () => {
    const t = await mk({ cfg: new FakeConfig({ 'schedule.offDays': [0, 6], 'limits.openTasks': 1 }) });
    lounge(t);
    await t.send(ceo(t));
    expect(all(t)).toHaveLength(0);
    expect(notices(t).map(bodyOf)[0]).toContain('ถึงขีดจำกัดของงานแล้ว');
  });
});

describe('G2RR-01 the adopted conversation is settled under its own task lock', () => {
  it('the closing update of the adopted conversation runs while the task lock is held (a probe queued on that lock waits for it)', async () => {
    const t = await mk();
    lounge(t);
    const locks = (t.s as unknown as { locks: KeyedLock }).locks;
    const order: string[] = [];
    const update = t.tasks.update.bind(t.tasks);
    vi.spyOn(t.tasks, 'update').mockImplementation(async (id, patch, expected) => {
      if (patch.status === 'review' && expected === 'doing') {
        void locks.run(id, async () => void order.push('probe'));
        await new Promise((r) => setTimeout(r, 5));
        const out = await update(id, patch, expected);
        order.push('updated');
        return out;
      }
      return update(id, patch, expected);
    });
    await t.send(ceo(t));
    expect(order).toEqual(['updated', 'probe']);
    expect((await t.tasks.get(convs(t)[0]!.id))!.status).toBe('review');
  });
});

describe('RR-C6 lock scope', () => {
  it('a canStartThread that never resolves does not block a roll-up on the same parent', async () => {
    const t = await mk();
    lounge(t, ['sales', 'rnd']);
    await t.send(ceo(t));
    const conv = convs(t)[0]!;
    const kid = kids(t, 'sales')[0]!;
    t.port.canStartThread = () => new Promise<boolean>(() => undefined); // the next reroute hangs before any lock
    void t.s.onMessage(ceo(t, { mentionedHeads: ['rnd'], content: 'and @R&D' }));
    const done = await t.tasks.update(kid.id, { status: 'done' });
    const before = t.run.mock.calls.length;
    await t.bus.emit('task.changed', { task: done!, from: 'doing', to: 'done', summary: 's' });
    await vi.waitFor(() => expect(t.run.mock.calls.length).toBeGreaterThan(before), { timeout: 2000 });
    await vi.waitFor(async () => expect((await t.tasks.get(conv.id))!.status).not.toBe('doing'), { timeout: 2000 });
    expect(kids(t, 'rnd')).toHaveLength(0);
  });
});

describe('RR-C7 mentions only', () => {
  it('a warroom thread post with no mention is never rerouted, even when the continuation target cannot work there', async () => {
    const t = await mk();
    const thread = '1570000000000000900';
    t.port.workDenied.add(`sales|${thread}`);
    const base = { channelId: thread, parentChannelId: AI_WARROOM_CHANNEL_ID, threadId: thread };
    const first = bot(SALES, { ...base, mentionedHeads: [], content: 'hello', replyToId: undefined });
    await t.send(first);
    const second = bot(HQ, { ...base, mentionedHeads: [], content: 'no mention at all', replyToId: undefined });
    t.prov.rows.set(second.id, { tainted: false, userId: null, answer: false });
    await t.send(second);
    expect(all(t)).toHaveLength(0);
    expect(t.port.workCalls.some((c) => c.id === thread)).toBe(false); // the continuation route is not even checked
  });
});

describe('RR-C8 non-owner in a task thread', () => {
  const taskThread = async (t: H, owner: ActorRef, requester: ActorRef) => {
    const thread = '1570000000000000800';
    t.port.workDenied.add(`sales|${thread}`);
    const parent = await t.tasks.create({ title: 'T', deptId: owner.kind === 'head' ? owner.dept : 'software', owner, requester, origin: 'delegated', status: 'doing', threadId: thread, channelId: '1565682159375749161' });
    return { parent, thread, base: { channelId: thread, parentChannelId: '1565682159375749161', threadId: thread, replyToId: undefined } };
  };
  it('the requester bot mentions in its child\'s thread: no task, no notice (its post would steer the owner)', async () => {
    const t = await mk();
    const { base } = await taskThread(t, CTO, HQ);
    const m = bot(HQ, base);
    t.prov.rows.set(m.id, { tainted: false, userId: null, answer: false });
    await t.send(m);
    expect(kids(t)).toHaveLength(0);
    expect(all(t)).toHaveLength(1);
    expect(t.port.posts.filter((p) => bodyOf(p).startsWith('➜'))).toHaveLength(0);
  });
  it('the owner mentions in its own task thread: the child of that task, taken from the per-root cap, with a notice in the thread', async () => {
    const t = await mk();
    const { parent, thread, base } = await taskThread(t, CTO, HQ);
    const m = bot(CTO, base);
    t.prov.rows.set(m.id, { tainted: false, userId: null, answer: false });
    await t.send(m);
    expect(kids(t, 'sales')).toHaveLength(1);
    expect(kids(t, 'sales')[0]).toMatchObject({ parentId: parent.id, requester: CTO, depth: 1 });
    expect(t.tasks.forwardsTaken.get(parent.rootId)).toBe(1);
    const n = t.port.posts.filter((p) => bodyOf(p).startsWith('➜'));
    expect(n).toHaveLength(1);
    expect(n[0]!.target).toEqual({ channelId: '1565682159375749161', threadId: thread });
  });
  it('with TeamTalk on, H1 announces the child in the parent thread, so the notice is skipped', async () => {
    const t = await mk({ teamtalk: true });
    const { base } = await taskThread(t, CTO, HQ);
    const m = bot(CTO, base);
    t.prov.rows.set(m.id, { tainted: false, userId: null, answer: false });
    await t.send(m);
    expect(kids(t, 'sales')).toHaveLength(1);
    expect(t.port.posts.filter((p) => bodyOf(p).startsWith('➜'))).toHaveLength(0);
    expect(t.port.handoffIds.size).toBe(1);
  });
  it('RR-C19: the chain refusal (the owner mentions a department that is already in the chain of work)', async () => {
    const t = await mk();
    const thread = '1570000000000000801';
    t.port.workDenied.add(`hq|${thread}`);
    await t.tasks.create({ title: 'T', deptId: 'software', owner: CTO, requester: HQ, origin: 'delegated', status: 'doing', threadId: thread, channelId: '1565682159375749161' });
    const m = bot(CTO, { channelId: thread, parentChannelId: '1565682159375749161', threadId: thread, mentionedHeads: ['hq'], replyToId: undefined });
    t.prov.rows.set(m.id, { tainted: false, userId: null, answer: false });
    await t.send(m);
    expect(kids(t)).toHaveLength(0);
    expect(t.port.posts.map(bodyOf).find((b) => b.startsWith('➜'))).toContain('แผนกนั้นอยู่ในสายงานเดียวกันอยู่แล้ว');
  });
  it('a persona that mentions another head: refusal not_allowed (a persona reaches only its own head)', async () => {
    const t = await mk();
    const m = bot(SA, { channelId: '1565670817646256178', replyToId: undefined }); // its own direct room
    t.port.workDenied.add('sales|1565670817646256178');
    t.prov.rows.set(m.id, { tainted: false, userId: null, answer: false });
    await t.send(m);
    expect(all(t)).toHaveLength(0);
  });
});

describe('G2RR-03 a persona mentioner is posted for by its head only when the head can work there', () => {
  const room = '1565670817646256178'; // system-analyst's direct room
  const persona = async (headCanWork: boolean) => {
    const t = await mk();
    t.port.workDenied.add(`sales|${room}`);
    if (!headCanWork) t.port.workDenied.add(`software|${room}`);
    const m = bot(SA, { channelId: room, replyToId: undefined });
    t.prov.rows.set(m.id, { tainted: false, userId: null, answer: false });
    await t.send(m);
    return t;
  };
  it('head can work: the refusal is posted; head cannot: log only, nothing posted', async () => {
    const yes = await persona(true);
    expect(yes.port.posts.filter((p) => bodyOf(p).startsWith('➜'))).toHaveLength(1);
    const no = await persona(false);
    expect(all(no)).toHaveLength(0);
    expect(no.port.posts.filter((p) => bodyOf(p).startsWith('➜'))).toHaveLength(0);
  });
});

describe('RR-C9 tri-state access', () => {
  it('unknown keeps today\'s route (the head runs in the source), creates nothing and is never cached; a definite answer is cached', async () => {
    const t = await mk();
    t.port.workUnknown.add(`sales|${LOUNGE}`);
    await t.send(ceo(t));
    await t.send(ceo(t));
    expect(all(t)).toHaveLength(0);
    expect(t.run).toHaveBeenCalledWith(expect.objectContaining({ route: expect.objectContaining({ actor: SALES, reason: 'mention' }) }), expect.anything());
    expect(t.port.workCalls.filter((c) => c.dept === 'sales')).toHaveLength(2); // asked again
    const u = await mk();
    lounge(u);
    await u.send(ceo(u));
    await u.send(ceo(u));
    expect(u.port.workCalls.filter((c) => c.dept === 'sales' && c.id === LOUNGE)).toHaveLength(1); // cached
  });
  it('an access check that throws counts as unknown', async () => {
    const t = await mk();
    t.port.botCanWork = async () => { throw new Error('boom'); };
    await t.send(ceo(t));
    expect(all(t)).toHaveLength(0);
    expect(t.run).toHaveBeenCalled();
  });
});

describe('RR-C10 card mode', () => {
  it('a private thread under the target\'s own work room: link; a public channel: full; channelIsPublic throws: link', async () => {
    const t = await mk();
    const thread = '1570000000000000700';
    t.port.workDenied.add(`sales|${thread}`);
    const m = bot(HQ, { channelId: thread, parentChannelId: SALES_WORK, threadId: thread, replyToId: undefined });
    t.prov.rows.set(m.id, { tainted: false, userId: null, answer: false });
    await t.send(m);
    expect(kids(t, 'sales')[0]!.forwardCard).toBe('link');
    const p = await mk();
    lounge(p);
    p.port.publicChannel.set(LOUNGE, true);
    await p.send(ceo(p));
    expect(kids(p, 'sales')[0]!.forwardCard).toBe('full');
    const e = await mk();
    lounge(e);
    e.port.channelIsPublic = async () => { throw new Error('boom'); };
    await e.send(ceo(e));
    expect(kids(e, 'sales')[0]!.forwardCard).toBe('link');
  });
});

describe('RR-C11/C12/C13 a person mentioning a head', () => {
  it('a member who can post in the room gets a human-origin root task owned by the head, run now, and a notice', async () => {
    const t = await mk();
    t.port.workDenied.add(`sales|${LOUNGE}`);
    await t.send(person());
    const [kid] = kids(t, 'sales');
    expect(kid).toMatchObject({ parentId: null, origin: 'chat', requester: { kind: 'human', userId: '42' }, owner: SALES, channelId: SALES_WORK, title: 'Rerouted mention (from member)', tainted: false });
    expect(t.run).toHaveBeenCalledWith(expect.objectContaining({ route: expect.objectContaining({ actor: SALES }) }), expect.anything());
    expect(notices(t)).toHaveLength(1);
    expect(notices(t)[0]!.actor).toEqual(HQ);
    expect(t.prov.recorded.find((r) => r.id === t.port.posts.find((p) => bodyOf(p).startsWith('➜'))!.id)).toMatchObject({ userId: '42', answer: false });
  });
  it('a view-only member (no send right in the target room): refusal no_access, zero tasks', async () => {
    const t = await mk();
    t.port.workDenied.add(`sales|${LOUNGE}`);
    t.port.memberPost.set(`42|${SALES_WORK}`, false);
    await t.send(person());
    expect(all(t)).toHaveLength(0);
    expect(notices(t).map(bodyOf)[0]).toContain('คุณยังไม่มีสิทธิ์โพสต์ในห้องงานของแผนกนั้น');
  });
  it('the 4th open reroute by one member is refused (limit), zero new tasks', async () => {
    const t = await mk();
    t.port.workDenied.add(`sales|${LOUNGE}`);
    for (let i = 0; i < 3; i++) await t.tasks.create({ title: 'old', deptId: 'rnd', owner: { kind: 'head', dept: 'rnd' }, requester: { kind: 'human', userId: '42' }, origin: 'chat', rerouteSourceId: nid(), rerouteWhere: LOUNGE });
    await t.send(person());
    expect(kids(t, 'sales')).toHaveLength(0);
    expect(notices(t).map(bodyOf)[0]).toContain('ถึงขีดจำกัดของงานแล้ว');
  });
  it('a hostile display name never reaches the title, the thread name or the card', async () => {
    const t = await mk();
    t.port.workDenied.add(`sales|${LOUNGE}`);
    await t.send(person({ author: { id: '42', name: '@everyone <@123> ‮x', kind: 'human' } }));
    const re = /^Rerouted mention \(from (?:[a-z]+|member)\)$/;
    expect(kids(t, 'sales')[0]!.title).toMatch(re);
    for (const th of t.port.threads) expect(th.name.replace(/^[^ ]* /, '')).toContain('Rerouted mention (from member)');
    expect(JSON.stringify(t.port.tasks)).not.toContain('@everyone');
  });
  it('the same person asking the same department twice in the lounge gets two tasks (the 15-minute guard is for bot chunks)', async () => {
    const t = await mk();
    t.port.workDenied.add(`sales|${LOUNGE}`);
    await t.send(person());
    await t.send(person());
    expect(kids(t, 'sales')).toHaveLength(2);
    expect(notices(t)).toHaveLength(2);
  });
  it('G2RR-02: four messages at once from one person to four departments (different keys) still stop at 3 open reroute roots', async () => {
    const t = await mk();
    const four = ['sales', 'rnd', 'marketing', 'hr'];
    for (const d of four) t.port.workDenied.add(`${d}|${LOUNGE}`);
    await Promise.all(four.map((d) => t.s.onMessage(person({ mentionedHeads: [d as never] }))));
    await t.s.idle();
    expect(kids(t)).toHaveLength(3);
  });
  it('a human mentions at most 3 heads per message', async () => {
    const t = await mk();
    for (const d of ['sales', 'rnd', 'marketing', 'hr']) t.port.workDenied.add(`${d}|${LOUNGE}`);
    await t.send(person({ mentionedHeads: ['sales', 'rnd', 'marketing', 'hr'] }));
    expect(kids(t)).toHaveLength(3);
  });
});

describe('RR-C14 ids and duplicates', () => {
  it('a message id that is not a snowflake is skipped with a warning', async () => {
    const t = await mk();
    lounge(t);
    const m = bot(HQ, { id: 'stall-1' });
    t.prov.rows.set('stall-1', { tainted: false, userId: '42', answer: true });
    await t.send(m);
    expect(all(t)).toHaveLength(0);
    expect(t.log.warn).toHaveBeenCalled();
  });
  it('the same message delivered twice (a restart) makes one task and takes no second per-root slot', async () => {
    const t = await mk();
    lounge(t);
    const m = ceo(t);
    await t.send(m);
    const conv = convs(t)[0]!;
    expect(t.tasks.forwardsTaken.get(conv.id)).toBe(1);
    const again = await mk({ tasks: t.tasks, prov: t.prov, port: t.port });
    await again.send(m);
    expect(kids(t, 'sales')).toHaveLength(1);
    expect(t.tasks.forwardsTaken.get(conv.id)).toBe(1);
  });
  it('a unique violation of another constraint is a fault (an incident), not a quiet duplicate', async () => {
    const t = await mk();
    lounge(t);
    vi.spyOn(t.tasks, 'createUnderOpenParent').mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505', constraint: 'some_other_index' }));
    await t.send(ceo(t));
    expect(t.incidents.report).toHaveBeenCalled();
    const dup = await mk();
    lounge(dup);
    vi.spyOn(dup.tasks, 'createUnderOpenParent').mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505', constraint: 'tasks_reroute_once' }));
    await dup.send(ceo(dup));
    expect(dup.incidents.report).not.toHaveBeenCalled();
    expect(kids(dup)).toHaveLength(0);
  });
});

describe('RR-C15 halt', () => {
  it('a halt that lands while the provenance poll waits: zero tasks, zero notices', async () => {
    const t = await mk();
    lounge(t);
    const m = ceo(t);
    t.prov.appearAt.set(m.id, 3);
    const lookup = t.prov.lookup.bind(t.prov);
    t.prov.lookup = async (ids) => {
      if ((t.prov.calls.get(m.id) ?? 0) === 1) t.halted.v = true;
      return lookup(ids);
    };
    await t.s.onMessage(m);
    await t.s.idle();
    expect(all(t)).toHaveLength(0);
    expect(t.port.posts).toHaveLength(0);
  });
  it('halted before the message: nothing at all', async () => {
    const t = await mk();
    lounge(t);
    t.halted.v = true;
    await t.send(ceo(t));
    expect(all(t)).toHaveLength(0);
  });
});

describe('RR-C16 notices are inert', () => {
  it('the rendered notice and refusal (with a department name that holds @Sales and a raw mention) route nowhere', async () => {
    const org = await seededOrg({ editDept: (d) => (d.id === 'sales' ? { ...d, name: '@Sales <@123456789012345678> @everyone' } : d) });
    const t = await mk({ org });
    lounge(t);
    await t.send(ceo(t));
    t.port.view.set(`42|${SALES_WORK}`, false);
    await t.send(ceo(t, { channelId: LOUNGE, content: 'again @Sales' }, { tainted: false, userId: '42', answer: true }));
    const bodies = t.port.posts.map(bodyOf).filter((b) => b.startsWith('➜'));
    expect(bodies.length).toBeGreaterThanOrEqual(2); // a notice and a refusal
    const inbound: InboundCtx = {
      guildId: GUILD, adminRoleId: '1', botUserIds: new Map<string, DeptId>([['1565000000000000101', 'hq'], ['1565000000000000102', 'sales']]), webhooks: new Map(), personaByName: () => null,
    };
    const before = { runs: t.run.mock.calls.length, tasks: all(t).length, posts: t.port.posts.length };
    for (const b of bodies) {
      expect(b).not.toContain('<@');
      expect(b).not.toContain('@everyone');
      // what the gateway would deliver: Discord resolves only a well-formed raw mention, so the resolved user list of this text must be empty
      const resolved = [...b.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]!);
      const echoed = toIncoming({
        id: nid(), guildId: GUILD, channelId: LOUNGE, channel: { id: LOUNGE, isThread: () => false, parentId: 'cat-1' }, author: { id: '1565000000000000101', username: 'hq', bot: true, globalName: null }, member: null,
        webhookId: null, applicationId: null, content: b, mentions: { users: new Map(resolved.map((id) => [id, { id }])), repliedUser: null, everyone: false, roles: new Map() },
        attachments: new Map(), embeds: [], system: false, reference: null, messageSnapshots: { first: () => undefined },
      } as never, inbound)!;
      expect(echoed.author.actor).toEqual(HQ);
      expect(echoed.mentionedHeads).toEqual([]);
      expect(await route(echoed, { org, taskByThread: async () => null })).toEqual([]);
      t.prov.rows.set(echoed.id, { tainted: false, userId: '42', answer: false });
      await t.send(echoed); // through the scheduler: no run, no task, no post, so no turn for the warroom guard to count
    }
    expect(t.run.mock.calls.length).toBe(before.runs);
    expect(all(t)).toHaveLength(before.tasks);
    expect(t.port.posts).toHaveLength(before.posts);
    for (const p of t.port.posts.filter((x) => bodyOf(x).startsWith('➜'))) {
      expect(p.payload).toMatchObject({ noHandles: true });
      expect(t.prov.recorded.find((r) => r.id === p.id)).toMatchObject({ answer: false });
    }
  });
  it('a notice is never posted in the bot-to-bot warroom', async () => {
    const t = await mk();
    const thread = '1570000000000000901';
    t.port.workDenied.add(`sales|${thread}`);
    const m = bot(HQ, { channelId: thread, parentChannelId: AI_WARROOM_CHANNEL_ID, threadId: thread, replyToId: undefined });
    t.prov.rows.set(m.id, { tainted: false, userId: null, answer: false });
    await t.send(m);
    expect(kids(t, 'sales')).toHaveLength(1);
    expect(t.port.posts.filter((p) => bodyOf(p).startsWith('➜'))).toHaveLength(0);
  });
});

describe('RR-C17 quote hygiene', () => {
  it('a planted secret is masked in the description and every log line; invisible and full-width characters are neutralised; the owner\'s text is absent', async () => {
    const secret = 'sk-live-ABCDEF1234567890';
    const t = await mk({ secrets: [secret] });
    lounge(t);
    await t.send(ceo(t, { content: `@Sales look ​${secret} and ＠everyone <@123456789012345678> now` }));
    const kid = kids(t, 'sales')[0]!;
    expect(kid.description).not.toContain(secret);
    expect(kid.description).not.toContain('​');
    expect(kid.description).not.toContain('＠');
    expect(kid.description).not.toMatch(/(^|[^‍])@everyone/);
    expect(kid.description).not.toMatch(/<@123/);
    expect(kid.description).not.toContain('PRIVATE owner words');
    expect(kid.description.split('\n')[0]).toBe(`Rerouted mention from hq. Source: https://discord.com/channels/${GUILD}/${LOUNGE}/${kid.rerouteSourceId}`);
    const lines = JSON.stringify([t.log.error.mock.calls, t.log.warn.mock.calls]);
    expect(lines).not.toContain(secret);
    expect(JSON.stringify(t.port.posts)).not.toContain(secret);
  });
});

describe('RR-C18 caps', () => {
  it('a CEO message mentioning six heads: the router takes five, at most four children in the one adopted root', async () => {
    const t = await mk();
    const six = ['sales', 'rnd', 'marketing', 'hr', 'finance', 'ops'] as const;
    lounge(t, [...six]);
    await t.send(ceo(t, { mentionedHeads: [...six] }));
    expect(convs(t)).toHaveLength(1);
    expect(kids(t)).toHaveLength(4);
    expect(new Set(kids(t).map((k) => k.parentId))).toEqual(new Set([convs(t)[0]!.id]));
    expect(t.tasks.forwardsTaken.get(convs(t)[0]!.id)).toBe(4);
    expect(t.port.posts.map(bodyOf).some((b) => b.includes('ถึงขีดจำกัดของงานแล้ว'))).toBe(true);
  });
  it('the per-root forward slots are shared with forward_to: exhausted means refusal limit and no task', async () => {
    const t = await mk();
    const thread = '1570000000000000802';
    t.port.workDenied.add(`sales|${thread}`);
    const parent = await t.tasks.create({ title: 'T', deptId: 'software', owner: CTO, requester: HQ, origin: 'delegated', status: 'doing', threadId: thread, channelId: '1565682159375749161' });
    t.tasks.forwardsTaken.set(parent.rootId, 4);
    const m = bot(CTO, { channelId: thread, parentChannelId: '1565682159375749161', threadId: thread, replyToId: undefined });
    t.prov.rows.set(m.id, { tainted: false, userId: null, answer: false });
    await t.send(m);
    expect(kids(t)).toHaveLength(0);
    expect(t.port.posts.map(bodyOf).find((b) => b.startsWith('➜'))).toContain('ถึงขีดจำกัดของงานแล้ว');
  });
});

describe('RR-C20 kill switch and the other safety rails', () => {
  it('reroute.enabled is a handler key: config_propose cannot write it', () => {
    expect(ADMIN_CONFIG_KEYS).not.toContain('reroute.enabled');
    expect(HANDLER_KEYS).toContain('reroute.enabled');
  });
  it('off (or unreadable): the moved route is dropped, nothing runs, nothing is created, one warning', async () => {
    for (const how of ['off', 'throws'] as const) {
      const cfg = new FakeConfig({ 'schedule.offDays': [0, 6], ...(how === 'off' ? { 'reroute.enabled': false } : {}) });
      if (how === 'throws') cfg.throwOn.add('reroute.enabled');
      const t = await mk({ cfg });
      lounge(t);
      await t.send(ceo(t));
      await t.send(ceo(t));
      expect(all(t), how).toHaveLength(0);
      expect(t.run, how).not.toHaveBeenCalled();
      expect(t.log.warn, how).toHaveBeenCalledTimes(1);
    }
  });
  it('Praw is never rerouted: dropped with a warning', async () => {
    const t = await mk();
    t.port.workDenied.add(`praw|${LOUNGE}`);
    await t.send(person({ mentionedHeads: ['praw'], content: '@Praw hi' }));
    expect(all(t)).toHaveLength(0);
    expect(t.run).not.toHaveBeenCalled();
    expect(t.log.warn).toHaveBeenCalled();
  });
  it('the TW6 daily cap on bot-started root tasks refuses (limit) and creates nothing', async () => {
    const t = await mk({ rootCap: 0 });
    t.port.workDenied.add(`sales|${LOUNGE}`);
    await t.send(ceo(t, {}, { tainted: false, userId: '42', answer: false }));
    expect(all(t)).toHaveLength(0);
    expect(notices(t).map(bodyOf)[0]).toContain('ถึงขีดจำกัดของงานแล้ว');
  });
  it('a target without a work room, a disabled or an offline department is refused with its own fixed reason', async () => {
    const t = await mk({ org: await seededOrg({ editDept: (d) => (d.id === 'rnd' ? { ...d, enabled: false } : d.id === 'sales' ? { ...d, workChannelId: null } : d) }) });
    t.port.workDenied.add(`sales|${LOUNGE}`);
    await t.send(person({ mentionedHeads: ['sales'] }));
    expect(notices(t).map(bodyOf)[0]).toContain('ห้องงานของแผนกนั้นใช้งานไม่ได้');
    expect(all(t)).toHaveLength(0);
  });
  it('an off day: the delegated child waits for the next workday and the notice says so; a person\'s own root still runs', async () => {
    const t = await mk({ now: SAT });
    lounge(t);
    await t.send(ceo(t));
    const kid = kids(t, 'sales')[0]!;
    expect(kid.status).toBe('todo');
    expect(t.run).not.toHaveBeenCalledWith(expect.objectContaining({ route: expect.objectContaining({ actor: SALES, reason: 'task_owner' }) }), expect.anything());
    expect(notices(t).map(bodyOf)[0]).toContain('(เริ่มวันทำงานถัดไป)');
    const h = await mk({ now: SAT });
    h.port.workDenied.add(`sales|${LOUNGE}`);
    await h.send(person());
    expect(h.run).toHaveBeenCalledWith(expect.objectContaining({ route: expect.objectContaining({ actor: SALES }) }), expect.anything());
  });
  it('a held title never changes on the DEPT_IDS list (labels are dept ids or member)', () => {
    expect(DEPT_IDS.every((d) => /^[a-z]+$/.test(d))).toBe(true);
  });
});

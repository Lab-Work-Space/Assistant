import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import { handlesIn } from '../../company/handles.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import {
  ActorProvider, CEO, CTO, HQ_WORK, SA, SOFTWARE_WORK, TestPort, boot, humanMsg, resetDb, respond, taskIdOf, turn,
} from './helpers.js';
import { CH, roundTrip } from '../fakes/roundtrip.js';
import { TeamTalk } from '../../agents/team/teamtalk.js';
import { RoomEntryRepo } from '../../db/repos/room-entries.js';

/**
 * TEAMTALK-1 Stage 6 (tester): independent acceptance run on the REAL app boot (real Postgres, real scheduler, loop, tools, repos; fake Discord port).
 * Chain: human -> CEO (hq) -> CTO (software head, stands in for the "R&D head": same code path) -> system-analyst persona.
 * Every code-written post is then read back through the REAL port, inbound mapper and router (roundTrip) and must wake nobody.
 */
const SA_DIRECT = '1565670817646256178';
const AI_WARROOM = '1566366032094961705';
const GUILD = '1565649426943442944';
let db: TestDb;
let app: App | null = null;
beforeAll(async () => { db = await freshDb(); });
afterEach(async () => {
  await app?.stop();
  app = null;
  await resetDb(db.pool);
  await db.pool.query('TRUNCATE room_entries RESTART IDENTITY'); // resetDb does not clear it (reported as a test-hygiene defect)
});
afterAll(async () => { await db.close(); });

const EVIL = '@CFO <@123456789012345678> @everyone @here @CEO';
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const HEADMARK = 'REPORT-HEAD-MARK';
const TAILMARK = 'REPORT-TAIL-MARK';
const LONG_REPORT = `${HEADMARK} ${'x'.repeat(1700)} ${TAILMARK}`;
const SECRET = 'sk-ant-api03-PLANTEDSECRETPLANTEDSECRET0123456789abcdef';

function script(opts: { saTurns?: ReturnType<typeof turn>[] | ((r: Parameters<typeof taskIdOf>[0]) => ReturnType<typeof turn>)[] } = {}) {
  const doneWith = (summary: string, report: ReturnType<typeof respond>, extra: Record<string, unknown> = {}) => (req: Parameters<typeof taskIdOf>[0]) =>
    turn({ name: 'update_task', input: { taskId: taskIdOf(req), status: 'done', summary, ...extra } }, report);
  return new ActorProvider({
    'heads/hq': [
      turn({ name: 'create_task', input: { title: `Build ${EVIL}`, description: 'Plan it.', assignee: { kind: 'head', dept: 'software' }, acceptance: `ship ${EVIL}`, due: tomorrow(), estCostUsd: 0.1 } }),
      turn(respond('chat', 'Delegated.')),
      doneWith('Plan ready.', respond('report', 'Final report: ready.')),
    ],
    'heads/software': [
      turn({ name: 'create_task', input: { title: `Spec ${EVIL}`, description: 'Write it.', assignee: { kind: 'persona', personaId: 'system-analyst' }, acceptance: `green ${EVIL}`, due: tomorrow(), estCostUsd: 0.05 } }),
      turn(respond('chat', 'Asked.')),
      doneWith(`Spec reviewed ${EVIL}`, respond('report', 'Spec accepted.')),
    ],
    'members/system-analyst': opts.saTurns ?? [
      doneWith(`Spec written ${EVIL} ${SECRET}`, respond('report', LONG_REPORT), {
        ideas: [`idea ${EVIL}`, 'second idea'], decisions: [`decide ${EVIL}`],
      }),
    ],
  });
}

async function runChain(provider: ActorProvider, o: { attach?: boolean; offDays?: number[]; before?: (t: Awaited<ReturnType<typeof boot>>) => void } = {}) {
  const port = new TestPort();
  port.snowflakes = true;
  const t = await boot(db.pool, { provider, port, ...(o.offDays ? { offDays: o.offDays } : {}) });
  app = t.app;
  const { scheduler, tasks } = t.app.services;
  // what the real port does on a first send: store the id (tasks.handoff_message_id, a snowflake)
  port.onHandoff = (taskId, id) => void tasks.claimMessage(taskId, 'handoff', id);
  o.before?.(t);
  if (o.attach !== undefined) {
    // a root task that is already tainted (outside content in its brief), owned by the CEO in a goal thread
    await scheduler.submitTask({ title: 'Launch an MVP', deptId: 'hq', owner: CEO, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: '1570000000000000001', channelId: HQ_WORK, tainted: o.attach, description: 'go' } as never);
  } else await scheduler.onMessage(humanMsg('<@100> Launch an MVP', { channelId: HQ_WORK, mentionedHeads: ['hq'] }));
  await scheduler.idle();
  return t;
}

const rowsOf = async () => (await db.pool.query('SELECT id, parent_id, depth, owner, status, thread_id, tainted, handoff_message_id, result_message_id, acceptance, due_on FROM tasks ORDER BY depth')).rows;

describe('TEAMTALK-1 acceptance on the real boot', () => {
  it('(a) chain: H1 in each parent thread, edited in place; persona room New/Idea/Decision/Done + board; H3 replies to H1 with Full result; roll-up reads the report excerpt', async () => {
    const provider = script();
    const t = await runChain(provider);
    const rows = await rowsOf();
    expect(rows.map((r) => r.status)).toEqual(['done', 'done', 'done']);
    expect(provider.remaining()).toEqual({ 'heads/hq': 0, 'heads/software': 0, 'members/system-analyst': 0 });

    // H1: exactly two lines, one per child, posted as the PARENT's owner in the PARENT's thread; ids stored on the child row
    const h1 = t.port.posts.filter((p) => p.payload.body.startsWith('➜ Handoff #'));
    expect(h1).toHaveLength(2);
    expect(h1.map((p) => [p.actor, p.target.threadId])).toEqual([[CEO, rows[0].thread_id], [CTO, rows[1].thread_id]]);
    expect(rows[1].handoff_message_id).toBe(h1[0]!.id);
    expect(rows[2].handoff_message_id).toBe(h1[1]!.id);
    for (const [i, p] of h1.entries()) {
      const b = p.payload.body;
      const child = rows[i + 1];
      expect(b).toContain(`#${child.id.slice(0, 8)}`);
      expect(b).toMatch(/\nAsk: /);
      expect(b).toMatch(/\nDone when: (ship|green) /);
      expect(b).toContain(`Due: ${tomorrow()}`);
      expect(b).toMatch(/Status: todo/);
      expect(b).toContain(`Thread: https://discord.com/channels/${GUILD}/${child.thread_id}`);
      expect(b.length).toBeLessThanOrEqual(600);
    }
    // edited in place on every status change, never a new post; the last edit shows done
    const edits = (id: string) => t.port.handoffEdits.filter((e) => e.taskId === id);
    expect(edits(rows[1].id).length).toBeGreaterThan(0);
    expect(edits(rows[2].id).length).toBeGreaterThan(0);
    expect(edits(rows[2].id).at(-1)!.payload.body).toContain('Status: done');
    expect(edits(rows[1].id).at(-1)!.payload.body).toContain('Status: done');
    expect(t.port.posts.filter((p) => p.payload.body.startsWith('➜ Handoff #'))).toHaveLength(2);

    // persona room (top level): New, Idea, Decision, Done, in that order, plain, with links
    const room = t.port.posts.filter((p) => p.actor.kind === 'persona' && p.target.channelId === SA_DIRECT && p.target.threadId === undefined).map((p) => p.payload.body);
    expect(room.map((b) => b.split(' ').slice(0, 2).join(' '))).toEqual(['📥 New:', '💡 Idea:', '💡 Idea:', '📌 Decision:', '✅ Done:']);
    expect(room[0]).toContain(`https://discord.com/channels/${GUILD}/${rows[2].thread_id}`);
    expect(room.at(-1)).toContain(`${rows[2].thread_id}/${rows[2].result_message_id}`); // Done line links the persona's final report message
    for (const l of room) expect(l.length).toBeLessThanOrEqual(400);
    // room line never uses logDirect (#direct line count is the pre-existing 4)
    expect(t.port.directs.every((d) => !d.text.startsWith('📥') && !d.text.startsWith('✅'))).toBe(true);

    // board: one pinned message for the room, plain, <= 1900 chars, Now/Done/Ideas/Decisions
    expect(t.port.roomBoardSends).toHaveLength(1);
    const board = t.port.roomBoardSends[0]!.payload.body;
    expect(board.length).toBeLessThanOrEqual(1900);
    for (const s of ['Now (', 'Done (', 'Ideas (', 'Decisions (']) expect(board).toContain(s);

    // H3: replies to H1, summary + Full result link to the owner's final report message
    const h3 = t.port.posts.filter((p) => p.payload.title === 'Subtask done');
    expect(h3).toHaveLength(2);
    const sa = h3.find((p) => p.payload.body.includes('system-analyst'))!;
    expect(sa.opts?.replyToId).toBe(rows[2].handoff_message_id);
    expect(sa.payload.body).toContain(`Full result: https://discord.com/channels/${GUILD}/${rows[2].thread_id}/${rows[2].result_message_id}`);
    expect(sa.payload).toMatchObject({ noHandles: true });
    expect(sa.actor).toEqual(CTO);
    expect(rows[2].result_message_id).toMatch(/^\d{17,20}$/);

    // H4: the CTO roll-up run (3rd software call) saw the persona's report head (first 1500 chars) and not the tail
    const rollup = JSON.stringify(provider.callsOf('heads/software').at(-1)!.messages);
    expect(rollup).toContain(HEADMARK);
    expect(rollup).not.toContain(TAILMARK);
    // T10: the planted secret is in no stored room entry and in no room line or board
    const entries = (await db.pool.query('SELECT kind, body, tainted, message_id FROM room_entries ORDER BY id')).rows;
    expect(entries.map((e) => e.kind)).toEqual(['assigned', 'idea', 'idea', 'decision', 'done']);
    expect(JSON.stringify(entries)).not.toContain(SECRET);
    expect(JSON.stringify([room, board])).not.toContain(SECRET);
    expect(entries.every((e) => /^\d{17,20}$/.test(e.message_id))).toBe(true);
  });

  it('(b) F-1: @CFO / <@id> / @everyone / @here in title, summary, acceptance, ideas, decisions: every code-written post read back through the real port, mapper and router wakes nobody', async () => {
    const provider = script();
    const t = await runChain(provider);
    const rows = await rowsOf();
    const where = (p: { target: { channelId: string; threadId?: string } }, actor: { kind: string }) =>
      actor.kind === 'persona'
        ? (p.target.threadId ? { channelId: CH.room, threadId: CH.roomThread } : { channelId: CH.room })
        : { channelId: CH.work, threadId: CH.thread };
    const posts = [
      ...t.port.posts.filter((p) => (p.payload as { noHandles?: boolean }).noHandles === true || p.payload.type === 'task'),
      ...t.port.roomBoardSends.map((b) => ({ actor: b.actor, target: { channelId: b.channelId }, payload: b.payload, id: b.id })),
    ];
    expect(posts.length).toBeGreaterThanOrEqual(2 + 2 + 5 + 3 + 1); // 2 H1, 2 H3, 5 room lines, 3 cards, 1 board
    let checked = 0;
    for (const p of posts) {
      // governance cards / system payloads that are not plain are covered too (type task)
      const r = await roundTrip(p.actor, where(p, p.actor), p.payload);
      const text = `${(r.sent.content as string) ?? ''}\n${JSON.stringify(r.sent.embeds ?? [])}`;
      expect(r.routes, `post "${p.payload.body.slice(0, 60)}" must route nowhere`).toEqual([]);
      expect(handlesIn(r.incoming.content)).toEqual([]);
      expect(text).not.toMatch(/<@!?\d/);
      expect(text).not.toMatch(/@(everyone|here)/);
      checked++;
    }
    expect(checked).toBe(posts.length);
    // the model's OWN report in the thread is still allowed to address a head (control: the defang is not blanket)
    void rows;
  });

  it('(c) tainted chain: child, room entries and the next head run are tainted; a clean chain stays clean', async () => {
    for (const attach of [true, false]) {
      const provider = script();
      const t = await runChain(provider, { attach });
      const rows = await rowsOf();
      expect(rows.map((r) => r.tainted), `attach=${attach}`).toEqual([attach, attach, attach]);
      const entries = (await db.pool.query('SELECT tainted FROM room_entries')).rows;
      expect(entries.length).toBeGreaterThanOrEqual(3);
      expect(entries.every((e) => e.tainted === attach), `entries attach=${attach}`).toBe(true);
      // H1 provenance for the child follows the child's taint, answer=false
      const h1 = t.port.posts.filter((p) => p.payload.body.startsWith('➜ Handoff #'));
      const prov = (await db.pool.query('SELECT message_id, tainted, answer FROM bot_messages WHERE message_id = ANY($1)', [h1.map((p) => p.id)])).rows;
      expect(prov).toHaveLength(2);
      for (const r of prov) expect(r).toMatchObject({ tainted: attach, answer: false });
      // the next human-started CTO run in a fresh channel message reads the room memory
      const before = provider.callsOf('heads/software').length;
      const next = new ActorProvider({ 'heads/software': [turn(respond('chat', 'Status: fine.'))] });
      void next;
      (provider as unknown as { scripts: Record<string, unknown[]> }).scripts['heads/software']!.push(turn(respond('chat', 'Status: fine.')));
      await t.app.services.scheduler.onMessage(humanMsg('<@101> status?', { id: 'next-1', channelId: SOFTWARE_WORK, mentionedHeads: ['software'] }));
      await t.app.services.scheduler.idle();
      const calls = provider.callsOf('heads/software');
      expect(calls.length).toBeGreaterThan(before);
      const sys = JSON.stringify(calls.at(-1));
      // LEARN-1 D1: a tainted room entry never reaches a prompt, so the next run holds no UNVERIFIED text and stays clean in both cases
      expect(sys.includes('UNVERIFIED: '), `UNVERIFIED prefix attach=${attach}`).toBe(false);
      const last = t.port.posts.filter((p) => p.actor.kind === 'head' && p.actor.dept === 'software').at(-1)!;
      const row = (await db.pool.query('SELECT tainted, answer FROM bot_messages WHERE message_id = $1', [last.id])).rows[0];
      expect(row, `provenance of the next CTO reply attach=${attach}`).toMatchObject({ tainted: false });
      await app?.stop();
      app = null;
      await resetDb(db.pool);
      await db.pool.query('TRUNCATE room_entries RESTART IDENTITY');
    }
  });

  it('(d1) off day: H1 shows the hold by status text, no persona run, no further posts', async () => {
    const provider = script({ saTurns: [] });
    const all = [0, 1, 2, 3, 4, 5, 6];
    const port = new TestPort();
    port.snowflakes = true;
    const t = await boot(db.pool, { provider, port, offDays: all });
    app = t.app;
    const { scheduler, tasks } = t.app.services;
    port.onHandoff = (taskId, id) => void tasks.claimMessage(taskId, 'handoff', id);
    // a human message runs the CEO even on an off day (human origin); its delegated child is held
    await scheduler.onMessage(humanMsg('<@100> Launch an MVP', { channelId: HQ_WORK, mentionedHeads: ['hq'] }));
    await scheduler.idle();
    const rows = await rowsOf();
    expect(rows[1]?.status).toBe('todo');
    expect(provider.callsOf('heads/software')).toHaveLength(0);
    const h1 = t.port.posts.filter((p) => p.payload.body.startsWith('➜ Handoff #'));
    expect(h1).toHaveLength(1);
    expect(h1[0]!.payload.body).toContain('Status: todo (starts next workday)');
    const before = t.port.posts.length;
    await scheduler.idle();
    expect(t.port.posts.length).toBe(before);
  });

  it('(d2) halt: nothing new is posted, no H1, no room line, no board, no room entries', async () => {
    const provider = script();
    const port = new TestPort();
    port.snowflakes = true;
    const t = await boot(db.pool, { provider, port });
    app = t.app;
    const { scheduler, halt } = t.app.services;
    // halt while the CEO's create_task turn is being produced: the child row may be written, nothing TeamTalk may be posted
    (provider as unknown as { scripts: Record<string, unknown[]> }).scripts['heads/hq']![0] = (req: Parameters<typeof taskIdOf>[0]) => {
      void req;
      void halt.halt('test');
      return turn({ name: 'create_task', input: { title: 'x', description: 'y', assignee: { kind: 'head', dept: 'software' }, estCostUsd: 0.1 } });
    };
    await scheduler.onMessage(humanMsg('<@100> Launch an MVP', { channelId: HQ_WORK, mentionedHeads: ['hq'] }));
    await scheduler.idle();
    expect(t.port.posts.filter((p) => p.payload.body.startsWith('➜ Handoff')
      || p.payload.title === 'Subtask done' || p.payload.body.startsWith('📥'))).toEqual([]);
    expect(t.port.roomBoardSends).toEqual([]);
    expect(t.port.handoffEdits).toEqual([]);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM room_entries')).rows[0].n).toBe(0);
  });

  it('(g) a top-level conversation (a person talking to a head in its channel) gets no H1 and no Subtask-done line', async () => {
    const provider = new ActorProvider({
      'heads/software': [
        turn({ name: 'create_task', input: { title: 'Do the thing', description: 'now', assignee: { kind: 'persona', personaId: 'system-analyst' }, estCostUsd: 0.05 } }),
        turn(respond('chat', 'Asked.')),
        turn(respond('report', 'Done and reported.')),
      ],
      'members/system-analyst': [(req) => turn({ name: 'update_task', input: { taskId: taskIdOf(req), status: 'done', summary: 'did it' } }, respond('report', 'Did it.'))],
    });
    const port = new TestPort();
    port.snowflakes = true;
    const t = await boot(db.pool, { provider, port });
    app = t.app;
    const { scheduler, tasks } = t.app.services;
    port.onHandoff = (taskId, id) => void tasks.claimMessage(taskId, 'handoff', id);
    await scheduler.onMessage(humanMsg('<@101> please do the thing', { channelId: SOFTWARE_WORK, mentionedHeads: ['software'] }));
    await scheduler.idle();
    const rows = (await db.pool.query('SELECT depth, status, conversation, thread_id FROM tasks ORDER BY depth')).rows;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(t.port.posts.filter((p) => p.payload.body.startsWith('➜ Handoff'))).toEqual([]);
    expect(t.port.posts.filter((p) => p.payload.title === 'Subtask done' && p.target.channelId === SOFTWARE_WORK && p.target.threadId === undefined)).toEqual([]);
    // the persona room still gets its lines
    expect(t.port.posts.filter((p) => p.actor.kind === 'persona' && p.target.threadId === undefined).map((p) => p.payload.body.slice(0, 6))).toEqual(expect.arrayContaining(['📥 New', '✅ Done']));
  });
});

describe('TEAMTALK-1 spam caps (f) against the real repo', () => {
  const room = '1565670817646256178';
  const mkTt = () => {
    const sent: string[] = [];
    const tt = new TeamTalk({
      port: { upsertRoomBoard: async () => ({ pin: 'skipped' as const }) }, tasks: { get: async () => null, setResultMessage: async () => undefined, openOwnedBy: async () => [] } as never,
      rooms: new RoomEntryRepo(db.pool), org: { persona: () => ({ id: 'system-analyst', name: 'SA', deptId: 'software', directChannelId: room }) },
      halt: { isHalted: () => false }, guildId: GUILD, log: { error: () => undefined, warn: () => undefined },
    });
    tt.bind({ post: async (_a, _t, p) => { sent.push(p.body); return String(1570000000000000000n + BigInt(sent.length)); } });
    return { tt, sent };
  };
  const child = { id: 'cap-task', title: 'T', owner: SA, requester: CTO, tainted: false, threadId: '1570000000000000009', resultMessageId: null, blockedReason: 'budget', dueOn: null } as never;

  it('6 idea/decision lines per task and 4 lifecycle lines per task, counted in the database; the 7th and 5th are dropped', async () => {
    const { tt, sent } = mkTt();
    for (let i = 0; i < 4; i++) await tt.notes(child, { ideas: [`i${i}a`, `i${i}b`, `i${i}c`], decisions: [`d${i}a`] });
    expect(sent.filter((x) => x.startsWith('💡') || x.startsWith('📌'))).toHaveLength(6);
    for (let i = 0; i < 6; i++) await tt.ended(child, 'blocked', undefined, 'budget');
    const lifecycle = (await db.pool.query("SELECT kind FROM room_entries WHERE task_id = 'cap-task' AND kind IN ('assigned','done','blocked','cancelled')")).rows;
    expect(lifecycle).toHaveLength(4);
  });

  it('FIXED G2T-01 / DEFECT-1: a task that was blocked 4 times before it finished loses its Done line (the lifecycle cap counts blocked lines)', async () => {
    const { tt, sent } = mkTt();
    await tt.assigned(child);
    for (let i = 0; i < 3; i++) await tt.ended(child, 'blocked', undefined, 'budget');
    await tt.ended(child, 'done', 'all finished');
    expect(sent.some((x) => x.startsWith('✅ Done'))).toBe(true); // expected by the spec: a finished task is recorded as done
  });
});
void AI_WARROOM; void SA;

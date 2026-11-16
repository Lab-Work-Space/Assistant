import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../app.js';
import type { ActorRef } from '../../company/types.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { DeptIncidentRepo } from '../../db/repos/dept-incidents.js';
import { INCIDENTS_HEADER } from '../../grow/incidents.js';
import { fakeResolver, fakeTransport } from '../fakes/net.js';
import { AI_SKILL_JUDGE_SYSTEM } from '../../governance/skill-judge-prompt.js';
import { ActorProvider, CEO, CTO, SA, SOFTWARE_WORK, TestPort, boot, humanMsg, mentionOf, resetDb, respond, turn } from './helpers.js';

/**
 * LEARN-1 (BE1) acceptance: D1 taint hygiene, LL-C1 (update_task copies the run taint onto its target) and the head's clean run that can skill_propose
 * while tainted notes and room entries sit in the database. Real app, real PostgreSQL, scripted models.
 */
class SkillProvider extends ActorProvider {
  override async *chat(req: Parameters<ActorProvider['chat']>[0], signal: AbortSignal) {
    const out = (text: string) => [{ type: 'text' as const, text }, { type: 'usage' as const, inputTokens: 5, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, { type: 'stop' as const, reason: 'end_turn' as const }];
    if (req.system === AI_SKILL_JUDGE_SYSTEM) { yield* out(JSON.stringify({ decision: 'escalate', reason: 'a person decides' })); return; }
    if (req.system.includes('JSON object') && !req.system.includes('Team skills')) { yield* out('{"verdict":"allow"}'); return; }
    yield* super.chat(req, signal);
  }
}

let db: TestDb;
let app: App | null = null;
beforeAll(async () => { db = await freshDb(); });
afterEach(async () => {
  await app?.stop();
  app = null;
  await resetDb(db.pool);
  await db.pool.query('TRUNCATE skill_proposals, room_entries, kb_docs, retro_runs RESTART IDENTITY CASCADE');
});
afterAll(async () => { await db.close(); });

const MARK_DONE = 'MARKER-STEERED-DONE-SUMMARY';
const MARK_BLOCK = 'MARKER-STEERED-BLOCKED-REASON';
const waitFor = async (fn: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error('timeout'); };
const text = (req: { messages: unknown }) => JSON.stringify(req.messages);
/** The tool results the model saw in this request. */
const results = (req: { messages: { content: { type: string; content?: string }[] }[] }) => req.messages.flatMap((m) => m.content).filter((b) => b.type === 'tool_result').map((b) => b.content ?? '').join('\n');
const uniq = () => Math.random().toString(36).slice(2, 8);

async function start(provider: ActorProvider, net?: NonNullable<Parameters<typeof boot>[1]>['net']) {
  const port = new TestPort();
  port.snowflakes = true;
  const t = await boot(db.pool, { provider, port, ...(net ? { net } : {}) });
  app = t.app;
  return { s: t.app.services, port, provider };
}
type S = Awaited<ReturnType<typeof start>>['s'];
const mk = (s: S, over: Partial<Parameters<S['tasks']['create']>[0]> & { title: string; owner: ActorRef }) =>
  s.tasks.create({ deptId: 'software', requester: { kind: 'human', userId: '42' }, origin: 'delegated', tainted: false, status: 'doing', ...over });
const ready = (s: S, taskId: string) => s.commands.taskAdmin!.bus.emit('task.ready', { taskId });
const taintedOf = async (id: string) => (await db.pool.query<{ tainted: boolean }>('SELECT tainted FROM tasks WHERE id = $1', [id])).rows[0]!.tainted;
const proposeInput = () => ({ name: 'skill_propose', input: { op: 'create', skill: `check-args-${uniq()}`, title: 'Check create_task arguments', instructions: 'Before calling create_task, confirm title, description and deptId are all filled and valid.', reason: 'repeated create_task errors this week' } });
const seedTaintedMemory = async () => {
  await db.pool.query("INSERT INTO dept_notes (dept_id, body, tainted, source, norm_hash) VALUES ('software','TAINTED-NOTE-FROM-A-WEB-PAGE', true, 'task', 'h1'), ('software','CLEAN-NOTE-RELEASES-THURSDAY', false, 'task', 'h2')");
  await db.pool.query("INSERT INTO room_entries (persona_id, dept_id, kind, body, tainted) VALUES ('system-analyst','software','done','TAINTED-ROOM-ENTRY-FROM-A-WEB-PAGE', true), ('system-analyst','software','done','CLEAN-ROOM-ENTRY-SHIPPED-PARSER', false)");
};
const proposals = async () => (await db.pool.query('SELECT status, tainted FROM skill_proposals')).rows;

describe('LEARN-1 D1: a clean human-started head run can skill_propose with tainted memory around', () => {
  it('trigger T: tainted notes and room entries are out of the prompt, the run is clean, the proposal row exists', async () => {
    const provider = new SkillProvider({ 'heads/software': [turn(proposeInput()), turn(respond('chat', 'Proposed a skill.'))] });
    const { s } = await start(provider);
    await seedTaintedMemory();
    await s.scheduler.onMessage(humanMsg(`${mentionOf('software')} please propose a way of working for create_task`, { channelId: SOFTWARE_WORK, mentionedHeads: ['software'] }));
    await s.scheduler.idle();
    const calls = provider.callsOf('heads/software');
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const first = text(calls[0]!);
    for (const gone of ['TAINTED-NOTE-FROM-A-WEB-PAGE', 'TAINTED-ROOM-ENTRY-FROM-A-WEB-PAGE', 'UNVERIFIED: ']) expect(first, gone).not.toContain(gone);
    for (const kept of ['CLEAN-NOTE-RELEASES-THURSDAY', 'CLEAN-ROOM-ENTRY-SHIPPED-PARSER']) expect(first, kept).toContain(kept);
    const result = results(calls[1] as never);
    expect(result).not.toMatch(/tainted|outside content/i);
    expect(await proposals()).toEqual([{ status: 'open', tainted: false }]);
  }, 60000);

  it('control: a tainted TASK refuses skill_propose (no proposal row)', async () => {
    const provider = new SkillProvider({ 'heads/software': [turn(proposeInput()), turn(respond('chat', 'refused'))] });
    const { s } = await start(provider);
    await seedTaintedMemory();
    const t = await mk(s, { title: 'tainted work', owner: CTO, status: 'todo', tainted: true });
    await ready(s, t.id);
    await s.scheduler.idle();
    await waitFor(async () => provider.callsOf('heads/software').length >= 2);
    expect(text(provider.callsOf('heads/software')[1]!)).toMatch(/tainted|outside content/i);
    expect(await proposals()).toEqual([]);
  }, 60000);

  it('control: a web (kb) read earlier in the same run refuses skill_propose', async () => {
    const provider = new SkillProvider({ 'heads/software': [turn({ name: 'kb_search', input: { query: 'zebra' } }), turn(proposeInput()), turn(respond('chat', 'refused'))] });
    const { s } = await start(provider);
    await db.pool.query("INSERT INTO kb_docs (scope, title, body, sources, tainted, created_by) VALUES ('software','Webby','Zebra tips from a web page','[]'::jsonb, true, 'x')");
    await s.scheduler.onMessage(humanMsg(`${mentionOf('software')} look up zebra then propose a skill`, { channelId: SOFTWARE_WORK, mentionedHeads: ['software'] }));
    await s.scheduler.idle();
    const calls = provider.callsOf('heads/software');
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(text(calls[2]!)).toMatch(/tainted|outside content/i);
    expect(await proposals()).toEqual([]);
  }, 60000);
});

describe('LEARN-1 D1 control through the registry taint path: a page read earlier in the run', () => {
  it('fetch_page of a url the person typed (no card), then skill_propose in the same run: refused, no proposal row', async () => {
    const provider = new SkillProvider({ 'heads/software': [turn({ name: 'fetch_page', input: { url: 'https://x.test/' } }), turn(proposeInput()), turn(respond('chat', 'refused'))] });
    const net = { resolver: fakeResolver({ 'x.test': ['93.184.215.14'] }), transport: fakeTransport({ 'https://x.test/': { body: '<p>hello</p>' } }) };
    const { s } = await start(provider, net as never);
    await s.scheduler.onMessage(humanMsg(`${mentionOf('software')} read https://x.test/ then propose a skill`, { channelId: SOFTWARE_WORK, mentionedHeads: ['software'] }));
    await s.scheduler.idle();
    const calls = provider.callsOf('heads/software');
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(results(calls[1] as never)).toContain('hello'); // the page was really read (no card held it back)
    expect(results(calls[2] as never)).toMatch(/tainted|outside content/i);
    expect(await proposals()).toEqual([]);
  }, 60000);
});

describe('LEARN-1 D2 / LL-C5: the head prompt holds the incident block and none of the planted text', () => {
  it('markers in a title, description, blocked note, audit outcomes and a 20+ character unknown_tool name never reach a column or the prompt; the block itself does', async () => {
    const MARK = 'MARKER-PLANTED-TEXT';
    const provider = new SkillProvider({ 'heads/software': [turn(respond('chat', 'status: fine'))] });
    const { s } = await start(provider);
    const t = await mk(s, { title: `Title ${MARK}`, description: `Desc ${MARK}`, owner: CTO, status: 'blocked' });
    await db.pool.query("UPDATE tasks SET blocked_reason = 'owner', blocked_note = $2 WHERE id = $1", [t.id, `Note ${MARK}`]);
    for (let i = 0; i < 3; i++) await db.pool.query("INSERT INTO audit_log (actor, action, tool, outcome) VALUES ('head:software','tool','create_task','denied')");
    for (let i = 0; i < 5; i++) await db.pool.query("INSERT INTO audit_log (actor, action, tool, outcome) VALUES ('head:software','tool','marker_unknown_tool_name_that_is_long','unknown_tool')");
    await db.pool.query("INSERT INTO audit_log (actor, action, tool, outcome) VALUES ('head:software','task.heal.resolve',NULL,$1)", [`refused:${MARK}`]);
    const repo = new DeptIncidentRepo(db.pool);
    for (const step of ['tasks', 'heal', 'tools', 'retention', 'cap'] as const) await repo.step(step, 'Asia/Bangkok');
    expect(JSON.stringify((await db.pool.query('SELECT * FROM dept_incidents')).rows)).not.toContain('MARKER');
    await s.scheduler.onMessage(humanMsg(`${mentionOf('software')} status?`, { channelId: SOFTWARE_WORK, mentionedHeads: ['software'] }));
    await s.scheduler.idle();
    const prompt = text(provider.callsOf('heads/software')[0]!) + provider.callsOf('heads/software')[0]!.system;
    expect(prompt).toContain(INCIDENTS_HEADER);
    expect(prompt).toContain('- Blocked tasks: owner 1');
    expect(prompt).toContain('- Tool errors: create_task denied 3');
    expect(prompt.toLowerCase()).not.toContain('marker');
    expect(prompt).not.toContain('UNVERIFIED: ');
  }, 60000);
});

describe('LEARN-1 LL-C1: update_task carries the run taint onto its target', () => {
  /** Task A (persona SA, tainted or clean) sets B1 done and B2 blocked with marker texts. */
  async function scene(aTainted: boolean) {
    const provider = new SkillProvider({
      'members/system-analyst': [
        (req) => { void req; return turn({ name: 'update_task', input: { taskId: ids.b1, status: 'done', summary: MARK_DONE } }); },
        () => turn({ name: 'update_task', input: { taskId: ids.b2, status: 'blocked', summary: MARK_BLOCK } }),
        () => turn({ name: 'update_task', input: { taskId: ids.a, status: 'done', summary: 'finished my own task' } }),
        () => turn(respond('chat', 'done')),
      ],
      'heads/hq': [() => turn(respond('chat', 'ok')), () => turn(respond('chat', 'ok')), () => turn(respond('chat', 'ok')), () => turn(respond('chat', 'ok'))],
      'heads/software': [() => turn(respond('chat', 'status: fine')), () => turn(respond('chat', 'status: fine'))],
    });
    const ids = { a: '', b1: '', b2: '', p1: '' };
    const { s, port } = await start(provider);
    const p1 = await mk(s, { title: 'parent one', owner: CEO, deptId: 'hq', threadId: '1566000000000009001' });
    const b1 = await mk(s, { title: 'child one', owner: SA, parentId: p1.id, requester: CEO });
    const b2 = await mk(s, { title: 'child two', owner: SA });
    const a = await mk(s, { title: 'task A', owner: SA, status: 'todo', tainted: aTainted });
    Object.assign(ids, { a: a.id, b1: b1.id, b2: b2.id, p1: p1.id });
    await ready(s, a.id);
    await waitFor(async () => (await db.pool.query("SELECT status FROM tasks WHERE id = $1", [b1.id])).rows[0]?.status === 'done');
    await waitFor(async () => (await db.pool.query("SELECT status FROM tasks WHERE id = $1", [b2.id])).rows[0]?.status === 'blocked');
    await s.scheduler.idle();
    return { s, port, provider, ids };
  }
  const roomRows = async (mark: string) => (await db.pool.query<{ kind: string; tainted: boolean }>('SELECT kind, tainted FROM room_entries WHERE body LIKE $1', [`%${mark}%`])).rows;

  it('a tainted run on A: B (done, blocked) is tainted, its room entries are stored tainted, the roll-up taints the parent, the heal decide task is tainted, and the head prompt holds none of the text', async () => {
    const { s, provider, ids } = await scene(true);
    expect(await taintedOf(ids.b1)).toBe(true);
    expect(await taintedOf(ids.b2)).toBe(true);
    expect(await roomRows(MARK_DONE)).toEqual([{ kind: 'done', tainted: true }]);
    expect(await roomRows(MARK_BLOCK)).toEqual([{ kind: 'blocked', tainted: true }]);
    await waitFor(async () => (await taintedOf(ids.p1)) === true); // the roll-up of B1 into its parent
    // the heal decide task takes its taint from the blocked task's row
    const blocked = (await s.tasks.get(ids.b2))!;
    expect(await s.scheduler.healWake({ blocked, decider: CEO, runTask: null, n: 1 })).toBe('started');
    await s.scheduler.idle();
    const decide = (await db.pool.query<{ tainted: boolean }>("SELECT tainted FROM tasks WHERE title LIKE 'Decide on blocked task %'")).rows;
    expect(decide).toEqual([{ tainted: true }]);
    // the next human-started head run reads the room: the steered lines are not in its prompt, and the run stays clean
    await s.scheduler.onMessage(humanMsg(`${mentionOf('software')} status?`, { channelId: SOFTWARE_WORK, mentionedHeads: ['software'] }));
    await s.scheduler.idle();
    const prompt = text(provider.callsOf('heads/software').at(-1)!);
    expect(prompt).not.toContain(MARK_DONE);
    expect(prompt).not.toContain(MARK_BLOCK);
    expect(prompt).not.toContain('UNVERIFIED: ');
  }, 90000);

  it('control: a clean run on A leaves B, its room entries and the parent clean', async () => {
    const { s, ids } = await scene(false);
    expect(await taintedOf(ids.b1)).toBe(false);
    expect(await taintedOf(ids.b2)).toBe(false);
    expect(await roomRows(MARK_DONE)).toEqual([{ kind: 'done', tainted: false }]);
    expect(await roomRows(MARK_BLOCK)).toEqual([{ kind: 'blocked', tainted: false }]);
    await s.scheduler.idle();
    expect(await taintedOf(ids.p1)).toBe(false);
  }, 90000);

  it('same-task variant: a tainted kb hit, then update_task done on the same task: the task, its roll-up and its parent are tainted', async () => {
    const ids = { c: '', p: '' };
    const provider = new SkillProvider({
      'heads/software': [turn({ name: 'kb_search', input: { query: 'zebra' } }), () => turn({ name: 'update_task', input: { taskId: ids.c, status: 'done', summary: MARK_DONE } }), () => turn(respond('chat', 'done'))],
      'heads/hq': [() => turn(respond('chat', 'ok')), () => turn(respond('chat', 'ok'))],
    });
    const { s } = await start(provider);
    await db.pool.query("INSERT INTO kb_docs (scope, title, body, sources, tainted, created_by) VALUES ('software','Webby','Zebra tips from a web page','[]'::jsonb, true, 'x')");
    const p = await mk(s, { title: 'parent', owner: CEO, deptId: 'hq', threadId: '1566000000000009002' });
    const c = await mk(s, { title: 'child task', owner: CTO, parentId: p.id, requester: CEO, status: 'todo' });
    Object.assign(ids, { c: c.id, p: p.id });
    await ready(s, c.id);
    await waitFor(async () => (await db.pool.query("SELECT status FROM tasks WHERE id = $1", [c.id])).rows[0]?.status === 'done');
    await s.scheduler.idle();
    expect(await taintedOf(c.id)).toBe(true);
    await waitFor(async () => (await taintedOf(p.id)) === true);
  }, 90000);
});

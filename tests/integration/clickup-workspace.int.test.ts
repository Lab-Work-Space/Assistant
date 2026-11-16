import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../../app.js';
import { localDay } from '../../company/calendar.js';
import { seed } from '../../company/index.js';
import { ChannelMapRepo, ClickUpWriteUsage, DepartmentRepo, PersonaRepo } from '../../db/repos/index.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { PROMPTS_DIR, loadPrompts } from '../../prompts/index.js';
import { workspaceFetch, ws, type WsState } from '../fakes/clickup-workspace.js';
import { createLogger } from '../../core/logger.js';
import { workspaceLabelText } from '../../tools/plugins/clickup/client.js';
import { teamB, teamsOf } from '../../tools/plugins/clickup/multi-helpers.js';
import { BOT_LOG_CHANNEL_ID } from '../../discord/port.js';
import { handleInteraction } from '../../discord/index.js';
import { interaction, text } from '../../discord/commands/test-helpers.js';
import { ActorProvider, boot, humanMsg, mentionOf, migrateUp, resetDb, respond, turn } from './helpers.js';

/** CLICKUP-ALL-1: the REAL client, the REAL ClickUpWriteUsage repo, the real registry and approvals, wired by createApp exactly as in production; only ClickUp's HTTP is a fake. */
const PRAW_WORK = '1565999999999999001';
const B = 'https://api.clickup.com/api/v2';
let db: TestDb;
let app: App | null = null;
beforeAll(async () => { db = await freshDb(); });
afterEach(async () => {
  await app?.stop();
  app = null;
  await db.pool.query('TRUNCATE clickup_write_usage');
  await resetDb(db.pool);
});
afterAll(async () => { await db.close(); });

async function prepare(): Promise<void> {
  await migrateUp(db.pool);
  await seed({ departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) }, loadPrompts(PROMPTS_DIR));
  await db.pool.query("UPDATE departments SET provider = 'claude', model = 'claude-sonnet-5-5', work_channel_id = $1 WHERE id = 'praw'", [PRAW_WORK]);
}
function rig(env: { teamId: string } = { teamId: '9001' }) {
  const state = ws();
  const f = workspaceFetch(state);
  return { state, f, env: { clickup: { apiToken: state.token, ...env } }, writes: () => f.requests.filter((q) => q.method !== 'GET'), reqs: (re: RegExp) => f.requests.filter((q) => re.test(q.url)) };
}
const pendingRows = async () => (await db.pool.query<{ id: number; tool_input: { in_list_id?: string; list_path?: string; in_task?: string } }>("SELECT id, tool_input FROM approvals WHERE status = 'pending' ORDER BY id")).rows;
const comment = (text: string) => turn({ name: 'clickup_add_comment', input: { task_id: 'a1', text } });
const ask = async (t: { app: App }, msg: string) => {
  await t.app.services.scheduler.onMessage(humanMsg(`${mentionOf('praw')} ${msg}`, { mentionedHeads: ['praw'] }));
  await t.app.services.scheduler.idle();
};
const approve = async (t: { app: App }, id: number) => {
  expect((await t.app.services.approvals.decide(id, 'approved', { id: 'admin1', isAdmin: true })).ok).toBe(true);
  await t.app.services.scheduler.idle();
};
const today = (t: { app: App }) => localDay(Date.now(), t.app.services.cfg.get('schedule.timezone')).date;

describe('clickup workspace mode, wired as app.ts does', () => {
  it('boot: one clickup.mode audit row (no ids), the team is resolved, and an empty watch list means the poller makes no request', async () => {
    await prepare();
    const r = rig();
    const t = await boot(db.pool, { provider: new ActorProvider({}), env: r.env, fetch: r.f });
    app = t.app;
    await t.app.services.scheduler.idle();
    await new Promise((res) => setTimeout(res, 50));
    const rows = (await db.pool.query<{ action: string; outcome: string }>("SELECT action, outcome FROM audit_log WHERE action LIKE 'clickup.%' ORDER BY id")).rows;
    expect(rows).toEqual([{ action: 'clickup.mode', outcome: 'workspace' }]);
    expect(r.reqs(/\/team$/)).toHaveLength(1);
    expect(r.reqs(/\/team\/9001\/task/)).toEqual([]); // pollListIds is empty: nothing is polled
  });

  it('HEAL-1 H5: a restart in the same mode writes no second clickup.mode row and posts no second notice; the team is still resolved', async () => {
    await prepare();
    const r1 = rig();
    const t1 = await boot(db.pool, { provider: new ActorProvider({}), env: r1.env, fetch: r1.f });
    await new Promise((res) => setTimeout(res, 50));
    expect(t1.port.posts.filter((p) => p.target.channelId === BOT_LOG_CHANNEL_ID && JSON.stringify(p.payload).includes('ClickUp workspace mode'))).toHaveLength(1);
    await t1.app.stop();
    const r2 = rig();
    const t2 = await boot(db.pool, { provider: new ActorProvider({}), env: r2.env, fetch: r2.f });
    app = t2.app;
    await new Promise((res) => setTimeout(res, 50));
    expect((await db.pool.query("SELECT outcome FROM audit_log WHERE action = 'clickup.mode'")).rows).toEqual([{ outcome: 'workspace' }]);
    expect(t2.port.posts.filter((p) => JSON.stringify(p.payload).includes('ClickUp workspace mode'))).toHaveLength(0);
    expect(r2.reqs(/\/team$/)).toHaveLength(1);
  });

  it('boot with a team id the token does not see: one unresolved audit row carrying a reason code only', async () => {
    await prepare();
    const r = rig({ teamId: '4444' });
    const t = await boot(db.pool, { provider: new ActorProvider({}), env: r.env, fetch: r.f });
    app = t.app;
    await new Promise((res) => setTimeout(res, 50));
    const rows = (await db.pool.query<{ action: string; outcome: string }>("SELECT action, outcome FROM audit_log WHERE action LIKE 'clickup.workspace.%'")).rows;
    expect(rows).toEqual([{ action: 'clickup.workspace.unresolved', outcome: 'mismatch' }]);
    expect(JSON.stringify((await db.pool.query('SELECT * FROM audit_log')).rows)).not.toContain('4444');
  });

  it('a human talking straight to praw still gets an approval card; approving it performs exactly one write and takes one from the durable daily counter', async () => {
    await prepare();
    const r = rig();
    const provider = new ActorProvider({ 'heads/praw': [comment('hello from praw'), turn(respond('chat', 'waiting')), turn(respond('report', 'done'))] });
    const t = await boot(db.pool, { provider, env: r.env, fetch: r.f });
    app = t.app;
    await ask(t, 'comment on the spec task');
    expect(r.writes()).toEqual([]);
    const rows = await pendingRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool_input).toMatchObject({ in_list_id: '7001', in_task: 'Write spec' });
    expect(rows[0]!.tool_input.list_path).toContain('Engineering / Backend / Sprint [');
    await approve(t, rows[0]!.id);
    expect(r.writes().map((q) => `${q.method} ${q.url}`)).toEqual([`POST ${B}/task/a1/comment`]);
    expect(JSON.parse(r.writes()[0]!.body!)).toEqual({ comment_text: 'hello from praw', notify_all: false });
    // durable: a brand-new repo instance on the same database sees the count, under the company-timezone date
    expect(await new ClickUpWriteUsage(db.pool).used(today(t))).toBe(1);
  });

  it('the daily cap (clickup.writesPerDay) is enforced against the real table: the second approved write is refused and sends nothing', async () => {
    await prepare();
    const r = rig();
    const provider = new ActorProvider({ 'heads/praw': [comment('one'), comment('two'), turn(respond('chat', 'w')), turn(respond('report', 'd'))] });
    const t = await boot(db.pool, { provider, env: r.env, fetch: r.f });
    app = t.app;
    await app.services.cfg.set('clickup.writesPerDay', 1, 'test');
    await ask(t, 'two comments');
    const rows = await pendingRows();
    expect(rows).toHaveLength(2);
    await approve(t, rows[0]!.id);
    await approve(t, rows[1]!.id);
    expect(r.writes()).toHaveLength(1);
    expect(await new ClickUpWriteUsage(db.pool).used(today(t))).toBe(1); // a refused take adds nothing
  });

  it('a task moved between the card and the approval: nothing is written and nothing is counted', async () => {
    await prepare();
    const r = rig();
    const provider = new ActorProvider({ 'heads/praw': [comment('hello'), turn(respond('chat', 'w')), turn(respond('report', 'd'))] });
    const t = await boot(db.pool, { provider, env: r.env, fetch: r.f });
    app = t.app;
    await ask(t, 'comment');
    const [row] = await pendingRows();
    r.state.tasks.find((x) => x.id === 'a1')!.listId = '7002';
    await approve(t, row!.id);
    expect(r.writes()).toEqual([]);
    expect(await new ClickUpWriteUsage(db.pool).used(today(t))).toBe(0);
  });

  it('a task of another workspace never reaches a card, a write or the counter', async () => {
    await prepare();
    const r = rig();
    const provider = new ActorProvider({ 'heads/praw': [turn({ name: 'clickup_add_comment', input: { task_id: 'z9', text: 'x' } }), turn(respond('chat', 'refused'))] });
    const t = await boot(db.pool, { provider, env: r.env, fetch: r.f });
    app = t.app;
    await ask(t, 'comment on the foreign one');
    expect(await pendingRows()).toEqual([]);
    expect(r.writes()).toEqual([]);
    expect(await new ClickUpWriteUsage(db.pool).used(today(t))).toBe(0);
  });

  it('the tool set praw is offered in workspace mode has the search tool and no delete', async () => {
    await prepare();
    const r = rig();
    const provider = new ActorProvider({ 'heads/praw': [turn(respond('chat', 'hi'))] });
    const t = await boot(db.pool, { provider, env: r.env, fetch: r.f });
    app = t.app;
    await ask(t, 'hi');
    const names = provider.callsOf('heads/praw')[0]!.tools.map((x) => x.name);
    expect(names).toContain('clickup_search_tasks');
    expect(names).toContain('clickup_add_comment');
    expect(names).not.toContain('clickup_delete_task');
  });

  it('list mode is untouched: same env shape as before gives the delete tool, no search tool, and no /team request', async () => {
    await prepare();
    const state = ws();
    const f = workspaceFetch(state);
    const provider = new ActorProvider({ 'heads/praw': [turn(respond('chat', 'hi'))] });
    const t = await boot(db.pool, { provider, env: { clickup: { apiToken: state.token, listId: '7001' } }, fetch: f });
    app = t.app;
    await ask(t, 'hi');
    const names = provider.callsOf('heads/praw')[0]!.tools.map((x) => x.name);
    expect(names).toContain('clickup_delete_task');
    expect(names).not.toContain('clickup_search_tasks');
    expect(f.requests.filter((q) => /\/team/.test(q.url))).toEqual([]);
    expect((await db.pool.query("SELECT 1 FROM audit_log WHERE action LIKE 'clickup.mode'")).rowCount).toBe(0);
  });
});


describe('CLICKUP-HIER-1 create space / folder / list, wired as app.ts does', () => {
  const auditRows = async () => (await db.pool.query<{ action: string; outcome: string }>("SELECT action, outcome FROM audit_log WHERE action = 'clickup.hierarchy.created' ORDER BY id")).rows;
  const raw = async () => (await db.pool.query<{ id: number; tool_input: Record<string, string> }>("SELECT id, tool_input FROM approvals WHERE status = 'pending' ORDER BY id")).rows;

  it('a direct chat with praw: space -> list -> task, one approval card each, one POST and one durable take each, ids only in the audit-free rows', async () => {
    await prepare();
    const r = rig();
    const provider = new ActorProvider({ 'heads/praw': [
      turn({ name: 'clickup_create_space', input: { name: 'Research' } }), turn(respond('chat', 'w')), turn(respond('report', 'd')),
      turn({ name: 'clickup_create_list', input: { space_id: '8800', name: 'Backlog', description: 'first list' } }), turn(respond('chat', 'w')), turn(respond('report', 'd')),
      turn({ name: 'clickup_create_task', input: { list_id: '8801', name: 'First task' } }), turn(respond('chat', 'w')), turn(respond('report', 'd')),
    ] });
    const t = await boot(db.pool, { provider, env: r.env, fetch: r.f });
    app = t.app;
    await ask(t, 'make a research space');
    expect(r.writes()).toEqual([]); // nothing before the approval, direct chat included
    let rows = await raw();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool_input).toMatchObject({ name: 'Research', in_workspace: workspaceLabelText('9001', 'WS') });
    await approve(t, rows[0]!.id);
    expect(r.writes().map((q) => `${q.method} ${q.url}`)).toEqual([`POST ${B}/team/9001/space`]);
    // G2CH-01: the approved result is stored on the row and DELIVERED to the owner's next model turn: that task's continuation turn, which runs as soon as the
    // approval is decided (flag set, and the provider input of that turn carries "Created space 8800" as an approved-tool result).
    const spaceRow = (await db.pool.query<{ tool_result: string | null; result_delivered_at: Date | null }>("SELECT tool_result, result_delivered_at FROM approvals WHERE kind = 'tool' AND tool_name = 'clickup_create_space'")).rows;
    expect(spaceRow).toHaveLength(1);
    expect(spaceRow[0]!.tool_result).toContain('Created space 8800');
    expect(spaceRow[0]!.result_delivered_at).not.toBeNull();
    const carrying = provider.callsOf('heads/praw').filter((q) => JSON.stringify(q.messages).includes('Created space 8800'));
    expect(carrying).toHaveLength(1);
    expect(JSON.stringify(carrying[0]!.messages)).toMatch(/source=\\"approved-tool\\"[\s\S]*Approval #\d+ \(clickup_create_space\) ran:\\nCreated space 8800/);
    await ask(t, 'add a backlog list in it');
    rows = await raw();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool_input).toMatchObject({ space_id: '8800', in_space_id: '8800' });
    await approve(t, rows[0]!.id);
    // G2CH-02: the list that was just created is usable at once: `/clickup watch add` of it succeeds (the real listInScope against the fake), the config key
    // changes, one audit row (ids only in the tool), and nothing is written to ClickUp
    const writesBefore = r.writes().length;
    const watch = interaction({ commandName: 'clickup', subcommand: 'watch', userId: 'admin1', strings: { list_id: '8801', action: 'add' } });
    const watched = text(await handleInteraction(watch, t.app.services.commands));
    expect(watched).toMatch(/8801/); // the change reply names the new watched list
    expect(watched).not.toMatch(/not in the ClickUp workspace|already|Give the list id|not on/i);
    expect(t.app.services.cfg.get('clickup.pollListIds')).toEqual(['8801']);
    expect((await db.pool.query("SELECT outcome FROM audit_log WHERE action = 'clickup.watch' AND tool = 'add:8801'")).rows).toEqual([{ outcome: 'ok' }]);
    expect(r.writes()).toHaveLength(writesBefore);
    // and a list that does not exist is refused (the step above is not vacuous)
    const bad = interaction({ commandName: 'clickup', subcommand: 'watch', userId: 'admin1', strings: { list_id: '99999', action: 'add' } });
    expect(text(await handleInteraction(bad, t.app.services.commands))).toContain('not in the ClickUp workspace');
    expect(t.app.services.cfg.get('clickup.pollListIds')).toEqual(['8801']);
    await ask(t, 'add a first task');
    rows = await raw();
    expect(rows).toHaveLength(1);
    await approve(t, rows[0]!.id);
    expect(r.writes().map((q) => `${q.method} ${q.url}`)).toEqual([`POST ${B}/team/9001/space`, `POST ${B}/space/8800/list`, `POST ${B}/list/8801/task`]);
    expect(JSON.parse(r.writes()[1]!.body!)).toEqual({ name: 'Backlog', content: 'first list' });
    expect(await new ClickUpWriteUsage(db.pool).used(today(t))).toBe(3);
    expect(await auditRows()).toEqual([{ action: 'clickup.hierarchy.created', outcome: 'space' }, { action: 'clickup.hierarchy.created', outcome: 'list' }]);
    expect(JSON.stringify((await db.pool.query("SELECT * FROM audit_log WHERE action LIKE 'clickup.%' AND action <> 'clickup.watch'")).rows)).not.toMatch(/9001|8800|8801|Research|Backlog/); // /clickup watch audits the list id it was given, by its existing contract
  });

  it('a duplicate created by a human between the card and the approval: refused at run, nothing written, nothing counted', async () => {
    await prepare();
    const r = rig();
    const provider = new ActorProvider({ 'heads/praw': [turn({ name: 'clickup_create_folder', input: { space_id: '501', name: 'Plans' } }), turn(respond('chat', 'w')), turn(respond('report', 'd'))] });
    const t = await boot(db.pool, { provider, env: r.env, fetch: r.f });
    app = t.app;
    await ask(t, 'a folder');
    const [row] = await raw();
    r.state.folders.push({ id: 'fh1', name: 'plans', spaceId: '501' });
    await approve(t, row!.id);
    expect(r.writes()).toEqual([]);
    expect(await new ClickUpWriteUsage(db.pool).used(today(t))).toBe(0);
  });
});


describe('CLICKUP-MULTI-1 all-workspaces mode, wired as app.ts does', () => {
  function rigAll(over: Partial<WsState> = {}) {
    const state = ws({ teamName: 'Core', more: [teamB()], ...over });
    const f = workspaceFetch(state);
    return { state, f, env: { clickup: { apiToken: state.token, teams: 'all' as const } }, writes: () => f.requests.filter((q) => q.method !== 'GET'), reqs: (re: RegExp) => f.requests.filter((q) => re.test(q.url)) };
  }
  const auditRows = async (like = 'clickup.%') => (await db.pool.query<{ action: string; outcome: string }>('SELECT action, outcome FROM audit_log WHERE action LIKE $1 ORDER BY id', [like])).rows;

  it('boot: one clickup.mode audit row `workspace-all`, one #bot-log notice with the count only, one GET /team, and no request for the empty watch list', async () => {
    await prepare();
    const r = rigAll();
    const t = await boot(db.pool, { provider: new ActorProvider({}), env: r.env, fetch: r.f });
    app = t.app;
    await t.app.services.scheduler.idle();
    await new Promise((res) => setTimeout(res, 100));
    expect(await auditRows()).toEqual([{ action: 'clickup.mode', outcome: 'workspace-all' }]);
    expect(r.reqs(/\/team$/)).toHaveLength(1);
    expect(r.reqs(/\/team\/\d+\/task/)).toEqual([]);
    const notices = t.port.posts.filter((p) => p.target.channelId === BOT_LOG_CHANNEL_ID && JSON.stringify(p.payload).includes('all-workspaces mode'));
    expect(notices).toHaveLength(1);
    expect(JSON.stringify(notices[0]!.payload)).toContain('every project of 2 workspace(s)');
    expect(JSON.stringify(notices[0]!.payload)).not.toMatch(/9001|9002|Acme|Core/);
  });

  it('boot with more than 10 workspaces: ClickUp stays unresolved (E_TEAMS) with one audit row carrying a reason code only', async () => {
    await prepare();
    const r = rigAll({ more: teamsOf(11) });
    const t = await boot(db.pool, { provider: new ActorProvider({}), env: r.env, fetch: r.f });
    app = t.app;
    await new Promise((res) => setTimeout(res, 100));
    expect(await auditRows('clickup.workspace.%')).toEqual([{ action: 'clickup.workspace.unresolved', outcome: 'too_many' }]);
    expect(JSON.stringify((await db.pool.query('SELECT * FROM audit_log')).rows)).not.toMatch(/9001|91\d\d/);
  });

  it('a comment on a task of the second workspace: the card pins that workspace, and approving it performs one write and one durable take', async () => {
    await prepare();
    const r = rigAll();
    const provider = new ActorProvider({ 'heads/praw': [turn({ name: 'clickup_add_comment', input: { task_id: 'b1', text: 'for acme' } }), turn(respond('chat', 'waiting')), turn(respond('report', 'done'))] });
    const t = await boot(db.pool, { provider, env: r.env, fetch: r.f });
    app = t.app;
    await ask(t, 'comment on the acme task');
    expect(r.writes()).toEqual([]);
    const rows = await db.pool.query<{ id: number; tool_input: Record<string, string> }>("SELECT id, tool_input FROM approvals WHERE status = 'pending' ORDER BY id");
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.tool_input).toMatchObject({ in_list_id: '8001', in_workspace: workspaceLabelText('9002', 'Acme') });
    await approve(t, rows.rows[0]!.id);
    expect(r.writes().map((q) => `${q.method} ${q.url}`)).toEqual([`POST ${B}/task/b1/comment`]);
    expect(await new ClickUpWriteUsage(db.pool).used(today(t))).toBe(1);
  });

  it('a workspace renamed between the card and the approval: E_MOVED, nothing written, nothing counted', async () => {
    await prepare();
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    try {
      const r = rigAll();
      const provider = new ActorProvider({ 'heads/praw': [turn({ name: 'clickup_add_comment', input: { task_id: 'b1', text: 'for acme' } }), turn(respond('chat', 'waiting')), turn(respond('report', 'done'))] });
      const t = await boot(db.pool, { provider, env: r.env, fetch: r.f });
      app = t.app;
      await ask(t, 'comment on the acme task');
      const rows = await db.pool.query<{ id: number }>("SELECT id FROM approvals WHERE status = 'pending'");
      expect(rows.rows).toHaveLength(1);
      r.state.more![0]!.name = 'Acme Holdings';
      vi.setSystemTime(Date.now() + 11 * 60_000); // the cached workspace set is stale: the next check reads the new name
      await approve(t, rows.rows[0]!.id);
      expect(r.writes()).toEqual([]);
      expect(await new ClickUpWriteUsage(db.pool).used(today(t))).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('CLICKUP_TEAM_ID=all under a list id: list mode wins and the boot warns once, without any value', async () => {
    await prepare();
    const state = ws();
    const f = workspaceFetch(state);
    const lines: string[] = [];
    const logger = createLogger('trace', { destination: { write: (x: string) => void lines.push(x) } });
    const t = await boot(db.pool, { provider: new ActorProvider({}), env: { clickup: { apiToken: state.token, listId: '7001', teamAllIgnored: true } }, fetch: f, logger });
    app = t.app;
    const warn = lines.filter((l) => l.includes('CLICKUP_TEAM_ID=all is ignored'));
    expect(warn).toHaveLength(1);
    expect(warn[0]).not.toContain(state.token);
    expect(f.requests.filter((q) => /\/team/.test(q.url))).toEqual([]);
  });
});

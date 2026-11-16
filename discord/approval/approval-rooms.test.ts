import { PermissionFlagsBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { isExcludedChannel } from '../../company/exclusion.js';
import { DENIED_CATEGORY_IDS } from '../../company/denylist.js';
import type { Department } from '../../db/repos/index.js';
import type { Approval } from '../../db/repos/ledger.js';
import type { Task } from '../../db/repos/tasks.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeDiscordPort } from '../../tests/fakes/discordPort.js';
import { roomOverwriteProblem, type OverwriteLike } from './approval-room-check.js';
import { ApprovalRooms, isNonSensitiveTool } from './approval-rooms.js';
import { approvalBatchHooks, postApprovalCard } from '../commands/approval.js';
import { handleInteraction } from '../commands/index.js';
import { ADMIN_ROLE, interaction, makeDeps, text } from '../commands/test-helpers.js';
import { CONFIG_CHANNEL_ID } from '../commands/types.js';

const GUILD = '1565649426943442944';
const CAT = '1570000000000000100';
const ROOM = '1570000000000000200';
const IT_ROOM = '1570000000000000201';
const V = PermissionFlagsBits.ViewChannel;
const dept = (id: string, pattern: string): Department => ({ id, name: id, categoryNamePattern: pattern, workChannelId: null, color: 0, model: null, provider: null, enabled: true });

function mk(over: { map?: Record<string, string>; task?: Partial<Task> | null; lw?: string | null; cfg?: Record<string, unknown> } = {}) {
  const cfg = new FakeConfig({ 'approvals.channelByCategory': over.map ?? { [CAT]: ROOM }, ...(over.cfg as object) });
  const port = new FakeDiscordPort();
  port.channels = [{ id: CAT, name: 'SALES & PIPELINE', parentId: null, type: 4 }, { id: ROOM, name: 'approvals', parentId: CAT, type: 0 }];
  const alerts: string[] = [];
  const seen: { room: string; cat: string; users: readonly string[]; roles: readonly string[] }[] = [];
  const orig = port.approvalRoomProblem.bind(port);
  port.approvalRoomProblem = async (room, cat, allow) => { seen.push({ room, cat, users: allow.userIds, roles: allow.roleIds }); return orig(room, cat, allow); };
  const task = over.task === null ? null : ({ id: 't1', originCategoryId: CAT, ...over.task } as Task);
  const rooms = new ApprovalRooms({
    cfg, tasks: { get: async () => task }, port, org: { heads: () => [dept('sales', 'SALES'), dept('hr', 'HR')] },
    botUserIds: () => new Map([['bot-sales', 'sales'], ['bot-hr', 'hr'], ['bot-praw', 'praw'], ['bot-hq', 'hq']]),
    adminRoleId: ADMIN_ROLE, lwAdminUserId: async () => (over.lw === undefined ? 'bot-lw' : over.lw), alert: async (t) => void alerts.push(t), log: { error() {} },
  });
  return { rooms, port, alerts, seen, cfg };
}
const est = (over: Partial<Approval> = {}): Approval => ({ id: 1, taskId: 't1', reason: 'big', estCostUsd: 3, requestedBy: 'head:sales', status: 'pending', decidedBy: null, createdAt: new Date(), decidedAt: null, kind: 'estimate', ...over });
const tool = (name: string): Approval => est({ kind: 'tool', toolName: name, toolInput: { a: 1 }, inputSha256: 'a'.repeat(64) });

describe('approvals rooms: routing allow-list (WS7)', () => {
  it('an estimate card of a task in category X goes to its room', async () => {
    const t = mk();
    expect(await t.rooms.channelFor(est())).toBe(ROOM);
    expect(t.seen[0]).toMatchObject({ room: ROOM, cat: CAT, roles: [ADMIN_ROLE] });
    expect(new Set(t.seen[0]!.users)).toEqual(new Set(['bot-sales', 'bot-praw', 'bot-hq', 'bot-lw']));
  });

  it('a non-sensitive tool card goes to the room; sensitive tool cards stay central', async () => {
    const t = mk();
    expect(await t.rooms.channelFor(tool('clickup_create_task'))).toBe(ROOM);
    for (const n of ['github_create_issue', 'devjob_run', 'code_propose', 'deploy_propose', 'site_publish_static', 'knowledge_propose', 'prompt_propose', 'config_propose', 'admin_op_propose', 'perm_propose', 'server_propose', 'mod_ban', 'welcome_set', 'save_lesson', 'delete_lesson', 'skill_propose'])
      expect(await t.rooms.channelFor(tool(n)), n).toBe(CONFIG_CHANNEL_ID);
  });

  it('cap approvals, unknown kinds and a missing kind stay in #setting', async () => {
    const t = mk();
    for (const kind of ['tree_cap', 'local_cap', undefined]) expect(await t.rooms.channelFor(est({ kind: kind as never }))).toBe(CONFIG_CHANNEL_ID);
  });

  it('no origin category, no room mapped, or an unknown task: fall back to #setting', async () => {
    expect(await mk({ task: { originCategoryId: null } }).rooms.channelFor(est())).toBe(CONFIG_CHANNEL_ID);
    expect(await mk({ map: {} }).rooms.channelFor(est())).toBe(CONFIG_CHANNEL_ID);
    expect(await mk({ task: null }).rooms.channelFor(est())).toBe(CONFIG_CHANNEL_ID);
  });

  it('the IT category (DENIED) never gets a room, even if one is mapped', async () => {
    const it = DENIED_CATEGORY_IDS[0]!;
    const t = mk({ map: { [it]: IT_ROOM }, task: { originCategoryId: it } });
    expect(await t.rooms.channelFor(est())).toBe(CONFIG_CHANNEL_ID);
    expect(t.seen).toHaveLength(0);
  });
});

describe('approvals rooms: validated at use, post-only (WS8)', () => {
  it('a room mapped to a public channel falls back to #setting with one alert', async () => {
    const t = mk();
    t.port.roomProblems.set(ROOM, '@everyone is not denied View Channel');
    expect(await t.rooms.channelFor(est())).toBe(CONFIG_CHANNEL_ID);
    expect(await t.rooms.channelFor(est())).toBe(CONFIG_CHANNEL_ID);
    expect(t.alerts).toHaveLength(1);
    expect(t.alerts[0]).toContain(ROOM);
  });

  it('a category the guild no longer has, a mod-room value or the bot-log as room fall back', async () => {
    expect(await mk({ map: { '1570000000000000999': ROOM }, task: { originCategoryId: '1570000000000000999' } }).rooms.channelFor(est())).toBe(CONFIG_CHANNEL_ID);
    const mod = mk({ cfg: { 'roles.modRoomId': ROOM } });
    expect(await mod.rooms.channelFor(est())).toBe(CONFIG_CHANNEL_ID);
    const log = mk({ map: { [CAT]: '1566454343820124352' } });
    expect(await log.rooms.channelFor(est())).toBe(CONFIG_CHANNEL_ID);
  });

  it('the mapped rooms are the post-only set: the router predicate excludes them, so they are never routed or read', () => {
    const t = mk();
    expect(t.rooms.rooms()).toEqual([ROOM]);
    expect(isExcludedChannel(ROOM, null, { postOnly: t.rooms.rooms() })).toBe(true);
    expect(isExcludedChannel('1570000000000000300', ROOM, { postOnly: t.rooms.rooms() })).toBe(true); // a thread under it
    expect(isExcludedChannel('1570000000000000300', null, { postOnly: t.rooms.rooms() })).toBe(false);
  });

  it('the schema accepts only snowflake pairs and refuses a shared room', async () => {
    const { ConfigSchema } = await import('../../config/schema.js');
    const s = ConfigSchema['approvals.channelByCategory'];
    expect(s.safeParse({ [CAT]: ROOM }).success).toBe(true);
    expect(s.safeParse({ x: ROOM }).success).toBe(false);
    expect(s.safeParse({ [CAT]: 'y' }).success).toBe(false);
    expect(s.safeParse({ [CAT]: ROOM, '1570000000000000101': ROOM }).success).toBe(false);
  });

  it('roomOverwriteProblem: @everyone must be denied, extra viewers must be on the allow list', () => {
    const allow = { roleIds: [ADMIN_ROLE], userIds: ['bot-sales'] };
    const everyone: OverwriteLike = { id: GUILD, type: 0, allow: 0n, deny: V };
    const ok: OverwriteLike[] = [everyone, { id: ADMIN_ROLE, type: 0, allow: V, deny: 0n }, { id: 'bot-sales', type: 1, allow: V, deny: 0n }];
    expect(roomOverwriteProblem(ok, GUILD, allow)).toBeNull();
    expect(roomOverwriteProblem([{ id: ADMIN_ROLE, type: 0, allow: V, deny: 0n }], GUILD, allow)).toMatch(/everyone/);
    expect(roomOverwriteProblem([{ ...everyone, deny: 0n }], GUILD, allow)).toMatch(/everyone/);
    expect(roomOverwriteProblem([{ ...everyone, allow: V }], GUILD, allow)).toMatch(/everyone/);
    expect(roomOverwriteProblem([...ok, { id: 'role-staff', type: 0, allow: V, deny: 0n }], GUILD, allow)).toMatch(/not on the allowed list/);
    expect(roomOverwriteProblem([...ok, { id: 'someone', type: 1, allow: V, deny: 0n }], GUILD, allow)).toMatch(/not on the allowed list/);
    expect(roomOverwriteProblem([...ok, { id: 'role-staff', type: 0, allow: 0n, deny: V }], GUILD, allow)).toBeNull(); // a deny is fine
  });
});

describe('postApprovalCard to a room and deciding there', () => {
  const A = est();
  it('posts as hq into the chosen room; a failing room post is retried once in #setting', async () => {
    const port = new FakeDiscordPort();
    await postApprovalCard(port, A, [], ROOM);
    expect(port.posts[0]).toMatchObject({ actor: { kind: 'head', dept: 'hq' }, target: { channelId: ROOM }, payload: { buttons: { approvalId: '1' } } });
    const failing = new FakeDiscordPort();
    const post = failing.post.bind(failing);
    failing.post = async (a, tg, p, o) => { if (tg.channelId === ROOM) throw new Error('Missing Access'); return post(a, tg, p, o); };
    await postApprovalCard(failing, A, [], ROOM);
    expect(failing.posts.map((p) => p.target.channelId)).toEqual([CONFIG_CHANNEL_ID]);
    await expect(postApprovalCard(Object.assign(new FakeDiscordPort(), { failPost: new Error('x') }), A)).rejects.toThrow('x');
  });

  const click = (roles: string[], channelId: string) => interaction({ kind: 'button', customId: 'approval:12:approve', channelId, roles, messageId: 'm1', messageAuthorId: 'hq' });

  it('only a Bot Admin can decide in a category room; a non-admin is refused and nothing is decided', async () => {
    const t = await makeDeps({ cfg: { get: ((k: string) => (k === 'approvals.channelByCategory' ? { [CAT]: ROOM } : undefined)) as never, set: async () => ({ old: 0, new: 0 }) as never } });
    expect(text(await handleInteraction(click([], ROOM), t.deps))).toContain('Only Bot Admins');
    expect(t.decisions).toHaveLength(0);
    const r = await handleInteraction(click([ADMIN_ROLE], ROOM), t.deps);
    expect(r).not.toBeNull();
    expect(t.decisions).toEqual([{ id: 12, decision: 'approved', user: { id: 'u1', isAdmin: true } }]);
  });

  it('a button in an unmapped channel is still refused, and room channels only take approval buttons', async () => {
    const t = await makeDeps({ cfg: { get: ((k: string) => (k === 'approvals.channelByCategory' ? { [CAT]: ROOM } : undefined)) as never, set: async () => ({ old: 0, new: 0 }) as never } });
    expect(text(await handleInteraction(click([ADMIN_ROLE], '1570000000000000999'), t.deps))).toContain('#⚙️-setting');
    const cmd = interaction({ commandName: 'halt', channelId: ROOM, roles: [ADMIN_ROLE] });
    expect(text(await handleInteraction(cmd, t.deps))).toContain('#⚙️-setting');
    expect(t.decisions).toHaveLength(0);
  });
});

describe('B7: batching never reuses a copy of the sensitive-tool rule', () => {
  const approval = (toolName: string): Approval => ({
    id: 1, taskId: 't1', reason: 'r', estCostUsd: 0, requestedBy: 'head:praw', status: 'pending', decidedBy: null, createdAt: new Date(), decidedAt: null,
    toolName, toolInput: { url: 'https://example.com' }, inputSha256: 'a'.repeat(64), kind: 'tool',
  });
  it('every sensitive prefix is never batched (the predicate, the room routing and the batch eligibility agree)', () => {
    const { rooms, port } = mk();
    const hooks = approvalBatchHooks({ port, rooms, secrets: [] });
    for (const name of [
      'github_create_issue', 'devjob_start', 'code_edit', 'deploy_site', 'site_publish', 'knowledge_edit', 'prompt_set', 'config_set', 'admin_op', 'perm_apply',
      'server_create_channel', 'mod_timeout', 'moderate_user', 'ban_member', 'kick_member', 'welcome_set', 'save_lesson', 'delete_lesson', 'GITHUB_X',
    ]) {
      expect(isNonSensitiveTool(name), name).toBe(false);
      expect(rooms.routable(approval(name)), name).toBe(false);
      expect(hooks.eligible(approval(name)), name).toBe(false);
    }
    for (const name of ['fetch_page', 'web_search', 'clickup_update_task']) expect(hooks.eligible(approval(name)), name).toBe(true);
  });
  it('estimate and cap approvals are never eligible, even though an estimate is routable', () => {
    const { rooms, port } = mk();
    const hooks = approvalBatchHooks({ port, rooms, secrets: [] });
    const est = { ...approval('x'), toolName: null, kind: 'estimate' } as Approval;
    expect(rooms.routable(est)).toBe(true);
    expect(hooks.eligible(est)).toBe(false);
    expect(hooks.eligible({ ...est, kind: 'tree_cap' })).toBe(false);
    expect(hooks.eligible({ ...est, kind: 'local_cap' })).toBe(false);
  });
});

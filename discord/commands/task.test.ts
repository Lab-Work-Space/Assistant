import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADMIN_TOOL_NAMES, MOD_TOOL_NAMES } from '../../admin/names.js';
import type { AdminTaskRow, SubtreeRow, TaskStatus } from '../../db/repos/tasks.js';
import { EventBus, type AppEvents } from '../../core/events.js';
import { TaskRuns } from '../../agents/tasks/task-runs.js';
import { PRAW_COMMANDS } from '../praw/definitions.js';
import { COMMANDS, CONFIG_CHANNEL_ID, handleInteraction } from './index.js';
import { NONCE_MAX, NONCE_TTL_MS, NonceStore } from './task-nonce.js';
import { resolveTaskRef, TASKADM_ID } from './task.js';
import { ADMIN_ROLE, cmd, interaction, makeDeps, text } from './test-helpers.js';
import type { CommandDeps, TaskAdminDeps } from './types.js';

// TASKADMIN-1 at the command layer: TA-C1 (authz, no model path), TA-C2 (nonces), TA-C3 (ids), TA-C4 (list masking and size). Flows with real repos: tests/integration/task-admin.int.test.ts.
const SECRET = 'sk-live-TOPSECRET-1234567890';
const UUID = (n: number) => `5060c62${n.toString(16)}-aaaa-4bbb-8ccc-${String(n).padStart(12, '0')}`;

type Row = { id: string; deptId: string; status: TaskStatus; title: string; depth: number; blockedReason: AdminTaskRow['blockedReason']; blockedNote: string | null; updatedAt: Date; openChildren: number };
class FakeTasks {
  rows: Row[] = [];
  lastLimit = 0;
  async get(id: string) { const r = this.rows.find((x) => x.id === id); return r ? ({ ...r, owner: { kind: 'head', dept: r.deptId }, requester: { kind: 'human', userId: '1' }, parentId: null, rootId: r.id, turnsUsed: 0 } as never) : null; }
  async update() { return null; }
  async listOpenAdmin(statuses: readonly TaskStatus[], limit: number) { this.lastLimit = limit; return this.rows.filter((r) => statuses.includes(r.status)).slice(0, limit); }
  async countByStatus() { const c = { todo: 0, doing: 0, review: 0, blocked: 0, awaiting_approval: 0 }; for (const r of this.rows) if (r.status in c) c[r.status as keyof typeof c]++; return c; }
  async openSubtree(id: string): Promise<{ rows: SubtreeRow[]; tooDeep: boolean }> { return { rows: this.rows.filter((r) => r.id === id).map((r) => ({ id: r.id, status: r.status, parentId: null, deptId: r.deptId, depth: 0 })), tooDeep: false }; }
  async findByIdPrefix(prefix: string, limit: number) { return this.rows.filter((r) => r.id.startsWith(prefix)).slice(0, limit).map((r) => ({ id: r.id, deptId: r.deptId, status: r.status })); }
  async pendingApprovalCount() { return 0; }
  async acceptDigest() { return 'abcdef012345'; }
  async countOpenChildren() { return 0; }
}
const row = (n: number, over: Partial<Row> = {}): Row => ({ id: UUID(n), deptId: 'hq', status: 'review', title: `task ${n}`, depth: 0, blockedReason: null, blockedNote: null, updatedAt: new Date(new Date('2026-10-31T12:00:00Z').getTime() - 3 * 3600_000 - 12 * 60_000), openChildren: 0, ...over });

async function rig(rows: Row[] = [], over: Partial<CommandDeps> = {}) {
  const t = await makeDeps(over);
  const tasks = new FakeTasks();
  tasks.rows = rows;
  const calls: string[] = [];
  const taskAdmin: TaskAdminDeps = {
    tasks: tasks as never,
    approvals: { adminCancel: async () => { calls.push('adminCancel'); return { ok: false, error: 'stale' } as never; } },
    taskRuns: new TaskRuns(),
    scheduler: { adminAccept: async () => { calls.push('adminAccept'); return { ok: false, error: 'stale' } as never; }, isTaskBusy: () => false },
    webGrants: { revokeRoot: async () => [] },
    bus: new EventBus<AppEvents>(),
    isHalted: () => false,
    nonces: new NonceStore(),
  };
  t.deps.taskAdmin = taskAdmin;
  t.deps.secrets = [SECRET];
  return { ...t, tasks, taskAdmin, calls };
}
const SUBS: [string, Record<string, string>][] = [['list', {}], ['cancel', { task: UUID(1) }], ['retry', { task: UUID(1) }], ['done', { task: UUID(1) }]];
const BUTTONS = ['taskadm:cancel:0123456789abcdef', 'taskadm:done:0123456789abcdef', 'taskadm:dismiss:0123456789abcdef'];

describe('authorisation (TA-C1)', () => {
  it.each(SUBS)('/task %s: a non-admin and a wrong channel are refused before any handler runs', async (sub, strings) => {
    const t = await rig([row(1)]);
    const a = await handleInteraction(cmd('task', sub, { strings, roles: ['1565000000000000002'] }), t.deps);
    expect(a!.content).toBe('Only Bot Admins can do this.');
    const b = await handleInteraction(cmd('task', sub, { strings, channelId: '999' }), t.deps);
    expect(b!.content).toBe('Use this in #⚙️-setting.');
    expect(t.calls).toEqual([]);
    expect(t.tasks.lastLimit).toBe(0);
  });

  it.each(BUTTONS)('button %s: a non-admin and a wrong channel are refused', async (customId) => {
    const t = await rig([row(1)]);
    expect((await handleInteraction(interaction({ kind: 'button', customId, roles: ['1565000000000000002'] }), t.deps))!.content).toBe('Only Bot Admins can do this.');
    expect((await handleInteraction(interaction({ kind: 'button', customId, channelId: '999' }), t.deps))!.content).toBe('Use this in #⚙️-setting.');
    // a taskadm button is never accepted in an approvals room (that branch is only for approval: ids)
    const room = '1570000000000000777';
    const t2 = await rig([row(1)]);
    (t2.deps.cfg as unknown as { get: (k: string) => unknown }).get = ((orig) => (k: string) => (k === 'approvals.channelByCategory' ? { x: room } : orig(k)))((t2.deps.cfg as unknown as { get: (k: string) => unknown }).get);
    expect((await handleInteraction(interaction({ kind: 'button', customId, channelId: room }), t2.deps))!.content).toBe('Use this in #⚙️-setting.');
  });

  it('every reply is ephemeral (the deferral is too) and allows no mentions', async () => {
    const t = await rig([row(1)]);
    for (const [sub, strings] of SUBS) {
      const i = cmd('task', sub, { strings });
      const r = await handleInteraction(i, t.deps);
      expect(i.deferred).toEqual({ ephemeral: true });
      expect(r!.ephemeral).toBe(true);
      expect(r!.allowedMentions).toEqual({ parse: [] });
    }
    const b = interaction({ kind: 'button', customId: BUTTONS[0]! });
    await handleInteraction(b, t.deps);
    expect(b.deferred).toEqual({ ephemeral: true });
  });

  it('a task command without the deps says so instead of failing', async () => {
    const t = await makeDeps();
    expect((await handleInteraction(cmd('task', 'list', {}), t.deps))!.content).toBe('Task administration is not available.');
  });

  it('there is no model path: no tool or AdminOp name, no Praw command, no panel or config key (static)', () => {
    const names = [...ADMIN_TOOL_NAMES, ...MOD_TOOL_NAMES] as string[];
    expect(names.filter((n) => /task_(cancel|retry|done)|taskadm/.test(n))).toEqual([]);
    expect((PRAW_COMMANDS as { name: string }[]).map((c) => c.name)).not.toContain('task');
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const hits: string[] = [];
    for (const d of ['tools', 'admin']) {
      const walk = (dir: string): void => {
        for (const f of readdirSync(dir)) {
          const p = join(dir, f);
          if (statSync(p).isDirectory()) walk(p);
          else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && /task_cancel|task_retry|task_done|taskadm:|adminCancel|adminAccept/.test(readFileSync(p, 'utf8'))) hits.push(p);
        }
      };
      walk(join(root, d));
    }
    expect(hits).toEqual([]);
  });

  it('the definitions: /task has list, cancel, retry and done with the bounded options', () => {
    const task = COMMANDS.find((c) => c.name === 'task') as unknown as { options: { name: string; options: { name: string; required?: boolean; min_length?: number; max_length?: number; choices?: { value: string }[] }[] }[] };
    expect(task.options.map((o) => o.name)).toEqual(['list', 'cancel', 'retry', 'done']);
    const cancel = task.options.find((o) => o.name === 'cancel')!;
    expect(cancel.options.find((o) => o.name === 'task')).toMatchObject({ required: true, min_length: 6, max_length: 36 });
    expect(cancel.options.find((o) => o.name === 'cascade')!.choices).toEqual([{ name: 'children', value: 'children' }]);
    expect(cancel.options.find((o) => o.name === 'reason')).toMatchObject({ max_length: 200 });
    expect(task.options.find((o) => o.name === 'list')!.options[0]!.choices!.map((c) => c.value)).toEqual(['open', 'blocked', 'review', 'doing', 'todo', 'awaiting_approval']);
    expect(task.options.find((o) => o.name === 'retry')!.options.map((o) => o.name)).toEqual(['task', 'reset_turns']);
  });
});

describe('the button custom id and the nonces (TA-C2)', () => {
  it('only the exact shape is accepted; anything else answers Unknown action.', async () => {
    expect(TASKADM_ID.test('taskadm:cancel:0123456789abcdef')).toBe(true);
    for (const bad of ['taskadm:cancel:0123456789abcde', 'taskadm:cancel:0123456789abcdeF', 'taskadm:cancel:0123456789abcdef0', 'taskadm:nuke:0123456789abcdef', 'taskadm:cancel:0123456789abcdeg', 'taskadm:cancel:0123456789abcdef\n']) expect(TASKADM_ID.test(bad)).toBe(false);
    const t = await rig();
    for (const customId of ['taskadm:cancel:xyz', 'taskadm:nuke:0123456789abcdef', 'taskadm:']) expect((await handleInteraction(interaction({ kind: 'button', customId }), t.deps))!.content).toBe('Unknown action.');
  });

  const e = { kind: 'cancel' as const, userId: 'u1', targetId: 't', digest: 'd'.repeat(12), cascade: true, reason: null };
  it('wrong user, expired, reused, and a nonce of the other subcommand all fail; every lookup consumes it', () => {
    let now = 1_000;
    const s = new NonceStore(() => now);
    const a = s.issue(e);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(s.take(a, 'u2', 'cancel')).toBeNull();
    expect(s.take(a, 'u1', 'cancel')).toBeNull(); // consumed by the refused lookup
    const b = s.issue(e);
    expect(s.take(b, 'u1', 'cancel')).toMatchObject({ targetId: 't' });
    expect(s.take(b, 'u1', 'cancel')).toBeNull(); // single use
    const c = s.issue(e);
    expect(s.take(c, 'u1', 'done')).toBeNull(); // a cancel nonce on a done button
    const d = s.issue({ ...e, kind: 'done' });
    expect(s.take(d, 'u1', 'cancel')).toBeNull(); // and the reverse
    const x = s.issue(e);
    now += NONCE_TTL_MS;
    expect(s.take(x, 'u1', 'cancel')).toBeNull(); // expired after 5 minutes
    expect(s.take('0123456789abcdef', 'u1', 'any')).toBeNull(); // a forged id
    const dm = s.issue({ ...e, kind: 'done' });
    expect(s.take(dm, 'u1', 'any')).toMatchObject({ kind: 'done' }); // dismiss takes either
  });

  it('is capped: the oldest entry is evicted, the map never grows past the cap, expired entries are dropped first', () => {
    let now = 1;
    const s = new NonceStore(() => now);
    const first = s.issue(e);
    for (let i = 0; i < NONCE_MAX + 20; i++) s.issue(e);
    expect(s.size).toBe(NONCE_MAX);
    expect(s.take(first, 'u1', 'cancel')).toBeNull();
    now += NONCE_TTL_MS + 1;
    s.issue(e);
    expect(s.size).toBe(1);
  });
});

describe('resolveTaskRef (TA-C3)', () => {
  const t = new FakeTasks();
  t.rows = [row(1), row(2, { status: 'blocked' }), row(3)];
  it.each(['', 'abc12', 'ABC123XYZ', '%%%%%%', '50_0c62', '5060c62%', '50 60c6', 'x'.repeat(40), `${'a'.repeat(37)}`, '..\\..\\x'])('refuses %j before any query', async (ref) => {
    const before = t.lastLimit;
    expect(await resolveTaskRef(ref, t as never)).toEqual({ ok: false, code: 'E_BAD_ID' });
    expect(t.lastLimit).toBe(before);
  });
  it('trims and lowercases; 0 rows is not found; one is the match; several are ambiguous with at most 5 listed', async () => {
    expect(await resolveTaskRef(`  ${UUID(1).toUpperCase()} `, t as never)).toEqual({ ok: true, id: UUID(1), deptId: 'hq', status: 'review' });
    expect(await resolveTaskRef('ffffffff', t as never)).toEqual({ ok: false, code: 'E_NOT_FOUND' });
    const many = new FakeTasks();
    many.rows = Array.from({ length: 8 }, (_, i) => row(1, { id: `5060c62${i}-aaaa-4bbb-8ccc-000000000000` }));
    const r = await resolveTaskRef('5060c62', many as never);
    expect(r).toMatchObject({ ok: false, code: 'E_AMBIGUOUS' });
    expect((r as { lines: string[] }).lines).toHaveLength(5);
    expect((r as { lines: string[] }).lines[0]).toBe('5060c620 hq review');
  });
});

describe('/task list (TA-C4)', () => {
  it('prints the header, one line per task with idle time, children, depth, a masked one-line title and blocked reasons (owner for a NULL reason)', async () => {
    const t = await rig([
      row(1, { title: `deploy ${SECRET} @everyone <@123456789012345678> **bold**\nsecond`, openChildren: 5 }),
      row(2, { status: 'blocked', blockedReason: 'turns', depth: 1 }),
      row(3, { status: 'blocked', blockedReason: null }),
      row(4, { status: 'blocked', blockedReason: 'owner', blockedNote: `need ${SECRET} now\nplease` }),
      row(5, { status: 'doing' }),
    ]);
    const r = await handleInteraction(cmd('task', 'list', {}), t.deps);
    const c = r!.content!;
    expect(c.split('\n')[0]).toBe('Open 5/20 (limits.openTasks) · todo 0 · doing 1 · review 1 · blocked 3 · awaiting 0');
    expect(c).toContain('5060c621 · hq · review · idle 3h12m · open children 5/5 · root · deploy');
    expect(c).not.toContain(SECRET);
    expect(c).not.toContain('@everyone');
    expect(c).not.toContain('<@123');
    expect(c).not.toContain('\nsecond');
    expect(c).toContain('blocked:turns');
    expect(c).toContain('d1');
    expect(c).toContain('blocked:owner');
    expect(c).toMatch(/blocked:owner[^\n]*need \\\[REDACTED/);
    expect(r!.allowedMentions).toEqual({ parse: [] });
  });

  it('filters by status, refuses an unknown filter, cuts the title to 40 characters and the note to 80', async () => {
    const t = await rig([row(1, { title: 'x'.repeat(100) }), row(2, { status: 'blocked', blockedReason: 'owner', blockedNote: 'n'.repeat(200) })]);
    const only = await handleInteraction(cmd('task', 'list', { strings: { status: 'blocked' } }), t.deps);
    expect(only!.content).not.toContain('5060c621');
    expect(only!.content).toMatch(/n{80}/);
    expect(only!.content).not.toMatch(/n{81}/);
    const all = await handleInteraction(cmd('task', 'list', {}), t.deps);
    expect(all!.content).toMatch(/x{40}/);
    expect(all!.content).not.toMatch(/x{41}/);
    expect((await handleInteraction(cmd('task', 'list', { strings: { status: 'done' } }), t.deps))!.content).toBe('Unknown status filter.');
  });

  it('25 rows of maximum length stay under 2000 characters with "… and N more"; at most 25 are read for display', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(i + 1, { title: '`*_~|>[]()#\\'.repeat(10), status: 'blocked', blockedReason: 'owner', blockedNote: '`*_~|>[]()#\\'.repeat(20), openChildren: 100, depth: 20 }));
    const t = await rig(rows);
    const r = await handleInteraction(cmd('task', 'list', {}), t.deps);
    expect(r!.content!.length).toBeLessThanOrEqual(2000);
    expect(r!.content).toMatch(/… and \d+ more$/);
    expect(t.tasks.lastLimit).toBeLessThanOrEqual(26);
    expect((r!.content!.match(/\n5060c62/g) ?? []).length).toBeLessThanOrEqual(25);
  });

  it('is read-only: it writes no audit row', async () => {
    const t = await rig([row(1)]);
    await handleInteraction(cmd('task', 'list', {}), t.deps);
    expect(t.audits).toEqual([]);
  });
});

describe('the cancel click: effects in the TA-C9 order and the reason (TA-C12)', () => {
  it('abort first, then the web grant revoke, then the card close, then every audit row, then the reply; the reason is passed on, masked', async () => {
    const order: string[] = [];
    const t = await rig([row(1)]);
    t.deps.cards = { close: async (_c, m) => { order.push(`close:${m}`); } };
    t.deps.audit = async (e) => { order.push(`audit:${e.action}`); };
    const seen: unknown[] = [];
    t.taskAdmin.approvals = {
      adminCancel: async (a, beforeEmit) => {
        seen.push(a);
        await beforeEmit?.([UUID(1)]);
        return { ok: true, ids: [UUID(1)], rootId: UUID(1), rootEnded: true, expired: [{ id: 5, taskId: UUID(1), kind: 'estimate', toolName: null }], batches: [{ id: 9, state: 'closed', channelId: '1570000000000000001', messageId: '1570000000000000002' }] };
      },
    };
    t.taskAdmin.taskRuns = { abort: (ids) => { order.push(`abort:${ids.length}`); return 1; }, active: () => false };
    t.taskAdmin.webGrants = { revokeRoot: async () => { order.push('revoke'); return [3]; } };
    const c = await handleInteraction(cmd('task', 'cancel', { strings: { task: UUID(1).slice(0, 8), reason: `old ${SECRET} @everyone` } }), t.deps);
    const id = (c!.components as unknown as { components: { custom_id: string }[] }[])[0]!.components[0]!.custom_id;
    order.length = 0;
    await handleInteraction(interaction({ kind: 'button', customId: id }), t.deps);
    expect(order).toEqual(['abort:1', 'revoke', 'close:1570000000000000002', 'audit:task.cancel', 'audit:approval.expire', 'audit:web_grant.revoke', 'audit:task.cancel.abort']);
    expect(seen).toEqual([expect.objectContaining({ reason: 'old [REDACTED] @everyone', target: UUID(1), cascade: false })]);
  });
});

describe('refusals before any state change (text and audit)', () => {
  it('cancel and retry with a bad, unknown or ambiguous id answer with the fixed text and write a refused audit row', async () => {
    const t = await rig([row(1)]);
    for (const sub of ['cancel', 'retry', 'done']) {
      expect((await handleInteraction(cmd('task', sub, { strings: { task: 'zz' } }), t.deps))!.content).toBe('Give at least 6 characters of the task id (0-9, a-f).');
      expect((await handleInteraction(cmd('task', sub, { strings: { task: 'ffffffff' } }), t.deps))!.content).toBe('No task matches that id.');
    }
    expect(t.audits).toContainEqual(expect.objectContaining({ actor: 'user:u1', action: 'task.cancel', outcome: 'refused:E_BAD_ID' }));
    expect(t.audits).toContainEqual(expect.objectContaining({ action: 'task.retry', outcome: 'refused:E_NOT_FOUND' }));
    expect(t.audits).toContainEqual(expect.objectContaining({ action: 'task.done', outcome: 'refused:E_BAD_ID' }));
    expect(JSON.stringify(t.audits)).not.toContain('task 1'); // ids and codes only, never titles
    expect(t.calls).toEqual([]);
  });
});

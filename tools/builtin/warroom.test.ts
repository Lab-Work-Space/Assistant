import { describe, expect, it, vi } from 'vitest';
import { MemNotes, MemTasks, auditSpy, newBus, runCtxBase, seededOrg } from '../../agents/test-helpers.js';
import type { ActorRef } from '../../company/types.js';
import { BotRoots } from '../../governance/botroots.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { ToolRegistry } from '../registry.js';
import type { MeetingPort, ToolContext } from '../types.js';
import { createTask } from './createTask.js';
import { meetingStart } from './meetingStart.js';

const HQ: ActorRef = { kind: 'head', dept: 'hq' };

async function ctx(over: Partial<ToolContext> = {}, cfg = new FakeConfig()) {
  const tasks = new MemTasks();
  const roots = new BotRoots(cfg, async () => [...tasks.rows.values()].filter((t) => t.parentId === null && t.origin === 'delegated' && t.requester.kind !== 'human').length);
  const c: ToolContext = {
    actor: HQ, task: null, ...runCtxBase(), org: await seededOrg(), tasks,
    approvals: { needsApproval: () => false, request: vi.fn(async () => ({}) as never) },
    limits: new Limits(cfg, tasks), bus: newBus(), notes: new MemNotes(), audit: auditSpy().audit, rootTaskGate: roots, ...over,
  };
  return { c, tasks, roots };
}
const input = (title = 't') => createTask.inputSchema.parse({ title, description: 'd', assignee: { kind: 'head', dept: 'software' }, estCostUsd: 0 });

describe('TW6 root tasks born from bot talk are capped per day', () => {
  it('the 11th root task of the day is refused with a toolError; the 10 before it are created, tainted like the run', async () => {
    const { c, tasks } = await ctx();
    c.run.markTainted();
    for (let i = 0; i < 10; i++) expect((await createTask.run(input(`t${i}`), c)).isError, `#${i}`).toBeFalsy();
    const res = await createTask.run(input('t10'), c);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/daily limit/);
    expect(tasks.rows.size).toBe(10);
    expect([...tasks.rows.values()].every((t) => t.tainted)).toBe(true);
  });

  it('concurrent creations cannot pass the cap together', async () => {
    const { c, tasks } = await ctx({}, new FakeConfig({ 'warroom.rootTasksPerDay': 3 }));
    const res = await Promise.all(Array.from({ length: 8 }, (_, i) => createTask.run(input(`t${i}`), c)));
    expect(res.filter((r) => !r.isError)).toHaveLength(3);
    expect(tasks.rows.size).toBe(3);
  });

  it('a subtask of an existing task is not a root task and is not gated', async () => {
    const { c, tasks } = await ctx({}, new FakeConfig({ 'warroom.rootTasksPerDay': 1 }));
    const parent = await tasks.create({ title: 'p', deptId: 'hq', owner: HQ, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
    for (let i = 0; i < 3; i++) expect((await createTask.run(input(`c${i}`), { ...c, task: parent })).isError).toBeFalsy();
  });

  it('a gate failure (count error) refuses; a run-specific gate (meeting close) replaces the default', async () => {
    const boom = new BotRoots(new FakeConfig(), async () => { throw new Error('db'); });
    const { c } = await ctx({ rootTaskGate: boom });
    expect((await createTask.run(input(), c)).isError).toBe(true);
    const { c: c2, tasks } = await ctx({ rootTaskGate: { acquire: async () => () => undefined } });
    expect((await createTask.run(input(), c2)).isError).toBeFalsy();
    expect(tasks.rows.size).toBe(1);
  });
});

describe('TW13 meeting_start', () => {
  const port = (): MeetingPort & { starts: unknown[] } => {
    const starts: unknown[] = [];
    return { starts, refusal: () => null, start: async (r) => (starts.push(r), { ok: true, id: 'm' }) };
  };
  const reg = () => {
    const r = new ToolRegistry({ halt: { isHalted: () => false } });
    r.register(meetingStart);
    return r;
  };
  const args = { topic: 'Launch', agenda: ['a'], invitees: ['rnd'] };

  it('an untainted run opens the meeting', async () => {
    const m = port();
    const { c } = await ctx({ meetings: m });
    const res = await reg().run('meeting_start', args, c);
    expect(res.isError).toBeFalsy();
    expect(m.starts).toHaveLength(1);
  });

  it('RULING: a tainted run with no task cannot start one (approval needed, and none can be asked outside a task)', async () => {
    const m = port();
    const { c } = await ctx({ meetings: m });
    c.run.markTainted();
    const res = await reg().run('meeting_start', args, c);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/needs approval and can only run inside a task/);
    expect(m.starts).toHaveLength(0);
  });

  it('RULING: a tainted run inside its own task files an approval and starts nothing yet', async () => {
    const m = port();
    const { c, tasks } = await ctx({ meetings: m });
    const task = await tasks.create({ title: 'goal', deptId: 'hq', owner: HQ, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
    c.run.markTainted();
    const res = await reg().run('meeting_start', args, { ...c, task });
    expect(res.content).toMatch(/^NOT DONE YET: waiting for approval of/);
    expect(c.approvals.request).toHaveBeenCalledTimes(1);
    expect(m.starts).toHaveLength(0);
  });

  it('the caps are checked before the approval question (and again at replay): refusal text, inside a meeting, other actors, no port', async () => {
    const refusing: MeetingPort = { refusal: () => 'another meeting is open', start: async () => ({ ok: true, id: 'x' }) };
    const { c } = await ctx({ meetings: refusing });
    expect((await reg().run('meeting_start', args, c)).content).toBe('another meeting is open');
    const { c: inside } = await ctx({ meetings: port(), inMeeting: true });
    expect((await reg().run('meeting_start', args, inside)).content).toMatch(/inside a meeting/);
    const { c: none } = await ctx();
    expect((await reg().run('meeting_start', args, none)).content).toMatch(/not available/);
    const { c: cto } = await ctx({ meetings: port(), actor: { kind: 'head', dept: 'software' } });
    expect((await reg().run('meeting_start', args, cto)).isError).toBe(true); // not in its allowlist
  });

  it('input bounds: at most 5 agenda points, 9 invitees, topic 100', () => {
    const ok = { topic: 't', agenda: ['a'], invitees: ['rnd'] };
    expect(meetingStart.inputSchema.safeParse(ok).success).toBe(true);
    for (const bad of [{ ...ok, agenda: Array(6).fill('a') }, { ...ok, agenda: [] }, { ...ok, invitees: [] }, { ...ok, invitees: ['hq', 'rnd', 'it', 'sales', 'hr', 'ops', 'finance', 'marketing', 'software', 'praw'] }, { ...ok, topic: 'a'.repeat(101) }, { ...ok, invitees: ['nobody'] }])
      expect(meetingStart.inputSchema.safeParse(bad).success).toBe(false);
  });
});

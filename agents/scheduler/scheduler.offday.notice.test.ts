import { describe, expect, it, vi } from 'vitest';
import { createCalendar } from '../../company/calendar.js';
import type { ActorRef } from '../../company/types.js';
import { Limits } from '../../governance/limits.js';
import type { OtHook } from '../../governance/spend/ot.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeDiscordPort } from '../../tests/fakes/discordPort.js';
import type { AgentDeps, AgentOutcome } from '../loop/loop.js';
import { Scheduler } from './scheduler.js';
import { CTO, MemTasks, newBus, noApprovedTools, seededOrg } from '../test-helpers.js';

const SA: ActorRef = { kind: 'persona', personaId: 'system-analyst' };
const HQ: ActorRef = { kind: 'head', dept: 'hq' };
const SAT = Date.parse('2026-11-07T03:00:00Z'); // Saturday 10:00 in Bangkok
const MON = Date.parse('2026-11-09T03:00:00Z');
const human = { kind: 'human', userId: '42' } as const;
const chat = (body: string): AgentOutcome => ({ payload: { type: 'chat', body }, costUsd: 0, turns: 1 });

/** `tasks` shared between two schedulers simulates a restart. */
async function mk(o: { tasks?: MemTasks; now?: number; holidays?: { date: string; name?: string }[]; ot?: OtHook } = {}) {
  const cfg = new FakeConfig({ 'schedule.offDays': [0, 6], 'schedule.holidays': o.holidays ?? [] });
  const tasks = o.tasks ?? new MemTasks();
  const port = new FakeDiscordPort();
  const bus = newBus();
  const run = vi.fn(async () => chat('ok'));
  const s = new Scheduler({
    agent: {} as AgentDeps, approvedTools: noApprovedTools, run, port, org: await seededOrg(), tasks, limits: new Limits(cfg, tasks),
    halt: { isHalted: () => false }, cfg, bus, log: { error: () => undefined }, now: () => o.now ?? SAT, calendar: createCalendar(cfg),
    ...(o.ot ? { ot: o.ot } : {}),
  });
  s.attach();
  return { s, port, tasks, bus, run };
}
const notices = (p: FakeDiscordPort) => p.posts.filter((x) => x.payload.type === 'chat' && x.payload.body.startsWith('⏸️'));
const root = (t: MemTasks, origin: 'chat' | 'schedule' = 'chat') =>
  t.create({ title: 'Root', deptId: 'hq', owner: HQ, requester: origin === 'chat' ? human : HQ, origin, threadId: 'th-root', channelId: 'ch-hq', status: 'doing' });
const child = (t: MemTasks, parentId: string, deptId: 'software' | 'hq' = 'software') => t.create({ title: 'Kid', deptId, owner: deptId === 'software' ? SA : CTO, requester: HQ, origin: 'delegated', parentId, threadId: null });

describe('off-day notice (OFFDAY-1)', () => {
  it('a delegated child of a person-started root posts one plain notice in the root thread, naming the dept and the next workday (weekend)', async () => {
    const t = await mk();
    const r = await root(t.tasks);
    const c = await child(t.tasks, r.id);
    await t.bus.emit('task.created', { task: c });
    await t.s.idle();
    const n = notices(t.port);
    expect(n).toHaveLength(1);
    expect(n[0]!.target).toEqual({ channelId: 'ch-hq', threadId: 'th-root' });
    expect(n[0]!.actor).toEqual({ kind: 'head', dept: 'hq' });
    expect(n[0]!.payload).toEqual({ type: 'chat', body: expect.stringContaining('วันจันทร์ที่ 9 พฤศจิกายน') });
    expect((n[0]!.payload as { title?: string }).title).toBeUndefined();
    expect(n[0]!.opts?.mentionUserIds).toBeUndefined();
    expect(t.run).not.toHaveBeenCalled(); // which tasks run is unchanged
    expect((await t.tasks.get(c.id))!.status).toBe('todo');
  });

  it('a holiday after the weekend moves the next workday on', async () => {
    const t = await mk({ holidays: [{ date: '2026-11-09', name: 'x' }] });
    const r = await root(t.tasks);
    await t.bus.emit('task.created', { task: await child(t.tasks, r.id) });
    await t.s.idle();
    expect(notices(t.port)[0]!.payload).toMatchObject({ body: expect.stringContaining('วันอังคารที่ 10 พฤศจิกายน') });
  });

  it('a second child of the same root, and a restart, post no second notice', async () => {
    const t = await mk();
    const r = await root(t.tasks);
    await t.bus.emit('task.created', { task: await child(t.tasks, r.id) });
    await t.bus.emit('task.created', { task: await child(t.tasks, r.id, 'hq') });
    await t.s.idle();
    expect(notices(t.port)).toHaveLength(1);
    const again = await mk({ tasks: t.tasks }); // restart: recovery re-schedules every todo task
    for (const k of await t.tasks.listByStatus('todo')) void again.s.onTaskReady(k.id);
    await again.s.idle();
    expect(notices(again.port)).toHaveLength(0);
  });

  it('the recovery pass tells a root that has held children and has had no notice today', async () => {
    const t = await mk();
    const r = await root(t.tasks);
    await child(t.tasks, r.id);
    await child(t.tasks, r.id, 'hq');
    await t.s.onTaskReady((await t.tasks.listByStatus('todo'))[0]!.id);
    await t.s.onTaskReady((await t.tasks.listByStatus('todo'))[1]!.id);
    await t.s.idle();
    expect(notices(t.port)).toHaveLength(1);
    expect((notices(t.port)[0]!.payload as { body: string }).body).toMatch(/.+, .+/); // both depts named
  });

  it('a new off day (the claim is per day) notifies again', async () => {
    const t = await mk();
    const r = await root(t.tasks);
    const c = await child(t.tasks, r.id);
    await t.bus.emit('task.created', { task: c });
    await t.s.idle();
    const sun = await mk({ tasks: t.tasks, now: SAT + 86_400_000 });
    await sun.s.onTaskReady(c.id);
    await sun.s.idle();
    expect(notices(sun.port)).toHaveLength(1);
  });

  it('a root no person started (schedule) posts nothing', async () => {
    const t = await mk();
    const r = await root(t.tasks, 'schedule');
    await t.bus.emit('task.created', { task: await child(t.tasks, r.id) });
    await t.s.idle();
    expect(notices(t.port)).toHaveLength(0);
  });

  it('a working day posts nothing and runs the child', async () => {
    const t = await mk({ now: MON });
    const r = await root(t.tasks);
    await t.bus.emit('task.created', { task: await child(t.tasks, r.id) });
    await t.s.idle();
    expect(notices(t.port)).toHaveLength(0);
    expect(t.run).toHaveBeenCalledTimes(1);
  });

  it('OT-C14: an overtime raise that throws never skips the notice (one notice, no OT line); a pending request adds the OT line to the same single notice', async () => {
    const boom: OtHook = { raise: async () => { throw new Error('raise failed'); }, usable: async () => false, consume: async () => false };
    const t = await mk({ ot: boom });
    const r = await root(t.tasks);
    await t.bus.emit('task.created', { task: await child(t.tasks, r.id) });
    await t.s.idle();
    expect(notices(t.port)).toHaveLength(1);
    expect((notices(t.port)[0]!.payload as { body: string }).body).not.toContain('OT');
    const pending: OtHook = { raise: async () => true, usable: async () => false, consume: async () => false };
    const p = await mk({ ot: pending });
    const r2 = await root(p.tasks);
    await p.bus.emit('task.created', { task: await child(p.tasks, r2.id) });
    await p.s.idle();
    expect(notices(p.port)).toHaveLength(1);
    expect((notices(p.port)[0]!.payload as { body: string }).body).toContain('ส่งคำขอ OT ให้ Bot Admin แล้ว');
  });
});

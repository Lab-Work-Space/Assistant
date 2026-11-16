import { describe, expect, it, vi } from 'vitest';
import type { Task } from '../../db/repos/tasks.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeProvider, ProviderRegistry } from '../../providers/index.js';
import { FakeDiscordPort } from '../../tests/fakes/discordPort.js';
import type { AgentDeps } from '../loop/loop.js';
import { AUTOCLOSE_SUMMARY, Scheduler } from './scheduler.js';
import { CTO, MemTasks, newBus, noApprovedTools, prompts, seededOrg } from '../test-helpers.js';

// OPS-HOLD part B: the stale review sweep. The repo owns the eligibility SQL (tasks.int.test.ts); the scheduler owns config, gates, lock, audit and the event.
const NOW = 1_800_000_000_000;
async function mk(o: { hours?: number; halted?: boolean; pending?: Record<string, number>; off?: boolean } = {}) {
  const cfg = new FakeConfig();
  if (o.hours !== undefined) await cfg.set('review.autoCloseHours', o.hours, 'test');
  const providers = new ProviderRegistry();
  providers.register(new FakeProvider([], 'claude-code-local'));
  const mem = new MemTasks();
  const candidates: Task[] = [];
  const closedWith: Date[] = [];
  const tasks = mem as unknown as MemTasks & { staleReview: (b: Date, n: number) => Promise<Task[]>; closeStaleReview: (id: string, b: Date) => Promise<Task | null> };
  tasks.staleReview = async () => candidates.filter((t) => t.status === 'review');
  tasks.closeStaleReview = async (id, before) => { closedWith.push(before); return (await mem.update(id, { status: 'done' }, 'review')) ?? null; };
  const bus = newBus();
  const changed: { from: string; to: string; summary?: string; id: string }[] = [];
  bus.on('task.changed', (e) => void changed.push({ from: e.from, to: e.to, ...(e.summary ? { summary: e.summary } : {}), id: e.task.id }));
  const audits: { action: string; taskId?: string | null; outcome?: string | null }[] = [];
  const org = await seededOrg();
  const agent = { org, prompts, overrides: { getActive: async () => null }, providers, cfg } as unknown as AgentDeps;
  const s = new Scheduler({
    agent, approvedTools: noApprovedTools, run: vi.fn(), port: new FakeDiscordPort(), org, tasks: tasks as never, limits: new Limits(cfg, mem), halt: { isHalted: () => o.halted === true }, cfg, bus,
    log: { error: () => undefined }, now: () => NOW, paused: () => false, providerReady: () => true, admin: { audit: async (e) => void audits.push(e) },
    ...(o.off ? { calendar: { isOffDay: () => ({ off: true as const, reason: 'weekday' as const }) } } : {}),
    pendingApprovals: async (id) => o.pending?.[id] ?? 0,
  });
  const inReview = async (extra: Partial<Parameters<MemTasks['create']>[0]> = {}) => {
    const t = await mem.create({ title: 'Done by owner', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '42' }, origin: 'delegated', ...extra });
    const r = (await mem.update(t.id, { status: 'review' }))!;
    candidates.push(r);
    return r;
  };
  return { s, mem, inReview, changed, audits, closedWith };
}

describe('Scheduler stale review sweep (OPS-HOLD)', () => {
  it('R1-02: no sweep on an off day', async () => {
    const t = await mk({ off: true });
    const a = await t.inReview();
    expect(await t.s.autoCloseReviews()).toBe(0);
    expect((await t.mem.get(a.id))?.status).toBe('review');
    expect(t.audits).toEqual([]);
  });
  it('closes an eligible review task to done with the fixed event summary, an audit row, and the cutoff = now - autoCloseHours (default 24)', async () => {
    const t = await mk();
    const a = await t.inReview();
    expect(await t.s.autoCloseReviews()).toBe(1);
    expect((await t.mem.get(a.id))?.status).toBe('done');
    expect(t.changed).toEqual([{ from: 'review', to: 'done', summary: AUTOCLOSE_SUMMARY, id: a.id }]);
    expect(t.audits).toEqual([{ actor: 'system', action: 'task.review.autoclose', taskId: a.id, outcome: 'done' }]);
    expect(t.closedWith[0]!.getTime()).toBe(NOW - 24 * 3_600_000);
    expect(await t.s.autoCloseReviews()).toBe(0);
  });
  it('autoCloseHours 0 turns it off; a custom value moves the cutoff', async () => {
    const off = await mk({ hours: 0 });
    const a = await off.inReview();
    expect(await off.s.autoCloseReviews()).toBe(0);
    expect((await off.mem.get(a.id))?.status).toBe('review');
    const six = await mk({ hours: 6 });
    await six.inReview();
    await six.s.autoCloseReviews();
    expect(six.closedWith[0]!.getTime()).toBe(NOW - 6 * 3_600_000);
  });
  it('leaves a task with a pending approval, and a conversation root (it has its own close)', async () => {
    const pending: Record<string, number> = {};
    const t = await mk({ pending });
    const pend = await t.inReview();
    pending[pend.id] = 1;
    const conv = await t.inReview({ conversation: true });
    expect(await t.s.autoCloseReviews()).toBe(0);
    expect((await t.mem.get(pend.id))?.status).toBe('review');
    expect((await t.mem.get(conv.id))?.status).toBe('review');
    pending[pend.id] = 0;
    expect(await t.s.autoCloseReviews()).toBe(1);
    expect((await t.mem.get(pend.id))?.status).toBe('done');
  });
  it('does nothing while halted', async () => {
    const h = await mk({ halted: true });
    const x = await h.inReview();
    expect(await h.s.autoCloseReviews()).toBe(0);
    expect((await h.mem.get(x.id))?.status).toBe('review');
  });
  it('closes at most 10 per sweep (a backlog never bursts roll-up runs)', async () => {
    const t = await mk();
    for (let i = 0; i < 12; i++) await t.inReview();
    expect(await t.s.autoCloseReviews()).toBe(10);
    expect(await t.s.autoCloseReviews()).toBe(2);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeProvider, ProviderRegistry } from '../../providers/index.js';
import { FakeDiscordPort } from '../../tests/fakes/discordPort.js';
import type { AgentDeps, AgentOutcome, AgentTrigger } from '../loop/loop.js';
import { PROVIDER_ID } from '../../providers/claude-code-local/protocol.js';
import { CLAUDE_LOCAL_ID } from '../../providers/types.js';
import { Scheduler } from './scheduler.js';
import { CTO, MemTasks, humanMsg, newBus, noApprovedTools, prompts, seededOrg } from '../test-helpers.js';

// OPS-HOLD: while the quota hold is on, actors on claude-code-local get no run (work waits, nothing fails); Praw (gemini) is unaffected.
const PRAW: ActorRef = { kind: 'head', dept: 'praw' };
const chat = (body: string): AgentOutcome => ({ payload: { type: 'chat', body }, costUsd: 0, turns: 1 });

async function mk() {
  const cfg = new FakeConfig();
  await cfg.set('provider.default', { provider: 'claude-code-local', model: 'claude-sonnet-5-5' }, 'test');
  const providers = new ProviderRegistry();
  providers.register(new FakeProvider([], 'gemini'));
  providers.register(new FakeProvider([], 'claude-code-local'));
  const tasks = new MemTasks();
  const port = new FakeDiscordPort();
  const bus = newBus();
  const runs: AgentTrigger[] = [];
  const run = vi.fn(async (t: AgentTrigger) => { runs.push(t); return chat('ok'); });
  const org = await seededOrg({ editDept: (d) => (d.id === 'praw' ? { ...d, provider: 'gemini', model: 'gemini-3.8-flash' } : d) });
  const agent = { org, prompts, overrides: { getActive: async () => null }, providers, cfg } as unknown as AgentDeps;
  const hold = { until: null as number | null };
  const s = new Scheduler({
    agent, approvedTools: noApprovedTools, run, port, org, tasks, limits: new Limits(cfg, tasks), halt: { isHalted: () => false }, cfg, bus,
    log: { error: () => undefined }, now: () => 1_000_000, paused: () => false, providerReady: () => true, quotaHold: { heldUntil: () => hold.until },
  });
  s.attach();
  return { s, port, tasks, bus, runs, hold };
}
const actorsRun = (runs: AgentTrigger[]) => runs.map((r) => r.route.actor);

describe('Scheduler quota hold (OPS-HOLD)', () => {
  it('the shared provider id constant equals the provider\'s own', () => expect(CLAUDE_LOCAL_ID).toBe(PROVIDER_ID));

  it('isHeld: true only for an actor whose provider is claude-code-local, only while a hold is on', async () => {
    const t = await mk();
    expect(await t.s.isHeld(CTO)).toBe(false);
    t.hold.until = 2_000_000;
    expect(await t.s.isHeld(CTO)).toBe(true);
    expect(await t.s.isHeld(PRAW)).toBe(false);
  });

  it('a held Claude-backed owner gets no run and no failure, its task stays todo; Praw still runs; resumeHeld starts the work after the hold', async () => {
    const t = await mk();
    t.hold.until = 2_000_000;
    const theirs = await t.tasks.create({ title: 'Build it', deptId: 'software', owner: CTO, requester: PRAW, origin: 'delegated' });
    const mine = await t.tasks.create({ title: 'Mine', deptId: 'praw', owner: PRAW, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'th-m', channelId: 'ch-m' });
    await t.bus.emit('task.created', { task: theirs });
    await t.s.onTaskReady(mine.id);
    await t.s.idle();
    expect(actorsRun(t.runs)).toEqual([PRAW]);
    expect((await t.tasks.get(theirs.id))?.status).toBe('todo');
    expect(t.runs.some((r) => (r.route.actor as { dept?: string }).dept === 'software')).toBe(false);
    t.hold.until = null;
    t.s.resumeHeld();
    await t.s.idle();
    expect(actorsRun(t.runs)).toContainEqual(CTO);
  });

  it('a chat message to a held head is not run and nothing is posted', async () => {
    const t = await mk();
    t.hold.until = 2_000_000;
    await t.s.onMessage(humanMsg('<@111> hello', { id: 'm1', mentionedHeads: ['software'] }));
    await t.s.idle();
    expect(t.runs).toEqual([]);
    expect(t.port.posts).toEqual([]);
  });
});

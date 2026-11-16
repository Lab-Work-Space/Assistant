import { describe, expect, it, vi } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeProvider, ProviderRegistry } from '../../providers/index.js';
import { FakeDiscordPort } from '../../tests/fakes/discordPort.js';
import type { AgentDeps, AgentOutcome, AgentTrigger } from '../loop/loop.js';
import { Scheduler } from './scheduler.js';
import { CTO, MemTasks, SA, humanMsg, newBus, noApprovedTools, prompts, seededOrg } from '../test-helpers.js';

// PROV-1: provider availability is per actor. provider.default (claude-code-local) is NOT registered; only gemini is, and Praw's department runs on it.
const PRAW: ActorRef = { kind: 'head', dept: 'praw' };
const chat = (body: string): AgentOutcome => ({ payload: { type: 'chat', body }, costUsd: 0, turns: 1 });

async function mk(o: { local?: boolean } = {}) {
  const cfg = new FakeConfig();
  await cfg.set('provider.default', { provider: 'claude-code-local', model: 'claude-sonnet-5-5' }, 'test');
  const providers = new ProviderRegistry();
  providers.register(new FakeProvider([], 'gemini'));
  if (o.local) providers.register(new FakeProvider([], 'claude-code-local'));
  const tasks = new MemTasks();
  const port = new FakeDiscordPort();
  const bus = newBus();
  const runs: AgentTrigger[] = [];
  const run = vi.fn(async (t: AgentTrigger) => { runs.push(t); return chat('ok'); });
  const org = await seededOrg({ editDept: (d) => (d.id === 'praw' ? { ...d, provider: 'gemini', model: 'gemini-3.8-flash' } : d) });
  const agent = { org, prompts, overrides: { getActive: async () => null }, providers, cfg } as unknown as AgentDeps;
  const s = new Scheduler({
    agent, approvedTools: noApprovedTools, run, port, org, tasks, limits: new Limits(cfg, tasks), halt: { isHalted: () => false }, cfg, bus,
    log: { error: () => undefined }, now: () => 1_000_000, paused: () => false, providerReady: () => providers.has(cfg.get('provider.default').provider),
  });
  s.attach();
  return { s, port, tasks, bus, runs, providers };
}
const toPraw = (id: string) => humanMsg('<@222> hello', { id, mentionedHeads: ['praw'] });
const toCto = (id: string) => humanMsg('<@111> hello', { id, mentionedHeads: ['software'] });
const actorsRun = (runs: AgentTrigger[]) => runs.map((r) => r.route.actor);

describe('Scheduler with provider.default missing (PROV-1)', () => {
  it('a chat message to Praw (gemini) runs and is answered', async () => {
    const t = await mk();
    await t.s.onMessage(toPraw('m1'));
    await t.s.idle();
    expect(actorsRun(t.runs)).toEqual([PRAW]);
    expect(t.port.posts.at(-1)).toMatchObject({ payload: { body: 'ok' } });
  });

  it('ask (slash/voice) to Praw runs', async () => {
    const t = await mk();
    const out = await t.s.ask(humanMsg('time?', { id: 'interaction:1', mentionedHeads: ['praw'] }), { deliver: false, origin: 'voice' });
    expect(out?.payload.body).toBe('ok');
  });

  it('a message to a head on the missing provider gets no run, no post, no failure; it runs once the provider is registered', async () => {
    const t = await mk();
    await t.s.onMessage(toCto('m2'));
    await t.s.idle();
    expect(t.runs).toEqual([]);
    expect(t.port.posts).toEqual([]);
    t.providers.register(new FakeProvider([], 'claude-code-local'));
    await t.s.onMessage(toCto('m3'));
    await t.s.idle();
    expect(actorsRun(t.runs)).toEqual([CTO]);
  });

  it('a task Praw delegated to such a head waits in todo and runs when re-scheduled after the provider registers', async () => {
    const t = await mk();
    const task = await t.tasks.create({ title: 'Build it', deptId: 'software', owner: CTO, requester: PRAW, origin: 'delegated' });
    await t.bus.emit('task.created', { task });
    await t.s.idle();
    expect(t.runs).toEqual([]);
    expect((await t.tasks.get(task.id))?.status).toBe('todo');
    t.providers.register(new FakeProvider([], 'claude-code-local'));
    await t.s.onTaskReady(task.id);
    await t.s.idle();
    expect(actorsRun(t.runs)).toEqual([CTO]);
  });

  it('a Praw-owned task runs while a persona on the default provider waits', async () => {
    const t = await mk();
    const mine = await t.tasks.create({ title: 'Mine', deptId: 'praw', owner: PRAW, requester: { kind: 'human', userId: '42' }, origin: 'chat', threadId: 'th-m', channelId: 'ch-m' });
    const theirs = await t.tasks.create({ title: 'Theirs', deptId: 'software', owner: SA, requester: PRAW, origin: 'delegated' });
    await t.s.onTaskReady(mine.id);
    await t.s.onTaskReady(theirs.id);
    await t.s.idle();
    expect(actorsRun(t.runs)).toEqual([PRAW]);
    expect((await t.tasks.get(theirs.id))?.status).toBe('todo');
  });

  it('the global gate stays for work without an actor (jobs, reminders)', async () => {
    const t = await mk();
    expect(t.s.canRun()).toBe(false);
    expect(await t.s.jobCapacity()).toBe(0);
  });

  it('with every provider present both heads run as before', async () => {
    const t = await mk({ local: true });
    await t.s.onMessage(toPraw('m4'));
    await t.s.onMessage(toCto('m5'));
    await t.s.idle();
    expect(actorsRun(t.runs).map((a) => (a as { dept: string }).dept).sort()).toEqual(['praw', 'software']);
    expect(t.s.canRun()).toBe(true);
  });
});

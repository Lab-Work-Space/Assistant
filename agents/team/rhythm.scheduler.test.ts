import { describe, expect, it, vi } from 'vitest';
import { FakeConfig } from '../../governance/test-helpers.js';
import { Limits } from '../../governance/limits.js';
import { FakeDiscordPort } from '../../tests/fakes/discordPort.js';
import { Scheduler } from '../scheduler/scheduler.js';
import { Rhythm } from './rhythm.js';
import { MemTasks, newBus, noApprovedTools, seededOrg } from '../test-helpers.js';
import type { AgentDeps, AgentTrigger } from '../loop/loop.js';

const CH = '1570000000000000111';
const NOW = Date.UTC(2026, 10, 2, 2, 5); // Monday 09:05 in Asia/Bangkok

describe('WS11 the scheduler host: one tool-less tainted CEO run, posted by code', () => {
  it('runs the CEO with postOnly (no tools) and the inputs as the message, then posts the text in the channel as the CEO; mentions stay display-only', async () => {
    const cfg = new FakeConfig({ 'rhythm.dailyGoalChannelId': CH } as never);
    const tasks = new MemTasks();
    const port = new FakeDiscordPort();
    const org = await seededOrg();
    const triggers: AgentTrigger[] = [];
    const run = vi.fn(async (t: AgentTrigger) => (triggers.push(t), { payload: { type: 'chat' as const, body: 'Today: ship. @CTO owns it.' }, costUsd: 0, turns: 1, tainted: true }));
    const saved: string[] = [];
    const rhythm = new Rhythm({
      cfg, now: () => NOW, claim: async () => true, save: async (_d, _k, b) => void saved.push(b), lastReport: async () => null,
      openTasks: async () => [{ id: 'abcdef12-1', status: 'todo', deptId: 'software' }], log: { error() {} },
    });
    const s = new Scheduler({
      agent: { org } as AgentDeps, approvedTools: noApprovedTools, run: run as never, port: port as never, org, tasks, limits: new Limits(cfg, tasks), halt: { isHalted: () => false }, cfg, bus: newBus(),
      log: { error() {} }, now: () => NOW, calendar: { isOffDay: () => ({ off: false }) }, rhythm,
    });
    s.attach();
    await rhythm.tick();
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(run).toHaveBeenCalledTimes(1);
    expect(triggers[0]).toMatchObject({ postOnly: true, pool: 'warroom', task: null, route: { actor: { kind: 'head', dept: 'hq' } } });
    expect(triggers[0]!.msg!.content).toContain('#abcdef12 software todo');
    expect(triggers[0]!.instruction).toContain('top three goals');
    expect(port.posts).toHaveLength(1);
    expect(port.posts[0]).toMatchObject({ target: { channelId: CH }, actor: { kind: 'head', dept: 'hq' } });
    expect(port.posts[0]!.payload.title).toBe('Today (2026-11-02)');
  });
});

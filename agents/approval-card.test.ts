import { describe, expect, it, vi } from 'vitest';
import { configRisk, requiresCard } from '../admin/keys.js';
import { CONFIG_CHANNEL_ID } from '../discord/commands/types.js';
import { FakeConfig } from '../governance/test-helpers.js';
import { Limits } from '../governance/limits.js';
import { FakeDiscordPort } from '../tests/fakes/discordPort.js';
import { Scheduler } from './scheduler/scheduler.js';
import { MemTasks, newBus, noApprovedTools, seededOrg } from './test-helpers.js';
import type { AgentDeps } from './loop/loop.js';

const ROOM = '1570000000000000200';

async function mk(approvalChannel?: (a: never) => Promise<string>, postOnly?: () => string[], batching?: never) {
  const cfg = new FakeConfig();
  const tasks = new MemTasks();
  const port = new FakeDiscordPort();
  const bus = newBus();
  const org = await seededOrg();
  const s = new Scheduler({
    agent: { org } as AgentDeps, approvedTools: noApprovedTools, run: vi.fn(), port, org, tasks, limits: new Limits(cfg, tasks), halt: { isHalted: () => false }, cfg, bus,
    log: { error() {} }, now: () => 5_000_000, calendar: { isOffDay: () => ({ off: false }) }, ...(approvalChannel ? { approvalChannel: approvalChannel as never } : {}), ...(postOnly ? { postOnly } : {}), ...(batching ? { batching } : {}),
  });
  s.attach();
  return { port, bus, s };
}
const approval = { id: 7, taskId: 't1', reason: 'big', estCostUsd: 2, requestedBy: 'head:hq', status: 'pending', decidedBy: null, createdAt: new Date(), decidedAt: null, kind: 'estimate' } as const;
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('approval card routing in the scheduler (WS7)', () => {
  it('posts the card where the room chooser says; without a chooser it is #setting as before', async () => {
    const a = await mk(async () => ROOM);
    await a.bus.emit('approval.requested', approval as never);
    await settle();
    expect(a.port.posts.map((p) => p.target.channelId)).toEqual([ROOM]);
    const b = await mk();
    await b.bus.emit('approval.requested', approval as never);
    await settle();
    expect(b.port.posts.map((p) => p.target.channelId)).toEqual([CONFIG_CHANNEL_ID]);
  });
});

describe('approvals.* and card keys (WS9)', () => {
  it('configRisk flags every approvals.* change; requiresCard covers exactly the WS9 list', () => {
    expect(configRisk('approvals.channelByCategory', {}, { a: 'b' })).toBe(true);
    for (const k of ['roles.managerId', 'approvals.channelByCategory', 'net.extraPorts', 'pricing', 'provider.default'] as const) expect(requiresCard(k, null, null), k).toBe(true);
    expect(requiresCard('limits.localUnlimited', false, true)).toBe(true);
    expect(requiresCard('limits.localUnlimited', true, false)).toBe(false);
    for (const k of ['limits.depth', 'budget.taskUsd', 'voice.idleMin'] as const) expect(requiresCard(k, 1, 2), k).toBe(false);
    // G2WS-02 (WS3): a raise of the stall threshold is a card; a lowering stays direct
    expect(requiresCard('warroom.stallTurns', 20, 50)).toBe(true);
    expect(requiresCard('warroom.stallTurns', 20, 10)).toBe(false);
  });
});

describe('approval batching in the scheduler (APPROVAL-BATCH-1)', () => {
  const tool = { ...approval, kind: 'tool', toolName: 'fetch_page', toolInput: { url: 'https://example.com' }, inputSha256: 'a'.repeat(64) };
  const stub = (answer: 'batched' | 'solo') => {
    const calls: string[] = [];
    return { calls, b: { enqueue: async (a: { id: number }) => (calls.push(`enqueue:${a.id}`), answer), flushAll: async () => void calls.push('flushAll'), stop: () => void calls.push('stop'), idle: async () => undefined } as never };
  };

  it('a tool approval that joined a batch posts no solo card; one that did not posts today\'s card at once', async () => {
    const batched = stub('batched');
    const a = await mk(undefined, undefined, batched.b);
    await a.bus.emit('approval.requested', tool as never);
    await settle();
    expect(batched.calls).toEqual(['enqueue:7']);
    expect(a.port.posts).toEqual([]);
    const solo = stub('solo');
    const b = await mk(undefined, undefined, solo.b);
    await b.bus.emit('approval.requested', tool as never);
    await settle();
    expect(b.port.posts.map((p) => p.payload.buttons?.approvalId)).toEqual(['7']);
  });

  it('estimate and cap approvals never reach the batcher', async () => {
    const t = stub('batched');
    const a = await mk(undefined, undefined, t.b);
    for (const kind of ['estimate', 'tree_cap', 'local_cap']) await a.bus.emit('approval.requested', { ...approval, kind } as never);
    await settle();
    expect(t.calls).toEqual([]);
    expect(a.port.posts).toHaveLength(3);
  });

  it('stop() clears the batch timers; recoverApprovalBatches() runs the boot seal-and-flush; attach() does not', async () => {
    const t = stub('solo');
    const a = await mk(undefined, undefined, t.b);
    expect(t.calls).toEqual([]);
    await a.s.recoverApprovalBatches();
    expect(t.calls).toEqual(['flushAll']);
    a.s.stop();
    expect(t.calls).toEqual(['flushAll', 'stop']);
  });

  it('without batching every approval is posted at once as before', async () => {
    const a = await mk();
    await a.bus.emit('approval.requested', tool as never);
    await settle();
    expect(a.port.posts).toHaveLength(1);
    await a.s.recoverApprovalBatches();
  });
});

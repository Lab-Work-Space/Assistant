import { describe, expect, it, vi } from 'vitest';
import { MemNotes, MemTasks, auditSpy, newBus, runCtxBase, seededOrg } from '../../agents/test-helpers.js';
import type { ActorRef } from '../../company/types.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeDiscordPort } from '../../tests/fakes/discordPort.js';
import type { ToolContext } from '../types.js';
import { createTask } from './createTask.js';

const PRAW: ActorRef = { kind: 'head', dept: 'praw' };
const MARKETING_WORK = '1565713202405445652';
const input = createTask.inputSchema.parse({ title: 't', description: 'd', assignee: { kind: 'head', dept: 'marketing' }, estCostUsd: 0 });

async function ctx(port: FakeDiscordPort, userId: string | null = '42') {
  const tasks = new MemTasks();
  const c: ToolContext = {
    actor: PRAW, task: null, ...runCtxBase({ origin: 'chat' }), org: await seededOrg(), tasks,
    approvals: { needsApproval: () => false, request: async () => ({}) as never },
    limits: new Limits(new FakeConfig(), tasks), bus: newBus(), notes: new MemNotes(), audit: auditSpy().audit,
    canMemberView: (u, ch) => port.canMemberView(u, ch),
  };
  c.source = { ...c.source, userId };
  return { c, tasks };
}

describe('delegation via praw (P16d)', () => {
  it('member without View Channel on the target department\'s channels cannot delegate via praw (create_task refused; uses DiscordPort.canMemberView)', async () => {
    const port = new FakeDiscordPort();
    const spy = vi.spyOn(port, 'canMemberView');
    port.view.set(`42|${MARKETING_WORK}`, false);
    const { c, tasks } = await ctx(port);
    const res = await createTask.run(input, c);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/access/);
    expect(spy).toHaveBeenCalledWith('42', MARKETING_WORK);
    expect(tasks.rows.size).toBe(0);
  });

  it('a member who can view the target work channel may delegate', async () => {
    const port = new FakeDiscordPort();
    port.view.set(`42|${MARKETING_WORK}`, true);
    const { c, tasks } = await ctx(port);
    expect((await createTask.run(input, c)).isError).toBeFalsy();
    expect(tasks.rows.size).toBe(1);
  });

  it('a failing permission lookup refuses (fail closed)', async () => {
    const port = new FakeDiscordPort();
    vi.spyOn(port, 'canMemberView').mockRejectedValue(new Error('gateway'));
    const { c, tasks } = await ctx(port);
    expect((await createTask.run(input, c)).isError).toBe(true);
    expect(tasks.rows.size).toBe(0);
  });

  it('a non-praw delegator is not subject to the member check', async () => {
    const port = new FakeDiscordPort();
    port.view.set(`42|${MARKETING_WORK}`, false);
    const { c } = await ctx(port);
    const res = await createTask.run(input, { ...c, actor: { kind: 'head', dept: 'software' } });
    expect(res.isError).toBeFalsy();
  });

  it('no canMemberView wired: praw with a human user is refused (fail closed)', async () => {
    const { c, tasks } = await ctx(new FakeDiscordPort());
    delete c.canMemberView;
    const res = await createTask.run(input, c);
    expect(res.isError).toBe(true);
    expect(tasks.rows.size).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { CTO, MemNotes, MemTasks, auditSpy, newBus, seededOrg, runCtxBase } from '../../agents/test-helpers.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import type { ToolContext } from '../types.js';
import { ToolRegistry } from '../registry.js';
import { approvalFor, BOT_TALK_TOOLS } from '../policy-approval.js';
import { cardBody, FORWARD_WITHHELD } from '../../company/forward.js';
import { forwardTo } from './forwardTo.js';

const GUILD = '1565649426943442944';
const SRC = '1570000000000000001';
async function ctx(over: Partial<ToolContext> = {}) {
  const tasks = new MemTasks();
  const c: ToolContext = {
    actor: CTO, task: null, ...runCtxBase(), org: await seededOrg(), tasks,
    approvals: { needsApproval: () => false, request: async () => ({}) as never },
    limits: new Limits(new FakeConfig(), tasks), bus: newBus(), notes: new MemNotes(), audit: auditSpy().audit,
    guildId: GUILD, source: { channelId: SRC, threadId: null, messageId: '1570000000000000009', userId: null, attachments: [] },
    ...over,
  };
  return { c, tasks };
}
const parse = (o: Record<string, unknown> = {}) => forwardTo.inputSchema.parse({ dept: 'finance', summary: 'Please prepare the Q4 budget', reason: 'budget work is finance duty', duty: 'finance', estCostUsd: 0.1, ...o });

describe('forward_to (RF9-RF11)', () => {
  it('RF9: creates a delegated child through the create_task path, with a fixed title, link, reason and the run taint', async () => {
    const { c, tasks } = await ctx({ channelIsPublic: async () => true });
    c.run.markTainted();
    const res = await forwardTo.run(parse(), c);
    expect(res.isError).toBeFalsy();
    const child = [...tasks.rows.values()][0]!;
    expect(child.origin).toBe('delegated');
    expect(child.tainted).toBe(true);
    expect(child.deptId).toBe('finance');
    expect(child.title).toBe('Forwarded work (finance)');
    expect(child.description).toContain(`https://discord.com/channels/${GUILD}/${SRC}/1570000000000000009`);
    expect(child.description).toContain('Reason: budget work is finance duty');
    expect(child.forwardCard).toBe('full');
  });
  it('RF9: duty and estimate are required, the estimate is positive, unknown keys are refused', () => {
    expect(forwardTo.inputSchema.safeParse({ dept: 'finance', summary: 's', reason: 'r', estCostUsd: 0.1 }).success).toBe(false);
    expect(forwardTo.inputSchema.safeParse({ dept: 'finance', summary: 's', reason: 'r', duty: 'finance' }).success).toBe(false);
    expect(forwardTo.inputSchema.safeParse({ dept: 'finance', summary: 's', reason: 'r', duty: 'finance', estCostUsd: 0 }).success).toBe(false);
    expect(forwardTo.inputSchema.safeParse({ dept: 'finance', summary: 's', reason: 'r', duty: 'finance', estCostUsd: 1, extra: 1 }).success).toBe(false);
  });
  it('RF9: the duty is checked in code against the target department', async () => {
    const { c, tasks } = await ctx();
    const res = await forwardTo.run(parse({ duty: 'marketing' }), c);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/does not own duty marketing/);
    expect(tasks.rows.size).toBe(0);
  });
  it('RF9: the viewing-rights check applies to every head, using the ROOT requester', async () => {
    const { c, tasks } = await ctx({ canMemberView: async () => false });
    const root = await tasks.create({ title: 'r', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '77' }, origin: 'chat' });
    const mid = await tasks.create({ title: 'm', deptId: 'software', owner: CTO, requester: { kind: 'head', dept: 'hq' }, origin: 'delegated', parentId: root.id });
    const res = await forwardTo.run(parse(), { ...c, task: mid });
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/no access/);
    const ok = await forwardTo.run(parse(), { ...c, task: mid, canMemberView: async (u) => u === '77' });
    expect(ok.isError).toBeFalsy();
  });
  it('RF9: forward_to is a write tool under approvalFor (a tainted or non-direct run asks) and is not a bot-talk tool', () => {
    expect(forwardTo.kind).toBe('write');
    expect(BOT_TALK_TOOLS).not.toContain('forward_to');
    expect(approvalFor('write', { direct: true, tainted: () => true }, { tool: 'forward_to', target: 't', change: 'c' })).toBeTruthy();
    expect(approvalFor('write', { direct: false, tainted: () => false }, { tool: 'forward_to', target: 't', change: 'c' })).toBeTruthy();
  });
  it('RF10 / G2RF-01: at most 2 forwards per run, counted as proposals: 3 calls through the registry file 2 approval cards and refuse the third', async () => {
    const reg = new ToolRegistry({ halt: { isHalted: () => false } });
    reg.register(forwardTo);
    const requests: unknown[] = [];
    const { c, tasks } = await ctx();
    const root = await tasks.create({ title: 'r', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
    const cc = { ...c, task: root, canMemberView: async () => true, approvals: { needsApproval: () => false, request: async (r: unknown) => (requests.push(r), { id: requests.length }) as never } } as ToolContext;
    const out = [];
    for (const [d, duty] of [['finance', 'finance'], ['hr', 'people'], ['ops', 'operations']] as const) out.push(await reg.run('forward_to', parse({ dept: d, duty }), cc));
    expect(requests).toHaveLength(2);
    expect(out.map((r) => !!r.isError)).toEqual([false, false, true]);
    expect(out[2]!.content).toMatch(/at most 2/);
    expect(tasks.rows.size).toBe(1); // nothing was created: both are waiting for approval
  });
  it('RF10: no forward back into the chain (A to B to A) and none to oneself', async () => {
    const { c, tasks } = await ctx();
    const root = await tasks.create({ title: 'r', deptId: 'finance', owner: { kind: 'head', dept: 'finance' }, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
    const child = await tasks.create({ title: 'c', deptId: 'software', owner: CTO, requester: { kind: 'head', dept: 'finance' }, origin: 'delegated', parentId: root.id });
    const back = await forwardTo.run(parse({ dept: 'finance' }), { ...c, task: child, canMemberView: async () => true });
    expect(back.isError).toBe(true);
    expect(back.content).toMatch(/already part of this chain/);
    expect((await forwardTo.run(parse({ dept: 'software', duty: 'engineering' }), c)).isError).toBe(true);
  });
  it('RF10: the per-root cap of 4 is taken in one step and then refuses', async () => {
    const { c, tasks } = await ctx();
    const root = await tasks.create({ title: 'r', deptId: 'software', owner: CTO, requester: { kind: 'human', userId: '1' }, origin: 'chat' });
    const depts = [['finance', 'finance'], ['hr', 'people'], ['ops', 'operations'], ['marketing', 'marketing'], ['sales', 'sales']] as const;
    const results = [];
    for (const [d, duty] of depts) results.push(await forwardTo.run(parse({ dept: d, duty }), { ...c, task: root, canMemberView: async () => true, run: { ...c.run, forwards: 0 } }));
    expect(results.map((r) => !!r.isError)).toEqual([false, false, false, false, true]);
    expect(results[4]!.content).toMatch(/maximum number of times/);
  });
  it('RF11: the card text is cleaned (secrets, mentions, zero-width and full-width variants) and the title is fixed', async () => {
    const { c, tasks } = await ctx({ channelIsPublic: async () => true });
    await forwardTo.run(parse({ summary: 'hi @​everyone ＠everyone <@123456789012345678> key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', reason: 'r' }), c);
    const d = [...tasks.rows.values()][0]!.description;
    expect(d).not.toMatch(/@everyone/i);
    expect(d).not.toContain('<@1');
    expect(d).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789');
  });
  it('RF11: a target room wider than the source gets the link and a fixed line, not the summary; the owner still holds the full text', async () => {
    const { c, tasks } = await ctx({ channelIsPublic: async () => false });
    await forwardTo.run(parse({ summary: 'salary of Ann is 99999' }), c);
    const t = [...tasks.rows.values()][0]!;
    expect(t.forwardCard).toBe('link');
    expect(t.description).toContain('salary of Ann is 99999');
    const shown = cardBody(t);
    expect(shown).not.toContain('99999');
    expect(shown).toContain(FORWARD_WITHHELD);
    expect(shown).toContain(`discord.com/channels/${GUILD}/${SRC}`);
  });
  it('RF11: no way to read who can see the source = withhold; a direct untainted run shows it', async () => {
    const a = await ctx();
    await forwardTo.run(parse(), a.c);
    expect([...a.tasks.rows.values()][0]!.forwardCard).toBe('link');
    const b = await ctx({ direct: true });
    await forwardTo.run(parse(), b.c);
    expect([...b.tasks.rows.values()][0]!.forwardCard).toBe('full');
    const t = await ctx({ direct: true });
    t.c.run.markTainted();
    await forwardTo.run(parse(), t.c);
    expect([...t.tasks.rows.values()][0]!.forwardCard).toBe('link');
  });
  it('G2RF-02: a private thread under a public parent (or the target channel) withholds the summary, even for a direct untainted run', async () => {
    const asked: string[] = [];
    const src = { channelId: SRC, threadId: '1570000000000000555', messageId: null, userId: null, attachments: [] };
    const privateThread = async (id: string) => (asked.push(id), id !== '1570000000000000555');
    const a = await ctx({ source: src, direct: true, channelIsPublic: privateThread });
    await forwardTo.run(parse(), a.c);
    expect([...a.tasks.rows.values()][0]!.forwardCard).toBe('link');
    expect(asked).toEqual(['1570000000000000555']);
    const b = await ctx({ source: src, channelIsPublic: async () => true });
    await forwardTo.run(parse(), b.c);
    expect([...b.tasks.rows.values()][0]!.forwardCard).toBe('full');
    const none = await ctx({ source: src });
    await forwardTo.run(parse(), none.c);
    expect([...none.tasks.rows.values()][0]!.forwardCard).toBe('link');
  });
  it('RF35: the registry refuses forward_to for an actor whose department does not hold it, at call time', async () => {
    const reg = new ToolRegistry({ halt: { isHalted: () => false } });
    reg.register(forwardTo);
    const { c } = await ctx();
    const noTool = { ...c, org: { ...c.org, toolsFor: () => ['respond'] } } as unknown as ToolContext;
    const res = await reg.run('forward_to', parse(), noTool);
    expect(res).toMatchObject({ isError: true });
    expect(res.content).toMatch(/not allowed/);
  });
});

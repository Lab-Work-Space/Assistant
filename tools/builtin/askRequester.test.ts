import { describe, expect, it } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import { CTO, MemNotes, MemTasks, auditSpy, newBus, runCtxBase, seededOrg } from '../../agents/test-helpers.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import type { AskPort, ToolContext } from '../types.js';
import { ANSWER_MAX_CHARS, ANSWER_REFUSALS, answerSubtask } from './answerSubtask.js';
import { ASK_MAX_CHARS, ASK_REFUSALS, askRequester, askRequesterInput } from './askRequester.js';

class FakePort implements AskPort {
  asks: { question: string; tainted: boolean; taskId: string }[] = [];
  answers: { answer: string; questionId: number; tainted: boolean }[] = [];
  askResult: Awaited<ReturnType<AskPort['ask']>> = { ok: true, seq: 1, hours: 4 };
  answerResult: Awaited<ReturnType<AskPort['answer']>> = { ok: true };
  async ask(r: Parameters<AskPort['ask']>[0]) { this.asks.push({ question: r.question, tainted: r.tainted, taskId: r.taskId }); return this.askResult; }
  async answer(r: Parameters<AskPort['answer']>[0]) { this.answers.push({ answer: r.answer, questionId: r.questionId, tainted: r.tainted }); return this.answerResult; }
}

async function setup(o: { owner?: ActorRef; actor?: ActorRef; status?: 'doing' | 'todo' | 'done'; port?: FakePort | null; tainted?: boolean; wake?: boolean; noAsk?: boolean; meeting?: boolean } = {}) {
  const tasks = new MemTasks();
  const base = runCtxBase();
  if (o.tainted) base.run.markTainted();
  const port = o.port === null ? undefined : (o.port ?? new FakePort());
  const t = await tasks.create({ title: 'x', deptId: 'software', owner: o.owner ?? CTO, requester: { kind: 'head', dept: 'hq' }, origin: 'delegated', status: o.status ?? 'doing' });
  const task = (await tasks.get(t.id))!;
  const c: ToolContext = {
    actor: o.actor ?? CTO, task, ...base, org: await seededOrg(), tasks,
    approvals: { needsApproval: () => false, request: async () => ({}) as never },
    limits: new Limits(new FakeConfig(), tasks), bus: newBus(), notes: new MemNotes(), audit: auditSpy().audit,
    ...(port ? { ask: port } : {}), ...(o.wake ? { askWake: { questionId: 5 } } : {}), ...(o.noAsk ? { noAsk: true as const } : {}), ...(o.meeting ? { inMeeting: true as const } : {}),
  };
  return { c, task, port };
}

describe('ask_requester', () => {
  it('sends the question through the port with the run taint and ends via run.asked', async () => {
    const { c, task, port } = await setup({ tainted: true });
    const r = await askRequester.run(askRequesterInput.parse({ question: '  which env?  ' }), c); // the registry parses (trims) first
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('question 1/2 sent');
    expect(port!.asks).toEqual([{ taskId: task.id, question: 'which env?', tainted: true }]);
    expect(c.run.asked).toBe(true);
  });

  it('redacts, neutralises mentions and defangs handles BEFORE the length check and the port sees only that text', async () => {
    const { c, port } = await setup();
    await askRequester.run({ question: 'ask <@123456789012345678> and @everyone and @CFO about sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' }, c);
    const q = port!.asks[0]!.question;
    expect(q).not.toMatch(/<@\d/);
    expect(q).not.toMatch(/@everyone/i);
    expect(q).not.toMatch(/@CFO/);
    expect(q).not.toContain('sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789');
  });

  it('refuses over 500 characters measured after defanging, with a fixed text that does not echo the model', async () => {
    const { c, port } = await setup();
    const r = await askRequester.run({ question: 'x'.repeat(ASK_MAX_CHARS + 1) }, c);
    expect(r).toMatchObject({ isError: true, content: ASK_REFUSALS.length });
    expect(port!.asks).toHaveLength(0);
    expect(c.run.askCalls).toBe(0);
    expect((await askRequester.run({ question: 'x'.repeat(ASK_MAX_CHARS) }, c)).isError).toBeFalsy();
  });

  it.each([
    ['no port', { port: null }, ASK_REFUSALS.unavailable],
    ['a wake run', { wake: true }, ASK_REFUSALS.wake],
    ['a noAsk run', { noAsk: true }, ASK_REFUSALS.wake],
    ['a meeting', { meeting: true }, ASK_REFUSALS.meeting],
    ['a task that is not in progress', { status: 'todo' as const }, ASK_REFUSALS.noTask],
    ['a task the actor does not own', { actor: { kind: 'head', dept: 'it' } as ActorRef }, ASK_REFUSALS.noTask],
  ])('refuses in %s', async (_n, o, text) => {
    const { c, port } = await setup(o as never);
    const r = await askRequester.run({ question: 'secret marker question' }, c);
    expect(r).toMatchObject({ isError: true, content: text });
    expect(r.content).not.toContain('secret marker');
    expect(port?.asks ?? []).toHaveLength(0);
  });

  it('once per run; every port refusal maps to its fixed text and leaves run.asked false', async () => {
    const { c, port } = await setup();
    for (const reason of ['unavailable', 'noTask', 'noRequester', 'open', 'cap', 'limit', 'post'] as const) {
      port!.askResult = { ok: false, reason };
      c.run.askCalls = 0;
      expect(await askRequester.run({ question: 'q' }, c)).toMatchObject({ isError: true, content: ASK_REFUSALS[reason] });
      expect(c.run.asked).toBe(false);
    }
    port!.askResult = { ok: true, seq: 2, hours: 4 };
    c.run.askCalls = 0;
    await askRequester.run({ question: 'q' }, c);
    expect(await askRequester.run({ question: 'again' }, c)).toMatchObject({ isError: true, content: ASK_REFUSALS.perRun });
  });

  it('is not approval-gated, has no kind, and takes no task or question id as input', () => {
    expect(askRequester.requiresApproval({ question: 'q' }, {} as never)).toBe(false);
    expect(answerSubtask.requiresApproval({ answer: 'a' }, {} as never)).toBe(false);
    expect(askRequester.kind).toBeUndefined();
    expect(Object.keys((askRequester.inputSchema as unknown as { shape: object }).shape)).toEqual(['question']);
    expect(Object.keys((answerSubtask.inputSchema as unknown as { shape: object }).shape)).toEqual(['answer']);
  });
});

describe('answer_subtask', () => {
  it('only in a wake run; the question id comes from ctx, never from input', async () => {
    const { c, port } = await setup({ wake: true, tainted: true });
    const r = await answerSubtask.run({ answer: 'staging' }, c);
    expect(r.isError).toBeFalsy();
    expect(port!.answers).toEqual([{ answer: 'staging', questionId: 5, tainted: true }]);
    const off = await setup();
    expect(await answerSubtask.run({ answer: 'x' }, off.c)).toMatchObject({ isError: true, content: ANSWER_REFUSALS.notWake });
    expect(off.port!.answers).toHaveLength(0);
  });

  it('once per run, length after defang, and every port refusal is a fixed text', async () => {
    const { c, port } = await setup({ wake: true });
    expect(await answerSubtask.run({ answer: 'y'.repeat(ANSWER_MAX_CHARS + 1) }, c)).toMatchObject({ isError: true, content: ANSWER_REFUSALS.length });
    for (const reason of ['notWake', 'closed', 'post'] as const) {
      port!.answerResult = { ok: false, reason };
      c.run.answerCalls = 0;
      expect(await answerSubtask.run({ answer: 'a' }, c)).toMatchObject({ isError: true, content: ANSWER_REFUSALS[reason] });
    }
    port!.answerResult = { ok: true };
    c.run.answerCalls = 0;
    await answerSubtask.run({ answer: 'a' }, c);
    expect(await answerSubtask.run({ answer: 'b' }, c)).toMatchObject({ isError: true, content: ANSWER_REFUSALS.perRun });
  });

  it('handles and raw mentions in the answer are defanged before the port', async () => {
    const { c, port } = await setup({ wake: true });
    await answerSubtask.run({ answer: 'tell @CTO <@123456789012345678> @here' }, c);
    const a = port!.answers[0]!.answer;
    expect(a).not.toMatch(/@CTO|<@\d|@here/);
  });
});

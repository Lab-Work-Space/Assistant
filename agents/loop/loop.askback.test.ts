import { describe, expect, it } from 'vitest';
import type { AskPort } from '../../tools/types.js';
import type { FakeProvider } from '../../providers/index.js';
import { runAgent } from './loop.js';
import { ASK_REFUSALS } from '../../tools/builtin/askRequester.js';
import { owned, respond, route, setup, useScript } from './loop-fixture.js';
import { CTO, humanMsg } from '../test-helpers.js';

/** A class whose methods use `this` (REROUTE lesson: no unbound reads). */
class FakeAsk implements AskPort {
  readonly asks: { taskId: string; question: string; tainted: boolean }[] = [];
  readonly answers: { questionId: number; answer: string }[] = [];
  async ask(req: { actor: unknown; taskId: string; question: string; tainted: boolean }): ReturnType<AskPort['ask']> {
    this.asks.push({ taskId: req.taskId, question: req.question, tainted: req.tainted });
    return { ok: true as const, seq: this.asks.length, hours: 4 };
  }
  async answer(req: { actor: unknown; questionId: number; answer: string; tainted: boolean }) {
    this.answers.push({ questionId: req.questionId, answer: req.answer });
    return { ok: true as const };
  }
}
const ask = (q = 'which env?') => ({ name: 'ask_requester', input: { question: q } });
const lastResults = (p: FakeProvider) => p.calls.at(-1)!.messages.at(-1)!.content as { type: string; content?: string; isError?: boolean }[];

async function ownerSetup(script: Parameters<typeof setup>[0] = {}) {
  const s = await setup(script);
  const fake = new FakeAsk();
  s.deps.ask = fake;
  const task = await owned(s.tasks, CTO, { status: 'doing' });
  return { s, fake, task };
}

describe('ASKBACK-1 AB4: an asking run posts nothing', () => {
  it('[respond, ask_requester] in one batch: the run ends asked, the respond text is dropped, one provider call', async () => {
    const { s, fake, task } = await ownerSetup();
    const p = useScript(s, [{ toolUses: [respond('I will guess'), ask()] }, { toolUses: [respond('never')] }]);
    const out = await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(out.asked).toBe(true);
    expect(out.payload).toMatchObject({ type: 'chat', body: 'NO_REPLY' });
    expect(p.calls).toHaveLength(1);
    expect(fake.asks).toEqual([{ taskId: task.id, question: 'which env?', tainted: expect.any(Boolean) }]);
  });

  it('[ask_requester, create_task]: the later call is refused without running and no task is created', async () => {
    const { s, task } = await ownerSetup();
    const before = s.tasks.rows.size;
    let toolResults: unknown[] = [];
    const orig = s.deps.tools.run.bind(s.deps.tools);
    s.deps.tools.run = async (n, i, c) => {
      const r = await orig(n, i, c);
      toolResults.push(n);
      return r;
    };
    useScript(s, [{ toolUses: [ask(), { name: 'create_task', input: { title: 'x', description: 'x', assignee: { kind: 'head', dept: 'it' }, estCostUsd: 0 } }] }]);
    const out = await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(out.asked).toBe(true);
    expect(toolResults).toEqual(['ask_requester']); // create_task never reached the registry
    expect(s.tasks.rows.size).toBe(before);
  });

  it('a refused ask (port says no) does not end the run: the model continues and answers', async () => {
    const { s, fake, task } = await ownerSetup();
    fake.ask = async () => ({ ok: false as const, reason: 'noRequester' as const });
    const p = useScript(s, [{ toolUses: [ask()] }, { toolUses: [respond('guess')] }]);
    const out = await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(out.asked).toBeUndefined();
    expect(lastResults(p)).toBeDefined();
    expect(out.payload).toMatchObject({ body: 'guess' });
    expect(p.calls[1]!.messages.at(-1)!.content[0]).toMatchObject({ isError: true, content: ASK_REFUSALS.noRequester });
  });

  it('ask_requester is once per run', async () => {
    const { s, fake, task } = await ownerSetup();
    fake.ask = async () => ({ ok: false as const, reason: 'open' as const });
    const p = useScript(s, [{ toolUses: [ask()] }, { toolUses: [ask('again')] }, { toolUses: [respond('x')] }]);
    await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(p.calls[2]!.messages.at(-1)!.content[0]).toMatchObject({ isError: true, content: ASK_REFUSALS.perRun });
  });
});

describe('ASKBACK-1 offers and dispatch (AB5, AB10)', () => {
  const offered = (p: FakeProvider) => p.calls[0]!.tools.map((t) => t.name);

  it('offered to the owner of a task when enabled; never answer_subtask', async () => {
    const { s, task } = await ownerSetup();
    const p = useScript(s, [{ text: 'ok' }]);
    await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(offered(p)).toContain('ask_requester');
    expect(offered(p)).not.toContain('answer_subtask');
  });

  it('not offered without a task, to a non-owner, to a noAsk run, in a meeting, or when ask.enabled is off', async () => {
    const { s, task } = await ownerSetup();
    for (const [trigger, why] of [
      [{ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, 'no task'],
      [{ route: route({ kind: 'head', dept: 'it' }), msg: humanMsg('hi'), task, history: [] }, 'not owner'],
      [{ route: route(CTO), task, history: [], noAsk: true as const }, 'noAsk'],
      [{ route: route(CTO), task, history: [], inMeeting: true as const }, 'meeting'],
    ] as const) {
      const p = useScript(s, [{ text: 'ok' }]);
      await runAgent(trigger as never, s.deps);
      expect(offered(p), why).not.toContain('ask_requester');
    }
    await s.cfg.set('ask.enabled', false, 'test');
    const p = useScript(s, [{ toolUses: [ask()] }, { toolUses: [respond('x')] }]);
    await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(offered(p)).not.toContain('ask_requester');
    // not offered AND not dispatched: a call anyway is denied by the registry (same list)
    expect(p.calls[1]!.messages.at(-1)!.content[0]).toMatchObject({ isError: true, content: expect.stringMatching(/not allowed/) });
  });

  it('a port-less process offers neither tool', async () => {
    const s = await setup();
    const task = await owned(s.tasks, CTO, { status: 'doing' });
    const p = useScript(s, [{ text: 'ok' }]);
    await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(offered(p)).not.toContain('ask_requester');
  });

  it('a wake run is offered answer_subtask only (builtin tools carry no read kind) and the registry enforces the same list', async () => {
    const { s, fake, task } = await ownerSetup();
    const before = s.tasks.rows.size;
    const p = useScript(s, [
      { toolUses: [{ name: 'create_task', input: { title: 'x', description: 'x', assignee: { kind: 'head', dept: 'it' }, estCostUsd: 0 } }, { name: 'forward_to', input: {} }, { name: 'meeting_start', input: {} }, ask(), respond('x')] },
      { toolUses: [{ name: 'answer_subtask', input: { answer: 'staging' } }] },
    ]);
    const out = await runAgent({ route: { actor: CTO, reason: 'task_owner', taskId: task.id }, task, history: [], noAsk: true, askWake: { questionId: 7 } }, s.deps);
    expect(offered(p)).toEqual(['answer_subtask']);
    const r1 = p.calls[1]!.messages.at(-1)!.content as { content: string; isError?: boolean }[];
    expect(r1.slice(0, 5).every((x) => x.isError && /not allowed/.test(x.content))).toBe(true);
    expect(s.tasks.rows.size).toBe(before);
    expect(fake.asks).toHaveLength(0);
    expect(fake.answers).toEqual([{ questionId: 7, answer: 'staging' }]);
    expect(out.asked).toBeUndefined();
  });

  it('answer_subtask outside a wake run is refused by the tool itself (notWake) even if called', async () => {
    const { s, fake, task } = await ownerSetup();
    // heads list answer_subtask in their prompt, but dispatch removes it from every non-wake run
    const p = useScript(s, [{ toolUses: [{ name: 'answer_subtask', input: { answer: 'x' } }] }, { toolUses: [respond('x')] }]);
    await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(p.calls[1]!.messages.at(-1)!.content[0]).toMatchObject({ isError: true });
    expect(fake.answers).toHaveLength(0);
  });
});

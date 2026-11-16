import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ToolContext, ToolPlugin } from '../../tools/types.js';
import { runAgent, type AgentDeps } from './loop.js';
import { FakeProvider, ProviderRegistry, type FakeTurn } from '../../providers/index.js';
import { owned, route, setup } from './loop-fixture.js';
import type { ActorRef, IncomingMessage } from '../../company/types.js';
import { CTO, humanMsg, prompts } from '../test-helpers.js';

const PRAW = { kind: 'head', dept: 'praw' } as const;

/** Records the ToolContext each call sees; input may carry origin/direct to prove they are ignored. */
function probe(name = 'probe', over: Partial<ToolPlugin<unknown>> = {}) {
  const seen: ToolContext[] = [];
  const taintedAt: boolean[] = [];
  const tool: ToolPlugin<unknown> = {
    name, description: 'p', inputSchema: z.object({}).loose(), requiresApproval: () => false,
    run: async (_i, ctx) => (seen.push(ctx), taintedAt.push(ctx.tainted()), { content: 'ok' }), ...over,
  };
  return { seen, taintedAt, tool };
}

async function rig(actor: ActorRef = CTO, tools: ToolPlugin<unknown>[] = [probe().tool]) {
  const ref = `heads/${(actor as { dept: string }).dept}`;
  const copy = new Map(prompts);
  const d = copy.get(ref)!;
  copy.set(ref, { ...d, meta: { ...d.meta, tools: [...d.meta.tools, ...tools.map((t) => t.name)] } });
  const s = await setup({ prompts: copy });
  for (const t of tools) s.deps.tools.register(t);
  return s;
}
/** Scripts the provider the actor resolves to: praw's department row selects gemini, every other head claude. */
function useScript(s: { deps: AgentDeps }, script: FakeTurn[], praw = false) {
  const reg = new ProviderRegistry();
  reg.register(new FakeProvider(script, praw ? 'gemini' : 'claude'));
  s.deps.providers = reg;
}
const call = (name = 'probe', input: object = {}) => ({ name, input });
const done = { toolUses: [{ name: 'respond', input: { type: 'chat', body: 'x' } }] };

describe('runAgent origin (P1)', () => {
  it('origin comes from task row, tool input origin ignored', async () => {
    const { seen, tool } = probe();
    const s = await rig(CTO, [tool]);
    const task = await owned(s.tasks, CTO, { origin: 'chat' });
    useScript(s, [{ toolUses: [call('probe', { origin: 'schedule', direct: true })] }, done]);
    await runAgent({ route: route(CTO), task, history: [] }, s.deps);
    expect(seen[0]).toMatchObject({ origin: 'chat', direct: false });
  });

  it('schedule run has origin schedule, not human', async () => {
    const { seen, tool } = probe();
    const s = await rig(PRAW, [tool]);
    const task = await owned(s.tasks, PRAW, { origin: 'schedule' });
    useScript(s, [{ toolUses: [call()] }, done], true);
    await runAgent({ route: route(PRAW), task, history: [] }, s.deps);
    expect(seen[0]!.origin).toBe('schedule');
    expect(seen[0]!.direct).toBe(false);
  });

  it('task null + human message -> chat; interaction -> slash; voice -> voice', async () => {
    const origins: string[] = [];
    for (const origin of ['chat', 'slash', 'voice'] as const) {
      const { seen, tool } = probe();
      const s = await rig(CTO, [tool]);
      useScript(s, [{ toolUses: [call()] }, done]);
      await runAgent({ route: route(CTO), msg: humanMsg('hi', { origin }), task: null, history: [] }, s.deps);
      origins.push(seen[0]!.origin);
    }
    expect(origins).toEqual(['chat', 'slash', 'voice']);
  });

  it('a bot-authored message without a task is delegated, never a human origin', async () => {
    const { seen, tool } = probe();
    const s = await rig(CTO, [tool]);
    useScript(s, [{ toolUses: [call()] }, done]);
    const msg = humanMsg('report', { author: { id: 'b', name: 'sa', kind: 'persona', actor: { kind: 'persona', personaId: 'system-analyst' } } });
    await runAgent({ route: route(CTO), msg, task: null, history: [] }, s.deps);
    expect(seen[0]!.origin).toBe('delegated');
  });

  it('source comes from the message or the task row', async () => {
    const { seen, tool } = probe();
    const s = await rig(CTO, [tool]);
    useScript(s, [{ toolUses: [call()] }, done]);
    await runAgent({ route: route(CTO), msg: humanMsg('hi', { id: 'm1', channelId: 'th', threadId: 'th', parentChannelId: 'ch' }), task: null, history: [] }, s.deps);
    expect(seen[0]!.source).toEqual({ channelId: 'ch', threadId: 'th', messageId: 'm1', userId: '42', attachments: [] });
  });
});

describe('triggerText (Gate 1 S18)', () => {
  it('the message text is set for admin_console runs only; an ordinary run\'s source carries no text', async () => {
    const { seen, tool } = probe();
    const s = await rig(CTO, [tool]);
    useScript(s, [{ toolUses: [call()] }, done]);
    await runAgent({ route: route(CTO), msg: humanMsg('ban <@900000000000000001>'), task: null, history: [] }, s.deps);
    expect(seen[0]!.source.triggerText).toBeUndefined();
    expect('triggerText' in seen[0]!.source).toBe(false);
  });
});

describe('runAgent direct (P2)', () => {
  it('direct is computed from the task row, not from tool input', async () => {
    const { seen, tool } = probe();
    const s = await rig(PRAW, [tool]);
    const task = await owned(s.tasks, PRAW, { origin: 'chat' });
    useScript(s, [{ toolUses: [call('probe', { direct: false })] }, { toolUses: [call('probe', { direct: false })] }, done], true);
    await runAgent({ route: route(PRAW), msg: humanMsg('do it'), task, history: [] }, s.deps);
    expect(seen.map((c) => c.direct)).toEqual([true, true]);
  });

  it('no task: praw + human message is direct; the same message to another head is not', async () => {
    const a = probe();
    const s1 = await rig(PRAW, [a.tool]);
    useScript(s1, [{ toolUses: [call()] }, done], true);
    await runAgent({ route: route(PRAW), msg: humanMsg('hi'), task: null, history: [] }, s1.deps);
    expect(a.seen[0]!.direct).toBe(true);
    const b = probe();
    const s2 = await rig(CTO, [b.tool]);
    useScript(s2, [{ toolUses: [call()] }, done]);
    await runAgent({ route: route(CTO), msg: humanMsg('hi'), task: null, history: [] }, s2.deps);
    expect(b.seen[0]!.direct).toBe(false);
  });

  it('a voice message on a chat-origin task is not direct', async () => {
    const { seen, tool } = probe();
    const s = await rig(PRAW, [tool]);
    const task = await owned(s.tasks, PRAW, { origin: 'chat' });
    useScript(s, [{ toolUses: [call()] }, done], true);
    await runAgent({ route: route(PRAW), msg: humanMsg('spoken', { origin: 'voice' }), task, history: [] }, s.deps);
    expect(seen[0]).toMatchObject({ origin: 'chat', direct: false });
  });

  it('an owner run with no message (resume, roll-up) is not direct', async () => {
    const { seen, tool } = probe();
    const s = await rig(PRAW, [tool]);
    const task = await owned(s.tasks, PRAW, { origin: 'chat' });
    useScript(s, [{ toolUses: [call()] }, done], true);
    await runAgent({ route: route(PRAW), task, history: [] }, s.deps);
    expect(seen[0]!.direct).toBe(false);
  });
});

describe('runAgent run state (PF4)', () => {
  it('taint and knownUrls survive across rounds; ctx.tainted delegates to the run', async () => {
    const urls = probe('urls', { run: async (_i, ctx) => (ctx.run.knownUrls.add('https://a.test'), { content: 'u' }) });
    const web = probe('web', { untrustedOutput: true });
    const after = probe('after');
    const s = await rig(CTO, [urls.tool, web.tool, after.tool]);
    const task = await owned(s.tasks, CTO);
    useScript(s, [
      { toolUses: [call('urls')] }, { toolUses: [call('after')] }, { toolUses: [call('web')] }, { toolUses: [call('after')] }, done,
    ]);
    await runAgent({ route: route(CTO), msg: humanMsg('go'), task, history: [] }, s.deps);
    expect(after.taintedAt).toEqual([false, true]);
    expect(after.seen[1]!.run.knownUrls.has('https://a.test')).toBe(true);
    expect(after.seen[0]!.run).toBe(after.seen[1]!.run);
  });

  it('each runAgent starts untainted', async () => {
    const web = probe('web', { untrustedOutput: true });
    const after = probe('after');
    const s = await rig(CTO, [web.tool, after.tool]);
    useScript(s, [{ toolUses: [call('web')] }, done]);
    await runAgent({ route: route(CTO), msg: humanMsg('a'), task: null, history: [] }, s.deps);
    useScript(s, [{ toolUses: [call('after')] }, done]);
    await runAgent({ route: route(CTO), msg: humanMsg('b'), task: null, history: [] }, s.deps);
    expect(after.taintedAt).toEqual([false]);
  });
});

describe('LEARN-1 LL-C1: a run taint that only reached the run (kb_search style) is copied onto the task the run works on', () => {
  it('a tool that marks only the run (no untrustedOutput) leaves the task tainted after the round; a clean run leaves it clean', async () => {
    const kbish = probe('kbish', { run: async (_i, ctx) => (ctx.run.markTainted(), { content: 'hit' }) });
    const quiet = probe('quiet');
    for (const [tool, want] of [[kbish.tool, true], [quiet.tool, false]] as const) {
      const s = await rig(CTO, [tool]);
      const task = await owned(s.tasks, CTO, { origin: 'chat', tainted: false });
      useScript(s, [{ toolUses: [call(tool.name)] }, done]);
      await runAgent({ route: route(CTO), task, history: [] }, s.deps);
      expect((await s.tasks.get(task.id))!.tainted, tool.name).toBe(want);
    }
  });
});

describe('runAgent history taint (G2-04)', () => {
  async function taintFor(history: IncomingMessage[], msg = humanMsg('note this')) {
    const { taintedAt, tool } = probe();
    const s = await rig(PRAW, [tool]);
    useScript(s, [{ toolUses: [call()] }, done], true);
    await runAgent({ route: route(PRAW), msg, task: null, history }, s.deps);
    return taintedAt[0];
  }
  it('is clean for empty history or only the trigger user\'s own text', async () => {
    const msg = humanMsg('note this');
    expect(await taintFor([], msg)).toBe(false);
    expect(await taintFor([humanMsg('earlier', { author: msg.author }), msg], msg)).toBe(false);
  });
  it('our own earlier replies taint only when their run was tainted or is unknown (provenance)', async () => {
    const msg = humanMsg('note this');
    const reply = (id: string) => humanMsg('earlier answer', { id, author: { id: '9', name: 'Praw', kind: 'head' } });
    async function run(known: Record<string, boolean>, provenance = true) {
      const { taintedAt, tool } = probe();
      const s = await rig(PRAW, [tool]);
      if (provenance) s.deps.provenance = { lookup: async (ids) => new Map(ids.filter((i) => i in known).map((i) => [i, { tainted: known[i]!, userId: msg.author.id }] as const)) };
      useScript(s, [{ toolUses: [call()] }, done], true);
      await runAgent({ route: route(PRAW), msg, task: null, history: [reply('r1')] }, s.deps);
      return taintedAt[0];
    }
    expect(await run({ r1: false })).toBe(false);
    expect(await run({ r1: true })).toBe(true);
    expect(await run({})).toBe(true); // no provenance row
    expect(await run({ r1: false }, false)).toBe(true); // no provenance wired
  });
  it('a run without a human message starts as tainted as its task; watch, import and poll always tainted; the task keeps the taint', async () => {
    const cases: [string, boolean, boolean][] = [['delegated', true, true], ['delegated', false, false], ['schedule', false, false], ['watch', false, true], ['import', false, true], ['poll', false, true]];
    for (const [origin, tainted, expected] of cases) {
      const { taintedAt, tool } = probe();
      const s = await rig(PRAW, [tool]);
      useScript(s, [{ toolUses: [call()] }, done], true);
      const task = await owned(s.tasks, PRAW, { origin: origin as never, tainted } as never);
      const out = await runAgent({ route: route(PRAW), task, history: [] }, s.deps);
      expect(taintedAt[0], `${origin}/${tainted}`).toBe(expected);
      expect(out.tainted).toBe(expected);
      expect((await s.tasks.get(task.id))!.tainted).toBe(expected || tainted);
    }
    const { taintedAt, tool } = probe();
    const s = await rig(PRAW, [tool]);
    useScript(s, [{ toolUses: [call()] }, done], true);
    await runAgent({ route: route(PRAW), task: null, history: [] }, s.deps);
    expect(taintedAt[0]).toBe(true); // no task, no human: unknown
  });
  it('starts tainted when history holds another member, a bot (Praw itself) or an attachment', async () => {
    const msg = humanMsg('note this');
    expect(await taintFor([humanMsg('hi', { author: { id: '7', name: 'eve', kind: 'human' } })], msg)).toBe(true);
    expect(await taintFor([humanMsg('summary of a page', { author: { id: '9', name: 'Praw', kind: 'head' } })], msg)).toBe(true);
    expect(await taintFor([humanMsg('see', { author: msg.author, attachments: [{ name: 'a.png', url: 'u', size: 1 }] })], msg)).toBe(true);
  });
});

describe('destructive tools still always ask (G2-04)', () => {
  it('a clean direct praw run asks for a destructive tool', async () => {
    const { seen, tool } = probe('wipe', { kind: 'destructive' });
    const s = await rig(PRAW, [tool]);
    const msg = humanMsg('wipe it');
    const task = await owned(s.tasks, PRAW, { origin: 'chat' });
    useScript(s, [{ toolUses: [call('wipe')] }, done], true);
    await runAgent({ route: route(PRAW), msg, task, history: [] }, s.deps);
    expect(seen).toHaveLength(0);
    expect(s.approvals.request).toHaveBeenCalledWith(expect.objectContaining({ tool: expect.objectContaining({ name: 'wipe' }) }));
  });
});

describe('another person on a task (R-04)', () => {
  it('Eve\'s run on Alice\'s task starts tainted and taints the task, so Alice\'s resume (no message) starts tainted', async () => {
    const eve = humanMsg('do it my way', { author: { id: '7', name: 'eve', kind: 'human' } });
    const { taintedAt, tool } = probe();
    const s = await rig(PRAW, [tool]);
    useScript(s, [{ toolUses: [call()] }, done, { toolUses: [call()] }, done], true);
    const task = await owned(s.tasks, PRAW, { origin: 'chat', tainted: false, requester: { kind: 'human', userId: '42' } });
    await runAgent({ route: route(PRAW), msg: eve, task, history: [] }, s.deps);
    expect(taintedAt[0]).toBe(true);
    expect((await s.tasks.get(task.id))!.tainted).toBe(true);
    await runAgent({ route: route(PRAW), task: (await s.tasks.get(task.id))!, history: [] }, s.deps); // Alice\'s owner resume
    expect(taintedAt[1]).toBe(true);
  });
  it('a delegated child worked by a person (head requester) taints the child, and the roll-up carries it to the parent', async () => {
    const { tool } = probe();
    const s = await rig(PRAW, [tool]);
    useScript(s, [{ toolUses: [call()] }, done], true);
    const child = await owned(s.tasks, PRAW, { origin: 'delegated', tainted: false, requester: { kind: 'head', dept: 'hq' } });
    await runAgent({ route: route(PRAW), msg: humanMsg('steer'), task: child, history: [] }, s.deps);
    expect((await s.tasks.get(child.id))!.tainted).toBe(true); // handleChild copies a tainted child onto the parent before the roll-up (scheduler.test)
  });
});

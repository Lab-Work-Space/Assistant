import { describe, expect, it, vi } from 'vitest';
import { AI_WARROOM_CHANNEL_ID } from '../../company/channels.js';
import type { ActorRef } from '../../company/types.js';
import type { Task } from '../../db/repos/tasks.js';
import type { OpenReplyStreamOptions, ReplyStream, StreamFinalOpts } from '../../discord/port.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeDiscordPort } from '../../tests/fakes/discordPort.js';
import type { OutboundPayload } from '../loop/payload.js';
import type { AgentDeps, AgentOutcome, AgentTrigger } from '../loop/loop.js';
import { Scheduler } from './scheduler.js';
import { CTO, MemTasks, humanMsg, newBus, noApprovedTools, quiet, seededOrg } from '../test-helpers.js';

/** STREAM-1 at the scheduler: eligibility (S22), routing neutrality (S5), halt predicate (S10), finally-path (S11), recording (S6). */

const SOFTWARE_WORK = '1565682159375749161';
const chat = (body: string, over: Partial<AgentOutcome> = {}): AgentOutcome => ({ payload: { type: 'chat', body }, costUsd: 0, turns: 1, ...over });
const toCto = (content = 'hi', over = {}) => humanMsg(`<@111> ${content}`, { mentionedHeads: ['software'], id: String(1570000000000000000n + BigInt(Math.floor(Math.random() * 1e9))), ...over });

type Call = { name: string; args: unknown[] };
class FakeStream implements ReplyStream {
  calls: Call[] = [];
  finalizeResult: string | null | undefined = 'preview-1';
  finalizeError: Error | null = null;
  hasPreview = true;
  private rec(name: string, ...args: unknown[]) { this.calls.push({ name, args }); }
  typing() { this.rec('typing'); }
  update(raw: string) { this.rec('update', raw); }
  restart() { this.rec('restart'); }
  active() { return this.hasPreview; }
  async finalize(p: OutboundPayload, o: StreamFinalOpts) {
    this.rec('finalize', p, o);
    if (this.finalizeError) throw this.finalizeError;
    if (this.finalizeResult) {
      o.onSent?.([this.finalizeResult]);
      o.onCode?.(['pointer-1']);
    }
    return this.finalizeResult;
  }
  async finalizeStopped(line: string, o?: Pick<StreamFinalOpts, 'onCode'>) { this.rec('finalizeStopped', line); o?.onCode?.(['preview-1']); }
  async release(onCode?: (ids: string[]) => void) { this.rec('release'); onCode?.(['left-1']); }
  names() { return this.calls.map((c) => c.name); }
}
class StreamPort extends FakeDiscordPort {
  opened: { actor: ActorRef; target: unknown; o: OpenReplyStreamOptions; stream: FakeStream }[] = [];
  stream = () => new FakeStream();
  next: FakeStream | null = null;
  openReplyStream(actor: ActorRef, target: { channelId: string; threadId?: string }, o: OpenReplyStreamOptions): ReplyStream | null {
    const stream = this.next ?? this.stream();
    this.opened.push({ actor, target, o, stream });
    return stream;
  }
}

async function mk(o: { run?: (t: AgentTrigger) => Promise<AgentOutcome>; cfg?: FakeConfig; halt?: () => boolean; agentHalt?: () => boolean } = {}) {
  const cfg = o.cfg ?? new FakeConfig();
  const tasks = new MemTasks() as MemTasks & { findByThread(id: string): Promise<Task | null> };
  tasks.findByThread = async (id) => [...tasks.rows.values()].find((t) => t.threadId === id) ?? null;
  const port = new StreamPort();
  const records: unknown[][] = [];
  const incidents: unknown[] = [];
  const runs: AgentTrigger[] = [];
  const run = vi.fn(async (t: AgentTrigger) => {
    runs.push(t);
    return o.run ? o.run(t) : chat('ok');
  });
  const s = new Scheduler({
    agent: { halt: { isHalted: o.agentHalt ?? (() => false), track: () => () => undefined } } as unknown as AgentDeps,
    approvedTools: noApprovedTools, run, port, org: await seededOrg(), tasks, limits: new Limits(cfg, tasks),
    halt: { isHalted: o.halt ?? (() => false) }, cfg, bus: newBus(), log: quiet, now: () => 1_000_000,
    provenance: { record: async (...a: unknown[]) => void records.push(a) } as never,
    incidents: { report: (i: unknown) => void incidents.push(i) } as never,
  });
  s.attach();
  return { s, port, tasks, runs, run, records, incidents, cfg };
}

describe('S22 eligibility', () => {
  it('a person typing to a head: a stream is opened with the reply target and no mentionUserIds; the run gets the sink', async () => {
    const t = await mk();
    const m = toCto();
    await t.s.onMessage(m);
    await t.s.idle();
    expect(t.port.opened).toHaveLength(1);
    expect(t.port.opened[0]!.o.replyToId).toBe(m.id);
    expect(t.port.opened[0]!.o).not.toHaveProperty('mentionUserIds'); // S9: runMessage never pings
    expect(t.runs[0]!.stream).toBeDefined();
    expect(t.port.opened[0]!.target).toEqual({ channelId: SOFTWARE_WORK });
  });

  it('stream.enabled false, or a config read error, means no stream and the answer is posted exactly as before', async () => {
    const off = new FakeConfig({ 'stream.enabled': false });
    const a = await mk({ cfg: off });
    await a.s.onMessage(toCto());
    await a.s.idle();
    expect(a.port.opened).toHaveLength(0);
    expect(a.runs[0]!.stream).toBeUndefined();
    expect(a.port.posts).toEqual([expect.objectContaining({ payload: { type: 'chat', body: 'ok' } })]);
    const cfg = new FakeConfig();
    cfg.throwOn.add('stream.enabled');
    const b = await mk({ cfg });
    await b.s.onMessage(toCto());
    await b.s.idle();
    expect(b.port.opened).toHaveLength(0);
    expect(b.port.posts).toHaveLength(1);
  });

  it('a bot author, the warroom, an excluded channel and a bot-talk run get no stream', async () => {
    const t = await mk();
    await t.s.onMessage(toCto('x', { channelId: AI_WARROOM_CHANNEL_ID }));
    await t.s.idle();
    expect(t.port.opened).toHaveLength(0);
    const bot = toCto('from a bot', { author: { id: '9', name: 'bot', kind: 'head', actor: { kind: 'head', dept: 'marketing' } } });
    await t.s.onMessage(bot);
    await t.s.idle();
    expect(t.port.opened).toHaveLength(0);
  });

  it('ask(): deliver true streams, deliver false (voice and callers that answer their own user) does not', async () => {
    const t = await mk();
    const praw = (id: string) => humanMsg('question', { id, channelId: '1565682159375749161', mentionedHeads: [] });
    await t.s.ask(praw('1570000000000000101'), { deliver: false });
    expect(t.port.opened).toHaveLength(0);
  });

  it('a port without openReplyStream streams nothing and nothing breaks', async () => {
    const t = await mk();
    (t.port as unknown as { openReplyStream: unknown }).openReplyStream = undefined;
    await t.s.onMessage(toCto());
    await t.s.idle();
    expect(t.runs[0]!.stream).toBeUndefined();
    expect(t.port.posts).toHaveLength(1);
  });
});

describe('S5 routing neutrality', () => {
  const requester: ActorRef = CTO;
  const other: ActorRef = { kind: 'head', dept: 'marketing' };
  const threadTask = (tasks: MemTasks, over: Partial<Task> = {}) =>
    tasks.create({ title: 'T', deptId: 'marketing', owner: other, requester, origin: 'chat', threadId: 'th-1', ...over } as never);

  it('a thread whose task was requested by this very bot (owner someone else): no stream (the router would route the preview as input)', async () => {
    const t = await mk();
    await threadTask(t.tasks);
    await t.s.onMessage(toCto('hello', { threadId: 'th-1', parentChannelId: SOFTWARE_WORK, channelId: 'th-1' }));
    await t.s.idle();
    expect(t.port.opened).toHaveLength(0);
  });

  it('the predicate is re-evaluated right before the create: a task bound mid-run makes canCreate false, a lookup error fails closed', async () => {
    const t = await mk();
    await t.s.onMessage(toCto('hello', { threadId: 'th-2', parentChannelId: SOFTWARE_WORK, channelId: 'th-2' }));
    await t.s.idle();
    const { o } = t.port.opened[0]!;
    expect(await o.canCreate!()).toBe(true);
    await threadTask(t.tasks, { threadId: 'th-2' });
    expect(await o.canCreate!()).toBe(false);
    t.tasks.findByThread = async () => { throw new Error('db down'); };
    expect(await o.canCreate!()).toBe(false);
  });
});

describe('S10 halt predicate', () => {
  it('uses the agent loop\'s predicate (agent.halt), not the bare halt; a throw counts as halted', async () => {
    let agentHalted = false;
    const t = await mk({ agentHalt: () => agentHalted, halt: () => false });
    await t.s.onMessage(toCto());
    await t.s.idle();
    const { halted } = t.port.opened[0]!.o;
    expect(halted()).toBe(false);
    agentHalted = true;
    expect(halted()).toBe(true);
    const thrower = await mk({ agentHalt: () => { throw new Error('boom'); } });
    await thrower.s.onMessage(toCto());
    await thrower.s.idle();
    expect(thrower.port.opened[0]?.o.halted() ?? true).toBe(true);
  });

  it('a halted outcome: one finalizeStopped with the fixed line, nothing posted, recorded as a code id (answer false)', async () => {
    const t = await mk({ run: async () => chat('Halted', { stopped: 'halted', tainted: true }) });
    await t.s.onMessage(toCto());
    await t.s.idle();
    const st = t.port.opened[0]!.stream;
    expect(st.calls.filter((c) => c.name === 'finalizeStopped').map((c) => c.args[0])).toEqual(['-# Stopped: the company is halted.']);
    expect(st.names()).not.toContain('finalize');
    expect(t.port.posts).toEqual([]);
    expect(t.records.some((r) => r[0] === 'preview-1' && r[4] === false)).toBe(true);
  });
});

describe('TASKADMIN-1 (TA-C11): a cancelled run with a live preview', () => {
  it('ends the preview with the fixed cancel line (no partial model text as the final message), posts nothing, records a code id (answer false)', async () => {
    const t = await mk({ run: async () => chat('Task cancelled', { stopped: 'cancelled', tainted: true }) });
    await t.s.onMessage(toCto());
    await t.s.idle();
    const st = t.port.opened[0]!.stream;
    expect(st.calls.filter((c) => c.name === 'finalizeStopped').map((c) => c.args[0])).toEqual(['-# Stopped: this task was cancelled.']);
    expect(st.names()).not.toContain('finalize');
    expect(t.port.posts).toEqual([]);
    expect(t.records.some((r) => r[0] === 'preview-1' && r[4] === false)).toBe(true);
  });
});

describe('S6 recording and the answer id', () => {
  it('finalize: answer ids recorded with the run taint and answer=true, code ids answer=false; no second post', async () => {
    const t = await mk({ run: async () => chat('final', { tainted: false, triggerUserId: '42' }) });
    const m = toCto();
    await t.s.onMessage(m);
    await t.s.idle();
    const st = t.port.opened[0]!.stream;
    const f = st.calls.find((c) => c.name === 'finalize')!;
    expect((f.args[1] as StreamFinalOpts).replyToId).toBe(m.id);
    expect(t.port.posts).toEqual([]);
    expect(t.records).toContainEqual(['preview-1', SOFTWARE_WORK, false, '42', true]);
    expect(t.records).toContainEqual(['pointer-1', SOFTWARE_WORK, false, '42', false]);
  });

  it('no preview was created (finalize says undefined): the answer is posted exactly as today', async () => {
    const t = await mk();
    t.port.next = new FakeStream();
    t.port.next.finalizeResult = undefined;
    await t.s.onMessage(toCto());
    await t.s.idle();
    expect(t.port.posts).toEqual([expect.objectContaining({ actor: CTO, payload: { type: 'chat', body: 'ok' } })]);
  });

  it('finalize throws: the existing "post (bot reply dropped)" incident, nothing posted, the slot still released', async () => {
    const t = await mk();
    t.port.next = new FakeStream();
    t.port.next.finalizeError = new Error('discord down');
    await t.s.onMessage(toCto());
    await t.s.idle();
    expect(t.incidents).toEqual([expect.objectContaining({ stage: 'post (bot reply dropped)' })]);
    expect(t.port.opened[0]!.stream.names()).toContain('release');
  });
});

describe('S11 finally path', () => {
  it('a run that throws still releases the stream once, and records what it left behind as tainted and not an answer', async () => {
    const t = await mk({ run: async () => { throw new Error('run exploded'); } });
    await t.s.onMessage(toCto());
    await t.s.idle();
    const st = t.port.opened[0]!.stream;
    expect(st.names().filter((n) => n === 'release')).toHaveLength(1);
    expect(st.names()).not.toContain('finalize');
    expect(t.records).toContainEqual(['left-1', SOFTWARE_WORK, true, null, false]);
  });

  it('a normal ending releases once as well (idempotent no-op in the real engine)', async () => {
    const t = await mk();
    await t.s.onMessage(toCto());
    await t.s.idle();
    expect(t.port.opened[0]!.stream.names().filter((n) => n === 'release')).toHaveLength(1);
  });
});

describe('the sink the loop gets', () => {
  it('respond input fragments update the stream, a new segment restarts it, a reset voids the fragments, other tools and text never show', async () => {
    const t = await mk({
      run: async (tr) => {
        const s = tr.stream!;
        s.typing();
        s.segment(new Set(['respond', 'warroom_say']));
        s.delta({ type: 'tool_input_delta', index: 0, name: 'warroom_say', partialJson: '{"body":"NOT THIS"}' });
        s.delta({ type: 'tool_input_delta', index: 1, name: 'respond', partialJson: '{"type":"chat","body":"hel' });
        s.delta({ type: 'tool_input_delta', index: 1, name: 'respond', partialJson: 'lo"}' });
        s.delta({ type: 'tool_input_delta', index: 2, name: 'respond', partialJson: '{"body":"SECOND BLOCK"}' });
        s.delta({ type: 'stream_reset' });
        s.delta({ type: 'tool_input_delta', index: 0, name: 'respond', partialJson: '{"body":"again"}' });
        return chat('x');
      },
    });
    await t.s.onMessage(toCto());
    await t.s.idle();
    const calls = t.port.opened[0]!.stream.calls.filter((c) => ['typing', 'restart', 'update'].includes(c.name)).map((c) => (c.name === 'update' ? `update:${c.args[0]}` : c.name));
    expect(calls).toEqual(['typing', 'restart', 'update:hel', 'update:hello', 'restart', 'update:again']);
  });

  it('claude-code-local structured output: only the respond item streams, with the loop\'s tool set', async () => {
    const t = await mk({
      run: async (tr) => {
        const s = tr.stream!;
        s.segment(new Set(['respond']));
        const j = '{"tool_calls":[{"name":"respond","input":{"type":"chat","body":"hi there"}}]}';
        for (let i = 0; i < j.length; i += 5) s.delta({ type: 'tool_input_delta', index: 0, name: 'StructuredOutput', partialJson: j.slice(i, i + 5) });
        s.segment(new Set(['respond']));
        const k = '{"tool_calls":[{"input":{"body":"NOPE"},"name":"respond"}]}';
        s.delta({ type: 'tool_input_delta', index: 0, name: 'StructuredOutput', partialJson: k });
        return chat('x');
      },
    });
    await t.s.onMessage(toCto());
    await t.s.idle();
    const updates = t.port.opened[0]!.stream.calls.filter((c) => c.name === 'update').map((c) => c.args[0]);
    expect(updates.at(-1)).toBe('hi there');
    expect(updates).not.toContain('NOPE');
  });
});

describe('S15 open failure log', () => {
  it('"reply stream could not be opened" logs code/status only, never the error object', async () => {
    const errors: unknown[][] = [];
    const t = await mk();
    (t.s as unknown as { d: { log: unknown } }).d.log = { error: (...a: unknown[]) => void errors.push(a) };
    t.port.openReplyStream = () => { throw Object.assign(new Error('boom PARTIAL-ANSWER'), { code: 50013, requestBody: { content: 'PARTIAL-ANSWER' } }); };
    await t.s.onMessage(toCto());
    await t.s.idle();
    const line = errors.find((e) => e[1] === 'reply stream could not be opened');
    expect(line).toBeDefined();
    expect(line![0]).toEqual({ code: 50013 });
    expect(JSON.stringify(errors)).not.toContain('PARTIAL-ANSWER');
  });
});

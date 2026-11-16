import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installFakeClaude, type FakeClaude } from '../../tests/fakes/claudeCli.js';
import { ProviderError } from '../types.js';
import type { ChatChunk, ChatRequest } from '../types.js';
import { createClaudeCodeLocalProvider, type LocalProviderOptions } from './index.js';
import { STREAM_LINE_CAP_BYTES, STREAM_TOTAL_CAP_BYTES } from './protocol.js';

/** STREAM-1: the stream-json path of the provider (S12, S18, S19), against the fake CLI. */

let root: string;
let fake: FakeClaude;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ccl-stream-'));
  fake = installFakeClaude(root);
});
afterEach(() => {
  for (const r of fake.records()) if (r.grandchild) try { process.kill(r.grandchild, 'SIGKILL'); } catch { /* gone */ }
  rmSync(root, { recursive: true, force: true });
});

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'local/claude-sonnet-5-5', system: 'sys', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [{ name: 'respond', description: 'reply', inputSchema: { type: 'object' } }], maxTokens: 100, ...over,
});
const mk = (o: Partial<LocalProviderOptions> = {}) =>
  createClaudeCodeLocalProvider({ claudePath: fake.path, timeoutMs: 5000, concurrency: 1, audit: async () => {}, log: { error: () => {} }, ...o });
async function collect(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(cond: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const ev = (event: object) => ({ type: 'stream_event', event, session_id: 's', parent_tool_use_id: null });
const init = { type: 'system', subtype: 'init', tools: ['StructuredOutput'] };
const block = (i = 0) => ev({ type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: 'x', name: 'StructuredOutput', input: {} } });
const jd = (partial_json: string, i = 0) => ev({ type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json } });
const done = (payload: unknown) => ({ type: 'result', subtype: 'success', is_error: false, structured_output: payload, usage: { input_tokens: 3, output_tokens: 2 } });
const respondPayload = (body: string) => ({ tool_calls: [{ name: 'respond', input: { type: 'chat', body } }] });
const json = JSON.stringify(respondPayload('hello world'));
const goodEvents = () => [init, ev({ type: 'message_start' }), block(), jd(''), jd(json.slice(0, 20)), jd(json.slice(20)), ev({ type: 'content_block_stop', index: 0 }), done(respondPayload('hello world'))];

describe('claude-code-local streaming (STREAM-1)', () => {
  it('streamToolInput: reset + structured-output fragments are yielded before the final blocks; the blocks equal the buffered result', async () => {
    fake.scenario({ mode: 'stream', events: goodEvents() });
    const out = await collect(mk().chat(req({ streamToolInput: true }), new AbortController().signal));
    const types = out.map((c) => c.type);
    expect(types).toEqual(['stream_reset', 'stream_reset', 'tool_input_delta', 'tool_input_delta', 'tool_input_delta', 'tool_use', 'usage', 'stop']);
    const frags = out.filter((c) => c.type === 'tool_input_delta').map((c) => (c as { partialJson: string }).partialJson).join('');
    expect(frags).toBe(json);
    expect(out.find((c) => c.type === 'tool_use')).toMatchObject({ name: 'respond', input: { type: 'chat', body: 'hello world' } });
    expect(out.at(-1)).toEqual({ type: 'stop', reason: 'tool_use' });
  });

  it('without streamToolInput the chunk sequence has no delta or reset chunks (identical to the buffered provider)', async () => {
    fake.scenario({ mode: 'stream', events: goodEvents() });
    const out = await collect(mk().chat(req(), new AbortController().signal));
    expect(out.map((c) => c.type)).toEqual(['tool_use', 'usage', 'stop']);
  });

  it('S18: thinking, text and snapshot events with a marker never reach the chunks', async () => {
    fake.scenario({ mode: 'stream', events: [init, ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'THINKING-MARKER' } }), ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'TEXT-MARKER' } }), { type: 'assistant', message: { content: [{ type: 'text', text: 'SNAPSHOT-MARKER' }] } }, block(2), jd(json, 2), done(respondPayload('x'))] });
    const out = await collect(mk().chat(req({ streamToolInput: true }), new AbortController().signal));
    expect(JSON.stringify(out)).not.toMatch(/THINKING-MARKER|TEXT-MARKER|SNAPSHOT-MARKER/);
  });

  it('S19: a Thai character split across two data events survives (byte-level line split)', async () => {
    const body = 'สวัสดีครับ ยินดีต้อนรับ ไทย';
    const lines = [init, done(respondPayload(body))];
    const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    const bytes = Buffer.from(text, 'utf8');
    const at = bytes.indexOf(Buffer.from('ส')) + 1; // inside the 3-byte sequence
    fake.scenario({ mode: 'stream', events: lines, splitAt: at });
    const out = await collect(mk().chat(req(), new AbortController().signal));
    expect(out.find((c) => c.type === 'tool_use')).toMatchObject({ input: { body } });
  });

  it('S19: one 200 KB line and a final line with no trailing newline are processed', async () => {
    const body = 'x'.repeat(200_000);
    fake.scenario({ mode: 'stream', events: [init, done(respondPayload(body))], noTrailingNewline: true });
    const out = await collect(mk().chat(req(), new AbortController().signal));
    expect((out.find((c) => c.type === 'tool_use') as { input: { body: string } }).input.body).toHaveLength(200_000);
  });

  it('garbled and partial lines are skipped; the result still counts', async () => {
    fake.scenario({ mode: 'stream', events: [init, '{"type":"stream_event","event":{"ty', 'garbage owner@example.com', done(respondPayload('ok'))] });
    const out = await collect(mk().chat(req({ streamToolInput: true }), new AbortController().signal));
    expect(out.find((c) => c.type === 'tool_use')).toMatchObject({ input: { body: 'ok' } });
  });

  it('exit 0 without a result event is a fixed-text malformed error (no CLI text in it)', async () => {
    fake.scenario({ mode: 'stream', events: [init, 'OWNER-SECRET-TEXT'] });
    const err = await collect(mk().chat(req(), new AbortController().signal)).then(() => undefined, (e: unknown) => e as ProviderError);
    expect(err).toBeInstanceOf(ProviderError);
    expect(`${err!.message} ${String(err!.cause)}`).not.toContain('OWNER-SECRET');
    expect(err!.diag).toBe('no_result');
  });

  it('S19: a single line over the per-line cap is an overflow failure (no retry) and the child is killed', async () => {
    fake.scenario({ mode: 'stream-hang', events: ['y'.repeat(STREAM_LINE_CAP_BYTES + 10)], noTrailingNewline: true });
    const err = await collect(mk().chat(req(), new AbortController().signal)).then(() => undefined, (e: unknown) => e as ProviderError);
    expect(err).toMatchObject({ diag: 'overflow', retryable: false });
    expect(fake.starts()).toHaveLength(1);
    await until(() => !alive(fake.starts()[0]!.pid), 4000);
  });

  it('S19: total output over the cap is an overflow failure even when every line is small', async () => {
    const line = JSON.stringify(jd('z'.repeat(1000)));
    const n = Math.ceil(STREAM_TOTAL_CAP_BYTES / (line.length + 1)) + 50;
    fake.scenario({ mode: 'stream-hang', events: Array.from({ length: n }, () => line) });
    const err = await collect(mk({ timeoutMs: 20_000 }).chat(req({ streamToolInput: true }), new AbortController().signal)).then(() => undefined, (e: unknown) => e as ProviderError);
    expect(err).toMatchObject({ diag: 'overflow' });
    await until(() => !alive(fake.starts()[0]!.pid), 4000);
  }, 40_000);

  it('abort mid-stream: the call ends as aborted and the CLI process is gone', async () => {
    fake.scenario({ mode: 'stream-hang', events: [init, block(), jd('{"tool_calls":')] });
    const ac = new AbortController();
    const out: ChatChunk[] = [];
    for await (const c of mk().chat(req({ streamToolInput: true }), ac.signal)) {
      out.push(c);
      if (c.type === 'tool_input_delta') ac.abort();
    }
    expect(out.at(-1)).toEqual({ type: 'stop', reason: 'aborted' });
    await until(() => !alive(fake.starts()[0]!.pid), 4000);
  });

  it('S12: timeout then retry yields a stream_reset between the attempts and attempt 2 fragments are not mixed with attempt 1', async () => {
    fake.scenario({ sequence: [
      { mode: 'stream-hang', events: [init, ev({ type: 'message_start' }), block(), jd('{"tool_calls":[{"name":"respond","input":{"body":"OLD ATTEMPT')] },
      { mode: 'stream', events: [init, ev({ type: 'message_start' }), block(), jd(json), done(respondPayload('hello world'))] },
    ] });
    const out = await collect(mk({ timeoutMs: 700 }).chat(req({ streamToolInput: true }), new AbortController().signal));
    const seq = out.filter((c) => c.type === 'tool_input_delta' || c.type === 'stream_reset').map((c) => (c.type === 'stream_reset' ? 'R' : (c as { partialJson: string }).partialJson));
    const firstDeltaOfAttempt2 = seq.lastIndexOf(json);
    expect(seq.slice(0, seq.indexOf('R', 3) + 1).join('')).toContain('OLD ATTEMPT');
    // everything before the last fragment run is separated by a reset from attempt 1's fragments
    const lastReset = seq.lastIndexOf('R');
    expect(lastReset).toBeGreaterThan(seq.findIndex((s) => s.includes('OLD ATTEMPT')));
    expect(seq.slice(lastReset + 1)).toEqual([json]);
    expect(firstDeltaOfAttempt2).toBeGreaterThan(lastReset);
    expect(fake.starts()).toHaveLength(2);
    expect(out.find((c) => c.type === 'tool_use')).toMatchObject({ input: { body: 'hello world' } });
  }, 20_000);

  it('onAttempt gets the CALLER\'s own signal on every attempt (the budget binds a local reservation to it)', async () => {
    fake.scenario({ sequence: [{ mode: 'stream-hang', events: [init] }, { mode: 'stream', events: goodEvents() }] });
    const caller = new AbortController();
    const seen: AbortSignal[] = [];
    await collect(mk({ timeoutMs: 600, onAttempt: async (_n, sig) => { seen.push(sig); } }).chat(req(), caller.signal));
    expect(seen).toHaveLength(2);
    for (const sig of seen) expect(sig).toBe(caller.signal);
  }, 20_000);

  it('a consumer that stops early frees the slot, kills the CLI and removes the temp dir', async () => {
    fake.scenario({ mode: 'stream-hang', events: [init, block(), jd('{"tool_calls":')] });
    const p = mk();
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('assistant-local-')).length;
    for await (const c of p.chat(req({ streamToolInput: true }), new AbortController().signal)) {
      if (c.type === 'tool_input_delta') break;
    }
    await until(() => !alive(fake.starts()[0]!.pid), 4000);
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('assistant-local-')).length).toBeLessThanOrEqual(before);
    // concurrency is 1: the slot must be free again
    fake.scenario({ mode: 'stream', events: goodEvents() });
    const out = await collect(p.chat(req(), new AbortController().signal));
    expect(out.some((c) => c.type === 'tool_use')).toBe(true);
  }, 20_000);

  it('OPS-HOLD: a non-zero exit after a rejected rate_limit_event is a non-retryable quota rejection, spawned once', async () => {
    const rejected = { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1794307800, utilization: 1, unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1794307800, status: 'rejected' } } } };
    fake.scenario({ mode: 'stream', events: [init, rejected], code: 1 });
    const seen: unknown[] = [];
    let err: unknown;
    try { await collect(mk({ onQuota: (q) => seen.push(q) }).chat(req(), new AbortController().signal)); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).diag).toBe('quota_rejected');
    expect((err as ProviderError).retryable).toBe(false);
    expect(seen).toHaveLength(1);
    expect(fake.records().filter((r) => r.event === 'start')).toHaveLength(1);
  });
});

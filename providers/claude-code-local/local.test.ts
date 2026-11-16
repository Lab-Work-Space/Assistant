import { spawn, type SpawnOptions } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newBus } from '../../agents/test-helpers.js';
import { Budget } from '../../governance/budget.js';
import { Halt } from '../../governance/halt.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { installFakeClaude, type FakeClaude } from '../../tests/fakes/claudeCli.js';
import { ProviderError } from '../types.js';
import type { ChatChunk, ChatRequest } from '../types.js';
import { createClaudeCodeLocalProvider, toCliModel, type LocalProviderOptions } from './index.js';

const EMAIL = 'owner.account@example.com';
const MSG = 'MESSAGE-CANARY-2 $(touch PWNED) `id` ; rm -rf ~';
const CHILD_KEYS = ['HOME', 'LANG', 'PATH', 'TMPDIR', 'USER'];

let root: string;
let fake: FakeClaude;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ccl-test-'));
  fake = installFakeClaude(root);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const r of fake.records()) if (r.grandchild) try { process.kill(r.grandchild, 'SIGKILL'); } catch { /* gone */ }
  rmSync(root, { recursive: true, force: true });
});

const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'local/claude-sonnet-5-5',
  system: 'SYSTEM-CANARY-1 you are a head',
  messages: [{ role: 'user', content: [{ type: 'text', text: MSG }] }],
  tools: [{ name: 'respond', description: 'TOOL-CANARY-3 reply', inputSchema: { type: 'object' } }],
  maxTokens: 100,
  ...over,
});
const mk = (o: Partial<LocalProviderOptions> = {}) =>
  createClaudeCodeLocalProvider({ claudePath: fake.path, timeoutMs: 5000, concurrency: 2, audit: async () => {}, log: { error: () => {} }, ...o });

async function collect(it: AsyncIterable<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}
const run = (p = mk(), r = req(), signal = new AbortController().signal) => collect(p.chat(r, signal));
const failure = (p: Promise<unknown>) => p.then(() => { throw new Error('expected rejection'); }, (e: unknown) => e as ProviderError);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(cond: () => boolean, ms: number) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const textPayload = { mode: 'payload', payload: { text: 'hello' } };

describe('claude-code-local provider', () => {
  it('argv has no system or message text (brief: argv has no conversation text and no shell metacharacter expansion)', async () => {
    fake.scenario(textPayload);
    await run();
    const [s] = fake.starts();
    const argv = s!.argv!.join('\n');
    for (const canary of ['SYSTEM-CANARY-1', 'MESSAGE-CANARY-2', 'TOOL-CANARY-3', '$(touch', 'rm -rf']) expect(argv).not.toContain(canary);
    expect(s!.argv).toContain('--model=claude-sonnet-5-5');
    expect(s!.argv).not.toContain('--model');
    const spf = s!.argv!.find((a) => a.startsWith('--system-prompt-file='))!.slice('--system-prompt-file='.length);
    expect(dirname(spf)).toBe(s!.cwd);
    expect(s!.system).toContain('SYSTEM-CANARY-1');
    expect(s!.system).toContain('TOOL-CANARY-3');
    expect(JSON.parse(s!.stdin!)).toEqual([{ role: 'user', content: [{ type: 'text', text: MSG }] }]);
    expect(existsSync(join(s!.cwd!, 'PWNED'))).toBe(false);
  });

  it('child env keys equal the L2 allowlist with the seed containing BOT_TOKEN_*, GEMINI_API_KEY, CLICKUP_API_TOKEN, JIRA_API_TOKEN, GITHUB_APP_PRIVATE_KEY, GOOGLE_SHEETS_WEBAPP_SECRET, DATABASE_URL, CONFIG_MASTER_KEY, NODE_OPTIONS', async () => {
    const secrets: Record<string, string> = {
      ANTHROPIC_API_KEY: 'sk-ant-secret', NODE_OPTIONS: '--max-old-space-size=4096', DYLD_INSERT_LIBRARIES: '/x.dylib', DYLD_LIBRARY_PATH: '/x',
      CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CONFIG_DIR: '/x', DISCORD_TOKEN: 'tok', DISCORD_TOKEN_HQ: 'tok2',
      BOT_TOKEN_HQ: 'bt', BOT_TOKEN_PRAW: 'bt2', GEMINI_API_KEY: 'AIzaFAKEKEY0123456789', CLICKUP_API_TOKEN: 'cu', JIRA_API_TOKEN: 'jr',
      GITHUB_APP_PRIVATE_KEY: 'pem', GOOGLE_SHEETS_WEBAPP_SECRET: 'gs', DATABASE_URL: 'postgres://x', CONFIG_MASTER_KEY: 'mk',
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/home/x', USER: 'someone', LANG: 'en_US.UTF-8', TMPDIR: tmpdir(),
    };
    for (const [k, v] of Object.entries(secrets)) vi.stubEnv(k, v);
    fake.scenario(textPayload);
    const seen: { env?: NodeJS.ProcessEnv; shell?: unknown; detached?: unknown }[] = [];
    const spawnImpl = ((cmd: string, args: readonly string[], o: SpawnOptions) => {
      seen.push({ env: o.env, shell: o.shell, detached: o.detached });
      return spawn(cmd, args, o);
    }) as typeof spawn;
    await run(mk({ spawnImpl }));
    // What the provider hands to spawn: exactly the allowlist.
    expect(Object.keys(seen[0]!.env!).sort()).toEqual(CHILD_KEYS);
    expect(seen[0]).toMatchObject({ shell: false, detached: true });
    // What the child actually sees. macOS adds __CF_USER_TEXT_ENCODING at exec even under `env -i`; it is not ours.
    const env = fake.starts()[0]!.env!;
    expect(Object.keys(env).filter((k) => k !== '__CF_USER_TEXT_ENCODING').sort()).toEqual(CHILD_KEYS);
    expect(env.USER).toBe('someone');
    expect(JSON.stringify(env)).not.toMatch(/sk-ant-secret|postgres:|"tok"|"mk"|AIzaFAKE|"bt"|"bt2"|"cu"|"jr"|"pem"|"gs"/);
  });

  it('tool_calls become tool_use chunks with stop tool_use', async () => {
    fake.scenario({ mode: 'payload', payload: { tool_calls: [{ name: 'respond', input: { body: 'x' } }] }, usage: { input_tokens: 11, output_tokens: 5 } });
    const out = await run();
    expect(out).toEqual([
      { type: 'tool_use', id: expect.stringMatching(/^toolu_local_/), name: 'respond', input: { body: 'x' } },
      { type: 'usage', inputTokens: 11, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { type: 'stop', reason: 'tool_use' },
    ]);
  });

  it('unknown tool names are dropped with a text note and audited as unknown_tool', async () => {
    fake.scenario({ mode: 'payload', payload: { tool_calls: [{ name: 'create_task', input: {} }] } });
    const audit = vi.fn(async () => {});
    const out = await run(mk({ audit }));
    expect(out.map((c) => c.type)).toEqual(['text', 'usage', 'stop']);
    expect(out.at(-1)).toEqual({ type: 'stop', reason: 'end_turn' });
    expect(JSON.stringify(out)).not.toContain('create_task');
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ provider: 'claude-code-local', model: 'local/claude-sonnet-5-5', outcome: 'unknown_tool' }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain('create_task');
  });

  it('text response becomes end_turn', async () => {
    fake.scenario(textPayload);
    expect(await run()).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'usage', inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { type: 'stop', reason: 'end_turn' },
    ]);
    fake.scenario({ mode: 'result-string', payload: { text: 'hello' } });
    expect((await run())[0]).toEqual({ type: 'text', text: 'hello' });
  });

  it('CLI is_error / non-zero exit / bad JSON → ProviderError', async () => {
    fake.scenario({ mode: 'is_error' });
    expect(await failure(run())).toMatchObject({ name: 'ProviderError', retryable: false });
    fake.scenario({ mode: 'exit', code: 3 });
    const e = await failure(run());
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toMatch(/code 3/);
    fake.scenario({ mode: 'raw', stdout: '{"type":"result",' });
    expect(await failure(run())).toBeInstanceOf(ProviderError);
    expect(fake.starts()).toHaveLength(3); // no retry for these
  });

  it('stderr with email absent from logs and payload', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      fake.scenario({ mode: 'exit', code: 1, stderr: `Error: account ${EMAIL} is over quota` });
      const e1 = await failure(run());
      fake.scenario({ mode: 'is_error', result: `account ${EMAIL} rate limited`, stderr: EMAIL });
      const e2 = await failure(run());
      for (const e of [e1, e2]) {
        expect(e).toBeInstanceOf(ProviderError);
        expect(`${e.message}\n${String(e.cause)}\n${e.stack}\n${JSON.stringify(e)}`).not.toContain(EMAIL);
      }
      expect(JSON.stringify([...log.mock.calls, ...warn.mock.calls])).not.toContain(EMAIL);
    } finally {
      log.mockRestore();
      warn.mockRestore();
    }
  });

  it('2 MiB stdout → ProviderError, child killed', async () => {
    fake.scenario({ mode: 'oversize', bytes: 2 * 1024 * 1024 });
    const e = await failure(run());
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toMatch(/output limit/);
    const s = fake.starts()[0]!;
    await until(() => !alive(s.pid) && !alive(s.grandchild!), 2000);
  });

  it('timeout retries once then ProviderError', async () => {
    fake.scenario({ mode: 'hang' });
    const e = await failure(run(mk({ timeoutMs: 300 })));
    expect(e).toMatchObject({ name: 'ProviderError', retryable: true });
    expect(e.message).toMatch(/timed out/);
    const starts = fake.starts();
    expect(starts).toHaveLength(2);
    await until(() => starts.every((s) => !alive(s.pid) && !alive(s.grandchild!)), 2000);
  });

  it('abort kills the process group within 2000 ms', async () => {
    fake.scenario({ mode: 'hang-stubborn' });
    const ac = new AbortController();
    const p = run(mk(), req(), ac.signal);
    await until(() => fake.starts().length === 1, 3000);
    const s = fake.starts()[0]!;
    const t0 = Date.now();
    ac.abort();
    expect(await p).toEqual([{ type: 'stop', reason: 'aborted' }]);
    await until(() => !alive(s.pid) && !alive(s.grandchild!), 2000 - (Date.now() - t0));
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(existsSync(s.cwd!)).toBe(false);
  });

  it('halt kills running child', async () => {
    fake.scenario({ mode: 'hang' });
    const halt = new Halt(new FakeConfig(), { listByStatus: async () => [], update: async () => null as never }, newBus());
    const ac = new AbortController();
    const untrack = halt.track(ac);
    const p = run(mk(), req(), ac.signal);
    await until(() => fake.starts().length === 1, 3000);
    const s = fake.starts()[0]!;
    await halt.halt('admin');
    expect(await p).toEqual([{ type: 'stop', reason: 'aborted' }]);
    untrack();
    await until(() => !alive(s.pid) && !alive(s.grandchild!), 2000);
  });

  it('temp dir removed on error (and on success; mode 0700)', async () => {
    fake.scenario(textPayload);
    await run();
    fake.scenario({ mode: 'exit', code: 9 });
    await failure(run());
    const [ok, bad] = fake.starts();
    for (const s of [ok!, bad!]) {
      expect(s.cwdMode).toBe(0o700);
      expect(s.cwd!.startsWith(root)).toBe(false);
      expect(existsSync(s.cwd!)).toBe(false);
    }
  });

  it('concurrency limit queues the third call', async () => {
    fake.scenario({ mode: 'slow', sleepMs: 400, payload: { text: 'x' } });
    const p = mk({ concurrency: 2 });
    await Promise.all([run(p), run(p), run(p)]);
    const recs = fake.records();
    let live = 0, peak = 0;
    for (const r of recs.sort((a, b) => a.t - b.t)) {
      live += r.event === 'start' ? 1 : -1;
      peak = Math.max(peak, live);
    }
    expect(fake.starts()).toHaveLength(3);
    expect(peak).toBe(2);
    const [, , third] = fake.starts().sort((a, b) => a.t - b.t);
    const firstEnd = Math.min(...recs.filter((r) => r.event === 'end').map((r) => r.t));
    expect(third!.t).toBeGreaterThanOrEqual(firstEnd);
  });

  it('21st queued call refused; an aborted queued call never spawns', async () => {
    fake.scenario({ mode: 'hang' });
    const p = mk({ concurrency: 1 });
    const ac = new AbortController();
    const running = run(p, req(), ac.signal);
    const queued = Array.from({ length: 20 }, () => run(p, req(), ac.signal));
    const e = await failure(run(p, req(), ac.signal));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.message).toMatch(/queue/);
    await until(() => fake.starts().length === 1, 3000);
    ac.abort();
    const outs = await Promise.all([running, ...queued]);
    for (const o of outs) expect(o).toEqual([{ type: 'stop', reason: 'aborted' }]);
    expect(fake.starts()).toHaveLength(1);
    // The slot and the queue are free again afterwards.
    fake.scenario(textPayload);
    expect((await run(p))[0]).toEqual({ type: 'text', text: 'hello' });
  });

  it('model "--tools=default" rejected before spawn', async () => {
    fake.scenario(textPayload);
    const e = await failure(run(mk(), req({ model: '--tools=default' })));
    expect(e).toMatchObject({ name: 'ProviderError', retryable: false });
    expect(fake.starts()).toHaveLength(0);
  });

  it('with local pricing present, provider claude still meters at the API price', () => {
    const cfg = new FakeConfig({
      pricing: { 'claude-sonnet-5-5': { inPerMTok: 2, outPerMTok: 10 }, 'local/claude-sonnet-5-5': { inPerMTok: 0, outPerMTok: 0 } },
    });
    const budget = new Budget(null as never, cfg, newBus());
    const u = { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(budget.costOf('claude-sonnet-5-5', u)).toBeCloseTo(3, 9);
    expect(budget.costOf('local/claude-sonnet-5-5', u)).toBe(0);
    // The local provider never sends a bare API id to the CLI, so the two ids cannot meet on one price.
    expect(() => toCliModel('claude-sonnet-5-5')).toThrow(ProviderError);
  });

  it('invalid model name rejected before spawn', async () => {
    fake.scenario(textPayload);
    for (const model of ['--tools=default', 'local/--tools=default', 'claude-sonnet-5-5', 'local/x y']) {
      expect(await failure(run(mk(), req({ model })))).toMatchObject({ name: 'ProviderError', retryable: false });
    }
    expect(fake.starts()).toHaveLength(0);
  });

  it('world-writable claude path refused', () => {
    chmodSync(fake.path, 0o777);
    expect(() => mk()).toThrow(/writable/);
    chmodSync(fake.path, 0o775);
    expect(() => mk()).toThrow(/writable/);
    chmodSync(fake.path, 0o755);
    expect(() => mk()).not.toThrow();
    const sub = join(root, 'open');
    mkdirSync(sub);
    const inner = installFakeClaude(sub);
    chmodSync(sub, 0o777);
    expect(() => mk({ claudePath: inner.path })).toThrow(/writable/);
    chmodSync(sub, 0o700);
    expect(() => mk({ claudePath: join(root, 'missing') })).toThrow();
  });

  it('pre-aborted signal yields aborted without spawning', async () => {
    fake.scenario(textPayload);
    const ac = new AbortController();
    ac.abort();
    expect(await run(mk(), req(), ac.signal)).toEqual([{ type: 'stop', reason: 'aborted' }]);
    expect(fake.starts()).toHaveLength(0);
  });

  it('descendant holding stdout does not delay a successful result', async () => {
    fake.scenario({ mode: 'inherit-exit', payload: { text: 'done' } });
    const t0 = Date.now();
    const out = await run(mk({ timeoutMs: 4000 }));
    expect(out[0]).toEqual({ type: 'text', text: 'done' });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(fake.starts()).toHaveLength(1);
    const s = fake.starts()[0]!;
    await until(() => !alive(s.grandchild!), 1000); // same process group: killed once the CLI exits
    expect(existsSync(s.cwd!)).toBe(false);
  });

  it('escaped (setsid) descendant holding stdout: success still returns promptly', async () => {
    fake.scenario({ mode: 'escaped-exit', payload: { text: 'done' } });
    const t0 = Date.now();
    const out = await run(mk({ timeoutMs: 4000 }));
    expect(out[0]).toEqual({ type: 'text', text: 'done' });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(fake.starts()).toHaveLength(1);
  });

  it('escaped (setsid) descendant holding stdout: abort resolves within 2000 ms, slot released, temp dir removed', async () => {
    fake.scenario({ mode: 'escaped-hang' });
    const p = mk({ concurrency: 1 });
    const ac = new AbortController();
    const call = run(p, req(), ac.signal);
    await until(() => fake.starts().length === 1, 3000);
    const s = fake.starts()[0]!;
    const t0 = Date.now();
    ac.abort();
    expect(await call).toEqual([{ type: 'stop', reason: 'aborted' }]);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(alive(s.pid)).toBe(false);
    expect(existsSync(s.cwd!)).toBe(false);
    fake.scenario(textPayload);
    expect((await run(p))[0]).toEqual({ type: 'text', text: 'hello' });
  });

  it('escaped descendant holding stdout: timeout resolves within 2000 ms of the deadline', async () => {
    fake.scenario({ mode: 'escaped-hang' });
    const t0 = Date.now();
    const e = await failure(run(mk({ timeoutMs: 300 })));
    expect(e.message).toMatch(/timed out/);
    expect(fake.starts()).toHaveLength(2);
    expect(Date.now() - t0).toBeLessThan(2 * (300 + 2000));
  });

  it('a failing unknown_tool audit is reported to the error sink with fixed text', async () => {
    fake.scenario({ mode: 'payload', payload: { tool_calls: [{ name: 'create_task', input: {} }] } });
    const error = vi.fn();
    const out = await run(mk({ audit: async () => { throw new Error('db down create_task'); }, log: { error } }));
    expect(out.at(-1)).toEqual({ type: 'stop', reason: 'end_turn' });
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(error.mock.calls)).not.toContain('create_task');
    expect(error.mock.calls[0]![1]).toBe('claude-code-local: unknown_tool audit failed');
  });

  it('onAttempt is awaited before each spawn, including the retry', async () => {
    fake.scenario({ mode: 'hang' });
    const seen: number[] = [];
    const onAttempt = vi.fn(async (n: number, signal: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(fake.starts()).toHaveLength(n - 1); // nothing spawned yet for this attempt
      seen.push(n);
    });
    await failure(run(mk({ timeoutMs: 1500, onAttempt })));
    expect(seen).toEqual([1, 2]);
    expect(fake.starts()).toHaveLength(2);
  }, 20_000);

  it('onAttempt throwing refuses the call without spawning (non-retryable quota)', async () => {
    fake.scenario(textPayload);
    const e = await failure(run(mk({ onAttempt: async () => { throw new Error('cap 40 reached'); } })));
    expect(e).toMatchObject({ name: 'ProviderError', retryable: false });
    expect(e.message).toMatch(/quota/);
    expect(e.message).not.toContain('cap 40');
    expect(fake.starts()).toHaveLength(0);
    // Refused on the retry: one spawn only.
    fake.scenario({ mode: 'hang' });
    const e2 = await failure(run(mk({ timeoutMs: 1500, onAttempt: async (n) => { if (n === 2) throw new Error('no'); } })));
    expect(e2).toMatchObject({ name: 'ProviderError', retryable: false });
    expect(e2.message).toMatch(/quota/);
    expect(fake.starts()).toHaveLength(1);
  });
});

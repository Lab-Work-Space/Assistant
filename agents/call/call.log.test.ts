import { describe, expect, it, vi } from 'vitest';
import { callProvider, failureInfo, type CallDeps } from './call.js';
import { ProviderError } from '../../providers/types.js';
import type { ChatRequest, LLMProvider } from '../../providers/types.js';

const req: ChatRequest = { model: 'local/claude-sonnet-5-5', system: 'SECRET-PROMPT', messages: [{ role: 'user', content: [{ type: 'text', text: 'SECRET-USER-TEXT' }] }], tools: [], maxTokens: 10 };
const deps = (log?: CallDeps['log']): CallDeps => ({
  budget: { reserve: async () => ({ ok: true, reservationId: 'r1' }), settle: async () => undefined, release: async () => undefined, costOf: () => 0 } as unknown as CallDeps['budget'],
  halt: { track: () => () => undefined },
  audit: async () => undefined,
  ...(log ? { log } : {}),
});
const failing = (id: string, err: unknown): LLMProvider => ({ id, async *chat() { throw err; } });
const actor = { kind: 'head', dept: 'hq' } as never;

describe('callProvider failure diagnostics', () => {
  it('logs class, provider, model, task id and diag for claude-code-local, never prompt text', async () => {
    const warn = vi.fn();
    const err = new ProviderError('claude-code-local: CLI exited with code 2', { retryable: false, diag: 'exit:2' });
    const o = await callProvider(req, failing('claude-code-local', err), actor, { id: 'T1' } as never, deps({ warn }));
    expect(o).toMatchObject({ kind: 'done', failed: err });
    expect(warn).toHaveBeenCalledTimes(1);
    const [obj] = warn.mock.calls[0]!;
    expect(obj).toMatchObject({ provider: 'claude-code-local', model: 'local/claude-sonnet-5-5', taskId: 'T1', errName: 'ProviderError', reason: 'claude-code-local: CLI exited with code 2', diag: 'exit:2' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET');
  });

  it('other providers: only name + status, not the message', () => {
    const e = Object.assign(new Error('prompt quoted: SECRET-PROMPT'), { name: 'APIError', status: 529 });
    expect(failureInfo(e, 'anthropic')).toEqual({ errName: 'APIError', status: 529 });
  });

  it('a throwing log sink does not change the outcome', async () => {
    const o = await callProvider(req, failing('claude-code-local', new Error('x')), actor, null, deps({ warn: () => { throw new Error('sink'); } }));
    expect(o.kind).toBe('done');
  });
});

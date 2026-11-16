import { describe, expect, it, vi } from 'vitest';
const seen: { opts?: unknown; params?: any } = {};
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContentStream: async (p: unknown) => { seen.params = p; return (async function* () {})(); } };
    constructor(o: unknown) { seen.opts = o; }
  },
}));
import { adaptGenAi, sdkClientOptions, toSdkParams } from './adapter.js';

const REQ = { model: 'm', systemInstruction: 's', contents: [], functionDeclarations: [{ name: 't', description: 'd' }], maxOutputTokens: 9 };

describe('adapter (P11: no SDK-side billable re-sends)', () => {
  it('turns automaticContinuation off, limits SDK retries to one attempt, sends only functionDeclarations', () => {
    const ac = new AbortController();
    const p = toSdkParams(REQ, ac.signal);
    expect(p.config.automaticContinuation).toBe(false);
    expect(p.config.httpOptions.retryOptions.attempts).toBe(1);
    expect(p.config.abortSignal).toBe(ac.signal);
    expect(Object.keys(p.config.tools![0]!)).toEqual(['functionDeclarations']);
  });

  it('builds its own client from the key with retryOptions.attempts 1; caller httpOptions cannot override', () => {
    expect(sdkClientOptions('k')).toEqual({ apiKey: 'k', httpOptions: { retryOptions: { attempts: 1 } } });
    expect(() => adaptGenAi({ apiKey: 'k', httpOptions: { retryOptions: { attempts: 9 } } })).not.toThrow();
    expect(() => adaptGenAi({})).toThrow(/apiKey/);
    expect(() => adaptGenAi({ models: {} })).toThrow(/apiKey/);
  });

  it('the real call path uses the built client options and params', async () => {
    const ac = new AbortController();
    const it = await adaptGenAi({ apiKey: 'k', httpOptions: { retryOptions: { attempts: 9 } } }).stream(REQ, ac.signal);
    for await (const _ of it) void _;
    expect(seen.opts).toEqual({ apiKey: 'k', httpOptions: { retryOptions: { attempts: 1 } } });
    expect(seen.params.config).toMatchObject({ automaticContinuation: false, abortSignal: ac.signal });
  });
});

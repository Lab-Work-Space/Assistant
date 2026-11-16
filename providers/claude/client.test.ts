import Anthropic from '@anthropic-ai/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildClientOptions, createClaudeProvider } from './index.js';

afterEach(() => vi.unstubAllEnvs());

/** R8 PV-C07: the API key only ever goes to api.anthropic.com, and SDK debug output never bypasses the masking logger. */
describe('claude SDK client hardening (PV-C07)', () => {
  it('the provider builds its client from the hardened options', () => {
    let seen: Record<string, unknown> = {};
    createClaudeProvider('sk-test-fake', { client: { messages: { stream: () => (async function* () {})() }, beta: { messages: { stream: () => (async function* () {})() } } } as never, onClientOptions: (o) => { seen = o as never; } });
    expect(seen).toMatchObject({ apiKey: 'sk-test-fake', maxRetries: 3, baseURL: 'https://api.anthropic.com', logLevel: 'off', authToken: null, openTelemetry: { propagation: false, traces: { enabled: false } } });
  });

  it('a real client ignores ANTHROPIC_BASE_URL, ANTHROPIC_LOG and ANTHROPIC_AUTH_TOKEN from the environment', () => {
    vi.stubEnv('ANTHROPIC_BASE_URL', 'http://evil.invalid');
    vi.stubEnv('ANTHROPIC_LOG', 'debug');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'env-token-should-not-be-used');
    const unhardened = new Anthropic({ apiKey: 'k', maxRetries: 3 });
    expect(unhardened.baseURL).toBe('http://evil.invalid'); // the premise: the SDK does read the environment
    const c = new Anthropic(buildClientOptions('k'));
    expect(c.baseURL).toBe('https://api.anthropic.com');
    expect(c.logLevel).toBe('off');
    expect(c.authToken).toBeNull();
    expect(c.apiKey).toBe('k');
  });

  it('a real client has tracing off and ignores ANTHROPIC_OPEN_TELEMETRY* and the content mode from the environment', () => {
    vi.stubEnv('ANTHROPIC_OPEN_TELEMETRY', 'true');
    vi.stubEnv('ANTHROPIC_OPEN_TELEMETRY_TRACES_CONTENT_MODE', 'content');
    const unhardened = new Anthropic({ apiKey: 'k' });
    expect(unhardened.openTelemetry.traces.contentMode).toBe('content'); // the premise
    const c = new Anthropic(buildClientOptions('k'));
    expect(c.openTelemetry.traces.enabled).toBe(false);
    expect(c.openTelemetry.traces.contentMode).toBe('metadata_only');
    expect(c.openTelemetry.propagation).toBe(false);
  });
});

describe('ANTHROPIC-WS: workspace header', () => {
  const id = 'wrkspc_0123456789AbCdEf';
  const send = async (opts: ReturnType<typeof buildClientOptions>) => {
    let headers: Headers | undefined;
    const fetch = (async (_u: unknown, init: RequestInit) => { headers = new Headers(init.headers); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); }) as never;
    await new Anthropic({ ...opts, fetch }).messages.create({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] });
    return headers!;
  };
  it('sends anthropic-workspace-id when set', async () => {
    expect((await send(buildClientOptions('k', id))).get('anthropic-workspace-id')).toBe(id);
  });
  it('does not send it when absent', async () => {
    expect((await send(buildClientOptions('k'))).has('anthropic-workspace-id')).toBe(false);
  });
  it('keeps the hardening and passes the id through createClaudeProvider', () => {
    let seen: Record<string, unknown> = {};
    createClaudeProvider('k', { workspaceId: id, client: {} as never, onClientOptions: (o) => { seen = o as never; } });
    expect(seen).toMatchObject({ baseURL: 'https://api.anthropic.com', logLevel: 'off', defaultHeaders: { 'anthropic-workspace-id': id } });
  });
});

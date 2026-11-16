import { describe, expect, it, vi } from 'vitest';
import { safeFetch } from '../../../net/guard.js';
import { fakeResolver, fakeTransport } from '../../../tests/fakes/net.js';
import { fetchPageTool } from './fetchPage.js';
import { webRig } from './test-helpers.js';

const PUBLIC = '93.184.215.14';
type Mode = 'http' | 'browser';
// C23 / G2C-09: every case below also runs with a browser configured. The fake browser applies the same guard to the same fake network,
// so the tool's own gates (G2-05, P5, wrapping, caps) are exercised on the browser path too.
const withMode = (mode: Mode, resolver: ReturnType<typeof fakeResolver>, transport: ReturnType<typeof fakeTransport>, extra: () => number[]) =>
  mode === 'browser' ? { resolver, transport, extraPorts: extra, browser: { fetch: (u: string) => safeFetch(u, { resolver, transport, extraPorts: extra() }) } } : { resolver, transport, extraPorts: extra };

describe.each(['http', 'browser'] as Mode[])('fetch_page (%s backend)', (mode) => {
  const net = (routes: Parameters<typeof fakeTransport>[0], extra: number[] = []) => {
    const transport = fakeTransport(routes);
    const resolver = fakeResolver({ 'example.com': [PUBLIC], 'evil.example': ['10.1.2.3'] });
    return { transport, resolver, tool: fetchPageTool(withMode(mode, resolver, transport, () => extra)) };
  };

  it('blocked URL returns tool error without contacting transport', async () => {
    for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'https://evil.example/', 'http://[::1]/']) {
      const { tool, transport } = net({});
      const { reg, c } = await webRig([tool]);
      const res = await reg.run('fetch_page', { url }, c);
      expect(res.isError, url).toBe(true);
      expect(res.content).toMatch(/refused|blocked/i);
      expect(transport.requests).toHaveLength(0);
    }
  });

  it('non-http input is rejected by the schema', async () => {
    const { tool, transport } = net({});
    const { reg, c } = await webRig([tool]);
    for (const url of ['file:///etc/passwd', 'not a url', 'ftp://example.com/']) {
      expect((await reg.run('fetch_page', { url }, c)).isError).toBe(true);
    }
    expect(transport.requests).toHaveLength(0);
  });

  it('returns page text (scripts stripped) with the final url, wrapped untrusted by the registry, and taints the run', async () => {
    const { tool } = net({ 'https://example.com/a': { body: '<html><script>evil()</script><p>Hello   world</p></html>' } });
    const { reg, c } = await webRig([tool]);
    const res = await reg.run('fetch_page', { url: 'https://example.com/a#top' }, c);
    expect(res.isError).toBeFalsy();
    expect(res.content).toMatch(/^<untrusted-[0-9a-f]{16} source="web" author="fetch_page"/);
    expect(res.content).toContain('https://example.com/a');
    expect(res.content).toContain('Hello world');
    expect(res.content).not.toContain('evil()');
    expect(c.tainted()).toBe(true);
    expect(c.run.knownUrls.has('https://example.com/a')).toBe(true);
  });

  it('plain text and json pass through; binary types are refused; long text is capped; truncation is said', async () => {
    const { tool } = net({
      'https://example.com/t': { headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(50_000) },
      'https://example.com/j': { headers: { 'content-type': 'application/json' }, body: '{"a":1}' },
      'https://example.com/p': { headers: { 'content-type': 'image/png' }, body: 'PNG' },
    });
    const run = (url: string) => tool.run({ url }, {} as never);
    const t = await run('https://example.com/t');
    expect(t.content.length).toBeLessThan(21_000);
    expect(t.content).toMatch(/truncated/);
    expect((await run('https://example.com/j')).content).toContain('{"a":1}');
    const p = await run('https://example.com/p');
    expect(p.isError).toBe(true);
    expect(p.content).toMatch(/image\/png/);
  });

  it('a compressed (non-identity) body is a tool error', async () => {
    const { tool } = net({ 'https://example.com/z': { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' }, body: '\x1f\x8b' } });
    const res = await tool.run({ url: 'https://example.com/z' }, {} as never);
    expect(res.isError).toBe(true);
    expect(res.content).toMatch(/content encoding gzip/);
  });

  it('an HTTP error status is a tool error that still shows the status', async () => {
    const { tool } = net({ 'https://example.com/x': { status: 404, body: '<p>gone</p>' } });
    const res = await tool.run({ url: 'https://example.com/x' }, {} as never);
    expect(res.isError).toBe(true);
    expect(res.content).toContain('404');
  });

  it('a configured extra port is honoured per call', async () => {
    let extra: number[] = [];
    const transport = fakeTransport({ 'https://example.com:8443/': { body: 'ok' } });
    const tool = fetchPageTool(withMode(mode, fakeResolver({ 'example.com': [PUBLIC] }), transport, () => extra));
    expect((await tool.run({ url: 'https://example.com:8443/' }, {} as never)).isError).toBe(true);
    extra = [8443];
    expect((await tool.run({ url: 'https://example.com:8443/' }, {} as never)).isError).toBeFalsy();
  });

  it('requiresApproval: untainted never; tainted asks for an unknown url, not for a known one (R17)', async () => {
    const { tool } = net({});
    const { c } = await webRig([tool]);
    expect(tool.requiresApproval({ url: 'https://new.example/x' }, c)).toBe(false);
    c.run.markTainted();
    const ask = tool.requiresApproval({ url: 'https://new.example/x?key=AIzaSyA-1234567890abcdefghijklmnopqrstu' }, c);
    expect(ask).toMatchObject({ reason: expect.stringContaining('new.example') });
    expect(JSON.stringify(ask)).not.toContain('AIzaSyA-1234567890abcdefghijklmnopqrstu');
    c.run.knownUrls.add('https://known.example/a');
    expect(tool.requiresApproval({ url: 'https://known.example/a#frag' }, c)).toBe(false);
  });
});

// WEBGRANT-1: the task web grant, applied in fetch_page.precheck (D7).
describe('fetch_page task web grant', () => {
  const rig = async (over: Parameters<typeof webRig>[1] = {}) => {
    const transport = fakeTransport({ 'https://example.com/a': { body: '<p>page</p>' } });
    const resolver = fakeResolver({ 'example.com': [PUBLIC] });
    const tool = fetchPageTool({ resolver, transport, extraPorts: () => [] });
    return { transport, ...(await webRig([tool], over)) };
  };
  const ok = { ok: true as const, grantId: 7, used: 1, max: 20 };

  it('untainted / no task / no port: consume is not called (W-C13)', async () => {
    const consume = vi.fn(async () => ok);
    const a = await rig({ webGrants: { consume } });
    await a.reg.run('fetch_page', { url: 'https://example.com/a' }, a.c); // untainted
    const b = await rig({ webGrants: { consume }, task: null });
    b.c.run.markTainted();
    await b.reg.run('fetch_page', { url: 'https://example.com/a' }, b.c);
    const c = await rig();
    c.c.run.markTainted();
    await c.reg.run('fetch_page', { url: 'https://example.com/a' }, c.c);
    expect(consume).not.toHaveBeenCalled();
    expect(c.approvals.request).toHaveBeenCalledTimes(1); // no port: today's card
  });

  it('with no task, precheck never opens a conversation task (W-C13)', async () => {
    const consume = vi.fn(async () => ok);
    const ensure = vi.fn(async () => { throw new Error('must not be called by precheck'); });
    const t = await rig({ webGrants: { consume }, task: null, ensureConversationTask: ensure as never });
    t.c.run.markTainted();
    await t.reg.run('fetch_page', { url: 'https://example.com/a' }, t.c);
    expect(consume).not.toHaveBeenCalled();
    expect(ensure).toHaveBeenCalledTimes(1); // only the registry's approval path (today's behaviour), after precheck returned
  });

  it('tainted + live grant: consumes with the parsed host and pathname+search length, fetches, files no card', async () => {
    const consume = vi.fn(async () => ok);
    const t = await rig({ webGrants: { consume } });
    t.c.run.markTainted();
    const res = await t.reg.run('fetch_page', { url: 'https://example.com/a' }, t.c);
    expect(res.isError).toBeFalsy();
    expect(consume).toHaveBeenCalledWith({ rootId: t.c.task!.rootId, host: 'example.com', chars: 2 });
    expect(t.approvals.request).not.toHaveBeenCalled();
    expect(t.transport.requests).toHaveLength(1);
    expect(t.c.run.knownUrls.has('https://example.com/a')).toBe(true);
  });

  it('a url already known in the run is not consumed again', async () => {
    const consume = vi.fn(async () => ok);
    const t = await rig({ webGrants: { consume } });
    t.c.run.markTainted();
    t.c.run.knownUrls.add('https://example.com/a');
    await t.reg.run('fetch_page', { url: 'https://example.com/a' }, t.c);
    expect(consume).not.toHaveBeenCalled();
  });

  it('a consume miss files the card with the reason infix (D8); a port that throws also files the card', async () => {
    const miss = await rig({ webGrants: { consume: async () => ({ ok: false as const, why: 'cap_fetches' as const }) } });
    miss.c.run.markTainted();
    await miss.reg.run('fetch_page', { url: 'https://example.com/a' }, miss.c);
    expect(miss.approvals.request).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('url not seen in this run (web grant not applied: cap_fetches): https://example.com/a') }));
    expect(miss.transport.requests).toHaveLength(0);
    const boom = await rig({ webGrants: { consume: async () => { throw new Error('db down'); } } });
    boom.c.run.markTainted();
    const res = await boom.reg.run('fetch_page', { url: 'https://example.com/a' }, boom.c);
    expect(res.content).toMatch(/NOT DONE YET/);
    expect(boom.approvals.request).toHaveBeenCalledTimes(1);
  });

  it('a url that fails grantUrlCheck is not consumed and gets a card naming the rule, redacted (W-C14)', async () => {
    const consume = vi.fn(async () => ok);
    const t = await rig({ webGrants: { consume } });
    t.c.run.markTainted();
    await t.reg.run('fetch_page', { url: 'https://example.com/u/1234567890' }, t.c);
    expect(consume).not.toHaveBeenCalled();
    const reason = (t.approvals.request.mock.calls[0] as unknown as [{ reason: string }])[0].reason;
    expect(reason).toContain('web grant not applied: url:E7');
    expect(reason.length).toBeLessThanOrEqual(300);
  });

  it('audits the consume with the host-free outcome (W-C12 / W9)', async () => {
    const entries: { action: string; outcome?: string | null }[] = [];
    const t = await rig({ webGrants: { consume: async () => ok }, audit: async (e) => void entries.push(e) });
    t.c.run.markTainted();
    await t.reg.run('fetch_page', { url: 'https://example.com/a' }, t.c);
    expect(entries.find((e) => e.action === 'web_grant.consume')).toMatchObject({ outcome: 'ok #7 1/20' });
    expect(JSON.stringify(entries)).not.toContain('example.com');
  });
});

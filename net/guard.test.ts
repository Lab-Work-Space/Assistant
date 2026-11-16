import { describe, expect, it } from 'vitest';
import { endlessBody, fakeResolver, fakeTransport, redirect, stalledBody } from '../tests/fakes/net.js';
import { isBlockedAddress, safeFetch, SafeFetchError } from './guard.js';

const PUBLIC = '93.184.215.14';
const PUBLIC6 = '2606:2800:21f:cb07:6820:80da:af6b:8b2c';
const resolver = fakeResolver({ 'example.com': [PUBLIC], 'v6.example.com': [PUBLIC6] });

async function refused(url: string, o: Partial<Parameters<typeof safeFetch>[1]> = {}) {
  const transport = o.transport ?? fakeTransport({});
  const err = await safeFetch(url, { resolver, ...o, transport }).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, url).toBeInstanceOf(SafeFetchError);
  return { err: err as SafeFetchError, transport: transport as ReturnType<typeof fakeTransport> };
}

describe('guard › addresses', () => {
  it.each([
    '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '127.255.255.254', '169.254.169.254', '172.16.0.1', '172.30.0.1',
    '172.31.255.255', '192.168.1.1', '198.18.0.1', '198.19.255.255', '192.0.2.1', '198.51.100.7', '203.0.113.9', '224.0.0.1',
    '240.0.0.1', '255.255.255.255', '::', '::1', 'fd00::1', 'fc00::1', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1',
    '::ffff:7f00:1', '::ffff:10.0.0.1', '64:ff9b::1', '64:ff9b::7f00:1', '64:ff9b:1::1', '::127.0.0.1', '100::1', '2001::1',
    '2001:db8::1', '2002:7f00:1::1', 'fe80::1%en0', 'not-an-ip', '', '1.2.3', '1.2.3.256',
  ])('%s is blocked', (ip) => expect(isBlockedAddress(ip)).toBe(true));

  it.each(['8.8.8.8', PUBLIC, '172.15.255.255', '172.32.0.1', '100.128.0.1', PUBLIC6, '::ffff:8.8.8.8', '2a00:1450:4001:80b::200e'])(
    '%s is allowed',
    (ip) => expect(isBlockedAddress(ip)).toBe(false),
  );
});

describe('guard › urls', () => {
  it.each([
    'http://127.0.0.1/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://192.168.1.1/',
    'http://[::1]/', 'http://[fd00::1]/', 'http://[::ffff:127.0.0.1]/', 'http://2130706433/', 'http://0x7f.1/', 'http://0177.0.0.1/',
    'http://127.1/', 'http://0.0.0.0/', 'http://100.64.0.1/', 'http://172.30.0.1/', 'http://198.18.0.1/', 'http://[64:ff9b::1]/',
    'http://240.0.0.1/', 'http://foo.localhost/', 'http://localhost./',
  ])('refuses %s without contacting the transport', async (url) => {
    const { err, transport } = await refused(url);
    expect(err.code).toBe('blocked');
    expect(transport.requests).toHaveLength(0);
  });

  it('a hostname resolving to a mix of public and private addresses is refused', async () => {
    const r = fakeResolver({ 'mixed.example': [PUBLIC, '10.0.0.5'] });
    const { err, transport } = await refused('https://mixed.example/', { resolver: r });
    expect(err.code).toBe('blocked');
    expect(transport.requests).toHaveLength(0);
  });

  it('a resolver error, an empty answer or a garbage answer fails closed', async () => {
    for (const r of [fakeResolver({}), fakeResolver({ 'e.example': [] }), fakeResolver({ 'e.example': ['bogus'] })]) {
      const { err, transport } = await refused('https://e.example/', { resolver: r });
      expect(err.code).toBe('blocked');
      expect(transport.requests).toHaveLength(0);
    }
  });

  it('non-http(s) schemes, userinfo urls and unparsable urls are refused', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/', 'gopher://example.com/', 'data:text/plain,hi', 'javascript:alert(1)',
      'http://user:pass@example.com/', 'http://user@example.com/', 'https://:x@example.com/', 'not a url', '']) {
      const { err, transport } = await refused(url);
      expect(err.code, url).toBe('blocked');
      expect(transport.requests).toHaveLength(0);
    }
  });

  it('ports other than 80/443 are refused; a configured extra port >= 1024 is allowed, a low one is ignored', async () => {
    for (const url of ['http://example.com:8080/', 'https://example.com:22/', 'http://example.com:6379/']) {
      const { err } = await refused(url);
      expect(err.code).toBe('blocked');
    }
    const t = fakeTransport({ 'http://example.com:8080/': { body: 'ok' } });
    await expect(safeFetch('http://example.com:8080/', { resolver, transport: t, extraPorts: [8080] })).resolves.toMatchObject({ status: 200 });
    const { err } = await refused('http://example.com:22/', { extraPorts: [22] });
    expect(err.code).toBe('blocked');
    const both = fakeTransport({ 'http://example.com:443/': { body: 'a' }, 'https://example.com/': { body: 'b' } });
    await expect(safeFetch('http://example.com:443/', { resolver, transport: both })).resolves.toMatchObject({ status: 200 });
  });
});

describe('guard › fetch', () => {
  it('connects to the validated address, not a second resolution (DNS-rebinding fake returns public then private)', async () => {
    const r = fakeResolver({ 'rebind.example': (n) => (n === 1 ? [PUBLIC] : ['127.0.0.1']) });
    const t = fakeTransport({ 'https://rebind.example/': { body: 'hello' } });
    const res = await safeFetch('https://rebind.example/', { resolver: r, transport: t });
    expect(res.body.toString()).toBe('hello');
    expect(r.calls).toEqual(['rebind.example']);
    expect(t.requests.map((q) => q.address)).toEqual([PUBLIC]);
    expect(t.requests[0]!.url.hostname).toBe('rebind.example');
  });

  it('public URL redirecting to http://127.0.0.1 is refused at the hop (AC5)', async () => {
    const t = fakeTransport({ 'https://example.com/go': redirect('http://127.0.0.1/admin') });
    const { err } = await refused('https://example.com/go', { transport: t });
    expect(err.code).toBe('blocked');
    expect(t.requests.map((q) => q.url.href)).toEqual(['https://example.com/go']);
  });

  it('redirect to a hostname that resolves private is refused', async () => {
    const r = fakeResolver({ 'example.com': [PUBLIC], 'internal.example': ['172.30.0.4'] });
    const t = fakeTransport({ 'https://example.com/a': redirect('https://internal.example/b', 301) });
    const { err } = await refused('https://example.com/a', { resolver: r, transport: t });
    expect(err.code).toBe('blocked');
    expect(t.requests).toHaveLength(1);
    expect(r.calls).toEqual(['example.com', 'internal.example']);
  });

  it('follows relative redirects, re-resolving each hop, and reports the final url', async () => {
    const r = fakeResolver({ 'example.com': [PUBLIC], 'v6.example.com': [PUBLIC6] });
    const t = fakeTransport({
      'https://example.com/a': redirect('/b'),
      'https://example.com/b': redirect('https://v6.example.com/c', 307),
      'https://v6.example.com/c': { body: 'done', headers: { 'content-type': 'text/plain' } },
    });
    const res = await safeFetch('https://example.com/a', { resolver: r, transport: t });
    expect(res).toMatchObject({ finalUrl: 'https://v6.example.com/c', status: 200, contentType: 'text/plain', truncated: false });
    expect(t.requests.map((q) => q.address)).toEqual([PUBLIC, PUBLIC, PUBLIC6]);
  });

  it('>5 redirects refused', async () => {
    const routes: Record<string, ReturnType<typeof redirect>> = {};
    for (let i = 0; i < 7; i++) routes[`https://example.com/${i}`] = redirect(`/${i + 1}`);
    const t = fakeTransport(routes);
    const { err } = await refused('https://example.com/0', { transport: t });
    expect(err.code).toBe('too_many_redirects');
    expect(t.requests).toHaveLength(6);
    const ok = fakeTransport({ ...routes, 'https://example.com/5': { body: 'end' } });
    await expect(safeFetch('https://example.com/0', { resolver, transport: ok })).resolves.toMatchObject({ finalUrl: 'https://example.com/5' });
  });

  it('>2 MiB body truncated with flag, whatever content-length says', async () => {
    const t = fakeTransport({ 'https://example.com/big': () => ({ headers: { 'content-length': '10' }, body: endlessBody() }) });
    const res = await safeFetch('https://example.com/big', { resolver, transport: t });
    expect(res.truncated).toBe(true);
    expect(res.body.length).toBe(2 * 1024 * 1024);
    const small = await safeFetch('https://example.com/big', { resolver, transport: t, maxBytes: 1000 });
    expect(small).toMatchObject({ truncated: true });
    expect(small.body.length).toBe(1000);
  });

  it('10 s timeout aborts a stalled body (default), and a shorter timeout aborts sooner', async () => {
    const t = fakeTransport({ 'https://example.com/slow': { body: stalledBody() } });
    const started = Date.now();
    const { err } = await refused('https://example.com/slow', { transport: t, timeoutMs: 50 });
    expect(err.code).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(t.requests[0]!.signal.aborted).toBe(true);
  });

  it('the default timeout is 10 s', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers();
    try {
      const t = fakeTransport({ 'https://example.com/slow': { body: stalledBody() } });
      const p = safeFetch('https://example.com/slow', { resolver, transport: t }).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(9_900);
      expect(t.requests[0]!.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(await p).toMatchObject({ code: 'timeout' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a caller abort stops the fetch', async () => {
    const ctl = new AbortController();
    const t = fakeTransport({ 'https://example.com/slow': { body: stalledBody() } });
    const p = safeFetch('https://example.com/slow', { resolver, transport: t, signal: ctl.signal }).catch((e: unknown) => e);
    setTimeout(() => ctl.abort(), 10);
    expect(await p).toMatchObject({ code: 'aborted' });
  });

  it('POST sends method, headers and body; a redirect after POST is returned unfollowed (fail closed)', async () => {
    const t = fakeTransport({
      'https://example.com/hook': { status: 302, headers: { location: 'https://example.com/elsewhere', 'content-type': 'text/plain' }, body: 'moved' },
    });
    const res = await safeFetch('https://example.com/hook', { resolver, transport: t, method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
    expect(res).toMatchObject({ status: 302, finalUrl: 'https://example.com/hook', headers: { location: 'https://example.com/elsewhere' } });
    expect(t.requests).toHaveLength(1);
    const q = t.requests[0]!;
    expect(q.method).toBe('POST');
    expect(q.headers['content-type']).toBe('application/json');
    expect(q.headers['content-length']).toBe('7');
    expect(q.body?.toString()).toBe('{"a":1}');
  });

  it('GET defaults: identity encoding, no body; credentials headers dropped on a cross-origin hop', async () => {
    const r = fakeResolver({ 'example.com': [PUBLIC], 'other.example': [PUBLIC] });
    const t = fakeTransport({ 'https://example.com/a': redirect('https://other.example/b'), 'https://other.example/b': { body: 'x' } });
    await safeFetch('https://example.com/a', { resolver: r, transport: t, headers: { authorization: 'Bearer s', cookie: 'c=1' } });
    expect(t.requests[0]!.method).toBe('GET');
    expect(t.requests[0]!.body).toBeUndefined();
    expect(t.requests[0]!.headers).toMatchObject({ 'accept-encoding': 'identity', authorization: 'Bearer s' });
    expect(t.requests[1]!.headers.authorization).toBeUndefined();
    expect(t.requests[1]!.headers.cookie).toBeUndefined();
  });

  it('a transport failure becomes a SafeFetchError', async () => {
    const t = Object.assign(async () => {
      throw new Error('ECONNRESET');
    }, { requests: [] });
    const { err } = await refused('https://example.com/', { transport: t as never });
    expect(err.code).toBe('failed');
  });
});

describe('guard › config', () => {
  it('net.extraPorts accepts ports >= 1024 only and defaults to none', async () => {
    const { ConfigSchema } = await import('../config/schema.js');
    const { CONFIG_DEFAULTS } = await import('../config/defaults.js');
    expect(CONFIG_DEFAULTS['net.extraPorts']).toEqual([]);
    expect(ConfigSchema['net.extraPorts'].safeParse([8080, 65535]).success).toBe(true);
    for (const bad of [[22], [1023], [0], [65536], [8080.5], ['8080']]) expect(ConfigSchema['net.extraPorts'].safeParse(bad).success, String(bad)).toBe(false);
  });
});

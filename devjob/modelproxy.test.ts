import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { allowLoopbackForTest } from '../vitest.setup.no-network.js';
import { bodyProblem, costOf, createModelProxy, UsageMeter, type Upstream, type UpstreamRequest } from './modelproxy.js';

beforeAll(allowLoopbackForTest);
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); }))); });

const PRICES = { 'claude-test': { inUsd: 3, outUsd: 15 } };
const listen = async (h: Parameters<typeof createServer>[1]): Promise<string> => {
  const s = createServer(h);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};
const jsonUp = (usage = { input_tokens: 1000, output_tokens: 500 }): Upstream => async () => ({ status: 200, headers: { 'content-type': 'application/json', 'x-secret': 'no' }, body: (async function* () { yield Buffer.from(JSON.stringify({ id: 'm', type: 'message', usage })); })() });

async function rig(o: { upstream?: Upstream; ledgerPath?: string; now?: () => Date; monthly?: number } = {}) {
  const seen: UpstreamRequest[] = [];
  const base = o.upstream ?? jsonUp();
  const proxy = createModelProxy({ upstream: async (r) => (seen.push(r), base(r)), apiKey: () => 'sk-REAL-KEY', prices: PRICES, maxTokensCap: 4000, monthlyCapUsd: o.monthly ?? 50, ...(o.ledgerPath ? { ledgerPath: o.ledgerPath } : {}), ...(o.now ? { now: o.now } : {}) });
  const url = await listen(proxy.handler);
  const ctl = await listen(proxy.controlHandler('t'.repeat(40), () => true));
  const reg = async (capUsd = 1, extra: Record<string, unknown> = {}) => (await (await fetch(`${ctl}/jobs`, { method: 'POST', headers: { authorization: `Bearer ${'t'.repeat(40)}` }, body: JSON.stringify({ jobId: 'J-0123456789abcdef', capUsd, ttlSec: 600, ...extra }) })).json() as { credential: string }).credential;
  const call = (cred: string, body: unknown, o2: { path?: string; method?: string; headers?: Record<string, string> } = {}) =>
    fetch(`${url}${o2.path ?? '/v1/messages'}`, { method: o2.method ?? 'POST', headers: { 'content-type': 'application/json', 'x-api-key': cred, ...o2.headers }, ...(o2.method === 'GET' ? {} : { body: JSON.stringify(body) }) });
  return { proxy, url, ctl, seen, reg, call };
}
const ok = { model: 'claude-test', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] };

describe('X1 gating', () => {
  it('a valid job request is forwarded with the REAL key; every inbound auth header is dropped', async () => {
    const x = await rig();
    const cred = await x.reg();
    const r = await x.call(cred, ok, { headers: { authorization: 'Bearer attacker', cookie: 'a=b', 'anthropic-beta': 'claude-code-20250219,files-api-2025-04-14,code-execution-2025-05-22' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-secret')).toBeNull();
    expect(x.seen).toHaveLength(1);
    expect(x.seen[0]!.headers['x-api-key']).toBe('sk-REAL-KEY');
    expect(JSON.stringify(x.seen[0]!.headers)).not.toContain(cred);
    expect(Object.keys(x.seen[0]!.headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    expect(x.seen[0]!.headers['anthropic-beta']).toBe('claude-code-20250219');
  });
  it('an unknown, foreign or expired credential gets 401 and nothing is forwarded; the real key is never echoed', async () => {
    let t = 1_000_000;
    const x = await rig({ now: () => new Date(t) });
    expect((await x.call('sk-ant-attacker-key', ok)).status).toBe(401);
    expect((await x.call('', ok)).status).toBe(401);
    const cred = await x.reg();
    t += 601_000;
    const r = await x.call(cred, ok);
    expect(r.status).toBe(401);
    expect(await r.text()).not.toContain('sk-REAL-KEY');
    expect(x.seen).toHaveLength(0);
  });
  it('only POST /v1/messages and /v1/messages/count_tokens: Files API, other paths, GET, odd queries are refused', async () => {
    const x = await rig();
    const cred = await x.reg();
    expect((await x.call(cred, ok, { path: '/v1/files' })).status).toBe(404);
    expect((await x.call(cred, ok, { path: '/v1/files/file_1/content', method: 'GET' })).status).toBe(405);
    expect((await x.call(cred, ok, { path: '/v1/messages/batches' })).status).toBe(404);
    expect((await x.call(cred, ok, { path: '/v1/messages?x=1' })).status).toBe(400);
    expect((await x.call(cred, ok, { path: '/v1/messages?beta=true' })).status).toBe(200);
    expect((await x.call(cred, ok, { path: '/v1/messages/count_tokens', headers: {} })).status).toBe(200);
    expect((await x.call(cred, ok, { path: '/v1/messages', headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect(x.seen).toHaveLength(2);
  });
  it('server tools and remote resources are refused wherever they sit', async () => {
    const x = await rig();
    const cred = await x.reg();
    const bad: unknown[] = [
      { ...ok, tools: [{ type: 'web_search_20250305', name: 'web_search' }] },
      { ...ok, tools: [{ type: 'web_fetch_20250910', name: 'web_fetch' }] },
      { ...ok, tools: [{ type: 'code_execution_20250522', name: 'code_execution' }] },
      { ...ok, mcp_servers: [{ type: 'url', url: 'https://evil.example', name: 'x' }] },
      { ...ok, container: 'container_1' },
      { ...ok, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'url', url: 'https://evil.example/a.pdf' } }] }] },
      { ...ok, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'file', file_id: 'file_1' } }] }] },
      { ...ok, messages: [{ role: 'user', content: [{ type: 'mcp_tool_use', id: 'x' }] }] },
    ];
    for (const b of bad) expect((await x.call(cred, b)).status, JSON.stringify(b).slice(0, 60)).toBe(400);
    // an ordinary client tool and an image by base64 are fine
    const fine = { ...ok, tools: [{ name: 'Read', description: 'd', input_schema: { type: 'object' } }], messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }] };
    expect((await x.call(cred, fine)).status).toBe(200);
    expect(x.seen).toHaveLength(1);
  });
  it('model allowlist and max_tokens cap', async () => {
    const x = await rig();
    const cred = await x.reg();
    expect((await x.call(cred, { ...ok, model: 'claude-other' })).status).toBe(400);
    expect((await x.call(cred, { ...ok, max_tokens: 4001 })).status).toBe(400);
    expect((await x.call(cred, { model: 'claude-test', messages: [] })).status).toBe(400);
    expect((await x.call(cred, '[]')).status).toBe(400);
    expect(x.seen).toHaveLength(0);
  });
  it('bodyProblem is pure and rejects a deeply nested body', () => {
    const o = { models: new Set(['claude-test']), maxTokensCap: 10, needMaxTokens: true };
    let deep: unknown = { a: 1 };
    for (let i = 0; i < 60; i++) deep = { n: deep };
    expect(bodyProblem({ model: 'claude-test', max_tokens: 5, d: deep }, o)).toMatch(/nested/);
    expect(bodyProblem({ model: 'claude-test', max_tokens: 5 }, o)).toBeNull();
  });
});

describe('X1 metering and caps (counted by the proxy)', () => {
  it('meters JSON usage into the job and the month; the control API reads it, and DELETE closes the credential', async () => {
    const x = await rig();
    const cred = await x.reg(1);
    await x.call(cred, ok);
    const spent = costOf(PRICES['claude-test'], { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 });
    const r = await (await fetch(`${x.ctl}/jobs/J-0123456789abcdef`, { headers: { authorization: `Bearer ${'t'.repeat(40)}` } })).json() as { spentUsd: number; requests: number; monthSpentUsd: number };
    expect(r.spentUsd).toBeCloseTo(spent);
    expect(r).toMatchObject({ requests: 1 });
    expect(r.monthSpentUsd).toBeCloseTo(spent);
    await fetch(`${x.ctl}/jobs/J-0123456789abcdef`, { method: 'DELETE', headers: { authorization: `Bearer ${'t'.repeat(40)}` } });
    expect((await x.call(cred, ok)).status).toBe(401);
  });
  it('meters SSE streams (message_start and message_delta)', async () => {
    const sse = [
      'event: message_start', `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 2000, output_tokens: 1, cache_read_input_tokens: 100 } } })}`, '',
      'event: message_delta', `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 700 } })}`, '', '',
    ].join('\n');
    const up: Upstream = async () => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: (async function* () { yield Buffer.from(sse.slice(0, 60)); yield Buffer.from(sse.slice(60)); })() });
    const x = await rig({ upstream: up });
    const cred = await x.reg();
    const r = await x.call(cred, ok);
    expect(await r.text()).toContain('message_delta');
    const j = await (await fetch(`${x.ctl}/jobs/J-0123456789abcdef`, { headers: { authorization: `Bearer ${'t'.repeat(40)}` } })).json() as { spentUsd: number };
    expect(j.spentUsd).toBeCloseTo(costOf(PRICES['claude-test'], { input: 2000, output: 700, cacheRead: 100, cacheWrite: 0 }));
  });
  it('cuts the job at its cap: the request that would exceed it is refused before it is forwarded', async () => {
    const x = await rig();
    const cred = await x.reg(0.01);
    expect((await x.call(cred, { ...ok, max_tokens: 4000 })).status).toBe(429); // worst case 4000 x $15/M = $0.06 > $0.01
    expect(x.seen).toHaveLength(0);
    expect((await x.call(cred, { ...ok, max_tokens: 100 })).status).toBe(200);
    for (let i = 0; i < 20; i++) await x.call(cred, { ...ok, max_tokens: 100 });
    expect((await x.call(cred, { ...ok, max_tokens: 100 })).status).toBe(429);
  });
  it('cuts at the monthly cap and keeps the month across a restart', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const d = mkdtempSync(join(tmpdir(), 'led-'));
    try {
      const a = await rig({ ledgerPath: join(d, 'ledger.json'), monthly: 0.02 });
      const cred = await a.reg(5);
      expect((await a.call(cred, ok)).status).toBe(200); // spends about $0.0105
      const b = await rig({ ledgerPath: join(d, 'ledger.json'), monthly: 0.02 });
      expect(b.proxy.monthly().spentUsd).toBeGreaterThan(0.01);
      const cred2 = await b.reg(5);
      await b.call(cred2, ok);
      expect((await b.call(cred2, ok)).status).toBe(429);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it('UsageMeter ignores garbage', () => {
    const m = new UsageMeter();
    m.feedSse('data: not json\n\ndata: {"type":"ping"}\n');
    m.take({ nothing: true });
    expect(m).toMatchObject({ input: 0, output: 0 });
  });
});

describe('G2SC-01 reservation under concurrency, G2SC-03 canonical body, G2SC-08 monthly cap', () => {
  const slow: Upstream = async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: (async function* () { await new Promise((r) => setTimeout(r, 40)); yield Buffer.from(JSON.stringify({ type: 'message', usage: { input_tokens: 1000, output_tokens: 500 } })); })() });
  it('20 parallel requests under a $1 cap: at most MAX_INFLIGHT are admitted at once and the metered total never exceeds the cap by more than one settled request', async () => {
    const x = await rig({ upstream: slow });
    const cred = await x.reg(0.05);
    const big = { ...ok, max_tokens: 3000 }; // worst case about $0.045 each
    const rs = await Promise.all(Array.from({ length: 20 }, () => x.call(cred, big)));
    const codes = rs.map((r) => r.status);
    expect(codes.filter((c) => c === 200).length).toBe(1); // one reservation of $0.045 fits under $0.05; the rest are refused while it is in flight
    expect(codes.filter((c) => c === 429).length).toBe(19);
    const j = await (await fetch(`${x.ctl}/jobs/J-0123456789abcdef`, { headers: { authorization: `Bearer ${'t'.repeat(40)}` } })).json() as { spentUsd: number; requests: number };
    expect(j.spentUsd).toBeLessThanOrEqual(0.05);
    expect(x.seen).toHaveLength(1);
  });
  it('the in-flight limit holds even with a big cap, and reservations are released afterwards', async () => {
    const x = await rig({ upstream: slow });
    const cred = await x.reg(50);
    const rs = await Promise.all(Array.from({ length: 10 }, () => x.call(cred, { ...ok, max_tokens: 100 })));
    expect(rs.filter((r) => r.status === 200).length).toBe(2);
    expect(rs.filter((r) => r.status === 429).length).toBe(8);
    expect((await x.call(cred, ok)).status).toBe(200); // slots are free again
  });
  it('the monthly total is reserved too, and a monthly cap of 0 refuses everything', async () => {
    const x = await rig({ upstream: slow, monthly: 0.05 });
    const cred = await x.reg(50);
    const rs = await Promise.all(Array.from({ length: 4 }, () => x.call(cred, { ...ok, max_tokens: 3000 })));
    expect(rs.filter((r) => r.status === 200).length).toBe(1);
    const z = await rig({ monthly: 0 });
    expect((await z.call(await z.reg(5), ok)).status).toBe(429);
    expect(z.seen).toHaveLength(0);
  });
  it('a caller cannot raise the monthly cap through the registration', async () => {
    const x = await rig({ monthly: 0 });
    const cred = (await (await fetch(`${x.ctl}/jobs`, { method: 'POST', headers: { authorization: `Bearer ${'t'.repeat(40)}` }, body: JSON.stringify({ jobId: 'J-0123456789abcdef', capUsd: 1, ttlSec: 60, monthlyCapUsd: 1000 }) })).json() as { credential: string }).credential;
    expect((await x.call(cred, ok)).status).toBe(429);
  });
  it('forwards the canonical body: a duplicate-key body that hides a server tool never reaches the upstream', async () => {
    const x = await rig();
    const cred = await x.reg();
    const raw = '{"model":"claude-test","max_tokens":50,"messages":[],"tools":[{"type":"web_search_20250305","name":"web_search"}],"tools":[]}';
    const r = await fetch(`${x.url}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': cred }, body: raw });
    expect(r.status).toBe(200); // the last duplicate wins in JSON.parse: the checked body has no tool
    const sent = x.seen[0]!.body.toString('utf8');
    expect(sent).not.toContain('web_search');
    expect(sent).toBe(JSON.stringify(JSON.parse(raw)));
  });
});

describe('control API', () => {
  it('needs the bearer token and an allowed caller; validates the registration', async () => {
    const proxy = createModelProxy({ upstream: jsonUp(), apiKey: () => 'k', prices: PRICES, monthlyCapUsd: 50 });
    const ctl = await listen(proxy.controlHandler('t'.repeat(40), () => true));
    const denied = await listen(proxy.controlHandler('t'.repeat(40), () => false));
    const h = { authorization: `Bearer ${'t'.repeat(40)}` };
    expect((await fetch(`${ctl}/jobs`, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await fetch(`${ctl}/jobs`, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' })).status).toBe(401);
    expect((await fetch(`${denied}/jobs`, { method: 'POST', headers: h, body: '{}' })).status).toBe(403);
    for (const body of [{}, { jobId: 'x', capUsd: 1, ttlSec: 10 }, { jobId: 'J-0123456789abcdef', capUsd: 1000, ttlSec: 10 }, { jobId: 'J-0123456789abcdef', capUsd: 1, ttlSec: 99999 }]) {
      expect((await fetch(`${ctl}/jobs`, { method: 'POST', headers: h, body: JSON.stringify(body) })).status).toBe(400);
    }
    expect((await fetch(`${ctl}/jobs/J-ffffffffffffffff`, { headers: h })).status).toBe(404);
  });
});

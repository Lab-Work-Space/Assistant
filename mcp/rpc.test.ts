import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { McpError } from './errors.js';
import { ACCEPTED_VERSIONS, PROTOCOL_VERSION, RPC_LIMITS, RpcClient, type McpProc } from './rpc.js';
import { fixtureSpawner } from './test-helpers.js';

const dockerArgv = ['run', 'x'];
const errCode = async (p: Promise<unknown>): Promise<string | undefined> => { try { await p; } catch (e) { return e instanceof McpError ? e.code : `other:${String(e)}`; } return undefined; };

async function withFixture<T>(env: Record<string, string>, fn: (c: RpcClient, sp: ReturnType<typeof fixtureSpawner>) => Promise<T>): Promise<T> {
  const sp = fixtureSpawner(env);
  const proc = sp(dockerArgv);
  const c = new RpcClient(proc, { onFatal: () => proc.kill() });
  try { return await fn(c, sp); } finally { c.closeStdin(); proc.kill(); await proc.exited; }
}

/** A client over in-memory streams, so a test controls every byte the "server" sends. */
function fed() {
  const out = new PassThrough();
  const written: string[] = [];
  let exit!: (v: { code: number | null; spawnFailed: boolean }) => void;
  const exited = new Promise<{ code: number | null; spawnFailed: boolean }>((r) => { exit = r; });
  const proc: McpProc = { stdin: { write: (d: string) => { written.push(d); return true; }, end: () => undefined, on: () => undefined } as never, stdout: out, stderr: new PassThrough(), exited, kill: () => undefined };
  const fatals: McpError[] = [];
  const c = new RpcClient(proc, { onFatal: (e) => fatals.push(e) });
  return { c, out, written, fatals, exit };
}
const lastId = (written: string[]): number => (JSON.parse(written[written.length - 1]!) as { id: number }).id;
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('MCP-AC06: the protocol path against the fixture server', () => {
  it('initialize, initialized, tools/list and tools/call work; the client declares no capabilities', async () => {
    await withFixture({}, async (c, sp) => {
      await c.handshake();
      const tools = await c.listTools();
      expect((tools as { name: string }[]).map((t) => t.name)).toEqual(['echo', 'add.numbers']);
      expect(await c.callTool('echo', { text: 'hi' }, 5000)).toMatchObject({ content: [{ type: 'text', text: 'echo:hi' }] });
      const init = JSON.parse(sp.log.stdin[0]!) as { method: string; params: { protocolVersion: string; capabilities: unknown } };
      expect(init.method).toBe('initialize');
      expect(init.params.protocolVersion).toBe(PROTOCOL_VERSION);
      expect(PROTOCOL_VERSION).toBe('2025-11-25');
      expect(init.params.capabilities).toEqual({});
    });
  });
  it('accepts 2025-11-25, 2025-06-18 and 2025-03-26; refuses any other version (MC-C11 f)', async () => {
    expect(ACCEPTED_VERSIONS).toEqual(['2025-11-25', '2025-06-18', '2025-03-26']);
    await withFixture({ MCP_SCENARIO: 'oldversion' }, async (c) => { await c.handshake(); });
    expect(await withFixture({ MCP_SCENARIO: 'badversion' }, (c) => errCode(c.handshake()))).toBe('E_PROTOCOL');
  });
  it('a non-JSON line is E_PROTOCOL', async () => {
    expect(await withFixture({ MCP_SCENARIO: 'nonjson' }, (c) => errCode(c.handshake()))).toBe('E_PROTOCOL');
  });
  it('MC-C11 b: a JSON array (a batch) is E_PROTOCOL, for every version, 2025-03-26 included', async () => {
    expect(await withFixture({ MCP_SCENARIO: 'batch' }, (c) => errCode(c.handshake()))).toBe('E_PROTOCOL');
  });
  it('a line over 1 MiB kills the call with E_TOO_BIG and fires onFatal once', async () => {
    const f = fed();
    const p = errCode(f.c.request('x', {}, 5000));
    f.out.write(Buffer.alloc(RPC_LIMITS.line + 10, 0x78));
    expect(await p).toBe('E_TOO_BIG');
    expect(f.fatals.map((e) => e.code)).toEqual(['E_TOO_BIG']);
  });
  it('more than 64 lines is E_TOO_BIG (blank lines and notifications count; server requests count too, MC-C11 d)', async () => {
    expect(await withFixture({ MCP_SCENARIO: 'manylines' }, (c) => errCode(c.handshake()))).toBe('E_TOO_BIG');
    const f = fed();
    const p = errCode(f.c.request('x', {}, 5000));
    f.out.write('\n'.repeat(65));
    expect(await p).toBe('E_TOO_BIG');
    const g = fed();
    const q = errCode(g.c.request('x', {}, 5000));
    g.out.write(Array.from({ length: 65 }, (_, i) => JSON.stringify({ jsonrpc: '2.0', id: `s${i}`, method: 'ping' })).join('\n') + '\n');
    expect(await q).toBe('E_TOO_BIG');
  });
  it('total stdout over 4 MiB is E_TOO_BIG even in lines of a legal size', async () => {
    const f = fed();
    const p = errCode(f.c.request('x', {}, 5000));
    const line = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'n', params: { s: 'a'.repeat(900_000) } })}\n`);
    for (let i = 0; i < 5; i++) f.out.write(line);
    expect(await p).toBe('E_TOO_BIG');
  });
  it('server requests: ping gets {} and sampling, elicitation, roots and anything else get -32601; notifications are ignored', async () => {
    await withFixture({ MCP_SCENARIO: 'requests' }, async (c) => {
      await c.handshake();
      const r = await c.callTool('echo', { text: 't' }, 5000);
      const t = (r['content'] as { text: string }[])[0]!.text;
      expect(t.startsWith('echo:t|')).toBe(true);
      expect(JSON.parse(t.slice(7))).toEqual([['srv-ping', {}, null], ['srv-sample', null, -32601]]);
    });
    const f = fed();
    void errCode(f.c.request('x', {}, 200));
    f.out.write([{ jsonrpc: '2.0', id: 1, method: 'elicitation/create' }, { jsonrpc: '2.0', id: 'r', method: 'roots/list' }, { jsonrpc: '2.0', method: 'notifications/tools/list_changed' }, { jsonrpc: '2.0', id: 7, method: 'zzz/unknown' }].map((m) => JSON.stringify(m)).join('\n') + '\n');
    await settle();
    const replies = f.written.slice(1).map((w) => JSON.parse(w) as { id: unknown; error?: { code: number } });
    expect(replies.map((r) => [r.id, r.error?.code])).toEqual([[1, -32601], ['r', -32601], [7, -32601]]);
  });
  it('tools/list follows nextCursor for at most 4 pages and a cursor is at most 256 characters', async () => {
    const t = await withFixture({ MCP_TOOLS: 'pages', MCP_PAGES: '4' }, async (c) => { await c.handshake(); return c.listTools(); });
    expect((t as { name: string }[]).map((x) => x.name)).toEqual(['p0', 'p1', 'p2', 'p3']);
    expect(await withFixture({ MCP_TOOLS: 'pages', MCP_PAGES: '5' }, async (c) => { await c.handshake(); return errCode(c.listTools()); })).toBe('E_PROTOCOL');
    const f = fed();
    const p = errCode(f.c.listTools());
    await settle();
    f.out.write(`${JSON.stringify({ jsonrpc: '2.0', id: lastId(f.written), result: { tools: [], nextCursor: 'x'.repeat(257) } })}\n`);
    expect(await p).toBe('E_PROTOCOL');
  });
  it('the raw tools/list total is capped at 256 KiB (E_TOO_BIG) and a non-array tools is E_PROTOCOL', async () => {
    const f = fed();
    const p = errCode(f.c.listTools());
    await settle();
    f.out.write(`${JSON.stringify({ jsonrpc: '2.0', id: lastId(f.written), result: { tools: [{ name: 'a', description: 'x'.repeat(300_000) }] } })}\n`);
    expect(await p).toBe('E_TOO_BIG');
    const g = fed();
    const q = errCode(g.c.listTools());
    await settle();
    g.out.write(`${JSON.stringify({ jsonrpc: '2.0', id: lastId(g.written), result: { tools: {} } })}\n`);
    expect(await q).toBe('E_PROTOCOL');
  });
});

describe('MC-C11: the response rules', () => {
  it('c: a response must match exactly one outstanding integer id; a wrong id, a string id and a duplicate are E_PROTOCOL', async () => {
    for (const scenario of ['wrongid', 'stringid', 'dupresp']) {
      const code = await withFixture({ MCP_SCENARIO: scenario }, async (c) => { await c.handshake(); return errCode(c.callTool('echo', { text: 'x' }, 5000).then(() => settle()).then(() => { if (c.fatal) throw c.fatal; })); });
      expect(code, scenario).toBe('E_PROTOCOL');
    }
  });
  it('d: result must be a plain object; an error response without a numeric code, or a message without jsonrpc 2.0, is E_PROTOCOL', async () => {
    for (const bad of [{ jsonrpc: '2.0', result: [] }, { jsonrpc: '2.0', result: null }, { jsonrpc: '2.0', result: 'x' }, { jsonrpc: '2.0' }, { jsonrpc: '1.0', result: {} }, { result: {} }, { jsonrpc: '2.0', result: {}, error: { code: 1, message: 'x' } }, { jsonrpc: '2.0', error: 'x' }, { jsonrpc: '2.0', error: { code: 'x' } }]) {
      const f = fed();
      const p = errCode(f.c.request('x', {}, 5000));
      f.out.write(`${JSON.stringify({ ...bad, id: 1 })}\n`);
      expect(await p, JSON.stringify(bad)).toBe('E_PROTOCOL');
    }
  });
  it('a JSON-RPC error response to a request is E_PROTOCOL and its text is never kept', async () => {
    const e = await withFixture({ MCP_SCENARIO: 'rpcerror' }, async (c) => { await c.handshake(); try { await c.callTool('echo', {}, 5000); } catch (x) { return x as McpError; } return null; });
    expect(e!.code).toBe('E_PROTOCOL');
    expect(e!.message).toBe('E_PROTOCOL');
    expect(JSON.stringify(e)).not.toContain('server text');
  });
  it('e: nesting is capped at 32 before JSON.parse: 200k nested arrays in a 1 MiB line give E_PROTOCOL, never a RangeError; the depth check is string-aware', async () => {
    expect(await withFixture({ MCP_SCENARIO: 'deep' }, async (c) => { await c.handshake(); return errCode(c.callTool('echo', {}, 5000)); })).toBe('E_PROTOCOL');
    const f = fed();
    const p = f.c.request('x', {}, 5000);
    f.out.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { s: '[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[', t: '"\\"[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[' } })}\n`);
    await expect(p).resolves.toMatchObject({ s: expect.any(String) });
  });
  it('a process that exits before the response is E_EXIT', async () => {
    expect(await withFixture({ MCP_SCENARIO: 'exitcall' }, async (c) => { await c.handshake(); return errCode(c.callTool('echo', {}, 5000)); })).toBe('E_EXIT');
    const f = fed();
    const p = errCode(f.c.request('x', {}, 5000));
    f.exit({ code: 1, spawnFailed: false });
    expect(await p).toBe('E_EXIT');
  });
  it('a request that gets no answer is E_TIMEOUT at its deadline and the failure is fatal', async () => {
    const e = await withFixture({ MCP_SCENARIO: 'hang' }, async (c) => { await c.handshake(); const code = await errCode(c.callTool('echo', {}, 150)); return [code, c.fatal?.code]; });
    expect(e).toEqual(['E_TIMEOUT', 'E_TIMEOUT']);
  });
  it('after a fatal error every further request fails at once with the same error and nothing more is written', async () => {
    const f = fed();
    const p = errCode(f.c.request('x', {}, 5000));
    f.out.write('not json\n');
    expect(await p).toBe('E_PROTOCOL');
    const n = f.written.length;
    expect(await errCode(f.c.request('y', {}, 5000))).toBe('E_PROTOCOL');
    expect(f.written.length).toBe(n);
  });
  it('writes only the lines it means to: one JSON object per line, ids from a safe-integer counter', async () => {
    const f = fed();
    void errCode(f.c.request('a', { k: 1 }, 100));
    void errCode(f.c.request('b', {}, 100));
    f.c.notify('notifications/initialized');
    expect(f.written.map((w) => JSON.parse(w))).toEqual([{ jsonrpc: '2.0', id: 1, method: 'a', params: { k: 1 } }, { jsonrpc: '2.0', id: 2, method: 'b', params: {} }, { jsonrpc: '2.0', method: 'notifications/initialized' }]);
    expect(f.written.every((w) => w.endsWith('\n') && w.indexOf('\n') === w.length - 1)).toBe(true);
  });
});

describe('MC-C11 g: a CPU bench of 4 MiB of adversarial stdout through the full path', () => {
  it('one 1 MiB line, and a no-separator repeat, are refused in well under a second', async () => {
    const t0 = Date.now();
    const f = fed();
    const p = errCode(f.c.request('x', {}, 5000));
    f.out.write(Buffer.alloc(RPC_LIMITS.line + 1, 0x7b)); // `{` x 1 MiB: the deepest nesting a line can have
    expect(await p).toBe('E_TOO_BIG');
    const g = fed();
    const q = errCode(g.c.request('x', {}, 5000));
    const chunk = Buffer.alloc(65536, 0x61);
    for (let i = 0; i < 64; i++) g.out.write(chunk); // 4 MiB with no newline
    expect(await q).toBe('E_TOO_BIG');
    const h = fed();
    const r = errCode(h.c.request('x', {}, 5000));
    h.out.write(Buffer.concat([Buffer.alloc(1_000_000, 0x5b), Buffer.from('\n')])); // 1 MB of `[` then a newline: caught by the depth scan
    expect(await r).toBe('E_PROTOCOL');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('a stream of 1 MB lines of valid JSON hits the 4 MiB total on the fifth and stays quick', async () => {
    const f = fed();
    const p = errCode(f.c.request('x', {}, 5000));
    const line = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'n', params: { s: 'a'.repeat(1_000_000) } })}\n`);
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) f.out.write(line);
    expect(await p).toBe('E_TOO_BIG');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

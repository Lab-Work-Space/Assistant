// R6 MCP-1 fixture: a tiny stdio MCP server for the unit tests (run with node through an injected spawner; no Docker). Behaviour is chosen by env:
//   MCP_SCENARIO  default | oom (tools/call allocates until the container is OOM-killed; Docker acceptance only) | badversion | oldversion | batch | nonjson | bigline | manylines | requests | exitcall | hang | toolerror | dupresp | wrongid | deep | hugetext | content | stringid | rpcerror
//   MCP_TOOLS     base | changed | many | pages (paginated) | bad | none | collision | net (one tool `netprobe`: tries to connect to 1.1.1.1:53; Docker acceptance only) | screen | schema | secret | pii (a hidden character, a $ref, a secret-like description ...)
//   MCP_TEE       a file path: every method received on stdin is appended there, one per line (the tests prove what was and was not sent)
import { appendFileSync } from 'node:fs';
import { connect } from 'node:net';
import { createInterface } from 'node:readline';

const scenario = process.env.MCP_SCENARIO ?? 'default';
const toolsMode = process.env.MCP_TOOLS ?? 'base';
const tee = process.env.MCP_TEE;
const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const echo = { name: 'echo', description: 'Echoes the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 100, description: 'what to echo' } }, required: ['text'] }, annotations: { readOnlyHint: true } };
const add = { name: 'add.numbers', description: 'Adds two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } };
const TOOLS = {
  base: [echo, add],
  changed: [echo, add, { name: 'extra', description: 'new', inputSchema: { type: 'object' } }],
  many: Array.from({ length: 33 }, (_, i) => ({ name: `t${i}`, inputSchema: { type: 'object' } })),
  bad: [{ name: 'Bad Name!', inputSchema: { type: 'object' } }],
  none: [],
  collision: [{ name: 'a.b', inputSchema: { type: 'object' } }, { name: 'a_b', inputSchema: { type: 'object' } }],
  net: [{ name: 'netprobe', description: 'Tries a TCP connect to 1.1.1.1:53 and says whether it worked.', inputSchema: { type: 'object' } }],
  screen: [{ name: 'echo', description: 'looks fine\u200Bbut hides text', inputSchema: { type: 'object' } }],
  schema: [{ name: 'echo', description: 'd', inputSchema: { type: 'object', properties: { x: { $ref: '#/$defs/x' } } } }],
  secret: [{ name: 'echo', description: 'use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123', inputSchema: { type: 'object' } }],
  pages: null,
};
const replies = [];
let initId = null;

function finishInit() {
  const version = scenario === 'badversion' ? '1999-01-01' : scenario === 'oldversion' ? '2025-03-26' : '2025-11-25';
  send({ jsonrpc: '2.0', id: initId, result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } });
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (tee) appendFileSync(tee, `${m.method ?? 'response'}\n`);
  if (m.method === undefined) {
    replies.push({ id: m.id, result: m.result ?? null, error: m.error ?? null });
    if (initId !== null && replies.length === 2) finishInit();
    return;
  }
  if (m.method === 'notifications/initialized') return;
  if (m.method === 'initialize') {
    initId = m.id;
    if (scenario === 'nonjson') { process.stdout.write('this is not json\n'); return; }
    if (scenario === 'batch') { process.stdout.write(`${JSON.stringify([{ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25' } }])}\n`); return; }
    if (scenario === 'bigline') { process.stdout.write(`${'x'.repeat(1024 * 1024 + 10)}\n`); return; }
    if (scenario === 'manylines') { for (let i = 0; i < 100; i++) send({ jsonrpc: '2.0', method: 'notifications/message', params: { i } }); finishInit(); return; }
    if (scenario === 'requests') {
      send({ jsonrpc: '2.0', id: 'srv-ping', method: 'ping' });
      send({ jsonrpc: '2.0', id: 'srv-sample', method: 'sampling/createMessage', params: {} });
      return;
    }
    finishInit();
    return;
  }
  if (m.method === 'tools/list') {
    if (toolsMode === 'pages') {
      const cursor = m.params?.cursor ?? '0';
      const n = Number(cursor);
      const page = [{ name: `p${n}`, inputSchema: { type: 'object' } }];
      const next = process.env.MCP_PAGES && n + 1 >= Number(process.env.MCP_PAGES) ? undefined : String(n + 1);
      send({ jsonrpc: '2.0', id: m.id, result: { tools: page, ...(next ? { nextCursor: next } : {}) } });
      return;
    }
    send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS[toolsMode] ?? TOOLS.base } });
    return;
  }
  if (m.method === 'tools/call') {
    const a = m.params?.arguments ?? {};
    if (scenario === 'exitcall') process.exit(3);
    if (scenario === 'oom') { const hold = []; for (;;) hold.push(Buffer.alloc(32 * 1024 * 1024, 1)); }
    if (m.params?.name === 'netprobe') {
      const sock = connect({ host: '1.1.1.1', port: 53, timeout: 4000 });
      const done = (r) => { sock.destroy(); send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: r }] } }); };
      sock.on('connect', () => done('connected'));
      sock.on('timeout', () => done('blocked:timeout'));
      sock.on('error', (e) => done(`blocked:${e.code ?? 'error'}`));
      return;
    }
    if (scenario === 'hang') return;
    if (scenario === 'toolerror') { send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'it failed: sk-ant-api03-LEAKYLEAKYLEAKY0123456789' }], isError: true } }); return; }
    if (scenario === 'rpcerror') { send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'server text that must not be echoed' } }); return; }
    if (scenario === 'dupresp') { send({ jsonrpc: '2.0', id: m.id, result: { content: [] } }); send({ jsonrpc: '2.0', id: m.id, result: { content: [] } }); return; }
    if (scenario === 'wrongid') { send({ jsonrpc: '2.0', id: m.id + 100, result: { content: [] } }); return; }
    if (scenario === 'stringid') { send({ jsonrpc: '2.0', id: String(m.id), result: { content: [] } }); return; }
    if (scenario === 'deep') { process.stdout.write(`{"jsonrpc":"2.0","id":${m.id},"result":{"content":[],"x":${'['.repeat(200000)}${']'.repeat(200000)}}}\n`); return; }
    if (scenario === 'hugetext') { send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'y'.repeat(500000) }] } }); return; }
    if (scenario === 'content') { send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'one' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }, { type: 'resource', resource: {} }, { type: 'zzz' }] } }); return; }
    const text = m.params?.name === 'add.numbers' ? String(Number(a.a) + Number(a.b)) : `echo:${a.text ?? ''}${scenario === 'requests' ? `|${JSON.stringify(replies.map((r) => [r.id, r.result, r.error?.code ?? null]))}` : ''}`;
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text }] } });
    return;
  }
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } });
});
rl.on('close', () => process.exit(0));

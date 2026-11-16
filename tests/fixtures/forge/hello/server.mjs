// stdio MCP server: newline-delimited JSON-RPC 2.0 (initialize, tools/list, tools/call). Runs as uid 65534 with no network and a read-only disk.
import { createInterface } from 'node:readline';
import { TOOLS, call } from './src/tools.mjs';

const send = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const rl = createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method === undefined || m.method === 'notifications/initialized') return;
  if (m.method === 'initialize') {
    send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'hello', version: '1.0.0' } } });
    return;
  }
  if (m.method === 'tools/list') { send({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } }); return; }
  if (m.method === 'tools/call') {
    const text = await call(m.params?.name, m.params?.arguments);
    if (text === null) { send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'unknown tool' } }); return; }
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text }] } });
    return;
  }
  send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } });
});
rl.on('close', () => process.exit(0));

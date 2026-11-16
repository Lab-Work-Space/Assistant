// R7 reference plugin (tests/fixtures/forge/hello): plain JS on Node built-ins, no dependencies. Derived from tests/fixtures/mcp/echo-server.mjs. `netprobe` (BE3) tries a TCP connect to 1.1.1.1:53 so the Docker acceptance test can prove the sandbox has no network.
import { connect } from 'node:net';

export const TOOLS = [
  { name: 'echo', description: 'Echoes the text back.', inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 100, description: 'what to echo' } }, required: ['text'] } },
  { name: 'add_numbers', description: 'Adds two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
  { name: 'netprobe', description: 'Tries a TCP connect to 1.1.1.1:53 and says whether it worked.', inputSchema: { type: 'object' } },
];

/** TCP connect to 1.1.1.1:53: resolves `connected` or `blocked:<code>`; never rejects. */
function netprobe() {
  return new Promise((resolve) => {
    const sock = connect({ host: '1.1.1.1', port: 53, timeout: 4000 });
    const done = (r) => { sock.destroy(); resolve(r); };
    sock.on('connect', () => done('connected'));
    sock.on('timeout', () => done('blocked:timeout'));
    sock.on('error', (e) => done(`blocked:${e.code ?? 'error'}`));
  });
}

export async function call(name, args) {
  if (name === 'echo') return `echo:${String(args?.text ?? '')}`;
  if (name === 'netprobe') return netprobe();
  if (name === 'add_numbers') return String(Number(args?.a) + Number(args?.b));
  return null;
}

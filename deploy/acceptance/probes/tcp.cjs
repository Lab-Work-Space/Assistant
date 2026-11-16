// TCP connect test. Args: <host> <port>. Prints open / closed:<code>; exit 0 when open, 1 otherwise (2 s timeout).
const net = require('net');
const [host, port] = process.argv.slice(1);
const s = net.connect({ host, port: Number(port), timeout: 2000 });
s.on('connect', () => { console.log(`${host}:${port} open`); s.destroy(); process.exit(0); });
s.on('timeout', () => { console.log(`${host}:${port} closed:ETIMEDOUT`); s.destroy(); process.exit(1); });
s.on('error', (e) => { console.log(`${host}:${port} closed:${e.code || e.message}`); process.exit(1); });

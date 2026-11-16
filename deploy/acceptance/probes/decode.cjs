// POST stdin to /v1/decode over MEDIA_SOCKET (stdin = an audio file). Prints status=<code> bytes=<n> [body=<json>].
const http = require('http');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const audio = Buffer.concat(chunks);
  const req = http.request({ socketPath: process.env.MEDIA_SOCKET, path: '/v1/decode', method: 'POST', timeout: 30000,
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': audio.length } }, (r) => {
    let n = 0; let b = '';
    r.on('data', (c) => { n += c.length; if (r.statusCode !== 200 && b.length < 1024) b += c.toString('utf8'); });
    r.on('end', () => { console.log(`in=${audio.length} status=${r.statusCode} bytes=${n}${b ? ` body=${b}` : ''}`); process.exit(0); });
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', (e) => { console.log(`error=${e.code || e.message}`); process.exit(1); });
  req.end(audio);
});

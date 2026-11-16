// GET /v1/health over MEDIA_SOCKET (run inside a container: node -e "$(cat health.cjs)"). Prints status=<code> body=<json>.
const http = require('http');
const req = http.get({ socketPath: process.env.MEDIA_SOCKET, path: '/v1/health', timeout: 5000 }, (r) => {
  let b = '';
  r.setEncoding('utf8');
  r.on('data', (c) => { if (b.length < 2048) b += c; });
  r.on('end', () => { console.log(`status=${r.statusCode} body=${b}`); process.exit(r.statusCode === 200 ? 0 : 1); });
});
req.on('timeout', () => req.destroy(new Error('timeout')));
req.on('error', (e) => { console.log(`error=${e.code || e.message}`); process.exit(1); });

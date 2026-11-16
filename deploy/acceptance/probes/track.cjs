// POST /v1/track over MEDIA_SOCKET. Args: <query> <allowlist host> <holdMs>. On 200 it reads up to 1 MiB of PCM, then pauses;
// holdMs after the reply it closes the request (the sidecar must then kill both child groups) and prints
// status=200 bytes=<n> closed_at=<epoch ms> (ended_at=... if the track ended first).
// On any other status it prints status=<code> body=<json>.
const http = require('http');
const [query, host, holdArg] = process.argv.slice(1);
const hold = Number(holdArg || 10000);
const body = JSON.stringify({ v: 1, query, allowlist: [host], capSeconds: 1200, capBytes: 52428800 });
const req = http.request({ socketPath: process.env.MEDIA_SOCKET, path: '/v1/track', method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (r) => {
  let n = 0; let b = '';
  const done = (how) => { console.log(`status=${r.statusCode} bytes=${n} ${how}=${Date.now()}${b ? ` body=${b}` : ''}`); process.exit(0); };
  r.on('data', (c) => {
    n += c.length;
    if (r.statusCode !== 200 && b.length < 1024) b += c.toString('utf8');
    // 200: stop reading once PCM flows (n >= 1 MiB), so backpressure keeps yt-dlp and ffmpeg alive (a player reads at playback
    // pace; this probe would otherwise drain a whole track in seconds) until the close below.
    if (r.statusCode === 200 && n >= 1048576) r.pause();
  });
  r.on('end', () => done('ended_at'));
  if (r.statusCode === 200) setTimeout(() => { req.destroy(); done('closed_at'); }, hold);
});
req.on('error', (e) => { console.log(`error=${e.code || e.message}`); process.exit(1); });
req.end(body);

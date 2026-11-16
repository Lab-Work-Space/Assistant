// TEST ONLY: a hostile origin at 10.89.78.10 (served as redir.test): redirects to private targets, a page that probes private targets,
// and the three C27 hostile pages (endless body, many subrequests, infinite script loop).
import http from 'node:http';

const REDIRECTS = {
  '/to-meta': 'http://169.254.169.254/latest/meta-data/', '/to-loop': 'http://127.0.0.1:9223/healthz', '/to-priv-https': 'https://10.0.0.1/',
  '/to-v6': 'http://[::1]/', '/to-zero': 'http://0.0.0.0/', '/to-short': 'http://127.1/',
};
const PROBE = `<html><body><h1>origin ok</h1><iframe src="http://127.0.0.1:9223/healthz"></iframe><script>
  const out = [];
  fetch('http://redir.test/hang').catch(() => {}); // keeps the network busy so the reader waits for the probes below
  const fin = () => document.body.append(document.createTextNode('PROBE-DONE ' + out.join(' | ')));
  const f = (u) => fetch(u, { mode: 'no-cors' }).then(() => out.push('answered'), () => out.push('failed'));
  const worker = new Promise((ok) => {
    try {
      const w = new Worker(URL.createObjectURL(new Blob(["fetch('http://127.0.0.1:9223/w', { mode: 'no-cors' }).then(() => postMessage('answered'), () => postMessage('failed'))"])));
      w.onmessage = () => { out.push('worker done'); ok(); }; w.onerror = () => { out.push('worker error'); ok(); };
      setTimeout(ok, 3000);
    } catch { out.push('worker threw'); ok(); }
  });
  // WebRTC towards a private STUN server: UDP cannot leave Chrome's network (no route) and non-proxied UDP is disabled by policy
  const rtc = new Promise((ok) => {
    try { const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:10.0.0.1:3478' }] }); pc.createDataChannel('x'); pc.onicecandidate = (e) => { if (e.candidate) out.push('candidate ' + e.candidate.candidate.split(' ')[4]); };
      pc.createOffer().then((o) => pc.setLocalDescription(o)); setTimeout(() => { pc.close(); ok(); }, 2500); } catch { out.push('rtc threw'); ok(); }
  });
  Promise.all([f('http://127.0.0.1:9223/healthz'), f('http://169.254.169.254/'), f('http://redir.test/ok-sub'), worker, rtc]).then(() => {
    try { const w = new WebSocket('ws://127.0.0.1:9223/x'); w.onopen = () => { out.push('ws open'); fin(); }; w.onerror = () => { out.push('ws failed'); fin(); }; } catch { out.push('ws threw'); fin(); }
  });
</script></body></html>`;

http.createServer((q, r) => {
  if (REDIRECTS[q.url]) return void r.writeHead(302, { location: REDIRECTS[q.url] }).end();
  if (q.url === '/endless') {
    r.writeHead(200, { 'content-type': 'text/html' });
    const chunk = '<p>' + 'x'.repeat(60_000) + '</p>';
    const pump = () => { while (!r.destroyed && r.write(chunk)); if (!r.destroyed) r.once('drain', pump); };
    return pump();
  }
  if (q.url === '/many') return void r.writeHead(200, { 'content-type': 'text/html' }).end('<html><body><script>for (let i = 0; i < 10000; i++) fetch("http://redir.test/ok-sub?i=" + i).catch(() => {});</script></body></html>');
  if (q.url === '/loop') return void r.writeHead(200, { 'content-type': 'text/html' }).end('<html><body><script>for (;;) {}</script></body></html>');
  if (q.url === '/hang') return void setTimeout(() => r.writeHead(200).end('late'), 6000);
  if (q.url === '/probe') return void r.writeHead(200, { 'content-type': 'text/html' }).end(PROBE);
  r.writeHead(200, { 'content-type': 'text/html' }).end('<html><body><h1>origin ok</h1></body></html>');
}).listen(80, '0.0.0.0');

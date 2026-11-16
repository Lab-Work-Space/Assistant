// Runs INSIDE a container started with the launcher's hardening baseline (docker/devjob/probe.sh). Prints one line per probe: "PASS|FAIL <name> <detail>".
// MODE=agent: network probes from the agent network (X2) and model-proxy gating (X1). MODE=prep: registry proxy gating (X3). MODE=test: no network.
const net = require('node:net'), dns = require('node:dns'), dgram = require('node:dgram'), http = require('node:http'), fs = require('node:fs');
const out = (ok, name, d = '') => console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${d}`);
const tcp = (host, port, ms = 3000) => new Promise((res) => { const s = net.connect({ host, port, timeout: ms }); s.on('connect', () => { s.destroy(); res('connected'); }); s.on('timeout', () => { s.destroy(); res('timeout'); }); s.on('error', (e) => res(e.code || 'error')); });
const mustFail = async (name, host, port) => { const r = await tcp(host, port); out(r !== 'connected', `no-route ${name}`, r); };
const req = (host, port, o = {}) => new Promise((res) => { const r = http.request({ host, port, method: o.method || 'POST', path: o.path || '/v1/messages', headers: { 'content-type': 'application/json', ...(o.headers || {}) }, timeout: 8000 }, (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res({ status: x.statusCode, body: b })); }); r.on('error', (e) => res({ status: 0, body: e.code || 'error' })); r.on('timeout', () => { r.destroy(); res({ status: 0, body: 'timeout' }); }); r.end(o.body); });
(async () => {
  const mode = process.env.MODE;
  out(process.getuid() === 65534, 'runs as 65534', String(process.getuid()));
  let w = 'writable'; try { fs.writeFileSync('/probe-root', 'x'); } catch { w = 'read-only'; }
  out(w === 'read-only', 'root filesystem read-only', w);
  const cap = (fs.readFileSync('/proc/self/status', 'utf8').match(/CapEff:\s+(\w+)/) || [])[1];
  out(/^0+$/.test(cap || ''), 'no capabilities', cap);
  out(!fs.existsSync('/var/run/docker.sock'), 'no docker socket');
  const secrets = Object.keys(process.env).filter((k) => /KEY|TOKEN|SECRET|PASSWORD/i.test(k) && k !== 'ANTHROPIC_API_KEY');
  out(secrets.length === 0, 'no secret-like env besides the job credential', secrets.join(','));
  if (mode === 'test') {
    await mustFail('public ip 1.1.1.1:443', '1.1.1.1', 443);
    await new Promise((r) => dns.lookup('example.com', (e) => { out(!!e, 'no external DNS (network none)', e ? e.code : 'resolved'); r(); }));
    return;
  }
  if (mode === 'agent') {
    const base = process.env.ANTHROPIC_BASE_URL.replace('http://', '').split(':');
    await new Promise((r) => dns.lookup('example.com', (e) => { out(!!e, 'no external DNS via the resolver', e ? e.code : 'resolved'); r(); }));
    await new Promise((r) => { const s = dgram.createSocket('udp4'); const q = Buffer.from('000001000001000000000000076578616d706c6503636f6d0000010001', 'hex'); const t = setTimeout(() => { s.close(); out(true, 'no DNS to 1.1.1.1:53', 'timeout'); r(); }, 3000); s.on('message', () => { clearTimeout(t); s.close(); out(false, 'no DNS to 1.1.1.1:53', 'ANSWERED'); r(); }); s.on('error', (e) => { clearTimeout(t); out(true, 'no DNS to 1.1.1.1:53', e.code); r(); }); s.send(q, 53, '1.1.1.1'); });
    await mustFail('public ip 1.1.1.1:443', '1.1.1.1', 443);
    await mustFail('public ip 8.8.8.8:443', '8.8.8.8', 443);
    await mustFail('host.docker.internal:80', 'host.docker.internal', 80);
    await mustFail('metadata 169.254.169.254:80', '169.254.169.254', 80);
    await mustFail('IPv6 2606:4700:4700::1111:443', '2606:4700:4700::1111', 443);
    await mustFail('chrome guard proxy 10.88.77.2:3128', '10.88.77.2', 3128);
    await mustFail('chrome CDP 127.0.0.1:9222', '127.0.0.1', 9222);
    await mustFail('chrome control 127.0.0.1:9223', '127.0.0.1', 9223);
    await mustFail('registry proxy 10.88.79.2:4873', '10.88.79.2', 4873);
    await mustFail('proxy upstream (fakeup:9000)', 'fakeup', 9000);
    const cred = process.env.ANTHROPIC_API_KEY, host = base[0], port = Number(base[1]);
    const ok = JSON.stringify({ model: 'claude-test', max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] });
    let r = await req(host, port, { body: ok, headers: { 'x-api-key': cred } });
    out(r.status === 200, 'model proxy: job credential works', String(r.status));
    out(!r.body.includes('REALKEY'), 'model proxy: the real key is never echoed');
    r = await req(host, port, { body: ok, headers: { 'x-api-key': 'sk-ant-attacker' } }); out(r.status === 401, 'model proxy: foreign key refused', String(r.status));
    r = await req(host, port, { body: ok, headers: { 'x-api-key': cred + 'x' } }); out(r.status === 401, 'model proxy: wrong credential refused', String(r.status));
    r = await req(host, port, { path: '/v1/files', body: ok, headers: { 'x-api-key': cred } }); out(r.status === 404, 'model proxy: Files API refused', String(r.status));
    r = await req(host, port, { body: JSON.stringify({ model: 'claude-test', max_tokens: 50, messages: [], tools: [{ type: 'web_search_20250305', name: 'web_search' }] }), headers: { 'x-api-key': cred } }); out(r.status === 400, 'model proxy: server tool refused', String(r.status));
    r = await req(host, port, { body: JSON.stringify({ model: 'claude-test', max_tokens: 50, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'url', url: 'https://evil.example/a.pdf' } }] }] }), headers: { 'x-api-key': cred } }); out(r.status === 400, 'model proxy: URL source refused', String(r.status));
    r = await req(host, port, { path: '/jobs', body: '{}', headers: { authorization: 'Bearer x'.padEnd(40, 'x') } }).then(() => req(host, 8788, { path: '/jobs', body: '{}', headers: { authorization: `Bearer ${'t'.repeat(40)}` } })); out(r.status !== 200 && r.status !== 400, 'model proxy: control API unreachable or refused from the agent network', String(r.status));
    return;
  }
  if (mode === 'prep') {
    const reg = process.env.NPM_REGISTRY.replace('http://', '').split(':');
    await mustFail('public ip 1.1.1.1:443', '1.1.1.1', 443);
    await mustFail('model proxy 10.88.78.2:8080', '10.88.78.2', 8080);
    let r = await req(reg[0], Number(reg[1]), { method: 'PUT', path: '/left-pad', body: '{}' }); out(r.status === 405, 'registry proxy: publish (PUT) refused', String(r.status));
    r = await req(reg[0], Number(reg[1]), { method: 'POST', path: '/-/npm/v1/security/advisories/bulk', body: '{}' }); out(r.status === 405, 'registry proxy: POST refused', String(r.status));
    r = await req(reg[0], Number(reg[1]), { method: 'GET', path: '/-/whoami' }); out(r.status === 404, 'registry proxy: whoami refused', String(r.status));
    r = await req(reg[0], Number(reg[1]), { method: 'GET', path: '/left-pad' }); out(r.status === 200 && r.body.includes('left-pad'), 'registry proxy: GET of a package document passes (fake upstream)', String(r.status));
  }
})();

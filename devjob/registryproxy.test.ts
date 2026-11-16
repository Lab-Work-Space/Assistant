import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { allowLoopbackForTest } from '../vitest.setup.no-network.js';
import { createRegistryProxy, pathAllowed } from './registryproxy.js';

beforeAll(allowLoopbackForTest);
const servers: Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); }))); });

async function rig() {
  const seen: { method: string; path: string; headers: Record<string, string> }[] = [];
  const h = createRegistryProxy({ upstream: async (r) => (seen.push(r), { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'x' }, body: (async function* () { yield Buffer.from('{"ok":1}'); })() }) });
  const s = createServer(h);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, seen };
}

describe('X3 registry proxy', () => {
  it('passes GET and HEAD of package documents and tarballs only', async () => {
    const x = await rig();
    for (const p of ['/left-pad', '/@types%2Fnode', '/@types/node', '/left-pad/-/left-pad-1.3.0.tgz', '/@types/node/-/node-22.1.0.tgz']) {
      expect((await fetch(`${x.url}${p}`)).status, p).toBe(200);
    }
    expect((await fetch(`${x.url}/left-pad`, { method: 'HEAD' })).status).toBe(200);
    expect(x.seen).toHaveLength(6);
  });
  it('refuses publish (PUT), POST (advisories, login), DELETE, PATCH and every other endpoint, and never forwards them', async () => {
    const x = await rig();
    for (const m of ['PUT', 'POST', 'DELETE', 'PATCH']) expect((await fetch(`${x.url}/left-pad`, { method: m, body: '{}' })).status, m).toBe(405);
    for (const p of ['/-/npm/v1/security/advisories/bulk', '/-/user/org.couchdb.user:me', '/-/whoami', '/-/v1/search?text=x', '/left-pad?write=true', '/', '//evil.example/x', '/a/b/c/d', '/left-pad/dist-tags/latest']) {
      expect([404, 405], p).toContain((await fetch(`${x.url}${p}`)).status);
    }
    expect(x.seen).toHaveLength(0);
  });
  it('drops auth and cookie headers and the upstream cookies', async () => {
    const x = await rig();
    const r = await fetch(`${x.url}/left-pad`, { headers: { authorization: 'Bearer npm_attacker', cookie: 'a=b', 'npm-otp': '123456' } });
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(Object.keys(x.seen[0]!.headers)).toEqual(['accept']);
  });
  it('pathAllowed', () => {
    expect(pathAllowed('/a-b.c_d')).toBe(true);
    expect(pathAllowed('/a/../b')).toBe(false);
    expect(pathAllowed('/%2e%2e/etc')).toBe(false);
    expect(pathAllowed('/A')).toBe(false); // upper case names are not on the registry any more
    expect(pathAllowed('/x'.repeat(400))).toBe(false);
  });
});

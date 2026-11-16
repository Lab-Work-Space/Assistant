import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allowLoopbackForTest, allowUnixSocketForTest } from '../vitest.setup.no-network.js';

describe('no-network opt-in', () => {
  it('allowLoopbackForTest lets loopback through but never an external host (and tests/no-network.test.ts, a separate file, still sees both blocked)', async () => {
    allowLoopbackForTest();
    await expect(fetch('https://example.com/')).rejects.toThrow(/no-network/);
    expect(() => net.connect({ host: 'example.com', port: 443 })).toThrow(/no-network/);
    const server = net.createServer((s) => s.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    const body = await new Promise<string>((resolve, reject) => {
      const c = net.connect({ host: '127.0.0.1', port });
      let d = '';
      c.on('data', (b) => (d += b)).on('end', () => resolve(d)).on('error', reject);
    });
    server.close();
    expect(body).toBe('ok');
  });
});

describe('no-network unix socket opt-in', () => {
  const listen = (server: net.Server, path: string) => new Promise<void>((r) => server.listen(path, r));
  const talk = (path: string) => new Promise<string>((resolve, reject) => {
    const c = net.connect({ path });
    let d = '';
    c.on('data', (b) => (d += b)).on('end', () => resolve(d)).on('error', reject);
  });

  it('a unix socket under the allowed dir connects; one outside it and TCP 10.0.0.1 still throw', async () => {
    const allowedDir = mkdtempSync(join(tmpdir(), 'nn-allowed-'));
    const otherDir = mkdtempSync(join(tmpdir(), 'nn-other-'));
    const inside = join(allowedDir, 'a.sock');
    const outside = join(otherDir, 'b.sock');
    const s1 = net.createServer((s) => s.end('in'));
    const s2 = net.createServer((s) => s.end('out'));
    try {
      await listen(s1, inside);
      await listen(s2, outside);
      expect(() => net.connect({ path: inside })).toThrow(/no-network/); // blocked until a test opts in
      allowUnixSocketForTest(allowedDir);
      expect(await talk(inside)).toBe('in');
      expect(() => net.connect({ path: outside })).toThrow(/no-network/);
      expect(() => net.connect({ host: '10.0.0.1', port: 80 })).toThrow(/no-network/);
      allowLoopbackForTest();
      expect(() => net.connect({ path: outside })).toThrow(/no-network/); // loopback opt-in does not open unix sockets
    } finally {
      s1.close();
      s2.close();
      rmSync(allowedDir, { recursive: true, force: true });
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('refuses a ..-escape, a symlinked dir and a symlinked socket that point outside the allowed dir', async () => {
    const allowedDir = mkdtempSync(join(tmpdir(), 'nn-allowed-'));
    const otherDir = mkdtempSync(join(tmpdir(), 'nn-other-'));
    const outside = join(otherDir, 'b.sock');
    const s2 = net.createServer((s) => s.end('out'));
    try {
      await listen(s2, outside);
      symlinkSync(otherDir, join(allowedDir, 'dirlink'));
      symlinkSync(outside, join(allowedDir, 'socklink'));
      allowUnixSocketForTest(allowedDir);
      expect(() => net.connect({ path: join(allowedDir, '..', basename(otherDir), 'b.sock') })).toThrow(/no-network/);
      expect(() => net.connect({ path: join(allowedDir, 'dirlink', 'b.sock') })).toThrow(/no-network/);
      expect(() => net.connect({ path: join(allowedDir, 'socklink') })).toThrow(/no-network/);
      expect(() => net.connect({ path: 'relative.sock' })).toThrow(/no-network/);
    } finally {
      s2.close();
      rmSync(allowedDir, { recursive: true, force: true });
      rmSync(otherDir, { recursive: true, force: true });
    }
  });

  it('refuses a sibling dir that shares the allowed dir name as a prefix', async () => {
    const base = mkdtempSync(join(tmpdir(), 'nn-pfx-'));
    const allowedDir = join(base, 'abc');
    const sibling = join(base, 'abcd');
    mkdirSync(allowedDir);
    mkdirSync(sibling);
    const s = net.createServer((c) => c.end('x'));
    try {
      await listen(s, join(sibling, 'c.sock'));
      allowUnixSocketForTest(allowedDir);
      expect(() => net.connect({ path: join(sibling, 'c.sock') })).toThrow(/no-network/);
    } finally {
      s.close();
      rmSync(base, { recursive: true, force: true });
    }
  });
});

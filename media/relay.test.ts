import { chmodSync, lstatSync, type Stats, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { allowLoopbackForTest, allowUnixSocketForTest } from '../vitest.setup.no-network.js';
import { createContainerRelay, envViolations, runContainerRelay, socketPathOk } from './relay-container.js';
import { createHostRelay, HostRelayRefusal, prepareHostSocket } from './relay-host.js';
import type { RelayLog } from './relay-core.js';

/** Gate 1 LM1, LM3-LM5, LM7, LM8, LM10: in-process servers on loopback and temp unix sockets, no Docker. */
const TOKEN = 'a1'.repeat(24);
const dirs: string[] = [];
const closers: Array<() => void> = [];
const mk = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'lm-'));
  dirs.push(d);
  return d;
};
beforeAll(() => allowLoopbackForTest());
afterEach(() => {
  while (closers.length) closers.pop()!();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const logs: string[] = [];
const log: RelayLog = (level, f, msg) => void logs.push(JSON.stringify({ level, msg, ...f }));
afterEach(() => {
  // LM10: neither relay ever writes the token, or a received line, to its log
  expect(logs.join('\n')).not.toContain(TOKEN);
  logs.length = 0;
});

/** A fake sidecar: a unix echo server that prefixes replies with "echo:". Returns its dir and socket path. */
async function sidecar(): Promise<{ dir: string; sock: string; received: Buffer[] }> {
  const dir = mk();
  allowUnixSocketForTest(dir);
  const sock = join(dir, 'media.sock');
  const received: Buffer[] = [];
  const srv = net.createServer((c) => {
    c.on('data', (d: Buffer) => {
      received.push(d);
      c.write(Buffer.concat([Buffer.from('echo:'), d]));
    });
    c.on('error', () => undefined);
  });
  await new Promise<void>((r) => srv.listen(sock, r));
  closers.push(() => srv.close());
  return { dir, sock, received };
}
const listenTcp = (s: net.Server): Promise<number> =>
  new Promise((r) => {
    s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port));
    closers.push(() => s.close());
  });
const connect = (port: number): Promise<net.Socket> =>
  new Promise((r) => {
    const c = net.connect(port, '127.0.0.1', () => r(c));
    c.on('error', () => undefined);
    closers.push(() => c.destroy());
  });
const readAll = (c: net.Socket, ms = 300): Promise<{ data: Buffer; closed: boolean }> =>
  new Promise((r) => {
    const chunks: Buffer[] = [];
    let closed = false;
    c.on('data', (d: Buffer) => chunks.push(d));
    c.on('close', () => (closed = true));
    setTimeout(() => r({ data: Buffer.concat(chunks), closed }), ms);
  });
const line = (t: string): string => `LWMEDIA1 ${t}\n`;

async function startContainer(over: Partial<Parameters<typeof createContainerRelay>[0]> = {}) {
  const sc = await sidecar();
  const server = createContainerRelay({ token: TOKEN, socketPath: sc.sock, prefix: sc.dir + '/', log, ...over });
  const port = await listenTcp(server);
  return { sc, server, port };
}

describe('container relay', () => {
  it('right token: bytes after the token line in the same chunk and later bytes are piped both ways', async () => {
    const { port, sc } = await startContainer();
    const c = await connect(port);
    c.write(line(TOKEN) + 'hello');
    await new Promise((r) => setTimeout(r, 100));
    c.write('more');
    const { data } = await readAll(c);
    expect(sc.received.map(String).join('')).toBe('hellomore');
    expect(data.toString()).toContain('echo:hello');
    expect(data.toString()).not.toContain('LWMEDIA1');
  });

  it('wrong token: closed with no reply and nothing reaches the sidecar', async () => {
    const { port, sc } = await startContainer();
    const c = await connect(port);
    c.write(line('b'.repeat(48)) + 'secret-payload');
    const r = await readAll(c);
    expect(r.closed).toBe(true);
    expect(r.data.length).toBe(0);
    expect(sc.received).toEqual([]);
  });

  it('LM10: a token of equal length that differs in one byte is refused', async () => {
    const { port, sc } = await startContainer();
    const c = await connect(port);
    c.write(line(TOKEN.slice(0, -1) + (TOKEN.endsWith('1') ? '2' : '1')) + 'x');
    const r = await readAll(c);
    expect(r.closed).toBe(true);
    expect(sc.received).toEqual([]);
  });

  it('LM4: CR, a missing or doubled space and a lowercase prefix are refused', async () => {
    const { port, sc } = await startContainer();
    for (const bad of [`LWMEDIA1 ${TOKEN}\r\n`, `LWMEDIA1  ${TOKEN}\n`, `lwmedia1 ${TOKEN}\n`, `LWMEDIA1${TOKEN}\n`, `LWMEDIA1 ${TOKEN} \n`]) {
      const c = await connect(port);
      c.write(bad + 'x');
      expect((await readAll(c, 100)).closed, JSON.stringify(bad)).toBe(true);
    }
    expect(sc.received).toEqual([]);
  });

  it('LM4: no newline within the auth window closes the connection', async () => {
    const { port } = await startContainer({ authMs: 150 });
    const c = await connect(port);
    c.write('LWMEDIA1 ');
    expect((await readAll(c, 500)).closed).toBe(true);
  });

  it('LM4: a line longer than 128 bytes (with or without a newline) closes the connection', async () => {
    const { port, sc } = await startContainer();
    const a = await connect(port);
    a.write('x'.repeat(129));
    expect((await readAll(a, 150)).closed).toBe(true);
    const b = await connect(port);
    b.write('x'.repeat(200) + '\n');
    expect((await readAll(b, 150)).closed).toBe(true);
    expect(sc.received).toEqual([]);
  });

  it('LM4: the unix socket is not touched before the token matches (missing socket + wrong token, then right token closes cleanly)', async () => {
    const dir = mk();
    const server = createContainerRelay({ token: TOKEN, socketPath: join(dir, 'none.sock'), prefix: dir + '/', log });
    const port = await listenTcp(server);
    const c = await connect(port);
    c.write(line(TOKEN));
    expect((await readAll(c, 200)).closed).toBe(true);
    expect(logs.join()).toContain('no-socket');
  });

  it('LM5: pre-auth sockets count toward the cap; connection 17 is destroyed at once', async () => {
    const { port } = await startContainer({ authMs: 5000 });
    const held: net.Socket[] = [];
    for (let i = 0; i < 16; i++) held.push(await connect(port)); // none has sent a byte: all pre-auth
    const extra = await connect(port);
    expect((await readAll(extra, 300)).closed).toBe(true);
    // a held one is still pre-auth and still usable
    held[0]!.write(line(TOKEN) + 'ping');
    expect((await readAll(held[0]!, 300)).data.toString()).toContain('echo:ping');
  });

  it('LM5: idle connections are closed, and closing the client closes the sidecar side', async () => {
    const { port } = await startContainer({ idleMs: 150 });
    const c = await connect(port);
    c.write(line(TOKEN) + 'a');
    expect((await readAll(c, 600)).closed).toBe(true);
  });

  it('LM7: socket path must be absolute, normalised and under the prefix; a non-socket target is refused', async () => {
    expect(socketPathOk('/run/media-ipc/media.sock')).toBe(true);
    for (const p of ['media.sock', '/tmp/x.sock', '/run/media-ipc/../x', '/run/media-ipc/', '/run/media-ipc//a', '/run/media-ipc-evil/x']) expect(socketPathOk(p), p).toBe(false);
    const dir = mk();
    const f = join(dir, 'file');
    writeFileSync(f, 'x');
    const server = createContainerRelay({ token: TOKEN, socketPath: f, prefix: dir + '/', log });
    const port = await listenTcp(server);
    const c = await connect(port);
    c.write(line(TOKEN));
    expect((await readAll(c, 200)).closed).toBe(true);
    const lnk = join(dir, 'link.sock');
    const sc = await sidecar();
    symlinkSync(sc.sock, lnk);
    const s2 = createContainerRelay({ token: TOKEN, socketPath: lnk, prefix: dir + '/', log });
    const p2 = await listenTcp(s2);
    const c2 = await connect(p2);
    c2.write(line(TOKEN));
    expect((await readAll(c2, 200)).closed).toBe(true); // a symlink is not followed (lstat)
  });
});

describe('container relay entry (LM1)', () => {
  const exitFn = (codes: number[]) => ((c: number) => void codes.push(c)) as unknown as (c: number) => never;
  it('exits 78 on an extra env key, logs the key name and never the values', () => {
    const codes: number[] = [];
    const env = { PATH: '/bin', MEDIA_RELAY_TOKEN: TOKEN, MEDIA_SOCKET: '/run/media-ipc/media.sock', DATABASE_URL: 'postgres://secret-value' } as NodeJS.ProcessEnv;
    expect(runContainerRelay({ env, exit: exitFn(codes), log })).toBeNull();
    expect(codes).toEqual([78]);
    expect(logs.join()).toContain('DATABASE_URL');
    expect(logs.join()).not.toContain('secret-value');
    expect(envViolations({ MEDIA_RELAY_TOKEN: 'x', MEDIA_SOCKET: 'y', NODE_ENV: 'z', 'BAD KEY': '1' })).toEqual(['BAD?KEY']);
  });
  it('exits 78 on a malformed token or a socket path outside media-ipc, without echoing them', () => {
    for (const env of [
      { MEDIA_RELAY_TOKEN: 'short-secret', MEDIA_SOCKET: '/run/media-ipc/media.sock' },
      { MEDIA_RELAY_TOKEN: TOKEN.toUpperCase(), MEDIA_SOCKET: '/run/media-ipc/media.sock' },
      { MEDIA_RELAY_TOKEN: TOKEN, MEDIA_SOCKET: '/tmp/evil.sock' },
      { MEDIA_SOCKET: '/run/media-ipc/media.sock' },
    ] as NodeJS.ProcessEnv[]) {
      const codes: number[] = [];
      runContainerRelay({ env, exit: exitFn(codes), log });
      expect(codes).toEqual([78]);
    }
    expect(logs.join()).not.toContain('short-secret');
  });
  it('deletes the token from the env object after reading it', async () => {
    const dir = mk();
    const env = { MEDIA_RELAY_TOKEN: TOKEN, MEDIA_SOCKET: join(dir, 'm.sock') } as NodeJS.ProcessEnv;
    const server = runContainerRelay({ env, exit: exitFn([]), port: 0, host: '127.0.0.1', prefix: dir + '/', log });
    expect(server).not.toBeNull();
    closers.push(() => server!.close());
    expect(env.MEDIA_RELAY_TOKEN).toBeUndefined();
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
  });
});

describe('host relay', () => {
  const home = (): { parent: string; dir: string; sock: string } => {
    const parent = mk();
    chmodSync(parent, 0o700);
    const dir = join(parent, 'media');
    return { parent, dir, sock: join(dir, 'media.sock') };
  };

  it('creates the directory 0700 and the socket 0600, and forwards with the token line first', async () => {
    const received: Buffer[] = [];
    const up = net.createServer((c) => {
      c.on('data', (d: Buffer) => {
        received.push(d);
        c.write('ok');
      });
      c.on('error', () => undefined);
    });
    const port = await listenTcp(up);
    const h = home();
    allowUnixSocketForTest(h.parent);
    const srv = await createHostRelay({ token: TOKEN, ...h, port, log });
    closers.push(() => srv.close());
    expect(lstatSync(h.dir).mode & 0o777).toBe(0o700);
    const st = lstatSync(h.sock);
    expect(st.isSocket()).toBe(true);
    expect(st.mode & 0o777).toBe(0o600);
    const c = net.connect(h.sock);
    closers.push(() => c.destroy());
    await new Promise((r) => c.once('connect', r));
    c.write('GET /v1/health');
    const { data } = await readAll(c);
    expect(data.toString()).toBe('ok');
    expect(Buffer.concat(received).toString().startsWith(line(TOKEN))).toBe(true);
    expect(Buffer.concat(received).toString()).toBe(line(TOKEN) + 'GET /v1/health');
  });

  it('LM5: the host relay caps connections at 16 as well', async () => {
    const port = await listenTcp(net.createServer((c) => c.on('error', () => undefined)));
    const h = home();
    allowUnixSocketForTest(h.parent);
    const srv = await createHostRelay({ token: TOKEN, ...h, port, log });
    closers.push(() => srv.close());
    expect(srv.maxConnections).toBe(16);
    const cs: net.Socket[] = [];
    for (let i = 0; i < 17; i++) {
      const c = net.connect(h.sock);
      c.on('error', () => undefined);
      closers.push(() => c.destroy());
      cs.push(c);
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(cs.filter((c) => c.destroyed).length).toBe(1);
  });

  it('refuses a symlinked media directory', () => {
    const h = home();
    const real = mk();
    symlinkSync(real, h.dir);
    expect(() => prepareHostSocket(h.dir, h.sock)).toThrow(HostRelayRefusal);
  });

  it('refuses a media directory that is not exactly 0700 (0750, 0755)', () => {
    for (const m of [0o750, 0o755, 0o770]) {
      const h = home();
      mkdirSync(h.dir, { mode: 0o700 });
      chmodSync(h.dir, m);
      expect(() => prepareHostSocket(h.dir, h.sock), m.toString(8)).toThrow(HostRelayRefusal);
    }
  });

  it('LM10: refuses a world-writable (and a group-writable) parent directory', () => {
    for (const m of [0o777, 0o770, 0o722]) {
      const h = home();
      chmodSync(h.parent, m);
      expect(() => prepareHostSocket(h.dir, h.sock), m.toString(8)).toThrow(HostRelayRefusal);
    }
  });

  it('refuses a foreign-owned directory (euid mismatch)', () => {
    const h = home();
    mkdirSync(h.dir, { mode: 0o700 });
    expect(() => prepareHostSocket(h.dir, h.sock, { euid: (process.geteuid?.() ?? 0) + 1 })).toThrow(HostRelayRefusal);
  });

  it('LM10: refuses a socket path owned by another user, a regular file and a symlink; unlinks only our own stale socket', async () => {
    const h = home();
    mkdirSync(h.dir, { mode: 0o700 });
    allowUnixSocketForTest(h.parent);
    const stale = net.createServer();
    await new Promise<void>((r) => stale.listen(h.sock, r));
    // keep the socket file but stop listening: node unlinks on close, so recreate it afterwards via a raw second server
    const other = (p: string): Stats => ({ uid: (process.geteuid?.() ?? 0) + 1, isSocket: () => true, isSymbolicLink: () => false, isDirectory: () => false, mode: lstatSync(p).mode }) as unknown as Stats;
    expect(() => prepareHostSocket(h.dir, h.sock, { lstat: (p) => (p === h.sock ? other(p) : (lstatSync(p) as Stats)) })).toThrow(HostRelayRefusal);
    // our own socket: allowed, and unlinked
    prepareHostSocket(h.dir, h.sock);
    expect(() => lstatSync(h.sock)).toThrow();
    stale.close();
    writeFileSync(h.sock, 'x');
    expect(() => prepareHostSocket(h.dir, h.sock)).toThrow(HostRelayRefusal);
    rmSync(h.sock);
    symlinkSync('/etc/hosts', h.sock);
    expect(() => prepareHostSocket(h.dir, h.sock)).toThrow(HostRelayRefusal);
  });

  it('refuses a bad token and a socket outside the media directory', async () => {
    const h = home();
    await expect(createHostRelay({ token: 'nope', ...h, log })).rejects.toThrow();
    expect(() => prepareHostSocket(h.dir, join(h.parent, 'elsewhere.sock'))).toThrow(HostRelayRefusal);
  });
});

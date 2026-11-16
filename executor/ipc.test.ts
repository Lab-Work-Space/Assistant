import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createConnection, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { allowUnixSocketForTest } from '../vitest.setup.no-network.js';
import { ExecutorClient } from '../admin/executor-port.js';
import { ipcCall, startIpcServer, type IpcRequest } from './ipc.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
/** A short path on purpose: macOS limits a Unix socket path to 104 bytes. */
function sockDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'lw-'));
  chmodSync(d, 0o700);
  dirs.push(d);
  allowUnixSocketForTest(d);
  return d;
}
async function serve(handler: (r: IpcRequest) => Promise<unknown>) {
  const dir = sockDir();
  const path = join(dir, 'e.sock');
  servers.push(await startIpcServer(path, handler));
  return path;
}
const raw = (path: string, text: string) => new Promise<string>((resolve) => {
  const s = createConnection(path);
  let buf = '';
  s.setEncoding('utf8');
  s.on('connect', () => s.write(text));
  s.on('data', (c: string) => (buf += c));
  s.on('close', () => resolve(buf));
  s.on('error', () => resolve(buf));
});
const ID = 'a'.repeat(32);

describe('executor IPC (S2)', () => {
  it('the socket is mode 0600 in a 0700 directory and a stale socket file is replaced', async () => {
    const path = await serve(async () => ({ ok: true }));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700);
    await new Promise<void>((r) => servers.pop()!.close(() => r()));
    writeFileSync(join(path, '..', 'other'), 'x');
    servers.push(await startIpcServer(path, async () => ({ ok: true }))); // the old socket file was left behind by the close: it is removed, not an error
    expect(await ipcCall(path, { op: 'status' })).toEqual({ ok: true });
  });
  it('refuses a directory that is not private, a symlinked directory and a non-socket at the path', async () => {
    const open = mkdtempSync(join(tmpdir(), 'lw-'));
    dirs.push(open);
    chmodSync(open, 0o755);
    await expect(startIpcServer(join(open, 'e.sock'), async () => ({}))).rejects.toThrow(/mode 0700/);
    const real = sockDir();
    const link = join(tmpdir(), `lw-link-${process.pid}`);
    symlinkSync(real, link);
    dirs.push(link);
    await expect(startIpcServer(join(link, 'e.sock'), async () => ({}))).rejects.toThrow(/real directory/);
    const d = sockDir();
    writeFileSync(join(d, 'e.sock'), 'not a socket');
    await expect(startIpcServer(join(d, 'e.sock'), async () => ({}))).rejects.toThrow(/not a socket/);
  });
  it('only the five known requests are accepted, strictly: unknown ops, extra keys, a bad card id and garbage get a fixed error and never reach the handler', async () => {
    const seen: IpcRequest[] = [];
    const path = await serve(async (r) => (seen.push(r), { ok: true }));
    for (const bad of [{ op: 'eval' }, { op: 'apply', cardId: 'nope' }, { op: 'apply', cardId: ID, extra: 1 }, { op: 'status', x: 1 }, { op: 'propose', family: 'config', ops: [], userId: '1', namedIds: [] }, { op: 'read', kind: 'env' }]) {
      expect(JSON.parse(await raw(path, `${JSON.stringify(bad)}\n`)), JSON.stringify(bad)).toEqual({ ok: false, error: 'invalid request' });
    }
    expect(JSON.parse(await raw(path, 'not json\n'))).toEqual({ ok: false, error: 'not JSON' });
    expect(seen).toEqual([]);
    expect(await ipcCall(path, { op: 'apply', cardId: ID })).toEqual({ ok: true });
    expect(seen).toEqual([{ op: 'apply', cardId: ID }]); // the ONLY thing an apply carries is a card id
  });
  it('an oversized request is refused; a throwing handler gives a generic error (no text leaks)', async () => {
    const path = await serve(async () => { throw new Error('secret detail'); });
    expect(JSON.parse(await raw(path, `${'x'.repeat(600 * 1024)}`))).toEqual({ ok: false, error: 'request too large' });
    const answer = await ipcCall(path, { op: 'status' });
    expect(answer).toEqual({ ok: false, error: 'internal error' });
  });
  it('a missing socket is "not running", not a crash', async () => {
    await expect(ipcCall(join(sockDir(), 'none.sock'), { op: 'status' })).rejects.toThrow(/not running/);
  });
  it('the call rejects when the executor does not answer in time', async () => {
    const path = await serve(() => new Promise(() => undefined));
    await expect(ipcCall(path, { op: 'status' }, 100)).rejects.toThrow(/in time/);
  });
  it('the socket file is gone after close is not required, but a second start over a live socket path works', async () => {
    const path = await serve(async () => ({ ok: true }));
    expect(existsSync(path)).toBe(true);
  });
});

describe('ExecutorClient (the main application\'s side)', () => {
  const mk = (answers: Record<string, unknown>, o: { recheck?: () => Promise<{ dept: string; warnings: string[] }[]>; alerts?: unknown[] } = {}) => {
    const sent: IpcRequest[] = [];
    const client = new ExecutorClient({
      socketPath: '/x', log: { error() {} }, ...(o.recheck ? { recheck: o.recheck } : {}), alert: async (d, w) => void o.alerts?.push([d, w]),
      call: async (_p, req) => { sent.push(req); const a = answers[req.op]; if (a instanceof Error) throw a; return a; },
    });
    return { client, sent };
  };
  it('readiness: ready, not ready (the reason) and unreachable', async () => {
    expect(await mk({ status: { ok: true, ready: null, userId: '1' } }).client.readiness()).toBeNull();
    expect(await mk({ status: { ok: true, ready: 'the executor is turned off: x', userId: null } }).client.readiness()).toContain('turned off');
    expect(await mk({ status: new Error('x') }).client.readiness()).toContain('not running');
  });
  it('propose forwards the family, ops, proposer and the ids the admin named; an executor refusal is passed on', async () => {
    const ok = mk({ propose: { ok: true, payload: { ops: [] }, snapshot: { snaps: [] }, items: [{ label: 'a', old: 'b', neu: 'c' }] } });
    expect(await ok.client.port('server').propose([{ kind: 'x' }], { userId: '900000000000000001', namedIds: ['900000000000000002'] })).toMatchObject({ ok: true });
    expect(ok.sent[0]).toEqual({ op: 'propose', family: 'server', ops: [{ kind: 'x' }], userId: '900000000000000001', namedIds: ['900000000000000002'] });
    expect(await mk({ propose: { ok: false, error: 'operation 1 refused: x' } }).client.port('perm').propose([], { userId: '1', namedIds: [] })).toEqual({ ok: false, error: 'operation 1 refused: x' });
    expect(await mk({ propose: new Error('x') }).client.port('perm').propose([], { userId: '1', namedIds: [] })).toMatchObject({ ok: false, error: expect.stringContaining('not running') });
  });
  it('apply sends only the card id, then re-checks the bots of THIS process (C21) and reports a disabled one', async () => {
    const alerts: unknown[] = [];
    const m = mk({ apply: { ok: true, result: { kind: 'done', ok: true, lines: ['done: x'], applied: 1, total: 1 } } }, { recheck: async () => [{ dept: 'software', warnings: ['software: bot has guild-wide Ban Members'] }], alerts });
    const r = await m.client.port('server').apply({ ops: [] }, {}, { userId: '1', cardId: ID, via: 'panel' });
    expect(m.sent).toEqual([{ op: 'apply', cardId: ID }]);
    expect(r).toMatchObject({ kind: 'done', ok: true });
    if (r.kind === 'done') expect(r.lines.join('\n')).toContain('software bot was turned off');
    expect(alerts).toHaveLength(1);
  });
  it('apply: an executor refusal, an unreachable executor and garbage all refuse (nothing is applied by this process)', async () => {
    expect(await mk({ apply: { ok: true, result: { kind: 'refused', why: 'nope' } } }).client.port('perm').apply(null, null, { userId: '1', cardId: ID })).toEqual({ kind: 'refused', why: 'nope' });
    expect(await mk({ apply: new Error('x') }).client.port('perm').apply(null, null, { userId: '1', cardId: ID })).toMatchObject({ kind: 'refused', why: expect.stringContaining('not running') });
    expect(await mk({ apply: { weird: 1 } }).client.port('perm').apply(null, null, { userId: '1', cardId: ID })).toMatchObject({ kind: 'unknown' });
  });
  it('G2SM-07: a timeout is "unknown", not refused; an unreachable executor and a garbage answer are handled apart', async () => {
    const slow = mk({ apply: new Error('the executor did not answer in time') });
    expect(await slow.client.port('server').apply(null, null, { userId: '1', cardId: ID })).toMatchObject({ kind: 'unknown' });
    expect(await mk({ apply: new Error('the executor is not running') }).client.port('server').apply(null, null, { userId: '1', cardId: ID })).toMatchObject({ kind: 'refused' });
    expect(await mk({ apply: { weird: 1 } }).client.port('server').apply(null, null, { userId: '1', cardId: ID })).toMatchObject({ kind: 'unknown' });
  });
  it('read and checkWelcome pass the executor\'s answer through; the filters travel as typed fields', async () => {
    const m = mk({ read: { ok: true, text: '[]' }, check_welcome: { ok: false, error: 'default role 1: bad' } });
    expect(await m.client.port('server').read('members', { roleId: '900000000000000009' })).toEqual({ ok: true, text: '[]' });
    expect(m.sent[0]).toEqual({ op: 'read', kind: 'members', roleId: '900000000000000009' });
    expect(await m.client.checkWelcome(['1'], null)).toBe('default role 1: bad');
  });
});

describe('shared socket for the launchd executor (OD-1)', () => {
  const shared = async (mode: number) => {
    const dir = sockDir();
    chmodSync(dir, mode);
    const path = join(dir, 'e.sock');
    const s = await startIpcServer(path, async () => ({ ok: true }), undefined, { shared: true });
    servers.push(s);
    return path;
  };
  it('a 0750 directory gives a 0660 socket and still answers', async () => {
    const path = await shared(0o750);
    expect(statSync(path).mode & 0o777).toBe(0o660);
    expect(await ipcCall(path, { op: 'status' })).toEqual({ ok: true });
  });
  it.each([0o755, 0o770, 0o757, 0o500])('refuses a directory with mode %o', async (m) => {
    await expect(shared(m)).rejects.toThrow(/shared socket directory/);
  });
  it('the private mode is unchanged for the dev executor (a 0750 directory is refused there)', async () => {
    const dir = sockDir();
    chmodSync(dir, 0o750);
    await expect(startIpcServer(join(dir, 'e.sock'), async () => ({ ok: true }))).rejects.toThrow(/mode 0700/);
  });
  it('deploy_read is a closed schema: unknown keys, a bad user id and lines over 200 are refused', async () => {
    const path = await serve(async () => ({ ok: true, text: 'x' }));
    const send = async (o: unknown) => JSON.parse(await raw(path, `${JSON.stringify(o)}\n`)) as { ok: boolean; error?: string };
    expect((await send({ op: 'deploy_read', userId: '900000000000000001', read: { kind: 'status' } })).ok).toBe(true);
    expect((await send({ op: 'deploy_read', userId: '900000000000000001', read: { kind: 'logs', app: 'apps/x', lines: 201 } })).error).toBe('invalid request');
    expect((await send({ op: 'deploy_read', userId: 'x', read: { kind: 'status' } })).error).toBe('invalid request');
    expect((await send({ op: 'deploy_read', userId: '900000000000000001', read: { kind: 'exec' } })).error).toBe('invalid request');
    expect((await send({ op: 'deploy_read', userId: '900000000000000001', read: { kind: 'status', cmd: 'id' } })).error).toBe('invalid request');
    expect((await send({ op: 'propose', family: 'deploy', ops: [{}], userId: '900000000000000001', namedIds: [] })).ok).toBe(true);
  });
});

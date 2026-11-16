import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keyProblem, sshArgs, VPS, VpsClient, type SshRun } from './ssh.js';

const HOSTKEY = `[${VPS.host}]:${VPS.port} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'A'.repeat(43)}\n`;
function setup(o: { hosts?: string; mode?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vps-'));
  const key = join(dir, 'id_ed25519');
  writeFileSync(key, 'k');
  chmodSync(key, o.mode ?? 0o600);
  writeFileSync(join(dir, 'known_hosts'), o.hosts ?? HOSTKEY);
  chmodSync(join(dir, 'known_hosts'), 0o600);
  return { dir, key };
}

describe('ssh options (V4)', () => {
  it('pins host, port, algorithms and refuses every widening option', () => {
    const a = sshArgs('/k/id', '/k/known_hosts').join(' ');
    for (const s of ['StrictHostKeyChecking=yes', 'UserKnownHostsFile=/k/known_hosts', 'GlobalKnownHostsFile=/dev/null', 'IdentitiesOnly=yes', 'IdentityAgent=none', 'BatchMode=yes', 'ControlMaster=no', 'ProxyCommand=none', '-F /dev/null', '-p 2223', 'assistantdeploy@72.60.196.53 request', 'HostKeyAlgorithms=ssh-ed25519', 'ClearAllForwardings=yes']) expect(a).toContain(s);
  });
});

describe('key file (V22)', () => {
  it('accepts a 0600 regular file with a pinned host key', () => expect(keyProblem(setup().key)).toBeNull());
  it('refuses a loose mode', () => expect(keyProblem(setup({ mode: 0o640 }).key)).toMatch(/mode 0600/));
  it('refuses a symlink', () => {
    const s = setup();
    const link = join(s.dir, 'link');
    symlinkSync(s.key, link);
    expect(keyProblem(link)).toMatch(/not a regular file/);
  });
  it('refuses another owner', () => expect(keyProblem(setup().key, { uid: 0 })).toMatch(/not owned/));
  it('refuses a key in the assistant config dir and a relative path', () => {
    expect(keyProblem('/Users/me/.config/assistant/id')).toMatch(/config directory/);
    expect(keyProblem('id_ed25519')).toMatch(/absolute/);
    expect(keyProblem('/a/../b')).toMatch(/absolute/);
  });
  it('requires exactly one pinned host line for the constants', () => {
    expect(keyProblem(setup({ hosts: `${HOSTKEY}${HOSTKEY}` }).key)).toMatch(/exactly/);
    expect(keyProblem(setup({ hosts: HOSTKEY.replace(String(VPS.port), '22') }).key)).toMatch(/exactly/);
    expect(keyProblem(setup({ hosts: '' }).key)).toMatch(/exactly/);
  });
});

describe('VpsClient', () => {
  const ok: SshRun = async (_a, input) => ({ code: 0, out: `OK {"echo":${JSON.stringify(input.toString().length)}}\n` });
  it('sends the line then the stream and parses the reply', async () => {
    let seen: Buffer | null = null;
    const c = new VpsClient({ keyPath: '/x', keyCheck: () => null, run: async (_a, i) => { seen = i; return { code: 0, out: 'OK {"queued":"J-0123456789abcdef"}\n' }; } });
    expect(await c.call('{"op":"x"}\n', Buffer.from('TAR'))).toEqual({ ok: true, data: { queued: 'J-0123456789abcdef' } });
    expect(seen!.toString()).toBe('{"op":"x"}\nTAR');
  });
  it('a bad key means no ssh at all', async () => {
    let called = false;
    const c = new VpsClient({ keyPath: '/x', keyCheck: () => 'bad', run: async () => { called = true; return { code: 0, out: '' }; } });
    expect(await c.call('{}\n')).toEqual({ ok: false, code: 'KEY' });
    expect(called).toBe(false);
  });
  it('maps timeouts, unreachable hosts and server errors', async () => {
    const mk = (r: { code: number | null; out: string }) => new VpsClient({ keyPath: '/x', keyCheck: () => null, run: async () => r });
    expect(await mk({ code: null, out: '' }).call('x\n')).toEqual({ ok: false, code: 'TIMEOUT' });
    expect(await mk({ code: 255, out: '' }).call('x\n')).toEqual({ ok: false, code: 'UNREACHABLE' });
    expect(await mk({ code: 1, out: 'ERR TAR\n' }).call('x\n')).toEqual({ ok: false, code: 'TAR' });
    expect(await mk({ code: 0, out: 'garbage\n' }).call('x\n')).toEqual({ ok: false, code: 'BAD_REPLY' });
    expect((await new VpsClient({ keyPath: '/x', keyCheck: () => null, run: ok }).call('abc\n')).ok).toBe(true);
  });
});

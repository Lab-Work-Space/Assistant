import { describe, expect, it } from 'vitest';
import { parseCommand } from './command.js';
import { buildArgv, formatOutput, OUTPUT_CHARS, runContainer, TailRing } from './runner.js';
import { FakeDocker } from './test-helpers.js';

const IMAGE = `sha256:${'a'.repeat(64)}`;
const base = { name: 'ws-demo-0123abcd', slug: 'demo', uid: 501, gid: 20, wsReal: '/Users/x/.config/assistant/workspaces', image: IMAGE };

// The full, fixed list (SA-1 5.3 plus Gate 1 WS-C1: --pull=never, --log-driver=none, --ulimit core=0). A deep-equality test: an extra flag fails it (WS-C3).
const head = (net: string): string[] => [
  'run', '--init', '--pull=never', '--log-driver=none', '--ulimit', 'core=0',
  '--name', 'ws-demo-0123abcd', '--label', 'ws=1', '--label', 'ws.slug=demo',
  '--user', '501:20', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
  '--pids-limit', '256', '--memory', '2g', '--memory-swap', '2g', '--cpus', '2',
  '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=512m', '--tmpfs', '/home/ws:rw,noexec,nosuid,nodev,size=512m',
  '--network', net,
  '--mount', 'type=bind,src=/Users/x/.config/assistant/workspaces/demo,dst=/work',
  '-w', '/work', '-e', 'HOME=/home/ws', '-e', 'CI=1', '-e', 'NO_UPDATE_NOTIFIER=1', '-e', 'npm_config_update_notifier=false',
  IMAGE,
];
const INSTALL = ['--ignore-scripts', '--no-audit', '--no-fund', '--registry', 'http://10.88.80.2:4873', '--userconfig', '/dev/null', '--globalconfig', '/nonexistent/npmrc', '--replace-registry-host=always'];

describe('buildArgv: deep equality per verb (WS-C3)', () => {
  const cases: [string, string, string[]][] = [
    ['npm ci', 'ws_prepnet', ['/usr/local/bin/npm', 'ci', ...INSTALL]],
    ['npm install a@1.0.0 @s/b@2.0.0-rc.1', 'ws_prepnet', ['/usr/local/bin/npm', 'install', ...INSTALL, 'a@1.0.0', '@s/b@2.0.0-rc.1']],
    ['npm test', 'none', ['/usr/local/bin/npm', 'test']],
    ['npm run build', 'none', ['/usr/local/bin/npm', 'run', 'build']],
    ['npx tsc', 'none', ['/usr/local/bin/node', '/work/node_modules/typescript/bin/tsc']],
    ['npx tsc --noEmit', 'none', ['/usr/local/bin/node', '/work/node_modules/typescript/bin/tsc', '--noEmit']],
    ['node src/x.mjs', 'none', ['/usr/local/bin/node', '/work/src/x.mjs']],
  ];
  it.each(cases)('%s', (cmd, net, tail) => {
    expect(buildArgv({ ...base, parsed: parseCommand(cmd) })).toEqual([...head(net), ...tail]);
  });

  it('cannot emit a forbidden flag, a second mount, a socket mount or an env name without a value', () => {
    for (const [cmd] of cases) {
      const a = buildArgv({ ...base, parsed: parseCommand(cmd) });
      const bad = ['-v', '--volume', '--volumes-from', '--privileged', '--cap-add', '--device', '--env-file', '--pid', '--ipc', '--userns', '--uts', '--rm'];
      for (const f of bad) expect(a, f).not.toContain(f);
      expect(a.filter((x) => x === '--mount')).toHaveLength(1);
      expect(a.filter((x) => x === '--security-opt' || x.startsWith('--security-opt='))).toEqual(['--security-opt=no-new-privileges']);
      expect(a.join(' ')).not.toContain('docker.sock');
      expect(a).not.toContain('host');
      expect(a).not.toContain('--add-host');
      a.forEach((x, i) => { if (a[i - 1] === '-e') expect(x).toMatch(/^[A-Za-z_]+=/); });
      expect(a[a.indexOf('--network') + 1]).toMatch(/^(none|ws_prepnet)$/);
    }
  });

  it('refuses a bad name, slug, image, root, or uid 0', () => {
    const p = parseCommand('npm test');
    expect(() => buildArgv({ ...base, parsed: p, uid: 0 })).toThrow();
    expect(() => buildArgv({ ...base, parsed: p, image: 'node:24' })).toThrow();
    expect(() => buildArgv({ ...base, parsed: p, wsReal: '/a,b' })).toThrow();
    expect(() => buildArgv({ ...base, parsed: p, wsReal: '/a b' })).toThrow();
    expect(() => buildArgv({ ...base, parsed: p, slug: 'other' })).toThrow();
    expect(() => buildArgv({ ...base, parsed: p, name: 'ws-demo-x' })).toThrow();
  });
});

describe('TailRing and formatOutput', () => {
  it('keeps the last 64 KiB and flags the overflow', () => {
    const r = new TailRing(10);
    r.push(Buffer.from('abcdef'));
    r.push(Buffer.from('ghijkl'));
    expect(r.bytes().toString()).toBe('cdefghijkl');
    expect(r.overflowed).toBe(true);
    r.push(Buffer.from('X'.repeat(25)));
    expect(r.bytes().toString()).toBe('X'.repeat(10));
  });
  it('strips ANSI and C0 (not \\n or \\t), redacts, then cuts to 8000 characters', () => {
    const out = formatOutput(Buffer.from('\u001b[31mred\u001b[0m\u0007 ok\r\n\ttab\u0000x\u001b]0;title\u0007end'), false, []);
    expect(out).toBe('red ok\n\ttabxend');
    const long = formatOutput(Buffer.from('a'.repeat(9000) + 'END'), false, []);
    expect(long).toHaveLength(OUTPUT_CHARS);
    expect(long.endsWith('END')).toBe(true);
  });
  it('a secret that straddles the 8000-character cut does not leak (redact before cutting)', () => {
    const secret = 'S3CR3T-LITERAL-VALUE-XYZ';
    const text = 'a'.repeat(1000) + secret + 'b'.repeat(7990);
    const out = formatOutput(Buffer.from(text), false, [secret]);
    expect(out).not.toContain('S3CR3T');
    expect(out).not.toContain('LITERAL');
    expect(out.length).toBeLessThanOrEqual(OUTPUT_CHARS);
    // The cut lands inside the secret in the raw text: cut-then-redact would have left a fragment.
    const cutFirst = text.slice(-8000);
    expect(cutFirst).toContain('VALUE-XYZ');
  });
  it('a secret cut by the 64 KiB ring (overflow) leaves no fragment', () => {
    const secret = 'LONG-SECRET-LITERAL-0123456789';
    const r = new TailRing(64 * 1024);
    r.push(Buffer.from(`${'x'.repeat(10)}${secret}\n`));
    r.push(Buffer.from('y'.repeat(64 * 1024 - 15)));
    // ring starts in the middle of the secret
    const tail = r.bytes();
    expect(tail.toString().startsWith('x')).toBe(false);
    const out = formatOutput(tail, r.overflowed, [secret]);
    expect(out).not.toMatch(/RAL-0123|0123456789|LITERAL/);
  });
});

describe('runContainer', () => {
  const run = (d: FakeDocker, o: Partial<Parameters<typeof runContainer>[1]> = {}) => runContainer(d, { argv: ['run', '--name', 'ws-demo-0123abcd'], name: 'ws-demo-0123abcd', isHalted: () => false, haltPollMs: 5, ...o });
  it('removes the container and verifies it is gone', async () => {
    const d = new FakeDocker();
    d.plan = [{ out: 'hello', exit: 3, code: 3 }];
    const r = await run(d);
    expect(r.info).toEqual({ oom: false, exit: 3, started: true });
    expect(r.removed).toBe(true);
    expect(d.containers.size).toBe(0);
    expect(d.execs.some((e) => e[0] === 'rm' && e[1] === '-f')).toBe(true);
  });
  it('a timeout runs rm -f, ends the client, and the container is gone', async () => {
    const d = new FakeDocker();
    d.plan = [{ hang: true }];
    const r = await run(d, { timeoutMs: 30 });
    expect(r.timedOut).toBe(true);
    expect(d.containers.size).toBe(0);
    expect(r.removed).toBe(true);
  });
  it('kills the client after the grace when rm -f does not end it', async () => {
    const d = new FakeDocker();
    d.plan = [{ hang: true }];
    d.neverRemove = true;
    const r = await run(d, { timeoutMs: 20, clientGraceMs: 20 });
    expect(r.timedOut).toBe(true);
    expect(d.killed).toBe(1);
    expect(r.removed).toBe(false); // verify failed: the caller reports E_STUCK
  });
  it('a halt flag set while it runs removes the container', async () => {
    const d = new FakeDocker();
    d.plan = [{ hang: true }];
    let halted = false;
    setTimeout(() => (halted = true), 30);
    const r = await run(d, { isHalted: () => halted });
    expect(r.stopped).toBe(true);
    expect(d.containers.size).toBe(0);
  });
  it('already halted: nothing is started', async () => {
    const d = new FakeDocker();
    const r = await run(d, { isHalted: () => true });
    expect(r.stopped).toBe(true);
    expect(d.runs).toHaveLength(0);
  });
});

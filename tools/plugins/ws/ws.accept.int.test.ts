import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { seededOrg } from '../../../agents/test-helpers.js';
import type { ActorRef } from '../../../company/types.js';
import { migrate } from '../../../db/migrate.js';
import { WorkspaceRepo } from '../../../db/repos/workspaces.js';
import { freshDb, type TestDb } from '../../../db/test-helpers.js';
import { FakeConfig } from '../../../governance/test-helpers.js';
import { WS_TEXT } from '../../../workspaces/errors.js';
import { acquireDockerTestLock, releaseDockerTestLock } from '../../../workspaces/docker-test-lock.js';
import { ProjectFiles } from '../../../workspaces/files.js';
import { SlugLock } from '../../../workspaces/lock.js';
import { PROXY_CONTAINER, realDockerCli } from '../../../workspaces/runner.js';
import { WsService } from '../../../workspaces/service.js';
import type { PluginDeps } from '../deps.js';
import { webRig } from '../web/test-helpers.js';
import { wsGroup } from './index.js';

/**
 * WS-T1/T2 acceptance, tool level: a fake model (a scripted list of tool calls) acts as the software head through the REAL ws tool group, the
 * REAL WsService/runner/Docker daemon/ws registry proxy and the real WorkspaceRepo on the test Postgres. It builds a minimal MV3 extension with a
 * unit test and a TypeScript module, installs pinned packages through the proxy, runs npm test and tsc, and exports a zip.
 * Negative cases: other department, container-planted symlink, disallowed commands, halt.
 */
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const sh = (args: string[]): string | null => {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
};
let runner: string | null = null;
try {
  runner = (JSON.parse(readFileSync(join(ROOT_DIR, 'docker/ws/images.json'), 'utf8')) as { runner: string }).runner;
} catch { /* none */ }
const ready = runner !== null && sh(['image', 'inspect', '--format', '{{.Id}}', runner]) === runner && sh(['inspect', '-f', '{{.State.Running}}', PROXY_CONTAINER]) === 'true' && sh(['network', 'inspect', 'ws_prepnet', '-f', '{{.Internal}}']) === 'true';

const HEAD: ActorRef = { kind: 'head', dept: 'software' };
const MKT: ActorRef = { kind: 'head', dept: 'marketing' };
const SLUG = 'mv3-accept';
const SRC = { source: { channelId: 'C1', threadId: 'T1', messageId: null, userId: '42', attachments: [] } };

let db: TestDb;
let base: string;
let root: string;
let halted = false;
let svc: WsService;
const posted: { target: unknown; payload: { body: string }; file: { name: string; data: Buffer; contentType: string } }[] = [];
const prov: { tainted: boolean }[] = [];
const audits: { action: string; outcome?: string | null }[] = [];
let call: (name: string, input: unknown) => Promise<{ content: string; isError?: boolean }>;
let callMkt: (name: string, input: unknown) => Promise<{ content: string; isError?: boolean }>;

beforeAll(async () => {
  if (!ready) return;
  await acquireDockerTestLock();
  db = await freshDb();
  await migrate(db.pool, join(ROOT_DIR, 'db', 'migrations'), 'up');
  await db.pool.query('DELETE FROM workspaces');
  base = realpathSync(mkdtempSync(join(homedir(), '.ws-accept-')));
  root = join(base, 'root');
  mkdirSync(root, { mode: 0o700 });
  svc = new WsService({
    repo: new WorkspaceRepo(db.pool), root, files: new ProjectFiles(root), lock: new SlugLock(),
    run: { docker: realDockerCli(), image: runner!, uid: process.getuid!(), gid: process.getgid!(), caps: () => ({ tree: 40, day: 200 }), isHalted: () => halted, secrets: () => [], timeoutMs: 120_000, haltPollMs: 100 },
  });
  const org = await seededOrg();
  const cfg = new FakeConfig({ 'ws.enabled': true });
  cfg.get = ((k: string) => (k === 'ws.enabled' ? true : undefined)) as never;
  const deps = {
    env: {}, cfg, log: { warn: vi.fn(), info: vi.fn() }, clock: () => 0, halt: { track: (p: Promise<unknown>) => p, isHalted: () => halted }, org, ws: svc,
    port: { postFile: async (_a: unknown, target: unknown, payload: { body: string }, file: { name: string; data: Buffer; contentType: string }) => { posted.push({ target, payload, file }); return 'msg-1'; } },
    provenance: { record: async (_i: string, _w: string, tainted: boolean) => void prov.push({ tainted }) },
    wsSecrets: [],
  } as unknown as PluginDeps;
  const g = wsGroup(deps);
  if ('disabled' in g) throw new Error(g.disabled);
  const mk = async (actor: ActorRef) => {
    const rig = await webRig(g.tools, { actor, org: Object.assign(org, { toolsFor: () => g.tools.map((t) => t.name) }) as never, ...SRC });
    rig.c.audit = async (e) => void audits.push(e);
    return async (name: string, input: unknown) => {
      const r = await rig.reg.run(name, input, rig.c);
      return { ...r, content: r.content.replace(/^<untrusted-[0-9a-f]+[^>]*>\n/, '').replace(/\n<\/untrusted-[0-9a-f]+>$/, '') };
    };
  };
  call = await mk(HEAD);
  callMkt = await mk(MKT);
}, 600_000);
afterAll(async () => {
  if (!ready) return;
  try {
    await teardown();
  } finally {
    releaseDockerTestLock();
  }
});
async function teardown(): Promise<void> {
  await svc.killAll();
  halted = false;
  rmSync(base, { recursive: true, force: true });
  await db.pool.query('DELETE FROM workspaces');
  await db.pool.query('DELETE FROM ws_run_counts');
  await db.close();
}

function unzip(z: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const eocd = z.length - 22;
  const n = z.readUInt16LE(eocd + 10);
  let p = z.readUInt32LE(eocd + 16);
  for (let i = 0; i < n; i++) {
    const method = z.readUInt16LE(p + 10);
    const csize = z.readUInt32LE(p + 20);
    const nl = z.readUInt16LE(p + 28);
    const lho = z.readUInt32LE(p + 42);
    const name = z.subarray(p + 46, p + 46 + nl).toString();
    const start = lho + 30 + z.readUInt16LE(lho + 26) + z.readUInt16LE(lho + 28);
    const raw = z.subarray(start, start + csize);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    p += 46 + nl + z.readUInt16LE(p + 30) + z.readUInt16LE(p + 32);
  }
  return out;
}

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'mv3-accept', version: '1.0.0', private: true, scripts: { test: 'node --test' } }, null, 2),
  'manifest.json': JSON.stringify({ manifest_version: 3, name: 'Starter kit', version: '1.0.0', background: { service_worker: 'src/background.js' }, permissions: ['storage'] }, null, 2),
  'src/background.js': "const { greet } = require('./greet.js');\nif (typeof chrome !== 'undefined') chrome.runtime.onInstalled.addListener(() => console.log(greet('mv3')));\n",
  'src/greet.js': "module.exports = { greet: (n) => 'hello ' + n };\n",
  'src/count.ts': 'export function count(xs: number[]): number { return xs.length; }\n',
  'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'es2020', module: 'commonjs', types: [] }, include: ['src/**/*.ts'] }),
  'test/greet.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\nconst isNumber = require('is-number');\nconst { greet } = require('../src/greet.js');\nconst m = require('../manifest.json');\ntest('greet', () => assert.strictEqual(greet('x'), 'hello x'));\ntest('manifest is v3 with a service worker', () => { assert.strictEqual(m.manifest_version, 3); assert.ok(m.background.service_worker); });\ntest('pinned dep from the proxy', () => assert.ok(isNumber(5)));\n",
};

describe.skipIf(!ready)('WS-1 acceptance: software head builds an MV3 starter through the tools', () => {
  it('create, write, npm install (pinned, via proxy), npm test, tsc --noEmit, export', async () => {
    expect((await call('ws_create', { slug: SLUG, title: 'MV3 starter' })).isError).toBeFalsy();
    for (const [path, content] of Object.entries(FILES)) expect((await call('ws_write', { slug: SLUG, path, content })).isError, path).toBeFalsy();

    const inst = await call('ws_run', { slug: SLUG, command: 'npm install is-number@7.0.0 typescript@5.6.3' });
    expect(inst.content, inst.content).toMatch(/^ws_run install in mv3-accept: exit 0/);
    const tst = await call('ws_run', { slug: SLUG, command: 'npm test' });
    expect(tst.content, tst.content).toMatch(/exit 0/);
    expect(tst.content).toMatch(/pass 3/);
    const tsc = await call('ws_run', { slug: SLUG, command: 'npx tsc --noEmit' });
    expect(tsc.content, tsc.content).toMatch(/^ws_run tsc in mv3-accept: exit 0/);

    // tsc must really check: a type error gives a non-zero exit with a diagnostic (not a vacuous pass)
    await call('ws_write', { slug: SLUG, path: 'src/bad.ts', content: "export const n: number = 'x';\n" });
    const bad = await call('ws_run', { slug: SLUG, command: 'npx tsc --noEmit' });
    expect(bad.content).toMatch(/exit 2/);
    expect(bad.content).toMatch(/TS2322/);
    await call('ws_delete', { slug: SLUG, path: 'src/bad.ts' });

    const exp = await call('ws_export', { slug: SLUG });
    expect(exp.isError, exp.content).toBeFalsy();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.target).toEqual({ channelId: 'C1', threadId: 'T1' });
    expect(posted[0]!.file).toMatchObject({ name: `${SLUG}.zip`, contentType: 'application/zip' });
    const zip = unzip(posted[0]!.file.data);
    expect([...zip.keys()].sort()).toEqual([...Object.keys(FILES), 'package-lock.json'].sort());
    for (const [n, d] of zip) expect(d.equals(readFileSync(join(root, SLUG, n))), n).toBe(true);
    for (const [n, c] of Object.entries(FILES)) if (n !== 'package.json') expect(zip.get(n)!.toString(), n).toBe(c);
    const deps = JSON.parse(zip.get('package.json')!.toString()) as { dependencies: Record<string, string>; devDependencies?: Record<string, string> };
    expect({ ...deps.dependencies, ...deps.devDependencies }).toMatchObject({ 'is-number': '^7.0.0', typescript: '^5.6.3' });
    expect(zip.has('node_modules/is-number/package.json')).toBe(false);
    expect(prov.at(-1)?.tainted).toBe(true);
    expect(audits.filter((a) => a.action === 'ws.run').map((a) => a.outcome)).toEqual(['mv3-accept:install:exit=0', 'mv3-accept:test:exit=0', 'mv3-accept:tsc:exit=0', 'mv3-accept:tsc:exit=2']);
    expect(sh(['ps', '-aq', '--filter', 'label=ws=1'])).toBe('');
  }, 400_000);

  it('another department is refused on every tool (E_DEPT) and nothing is created', async () => {
    for (const [name, input] of [['ws_list', {}], ['ws_read', { slug: SLUG, path: 'manifest.json' }], ['ws_write', { slug: SLUG, path: 'x.js', content: 'x' }], ['ws_run', { slug: SLUG, command: 'npm test' }], ['ws_export', { slug: SLUG }], ['ws_create', { slug: 'other', title: 't' }], ['ws_delete', { slug: SLUG, path: 'manifest.json' }]] as const) {
      const r = await callMkt(name, input);
      expect(r.isError, name).toBe(true);
      expect(r.content, name).toMatch(/software team only|not available|Unknown tool|not allowed|permission/i);
    }
    expect(existsSync(join(root, 'other'))).toBe(false);
    expect(existsSync(join(root, SLUG, 'x.js'))).toBe(false);
    expect(existsSync(join(root, SLUG, 'manifest.json'))).toBe(true);
  }, 60_000);

  it('a symlink planted by a container (to a canary outside WS_ROOT) is refused by read, write, list-as-link and export', async () => {
    const canary = join(base, 'canary.txt');
    writeFileSync(canary, 'CANARY-SECRET-9f3');
    await call('ws_write', { slug: SLUG, path: 'mk.js', content: `const fs=require('fs');fs.symlinkSync(${JSON.stringify(canary)}, 'link-abs');fs.symlinkSync('../../canary.txt','link-rel');fs.symlinkSync('../..','link-up');\n` });
    const mk = await call('ws_run', { slug: SLUG, command: 'node mk.js' });
    expect(mk.content, mk.content).toMatch(/exit 0/);
    expect(lstatSync(join(root, SLUG, 'link-abs')).isSymbolicLink()).toBe(true); // the symlink really reached the host
    await call('ws_write', { slug: SLUG, path: 'peek.js', content: "for (const l of ['link-abs','link-rel','link-up/canary.txt']) { try { console.log('READ ' + l + ' ' + require('fs').readFileSync(l, 'utf8')); } catch (e) { console.log('BLOCKED ' + l + ' ' + e.code); } }\n" });
    const peek = await call('ws_run', { slug: SLUG, command: 'node peek.js' });
    expect(peek.content, peek.content).not.toContain('CANARY-SECRET'); // the container cannot see the host canary through its symlinks either
    expect(peek.content).toMatch(/BLOCKED link-abs ENOENT/);
    for (const l of ['link-abs', 'link-rel', 'link-up']) {
      const r = await call('ws_read', { slug: SLUG, path: l });
      expect(r.isError, l).toBe(true);
      expect(r.content, l).not.toContain('CANARY-SECRET');
      const w = await call('ws_write', { slug: SLUG, path: l, content: 'OVERWRITE' });
      expect(w.isError, l).toBe(true);
    }
    expect(readFileSync(canary, 'utf8')).toBe('CANARY-SECRET-9f3');
    const under = await call('ws_read', { slug: SLUG, path: 'link-up/canary.txt' });
    expect(under.isError).toBe(true);
    expect(under.content).not.toContain('CANARY-SECRET');
    const ls = await call('ws_list', { slug: SLUG });
    expect(ls.content).toMatch(/link-abs \(not a regular file\)/);
    posted.length = 0;
    const exp = await call('ws_export', { slug: SLUG });
    const names = posted.length ? [...unzip(posted[0]!.file.data).keys()] : [];
    expect(names.some((n) => n.startsWith('link-'))).toBe(false);
    if (posted.length) expect([...unzip(posted[0]!.file.data).values()].some((b) => b.includes('CANARY-SECRET'))).toBe(false);
    expect(exp.content).toBeTruthy();
    // a recursive delete of a dir holding a link to an outside dir leaves the canary
    await call('ws_write', { slug: SLUG, path: 'd/a.txt', content: 'a' });
    await call('ws_write', { slug: SLUG, path: 'mk2.js', content: `require('fs').symlinkSync('../..', 'd/out');\n` });
    expect((await call('ws_run', { slug: SLUG, command: 'node mk2.js' })).content).toMatch(/exit 0/);
    await call('ws_delete', { slug: SLUG, path: 'd', recursive: true });
    expect(existsSync(canary)).toBe(true);
    expect(existsSync(join(base, 'root'))).toBe(true);
  }, 120_000);

  it('disallowed commands are refused before any container starts', async () => {
    const before = sh(['ps', '-aq', '--filter', 'label=ws=1']);
    const bad = ['curl http://example.com', 'sh -c id', 'npm install git+https://example.com/x.git', 'npm install https://example.com/x.tgz', 'npm install foo@npm:bar@1', 'npm run build && id', 'node ../x.js', 'npx tsc --project /etc', 'npm exec foo', 'docker ps', 'node -e 1'];
    for (const command of bad) {
      const r = await call('ws_run', { slug: SLUG, command });
      expect(r.isError, command).toBe(true);
      expect(r.content, command).toMatch(/not allowed|not a registry|Allowed|spec|version/i);
    }
    expect(sh(['ps', '-aq', '--filter', 'label=ws=1'])).toBe(before);
    expect((await call('ws_write', { slug: SLUG, path: '.npmrc', content: 'registry=http://evil/' })).isError).toBe(true);
    expect((await call('ws_write', { slug: SLUG, path: 'a/.NPMRC', content: 'x' })).isError).toBe(true);
    expect((await call('ws_write', { slug: SLUG, path: '../escape.txt', content: 'x' })).isError).toBe(true);
    expect(existsSync(join(base, 'escape.txt'))).toBe(false);
  }, 60_000);

  it('halt: refused at the gate; a halt during a real run kills the container; nothing is left', async () => {
    await call('ws_write', { slug: SLUG, path: 'spin.js', content: 'for(;;){}\n' });
    halted = true;
    const g = await call('ws_run', { slug: SLUG, command: 'node spin.js' });
    expect(g.isError).toBe(true);
    expect(g.content).toBe(WS_TEXT.E_HALTED);
    halted = false;
    const p = call('ws_run', { slug: SLUG, command: 'node spin.js' });
    await new Promise((r) => setTimeout(r, 3000));
    expect(sh(['ps', '-q', '--filter', 'label=ws=1'])).not.toBe('');
    halted = true;
    await svc.killAll();
    const r = await p;
    halted = false;
    expect(r.isError).toBe(true);
    expect(r.content).toBe(WS_TEXT.E_HALTED);
    expect(sh(['ps', '-aq', '--filter', 'label=ws=1'])).toBe('');
    const ok = await call('ws_run', { slug: SLUG, command: 'npm test' });
    expect(ok.content).toMatch(/exit 0/); // the slot is usable again after the halt is cleared
  }, 120_000);
});

describe('ws acceptance prerequisites', () => {
  it('real Docker, runner image, ws proxy and ws_prepnet are up (else the acceptance tests above were skipped)', () => {
    expect(ready).toBe(true);
  });
});

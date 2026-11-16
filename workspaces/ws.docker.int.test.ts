import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { WorkspaceRepo } from '../db/repos/workspaces.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { acquireDockerTestLock, releaseDockerTestLock } from './docker-test-lock.js';
import { ProjectFiles } from './files.js';
import { SlugLock } from './lock.js';
import { PROXY_CONTAINER, realDockerCli } from './runner.js';
import { WsService } from './service.js';

/**
 * WS-1 with the REAL Docker daemon, the real runner image and the live ws registry proxy (npm run local:ws), the real WorkspaceRepo on the test
 * Postgres: create a workspace, write a minimal package with a test, npm install a pinned package through the proxy, npm test passes, the export
 * zip matches the files. Skipped (visibly) when Docker, the images or the proxy are not up.
 */
const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
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
} catch { /* no images.json */ }
const ready = runner !== null && sh(['image', 'inspect', '--format', '{{.Id}}', runner]) === runner && sh(['inspect', '-f', '{{.State.Running}}', PROXY_CONTAINER]) === 'true' && sh(['network', 'inspect', 'ws_prepnet', '-f', '{{.Internal}}']) === 'true';

let db: TestDb;
let base: string;
let root: string;
let repo: WorkspaceRepo;
let svc: WsService;
const rootId = randomUUID();

beforeAll(async () => {
  if (!ready) return;
  await acquireDockerTestLock();
  db = await freshDb();
  await migrate(db.pool, join(ROOT_DIR, 'db', 'migrations'), 'up');
  await db.pool.query('DELETE FROM workspaces');
  base = realpathSync(mkdtempSync(join(homedir(), '.ws-int-')));
  root = join(base, 'root');
  mkdirSync(root, { mode: 0o700 });
  repo = new WorkspaceRepo(db.pool);
  svc = new WsService({
    repo, root, files: new ProjectFiles(root), lock: new SlugLock(),
    run: { docker: realDockerCli(), image: runner!, uid: process.getuid!(), gid: process.getgid!(), caps: () => ({ tree: 40, day: 200 }), isHalted: () => false, secrets: () => [], timeoutMs: 60_000 },
  });
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

describe.skipIf(!ready)('WS-1 with real Docker (create, write, npm install via the proxy, npm test, export)', () => {
  it('runs the whole flow and leaves no ws=1 container behind', async () => {
    await svc.create('mv3-kit', 'MV3 starter', 'head:software');
    const files: Record<string, string> = {
      'package.json': JSON.stringify({ name: 'mv3-kit', version: '1.0.0', private: true, scripts: { test: 'node --test' } }, null, 2),
      'manifest.json': JSON.stringify({ manifest_version: 3, name: 'Starter', version: '1.0.0' }, null, 2),
      'src/background.js': 'self.addEventListener("install", () => {});\n',
      'test/a.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\nconst isNumber = require('is-number');\ntest('is-number works', () => { assert.ok(isNumber(5)); assert.ok(!isNumber('x')); });\n",
    };
    for (const [p, c] of Object.entries(files)) await svc.write('mv3-kit', p, c);

    const install = await svc.run({ slug: 'mv3-kit', command: 'npm install is-number@7.0.0', rootId });
    expect(install, JSON.stringify(install)).toMatchObject({ outcome: 'exit', exit: 0, verb: 'install' });
    expect((install as { output: string }).output).toMatch(/added 1 package/);
    expect((await repo.get('mv3-kit'))!.nmBytes).toBeGreaterThan(0);

    const test = await svc.run({ slug: 'mv3-kit', command: 'npm test', rootId });
    expect(test, JSON.stringify(test)).toMatchObject({ outcome: 'exit', exit: 0, verb: 'test' });
    expect((test as { output: string }).output).toMatch(/pass 1/);

    const ci = await svc.run({ slug: 'mv3-kit', command: 'npm ci', rootId });
    expect(ci, JSON.stringify(ci)).toMatchObject({ outcome: 'exit', exit: 0, verb: 'ci' });

    // no network for npm test: the same container cannot reach the proxy
    await svc.write('mv3-kit', 'net.js', "require('http').get('http://10.88.80.2:4873/react', () => console.log('REACHED')).on('error', (e) => console.log('NO NETWORK ' + e.code));\n");
    const net = await svc.run({ slug: 'mv3-kit', command: 'node net.js', rootId });
    expect((net as { output: string }).output).toMatch(/NO NETWORK ENETUNREACH/);

    const z = await svc.export('mv3-kit', []);
    const zip = unzip(z.zip);
    expect([...zip.keys()].sort()).toEqual(['manifest.json', 'net.js', 'package-lock.json', 'package.json', 'src/background.js', 'test/a.test.js']);
    for (const [name, data] of zip) expect(data.equals(readFileSync(join(root, 'mv3-kit', name))), name).toBe(true);
    expect(JSON.parse(zip.get('package.json')!.toString()).dependencies).toEqual({ 'is-number': '^7.0.0' }); // npm install recorded it
    expect(zip.get('src/background.js')!.toString()).toBe(files['src/background.js']);
    expect(sh(['ps', '-aq', '--filter', 'label=ws=1'])).toBe('');
  }, 240_000);

  it('a real timeout removes the container (E_TIMEOUT path) and the next run works', async () => {
    await svc.write('mv3-kit', 'loop.js', 'for(;;){}\n');
    const quick = new WsService({
      repo, root, files: new ProjectFiles(root), lock: new SlugLock(),
      run: { docker: realDockerCli(), image: runner!, uid: process.getuid!(), gid: process.getgid!(), caps: () => ({ tree: 40, day: 200 }), isHalted: () => false, secrets: () => [], timeoutMs: 3000 },
    });
    const r = await quick.run({ slug: 'mv3-kit', command: 'node loop.js', rootId });
    expect(r).toMatchObject({ outcome: 'timeout', exit: 137 });
    expect(sh(['ps', '-aq', '--filter', 'label=ws=1'])).toBe('');
  }, 60_000);

  it('real halt: killAll while a container runs ends the run as halted with no container left', async () => {
    let halted = false;
    const h = new WsService({
      repo, root, files: new ProjectFiles(root), lock: new SlugLock(),
      run: { docker: realDockerCli(), image: runner!, uid: process.getuid!(), gid: process.getgid!(), caps: () => ({ tree: 40, day: 200 }), isHalted: () => halted, secrets: () => [], timeoutMs: 60_000 },
    });
    const p = h.run({ slug: 'mv3-kit', command: 'node loop.js', rootId });
    await new Promise((r) => setTimeout(r, 2500));
    expect(sh(['ps', '-q', '--filter', 'label=ws=1'])).not.toBe('');
    halted = true;
    await h.killAll();
    expect(await p).toMatchObject({ outcome: 'halted' });
    expect(sh(['ps', '-aq', '--filter', 'label=ws=1'])).toBe('');
  }, 60_000);
});

describe('ws docker integration prerequisites', () => {
  it('are up (images.json image present, proxy running, ws_prepnet internal)', () => {
    expect(ready, 'run `npm run local:ws` first: the real-Docker tests were skipped').toBe(true);
  });
});

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { canonical } from '../config/store.js';
import { migrate } from '../db/migrate.js';
import { DevJobRepo } from '../db/repos/devjobs.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { CodeApplier, type HealthBody } from '../executor/code-apply.js';
import { buildRelease, currentHead, makeWritable, switchCurrent, type BuildPorts } from '../executor/code-release.js';
import { ASSISTANT_REPO as EXEC_REPO, CodeService } from '../executor/code-service.js';
import { FakeSandbox } from './fake-sandbox-fixture.js';
import { realGit } from './git.js';
import { ASSISTANT_REPO, DevJobService } from './service.js';
import { makeRepo, okSupply, sh, type Repo } from './test-helpers.js';

/**
 * The whole path with a fake model and fake containers but REAL git, REAL bundle verification, REAL release directories, REAL compare-and-swap and the
 * REAL database: request -> sandbox (faked) -> tests -> review -> card payload -> executor check/apply in a temp release dir (fake restart and health) -> rollback.
 */
let db: TestDb;
const OWNER = '9'.repeat(18);
const ADMIN = '1'.repeat(18);
const dirs: string[] = [];
let src: Repo;
beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'), 'up');
});
afterAll(() => db.close());
afterEach(() => {
  src?.cleanup();
  for (const d of dirs.splice(0)) { try { makeWritable(d); } catch { /* */ } rmSync(d, { recursive: true, force: true }); }
});

const buildPorts = (): BuildPorts => ({
  extract: async (git, head, dir) => { execFileSync('tar', ['-x', '-C', dir], { input: await git.run(['archive', '--format=tar', head]) }); },
  install: async (dir) => { mkdirSync(join(dir, 'node_modules')); },
  compile: async (dir) => { mkdirSync(join(dir, 'dist')); writeFileSync(join(dir, 'dist/main.js'), '1'); },
});

async function rig(o: { files: Record<string, string | null>; sandbox?: Partial<ConstructorParameters<typeof FakeSandbox>[0]>; tainted?: boolean; health?: (serving: string, base: string) => HealthBody; halted?: boolean; offDay?: boolean }) {
  await db.pool.query('DELETE FROM dev_jobs');
  src = makeRepo();
  const base = src.head();
  const root = mkdtempSync(join(tmpdir(), 'e2e-root-'));
  const work = mkdtempSync(join(tmpdir(), 'e2e-work-'));
  dirs.push(root, work);
  sh(root, 'init', '-q', '--bare', '-b', 'main', 'repo.git');
  sh(src.dir, 'push', '-q', join(root, 'repo.git'), 'main:main');
  const egit = realGit(join(root, 'repo.git'));
  await buildRelease({ git: egit, head: base, root, ports: buildPorts() });
  switchCurrent(root, base);
  const app = { serving: base };
  const sandbox = new FakeSandbox({ files: o.files, ...o.sandbox });
  const repo = new DevJobRepo(db.pool);
  const cards: { confirmerId: string; payload: unknown }[] = [];
  const audits: string[] = [];
  const notices: string[] = [];
  const svc = new DevJobService({
    repo, sandbox, workDir: work, supply: okSupply(),
    models: { register: async () => `dj-${'a'.repeat(48)}`, close: async () => ({ spentUsd: 0.1 }) },
    source: { baseSha: async () => base, fullBundle: async () => execFileSync('git', ['bundle', 'create', '-', 'main'], { cwd: src.dir, maxBuffer: 1 << 28, env: { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null' } }) },
    cfg: { budgetUsd: () => 20, jobCapUsd: () => 2, ownerUserId: () => OWNER },
    halted: () => o.halted ?? false, offDay: () => o.offDay ?? false,
    audit: async (e) => void audits.push(`${e.action} ${e.outcome}`), log: { error() {} },
    postCard: async (p, payload) => (cards.push({ confirmerId: p.confirmerId, payload }), { ok: true, cardId: 'c'.repeat(32) }),
    notify: async (_j, t) => void notices.push(t),
  });
  const applier = new CodeApplier({
    git: egit, root, build: buildPorts(), windowMs: 10_000, maxWaitMs: 30_000, pollMs: 5_000, now: (() => { let t = 0; return () => t; })(), sleep: async () => undefined,
    restart: async () => { app.serving = currentHead(root)!; },
    health: async () => (o.health ?? ((s: string): HealthBody => ({ db: 'ok', clients: ['hq'], halted: false, provider: 'ok', build: s })))(app.serving, base),
    audit: async (e) => void audits.push(`${e.action} ${e.outcome}`),
  });
  // the clock must advance for the stable window: fake sleep moves it
  let clock = 0;
  (applier as unknown as { d: { now: () => number; sleep: (ms: number) => Promise<void> } }).d.now = () => clock;
  (applier as unknown as { d: { sleep: (ms: number) => Promise<void> } }).d.sleep = async (ms) => { clock += ms; };
  const code = new CodeService({
    jobs: { get: async (id) => repo.get(id), getBundle: (id) => repo.getBundle(id), finish: (id, s, out) => repo.finish(id, s, out) },
    git: egit, bundleDir: join(root, 'bundles'), applier, supply: okSupply(), ownerUserId: OWNER,
    exec: { push: async () => undefined }, audit: async (e) => void audits.push(`${e.action} ${e.outcome}`), log: { error() {} },
  });
  const request = (over: { request?: string; requesterId?: string } = {}) => svc.request({ repo: ASSISTANT_REPO, request: over.request ?? 'add a short document about polls', requesterId: over.requesterId ?? ADMIN, channelId: '5'.repeat(18), tainted: o.tainted ?? false });
  return { svc, sandbox, repo, cards, audits, notices, applier, code, root, egit, base, app, request };
}
const cardOf = (x: Awaited<ReturnType<typeof rig>>) => {
  const payload = x.cards[0]!.payload;
  return { id: 'c'.repeat(32), channelId: '5'.repeat(18), payload, snapshot: { canon: canonical(payload) } };
};

describe('self-code end to end (fake model, fake containers, real git/db/releases)', () => {
  it('docs-only job: sandbox -> tests -> review -> card (requester confirms) -> executor apply -> healthy -> applied', async () => {
    const x = await rig({ files: { 'docs/polls.md': '# polls\n' } });
    const r = await x.request();
    expect(r).toMatchObject({ ok: true });
    await x.svc.pump();
    const job = (await x.repo.get((r as { jobId: string }).jobId))!;
    expect(job).toMatchObject({ status: 'ready', cardId: 'c'.repeat(32), kind: 'assistant' });
    expect(job.spendUsd).toBeCloseTo(0.2); // the coder and the code review; no security pass for documentation
    expect(x.sandbox.calls).toEqual(['prepare:work', 'agent', 'export', 'prepare:head', 'tests', 'prepare:base', 'tests', 'review:code']);
    expect(x.cards[0]!.confirmerId).toBe(ADMIN);
    expect(x.cards[0]!.payload).toMatchObject({ jobId: job.id, repo: EXEC_REPO, base: x.base, head: job.headSha, bundleSha256: job.bundleSha256 });
    expect(job.verdicts).toMatchObject({ code: 'APPROVE', security: 'NOT_NEEDED', tests: { before: 11, after: 11 } });
    // executor: re-derive from the bundle, show, then apply on the click
    const card = cardOf(x);
    const c = await x.code.check(card, ADMIN);
    expect(c).toMatchObject({ ok: true, ownerOnly: false });
    if (!c.ok) throw new Error('x');
    const done = await x.code.apply(card, ADMIN, c.bind);
    expect(done).toMatchObject({ kind: 'done', ok: true });
    expect(currentHead(x.root)).toBe(job.headSha);
    expect(x.app.serving).toBe(job.headSha);
    expect((await x.egit.run(['rev-parse', 'refs/heads/main'])).toString().trim()).toBe(job.headSha);
    expect((await x.repo.get(job.id))!.status).toBe('applied');
    expect((await x.sandbox.cleanup()).removed).toBe(true);
  });

  it('rollback path: the new build serves the wrong sha although the database is ok -> rolled back, main restored, job rolled_back', async () => {
    const x = await rig({ files: { 'docs/polls.md': '# polls\n' }, health: (serving, base) => ({ db: 'ok', clients: ['hq'], halted: false, provider: 'ok', build: serving === base ? base : base }) });
    const r = await x.request();
    await x.svc.pump();
    const job = (await x.repo.get((r as { jobId: string }).jobId))!;
    const card = cardOf(x);
    const c = await x.code.check(card, ADMIN);
    if (!c.ok) throw new Error('x');
    expect(await x.code.apply(card, ADMIN, c.bind)).toMatchObject({ kind: 'done', ok: false });
    expect(currentHead(x.root)).toBe(x.base);
    expect(x.app.serving).toBe(x.base);
    expect((await x.egit.run(['rev-parse', 'refs/heads/main'])).toString().trim()).toBe(x.base);
    expect((await x.repo.get(job.id))!.status).toBe('rolled_back');
    expect(x.audits.join('\n')).toMatch(/code\.rollback rolled_back/);
  });

  it('manual rollback after a healthy apply returns to the previous release', async () => {
    const x = await rig({ files: { 'docs/polls.md': '# polls\n' } });
    await x.request();
    await x.svc.pump();
    const card = cardOf(x);
    const c = await x.code.check(card, ADMIN);
    if (!c.ok) throw new Error('x');
    await x.code.apply(card, ADMIN, c.bind);
    expect(currentHead(x.root)).not.toBe(x.base);
    expect(await x.code.rollback(ADMIN)).toMatchObject({ ok: true });
    expect(currentHead(x.root)).toBe(x.base);
  });

  it('a code change is owner-only: the card goes to the owner, a Bot Admin decider is refused by the executor', async () => {
    const x = await rig({ files: { 'tools/poll.ts': 'export const poll = 1;\n' }, sandbox: { reviews: { security: JSON.stringify({ verdict: 'CONDITIONAL', findings: [{ severity: 'low', file: 'tools/poll.ts', note: 'new tool' }] }) } } });
    const r = await x.request();
    await x.svc.pump();
    const job = (await x.repo.get((r as { jobId: string }).jobId))!;
    expect(job.status).toBe('ready');
    expect(x.sandbox.calls.at(-2)).toBe('review:code');
    expect(x.sandbox.calls.at(-1)).toBe('review:security');
    expect(x.cards[0]!.confirmerId).toBe(OWNER);
    expect(job.verdicts).toMatchObject({ code: 'APPROVE', security: 'CONDITIONAL' });
    expect(await x.code.check(cardOf(x), ADMIN)).toMatchObject({ ok: false, why: expect.stringMatching(/only the owner/) });
    expect(await x.code.check(cardOf(x), OWNER)).toMatchObject({ ok: true, ownerOnly: true });
  });

  it('a REJECT from either reviewer blocks the card', async () => {
    const x = await rig({ files: { 'tools/poll.ts': 'export const poll = 1;\n' }, sandbox: { reviews: { security: JSON.stringify({ verdict: 'REJECT', findings: [] }) } } });
    const r = await x.request();
    await x.svc.pump();
    expect(await x.repo.get((r as { jobId: string }).jobId)).toMatchObject({ status: 'failed', outcome: expect.stringMatching(/review rejected/) });
    expect(x.cards).toHaveLength(0);
    const y = await rig({ files: { 'docs/a.md': 'a\n' }, sandbox: { reviews: { code: 'I approve!' } } });
    const r2 = await y.request();
    await y.svc.pump();
    expect((await y.repo.get((r2 as { jobId: string }).jobId))!.status).toBe('failed'); // invalid reviewer output counts as REJECT
  });

  it('non-self-modifiable paths, lints and falling test counts end the job before any card', async () => {
    const a = await rig({ files: { 'executor/main.ts': 'export {}\n' } });
    const ra = await a.request();
    await a.svc.pump();
    expect(await a.repo.get((ra as { jobId: string }).jobId)).toMatchObject({ status: 'refused', outcome: expect.stringMatching(/non-self-modifiable/) });
    expect(a.sandbox.calls).not.toContain('tests');
    const b = await rig({ files: { 'docs/a.md': 'x‮y\n', 'tools/z.ts': 'export {}\n' } });
    const rb = await b.request();
    await b.svc.pump();
    expect((await b.repo.get((rb as { jobId: string }).jobId))!.outcome).toMatch(/bidirectional/);
    const c = await rig({ files: { 'tools/x.test.ts': null } });
    const rc = await c.request();
    await c.svc.pump();
    expect((await c.repo.get((rc as { jobId: string }).jobId))!.outcome).toMatch(/test count fell/);
    for (const x of [a, b, c]) expect(x.cards).toHaveLength(0);
  });

  it('failed tests, a crashed agent and a failed install each fail the job; the sandbox is always cleaned up', async () => {
    for (const sandbox of [{ testsFail: true }, { agentOk: false }, { installFails: true }]) {
      const x = await rig({ files: { 'docs/a.md': 'a\n' }, sandbox });
      const r = await x.request();
      await x.svc.pump();
      expect((await x.repo.get((r as { jobId: string }).jobId))!.status).toBe('failed');
      expect(x.cards).toHaveLength(0);
    }
    const x = await rig({ files: { 'docs/a.md': 'a\n' }, sandbox: { agentOk: false } });
    x.sandbox.removed = false;
    await x.request();
    await x.svc.pump();
    expect(x.audits.join('\n')).toMatch(/devjob\.cleanup WARNING/);
  });

  it('X22/X24: a tainted run, a wrong repo and the 3 per person limit are refused (and counted); halt and off-day queue instead of starting', async () => {
    const t = await rig({ files: {}, tainted: true });
    expect(await t.request()).toMatchObject({ ok: false, error: expect.stringMatching(/untrusted/) });
    const x = await rig({ files: { 'docs/a.md': 'a\n' } });
    expect(await x.svc.request({ repo: 'Lab-Work-Space/Other', request: 'x'.repeat(20), requesterId: ADMIN, channelId: null, tainted: false })).toMatchObject({ ok: false });
    for (let i = 0; i < 2; i++) expect(await x.request()).toMatchObject({ ok: true });
    // two refused above? the wrong-repo refusal was recorded as a job row and counts toward the day
    expect(await x.request()).toMatchObject({ ok: false, error: expect.stringMatching(/per person/) });
    await x.svc.pump();
    const h = await rig({ files: { 'docs/a.md': 'a\n' }, halted: true });
    const rh = await h.request();
    expect(rh).toMatchObject({ ok: true, queued: true });
    await h.svc.pump();
    expect((await h.repo.get((rh as { jobId: string }).jobId))!.status).toBe('queued');
    const o = await rig({ files: { 'docs/a.md': 'a\n' }, offDay: true });
    const ro = await o.request();
    await o.svc.pump();
    expect((await o.repo.get((ro as { jobId: string }).jobId))!.status).toBe('queued');
    expect(existsSync(o.root)).toBe(true);
  });
});

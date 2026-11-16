import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { realGit } from '../devjob/git.js';
import { makeRepo, sh, type Repo } from '../devjob/test-helpers.js';
import { CodeApplier, healthProblem, type HealthBody } from './code-apply.js';
import { buildRelease, currentHead, makeWritable, switchCurrent, type BuildPorts } from './code-release.js';

let src: Repo;
let root: string;
afterEach(() => { src?.cleanup(); if (root && existsSync(root)) { try { makeWritable(root); } catch { /* */ } rmSync(root, { recursive: true, force: true }); } });

const ports = (): BuildPorts => ({
  extract: async (git, head, dir) => { const { execFileSync } = await import('node:child_process'); execFileSync('tar', ['-x', '-C', dir], { input: await git.run(['archive', '--format=tar', head]) }); },
  install: async (dir) => { mkdirSync(join(dir, 'node_modules')); },
  compile: async (dir) => { mkdirSync(join(dir, 'dist')); writeFileSync(join(dir, 'dist/main.js'), '1'); },
});

/** A pretend application: restart() makes it serve whatever `current` points at, like launchd would. */
function rig(o: { mode?: (serving: string) => HealthBody | null; failRestart?: boolean } = {}) {
  src = makeRepo();
  const base = src.head();
  root = mkdtempSync(join(tmpdir(), 'apply-'));
  sh(root, 'init', '-q', '--bare', '-b', 'main', 'repo.git');
  sh(src.dir, 'push', '-q', join(root, 'repo.git'), 'main:main');
  const git = realGit(join(root, 'repo.git'));
  const app = { serving: '', restarts: 0, down: false };
  const audits: string[] = [];
  const mk = () => new CodeApplier({
    git, root, build: ports(), expectClients: [], windowMs: 20_000, maxWaitMs: 60_000, pollMs: 5_000,
    restart: async () => { app.restarts++; if (o.failRestart && currentHead(root) !== base) throw new Error('launchctl failed'); app.serving = currentHead(root)!; },
    health: async () => (app.down ? null : (o.mode ?? ((s) => ({ db: 'ok', clients: ['hq', 'praw'], halted: false, provider: 'ok', build: s })))(app.serving)),
    audit: async (e) => void audits.push(`${e.action} ${e.outcome}`),
    now: () => clock.t, sleep: async (ms) => { clock.t += ms; },
  });
  const clock = { t: Date.parse('2026-11-02T12:00:00Z') };
  return { git, app, audits, mk, base, clock, boot: async () => { await buildRelease({ git, head: base, root: root, ports: ports() }); switchCurrent(root, base); app.serving = base; } };
}
/** Bring a candidate commit into the executor repo the way the bundle path does. */
function bring(x: ReturnType<typeof rig>, files: Record<string, string>) {
  const head = src.commit(files);
  sh(src.dir, 'push', '-q', join(root, 'repo.git'), `${head}:refs/jobs/J-0123456789abcdef`);
  return head;
}
const job = (base: string, head: string) => ({ jobId: 'J-0123456789abcdef', base, head, by: '1'.repeat(18), bundleSha256: 'c'.repeat(64) });

describe('healthProblem (X18)', () => {
  const ok: HealthBody = { db: 'ok', clients: ['hq'], halted: false, provider: 'ok', build: 'a'.repeat(40) };
  const o = { sha: 'a'.repeat(40), expectClients: ['hq'], needProvider: true };
  it('wrong sha with a healthy db is NOT healthy', () => {
    expect(healthProblem(ok, o)).toBeNull();
    expect(healthProblem({ ...ok, build: 'b'.repeat(40) }, o)).toMatch(/serving build/);
    expect(healthProblem({ ...ok, build: undefined }, o)).toMatch(/unknown/);
  });
  it.each([[{ db: 'error' }, /database/], [{ halted: true }, /halted/], [{ provider: 'unavailable' }, /provider/], [{ clients: [] }, /not connected: hq/]])('%j', (patch, re) => {
    expect(healthProblem({ ...ok, ...patch }, o)).toMatch(re);
  });
  it('unreachable is a problem', () => expect(healthProblem(null, o)).toMatch(/did not answer/));
});

describe('CodeApplier (X17, X18)', () => {
  it('applies: builds the release, moves main by CAS, switches current, waits the stable window', async () => {
    const x = rig();
    await x.boot();
    const head = bring(x, { 'docs/a.md': 'a' });
    const r = await x.mk().apply(job(x.base, head));
    expect(r).toMatchObject({ ok: true, outcome: 'applied' });
    expect(currentHead(root)).toBe(head);
    expect((await x.git.run(['rev-parse', 'refs/heads/main'])).toString().trim()).toBe(head);
    expect(x.app.serving).toBe(head);
    expect(x.clock.t).toBeGreaterThanOrEqual(Date.parse('2026-11-02T12:00:20Z'));
    expect(x.audits.join('\n')).toMatch(/applied job:J-0123456789abcdef base:\w{12} head:\w{12} bundle:c{12} rollback-point:releases\//);
    expect(existsSync(join(root, 'apply.lock'))).toBe(false);
  });
  it('wrong sha with the database ok triggers rollback, restores main and proves the old build serves', async () => {
    const x = rig({ mode: (s) => ({ db: 'ok', clients: ['hq'], halted: false, provider: 'ok', build: x2(s) }) });
    const x2 = (s: string) => (s === x.base ? s : x.base); // the new build keeps reporting the OLD sha
    await x.boot();
    const head = bring(x, { 'docs/a.md': 'a' });
    const r = await x.mk().apply(job(x.base, head));
    expect(r.outcome).toBe('rolled_back');
    expect(currentHead(root)).toBe(x.base);
    expect((await x.git.run(['rev-parse', 'refs/heads/main'])).toString().trim()).toBe(x.base);
    expect((await x.git.run(['rev-parse', 'refs/rejected/J-0123456789abcdef'])).toString().trim()).toBe(head);
    expect(x.audits.join('\n')).toMatch(/code\.rollback rolled_back/);
    expect(x.app.serving).toBe(x.base);
  });
  it('a dead Discord client after the change rolls back', async () => {
    const x = rig({ mode: (s) => ({ db: 'ok', clients: s === x.base ? ['hq', 'praw'] : ['hq'], halted: false, provider: 'ok', build: s }) });
    await x.boot();
    const head = bring(x, { 'docs/a.md': 'a' });
    expect((await x.mk().apply(job(x.base, head))).outcome).toBe('rolled_back');
  });
  it('a restart that fails rolls back; if the old build does not come back it says so loudly', async () => {
    const x = rig({ failRestart: true });
    await x.boot();
    const head = bring(x, { 'docs/a.md': 'a' });
    const r = await x.mk().apply(job(x.base, head));
    expect(r.outcome).toBe('rolled_back');
    const y = rig({ mode: (s) => (s === y.base ? null : { db: 'ok', clients: [], halted: false, build: s }) });
    await y.boot();
    const h2 = bring(y, { 'docs/a.md': 'a' });
    // before the change the application is "down": nothing is applied at all
    expect((await y.mk().apply(job(y.base, h2))).outcome).toBe('refused');
  });
  it('refuses when main moved (X17 base-moved race), when halted, with no running release, and when unhealthy before', async () => {
    const x = rig();
    await x.boot();
    const head = bring(x, { 'docs/a.md': 'a' });
    const other = src.commit({ 'docs/b.md': 'b' });
    sh(src.dir, 'push', '-q', join(root, 'repo.git'), `${other}:refs/heads/main`);
    expect((await x.mk().apply(job(x.base, head))).lines[0]).toMatch(/main moved/);
    const y = rig({ mode: (s) => ({ db: 'ok', clients: [], halted: true, build: s }) });
    await y.boot();
    expect((await y.mk().apply(job(y.base, bring(y, { 'docs/a.md': 'a' })))).lines[0]).toMatch(/halted/);
    const z = rig();
    expect((await z.mk().apply(job(z.base, bring(z, { 'docs/a.md': 'a' })))).lines[0]).toMatch(/no running release/);
  });
  it('G2SC-02: refuses a base that is not the running release even when main equals it', async () => {
    const x = rig();
    await x.boot();
    const mid = src.commit({ 'docs/mid.md': 'm' });
    sh(src.dir, 'push', '-q', join(root, 'repo.git'), `${mid}:refs/heads/main`); // main moved ahead of the running release (an import)
    const head = src.commit({ 'docs/a.md': 'a' });
    sh(src.dir, 'push', '-q', join(root, 'repo.git'), `${head}:refs/jobs/J-0123456789abcdef`);
    const r = await x.mk().apply(job(mid, head));
    expect(r.lines[0]).toMatch(/base is not the running release/);
    expect(currentHead(root)).toBe(x.base);
  });
  it('releaseMain: bootstraps with no current release, then switches to an imported main with the health window; main is never moved', async () => {
    const x = rig();
    await buildRelease({ git: x.git, head: x.base, root, ports: ports() }); // a release exists but nothing is current yet
    const boot = await x.mk().releaseMain('1'.repeat(18));
    expect(boot).toMatchObject({ ok: true });
    expect(currentHead(root)).toBe(x.base);
    const next = src.commit({ 'docs/imported.md': 'i' });
    sh(src.dir, 'push', '-q', join(root, 'repo.git'), `${next}:refs/heads/main`); // the human import
    x.app.serving = x.base;
    const r = await x.mk().releaseMain('1'.repeat(18));
    expect(r).toMatchObject({ ok: true, outcome: 'applied' });
    expect(currentHead(root)).toBe(next);
    expect(x.app.serving).toBe(next);
    expect((await x.git.run(['rev-parse', 'refs/heads/main'])).toString().trim()).toBe(next);
    expect((await x.mk().releaseMain('1'.repeat(18))).lines[0]).toMatch(/already main/);
  });
  it('releaseMain: an unhealthy new release rolls back to the previous one and leaves main alone', async () => {
    const x = rig({ mode: (s) => ({ db: 'ok', clients: [], halted: false, provider: 'ok', build: s === x.base ? s : x.base }) });
    await x.boot();
    const next = src.commit({ 'docs/imported.md': 'i' });
    sh(src.dir, 'push', '-q', join(root, 'repo.git'), `${next}:refs/heads/main`);
    const r = await x.mk().releaseMain('1'.repeat(18));
    expect(r.outcome).toBe('rolled_back');
    expect(currentHead(root)).toBe(x.base);
    expect((await x.git.run(['rev-parse', 'refs/heads/main'])).toString().trim()).toBe(next);
  });
  it('a failed build changes nothing', async () => {
    const x = rig();
    await x.boot();
    const head = bring(x, { 'docs/a.md': 'a' });
    const bad = new CodeApplier({ git: x.git, root, build: { ...ports(), compile: async () => { throw new Error('tsc failed'); } }, restart: async () => undefined, health: async () => ({ db: 'ok', build: x.base, clients: [] }), audit: async () => undefined });
    expect((await bad.apply(job(x.base, head))).lines[0]).toMatch(/could not be built/);
    expect(currentHead(root)).toBe(x.base);
    expect((await x.git.run(['rev-parse', 'refs/heads/main'])).toString().trim()).toBe(x.base);
  });
  it('one lock: a second apply while one runs is refused, and a stale lock file refuses too', async () => {
    const x = rig();
    await x.boot();
    const head = bring(x, { 'docs/a.md': 'a' });
    const a = x.mk();
    const [r1, r2] = await Promise.all([a.apply(job(x.base, head)), a.apply(job(x.base, head))]);
    expect([r1.outcome, r2.outcome].sort()).toEqual(['applied', 'refused']);
    writeFileSync(join(root, 'apply.lock'), 'stale');
    expect((await x.mk().apply(job(head, head))).lines[0]).toMatch(/lock is held/);
  });
  it('manual rollback works within 24 h of the apply, not after, and only for the last applied change', async () => {
    const x = rig();
    await x.boot();
    const head = bring(x, { 'docs/a.md': 'a' });
    const a = x.mk();
    expect((await a.apply(job(x.base, head))).ok).toBe(true);
    x.clock.t += 25 * 3600_000;
    expect((await a.rollback('1'.repeat(18))).lines[0]).toMatch(/24 hours/);
    x.clock.t -= 20 * 3600_000;
    const r = await a.rollback('1'.repeat(18));
    expect(r.ok).toBe(true);
    expect(currentHead(root)).toBe(x.base);
    expect(x.app.serving).toBe(x.base);
    expect((await x.git.run(['rev-parse', 'refs/heads/main'])).toString().trim()).toBe(x.base);
    expect((await a.rollback('1'.repeat(18))).lines[0]).toMatch(/no applied code change/);
  });
});

import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { canonical } from '../config/store.js';
import { realGit } from '../devjob/git.js';
import { makeRepo, okSupply, sh, type Repo } from '../devjob/test-helpers.js';
import { ASSISTANT_REPO, CodeService, type JobRow } from './code-service.js';

const JOB = 'J-0123456789abcdef';
const OWNER = '9'.repeat(18);
const ADMIN = '1'.repeat(18);
let src: Repo;
let dir: string;
afterEach(() => { src?.cleanup(); if (dir) rmSync(dir, { recursive: true, force: true }); });

function rig(files: Record<string, string | null>, o: { ownerUserId?: string | null; mutate?: (job: JobRow, bundle: { data: Buffer }) => void } = {}) {
  src = makeRepo();
  const base = src.head();
  dir = mkdtempSync(join(tmpdir(), 'cs-'));
  sh(dir, 'init', '-q', '--bare', '-b', 'main', 'repo.git');
  sh(src.dir, 'push', '-q', join(dir, 'repo.git'), 'main:main');
  const head = src.commit(files);
  src.bundle(base, head, join(dir, 'job.bundle'));
  const data = readFileSync(join(dir, 'job.bundle'));
  const sha = createHash('sha256').update(data).digest('hex');
  const job: JobRow = { id: JOB, repo: ASSISTANT_REPO, kind: 'assistant', status: 'ready', baseSha: base, headSha: head, bundleSha256: sha, spendUsd: 0.42, facts: { tests: { before: 10, after: 11, typecheck: true, build: true } }, verdicts: { code: 'APPROVE', security: 'APPROVE', summary: 'Adds a doc @everyone' } };
  const bundle = { sha256: sha, size: data.length, data };
  o.mutate?.(job, bundle);
  const finish = vi.fn(async () => undefined);
  const push = vi.fn(async () => undefined);
  const audits: string[] = [];
  const apply = vi.fn(async () => ({ ok: true as const, outcome: 'applied' as const, lines: ['Applied.'] }));
  const svc = new CodeService({
    jobs: { get: async (id) => (id === JOB ? job : null), getBundle: async () => bundle, finish }, git: realGit(join(dir, 'repo.git')), bundleDir: join(dir, 'bundles'),
    applier: { apply, rollback: vi.fn(async () => ({ ok: true as const, outcome: 'applied' as const, lines: ['rb'] })), isBusy: () => false }, supply: okSupply(),
    ownerUserId: o.ownerUserId === undefined ? OWNER : o.ownerUserId, exec: { push }, audit: async (e) => void audits.push(`${e.action} ${e.outcome}`), log: { error() {} },
    dashboardUrl: (h) => `http://127.0.0.1:3000/devjobs/${h}`,
  });
  const payload = { jobId: JOB, repo: ASSISTANT_REPO, base, head, bundleSha256: sha, requesterId: ADMIN };
  const card = { id: 'c'.repeat(32), channelId: '5'.repeat(18), payload, snapshot: { canon: canonical(payload) } };
  return { svc, job, bundle, payload, card, finish, push, apply, audits, base, head, sha };
}

describe('CodeService (X16, X20, OD-5)', () => {
  it('propose re-derives facts; a docs-only change is Bot Admin territory, the summary leads with code facts and labels model text', async () => {
    const x = rig({ 'docs/a.md': 'a\n' });
    const p = await x.svc.propose(x.payload, ADMIN);
    expect(p).toMatchObject({ ok: true, snapshot: { ownerOnly: false } });
    const c = await x.svc.check(x.card, ADMIN);
    expect(c).toMatchObject({ ok: true, ownerOnly: false, bind: { head: x.head, bundleSha256: x.sha } });
    if (!c.ok) throw new Error('x');
    expect(c.summary.split('\n')[0]).toMatch(/^CODE CHANGE Lab-Work-Space\/Assistant: base [0-9a-f]{12} -> head [0-9a-f]{12}/);
    expect(c.summary).toMatch(/model-written, unverified: Adds a doc @​everyone/);
    expect(c.summary).toMatch(/tests 10 -> 11/);
    expect(c.summary).toMatch(/Full diff: http:\/\/127\.0\.0\.1:3000\/devjob/);
    expect(c.summary.length).toBeLessThanOrEqual(1700);
  });
  it('G2SC-09: the summary names the requester and the executor-computed diff hash, and the audit names the requester next to the decider', async () => {
    const x = rig({ 'docs/a.md': 'a\n' });
    const c = await x.svc.check(x.card, ADMIN);
    if (!c.ok) throw new Error('x');
    expect(c.summary).toMatch(new RegExp(`requested by <${ADMIN}>, diff sha256 [0-9a-f]{16}`));
    await x.svc.apply(x.card, ADMIN, c.bind);
    expect(x.audits.join('\n')).toMatch(new RegExp(`code\\.requested-by job:${JOB} requester:${ADMIN} decider:${ADMIN}`));
    const forged = rig({ 'docs/a.md': 'a\n' }, { mutate: (j) => { j.requesterId = OWNER; } });
    expect(await forged.svc.check(forged.card, ADMIN)).toMatchObject({ ok: false, why: expect.stringMatching(/does not match the card/) });
  });
  it('G2SC-02: an untrusted code root refuses check, propose and apply before anything is read', async () => {
    const x = rig({ 'docs/a.md': 'a\n' });
    const svc = new CodeService({ ...(x.svc as unknown as { d: ConstructorParameters<typeof CodeService>[0] }).d, trust: () => 'repo.git is writable by the owner uid' });
    expect(await svc.check(x.card, ADMIN)).toMatchObject({ ok: false, why: expect.stringMatching(/not trusted: repo\.git is writable/) });
    expect(await svc.propose(x.payload, ADMIN)).toMatchObject({ ok: false });
    expect(await svc.apply(x.card, ADMIN, { head: x.head, bundleSha256: x.sha })).toMatchObject({ kind: 'refused' });
    expect(x.apply).not.toHaveBeenCalled();
  });
  it('a code change is owner-only: Bot Admin is refused, the owner passes, and with no owner configured it is refused', async () => {
    const x = rig({ 'tools/new.ts': 'export const n = 1;\n' });
    expect(await x.svc.check(x.card, ADMIN)).toMatchObject({ ok: false, why: expect.stringMatching(/only the owner/) });
    expect(await x.svc.check(x.card, OWNER)).toMatchObject({ ok: true, ownerOnly: true });
    const y = rig({ 'tools/new.ts': 'export const n = 1;\n' }, { ownerUserId: null });
    expect(await y.svc.check(y.card, OWNER)).toMatchObject({ ok: false, why: expect.stringMatching(/no owner is configured/) });
  });
  it('refuses a non-self-modifiable diff, lints and the closure even when every reviewer approved', async () => {
    const x = rig({ 'executor/confirm.ts': 'export {}\n' });
    expect(await x.svc.check(x.card, OWNER)).toMatchObject({ ok: false, why: expect.stringMatching(/non-self-modifiable/) });
    expect((await x.svc.propose(x.payload, ADMIN))).toMatchObject({ ok: false });
    const y = rig({ 'tools/a.ts': 'const s = "a‮b";\n' });
    expect(await y.svc.check(y.card, OWNER)).toMatchObject({ ok: false, why: expect.stringMatching(/bidirectional/) });
  });
  it('X16 forged row: a card whose head differs from the job, a job that is not ready, another repo or kind', async () => {
    const x = rig({ 'docs/a.md': 'a\n' });
    const forged = { ...x.payload, head: 'f'.repeat(40) };
    expect(await x.svc.check({ ...x.card, payload: forged, snapshot: { canon: canonical(forged) } }, ADMIN)).toMatchObject({ ok: false, why: expect.stringMatching(/does not match the card/) });
    expect(await x.svc.check({ ...x.card, snapshot: { canon: 'something else' } }, ADMIN)).toMatchObject({ ok: false, why: expect.stringMatching(/differs from the one that was shown/) });
    const notReady = rig({ 'docs/a.md': 'a\n' }, { mutate: (j) => { j.status = 'failed'; } });
    expect(await notReady.svc.check(notReady.card, ADMIN)).toMatchObject({ ok: false, why: expect.stringMatching(/not ready/) });
    const other = rig({ 'docs/a.md': 'a\n' }, { mutate: (j) => { j.repo = 'Lab-Work-Space/Other'; } });
    expect(await other.svc.check(other.card, ADMIN)).toMatchObject({ ok: false, why: expect.stringMatching(/not an Assistant code job/) });
    expect(await x.svc.propose({ ...x.payload, extra: 1 }, ADMIN)).toMatchObject({ ok: false });
  });
  it('X16 bundle swap: other bytes under the same digest column are refused; a bundle with two heads is refused', async () => {
    const x = rig({ 'docs/a.md': 'a\n' }, { mutate: (_j, b) => { b.data = Buffer.from('not the bundle that was shown'); } });
    expect(await x.svc.check(x.card, ADMIN)).toMatchObject({ ok: false, why: expect.stringMatching(/does not match the digest/) });
    const y = rig({ 'docs/a.md': 'a\n' });
    sh(src.dir, 'update-ref', 'refs/heads/extra', y.head);
    sh(src.dir, 'update-ref', 'refs/heads/job', y.head);
    sh(src.dir, 'bundle', 'create', join(dir, 'two.bundle'), `${y.base}..refs/heads/job`, `${y.base}..refs/heads/extra`);
    const data = readFileSync(join(dir, 'two.bundle'));
    const sha = createHash('sha256').update(data).digest('hex');
    const z = { ...y.payload, bundleSha256: sha, requesterId: ADMIN };
    const bad = new CodeService({ ...(y.svc as unknown as { d: ConstructorParameters<typeof CodeService>[0] }).d, jobs: { get: async () => ({ ...y.job, bundleSha256: sha }), getBundle: async () => ({ sha256: sha, size: data.length, data }), finish: y.finish } });
    expect(await bad.check({ ...y.card, payload: z, snapshot: { canon: canonical(z) } }, ADMIN)).toMatchObject({ ok: false, why: expect.stringMatching(/2 heads/) });
  });
  it('X17 base moved: the executor main is ahead of the job base', async () => {
    const x = rig({ 'docs/a.md': 'a\n' });
    const other = src.commit({ 'docs/other.md': 'o\n' });
    sh(src.dir, 'push', '-q', join(dir, 'repo.git'), `${other}:refs/heads/main`);
    expect(await x.svc.check(x.card, ADMIN)).toMatchObject({ ok: false, why: expect.stringMatching(/current main/) });
  });
  it('apply binds to the shown head and bundle, records the end state, posts a code-written result and leaves no bundle copy', async () => {
    const x = rig({ 'docs/a.md': 'a\n' });
    const bad = await x.svc.apply(x.card, ADMIN, { head: 'f'.repeat(40), bundleSha256: x.sha });
    expect(bad).toMatchObject({ kind: 'refused', why: expect.stringMatching(/differs from the one shown/) });
    expect(x.apply).not.toHaveBeenCalled();
    const ok = await x.svc.apply(x.card, ADMIN, { head: x.head, bundleSha256: x.sha });
    expect(ok).toMatchObject({ kind: 'done', ok: true });
    expect(x.apply).toHaveBeenCalledWith({ jobId: JOB, base: x.base, head: x.head, by: ADMIN, bundleSha256: x.sha });
    expect(x.finish).toHaveBeenCalledWith(JOB, 'applied', 'Applied.');
    expect(x.push).toHaveBeenCalledWith('code.result', expect.objectContaining({ text: expect.stringMatching(/applied and healthy/) }));
    expect(readdirSync(join(dir, 'bundles'))).toEqual([]);
  });
  it('a rollback result is reported as rolled back and recorded', async () => {
    const x = rig({ 'docs/a.md': 'a\n' });
    x.apply.mockResolvedValueOnce({ ok: false, outcome: 'rolled_back', lines: ['unhealthy'] } as never);
    const r = await x.svc.apply(x.card, ADMIN, { head: x.head, bundleSha256: x.sha });
    expect(r).toMatchObject({ kind: 'done', ok: false });
    expect(x.finish).toHaveBeenCalledWith(JOB, 'rolled_back', 'unhealthy');
    expect(x.push).toHaveBeenCalledWith('code.result', expect.objectContaining({ text: expect.stringMatching(/ROLLED BACK/) }));
  });
});

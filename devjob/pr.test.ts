import { describe, expect, it, vi } from 'vitest';
import { BRANCH_RE, PR_PERMISSIONS, pushAndOpenPr, pushInvocation, type PrPorts } from './pr.js';

const JOB = 'J-0123456789abcdef';
const SHA = 'a'.repeat(40);
const ALLOW = [{ id: 42, fullName: 'Lab-Work-Space/landing' }];

function ports(over: Partial<PrPorts> = {}) {
  const p = {
    repoInfo: vi.fn(async (n: string) => ({ id: 42, fullName: n, defaultBranch: 'main' })),
    branchExists: vi.fn(async () => false),
    token: vi.fn(async () => 'ghs_SECRETTOKEN'),
    push: vi.fn(async (_inv: { argv: string[]; env: Record<string, string> }) => undefined),
    openPr: vi.fn(async () => ({ url: 'https://github.com/Lab-Work-Space/landing/pull/1' })),
  };
  return Object.assign(p, over) as typeof p;
}
const run = (p: ReturnType<typeof ports>, o: Partial<Parameters<typeof pushAndOpenPr>[0]> = {}) => pushAndOpenPr({ ports: p, fullName: 'Lab-Work-Space/landing', jobId: JOB, sha: SHA, changedPaths: ['src/a.ts'], title: 't', allowlist: ALLOW, deniedIds: new Set(), ...o });

describe('X23 PR path', () => {
  it('pushes bot/<job> with a one-repo, contents+pull_requests token, then opens a PR against the resolved default branch', async () => {
    const p = ports();
    expect(await run(p)).toEqual({ ok: true, url: 'https://github.com/Lab-Work-Space/landing/pull/1' });
    expect(p.token).toHaveBeenCalledWith({ repoId: 42, permissions: { contents: 'write', pull_requests: 'write' } });
    expect(Object.keys(PR_PERMISSIONS).sort()).toEqual(['contents', 'pull_requests']); // no `workflows`
    expect(p.openPr).toHaveBeenCalledWith(expect.objectContaining({ head: `bot/${JOB}`, base: 'main' }));
  });
  it('the token is only in the environment of the git child: never in argv, a URL or a refspec; no force', async () => {
    const p = ports();
    await run(p);
    const inv = p.push.mock.calls[0]![0];
    expect(inv.argv.join(' ')).not.toContain('ghs_SECRETTOKEN');
    expect(inv.argv.join(' ')).not.toContain(Buffer.from('x-access-token:ghs_SECRETTOKEN').toString('base64'));
    expect(inv.argv.some((a) => a.startsWith('+') || /force/.test(a))).toBe(false);
    expect(inv.argv).toContain(`${SHA}:refs/heads/bot/${JOB}`);
    expect(inv.env.GIT_CONFIG_KEY_0).toBe('http.extraHeader');
    expect(inv.env.GIT_CONFIG_VALUE_0).toContain('Authorization: Basic');
    expect(JSON.stringify(inv.argv)).not.toMatch(/@github\.com/);
  });
  it('refuses a denied or non-allowlisted repository, the default branch, an existing branch and .github/ changes before any token is minted', async () => {
    const a = ports();
    expect(await run(a, { allowlist: [] })).toMatchObject({ ok: false });
    expect(await run(a, { deniedIds: new Set([42]) })).toMatchObject({ ok: false });
    expect(await run(a, { fullName: 'Lab-Work-Space/Assistant' })).toMatchObject({ ok: false });
    const d = ports({ repoInfo: vi.fn(async (n: string) => ({ id: 42, fullName: n, defaultBranch: `bot/${JOB}` })) });
    expect(await run(d)).toMatchObject({ ok: false, why: expect.stringContaining('default branch') });
    const e = ports({ branchExists: vi.fn(async () => true) });
    expect(await run(e)).toMatchObject({ ok: false, why: expect.stringContaining('already exists') });
    const w = ports();
    expect(await run(w, { changedPaths: ['src/a.ts', '.GitHub/workflows/x.yml'] })).toMatchObject({ ok: false, why: expect.stringContaining('.github') });
    const r = ports({ repoInfo: vi.fn(async () => ({ id: 42, fullName: 'Lab-Work-Space/other', defaultBranch: 'main' })) });
    expect(await run(r)).toMatchObject({ ok: false });
    for (const x of [a, d, e, w, r]) { expect(x.token).not.toHaveBeenCalled(); expect(x.push).not.toHaveBeenCalled(); }
  });
  it('branch names and push inputs are strictly validated', () => {
    expect(BRANCH_RE.test(`bot/${JOB}`)).toBe(true);
    for (const b of ['main', 'bot/x', `bot/${JOB}/../main`, `refs/heads/bot/${JOB}`, `bot/${JOB}\n`]) expect(BRANCH_RE.test(b)).toBe(false);
    expect(() => pushInvocation({ fullName: 'a/b', branch: 'main', sha: SHA, token: 't' })).toThrow();
    expect(() => pushInvocation({ fullName: 'a/b;rm', branch: `bot/${JOB}`, sha: SHA, token: 't' })).toThrow();
    expect(() => pushInvocation({ fullName: 'a/b', branch: `bot/${JOB}`, sha: 'HEAD', token: 't' })).toThrow();
  });
});

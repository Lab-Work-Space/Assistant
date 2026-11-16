import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { toGeminiSchema } from '../../../providers/gemini/convert.js';
import type { ToolContext } from '../../types.js';
import { webRig } from '../web/test-helpers.js';
import { LWS, REPO, WRITE_CALLS, allow, lwsRepo, rig } from './test-helpers.js';

const T = { now: Date.UTC(2026, 10, 1, 12, 0, 0) };
const WIDGETS = { id: 777, fullName: 'acme/widgets' };
const MAIN_SHA = 'a'.repeat(40);
const FIX_SHA = 'b'.repeat(40);
const OLD = 'one\ntwo\nthree\n';
const repoWith = { ...REPO, branches: { main: MAIN_SHA, 'praw/fix': FIX_SHA }, files: { 'praw/fix:src/a.ts': OLD } };
const direct: Partial<ToolContext> = { direct: true, origin: 'chat' };
const blob = (s: string) => createHash('sha1').update(s).digest('hex');
const reasons = (a: { request: { mock: { calls: unknown[][] } } }) => a.request.mock.calls.map((c) => (c[0] as { reason: string }).reason);

const on = (owner: string, repo: string) => WRITE_CALLS.map(([n, i]) => [n, { ...i, owner, repo }] as [string, Record<string, unknown>]);

describe('AC10', () => {
  it('write against Lab-Work-Space/Assistant refused even when it is on the allowlist', async () => {
    const { g, f, writes } = rig({ account: LWS, repos: [lwsRepo('Assistant', 11)] }, T, allow({ id: 11, fullName: 'Lab-Work-Space/Assistant' }));
    const { reg, c, approvals } = await webRig(g.tools, direct);
    for (const [name, input] of on('Lab-Work-Space', 'Assistant')) {
      const r = await reg.run(name, input, c);
      expect(r.isError, name).toBe(true);
      expect(r.content, name).toMatch(/never allowed/);
      expect((await reg.runApproved(name, input, c)).content, name).toMatch(/never allowed/);
    }
    expect(approvals.request).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(f.requests).toEqual([]); // refused on the name before any request, not even a token
  });
});

describe('write', () => {
  it('tools: destructive, schemas convert, own fixed-text output', () => {
    const { g } = rig({}, T, allow(WIDGETS));
    const by = Object.fromEntries(g.tools.map((t) => [t.name, t]));
    for (const [n] of WRITE_CALLS) {
      expect(by[n]?.kind, n).toBe('destructive');
      expect(typeof by[n]?.precheck, n).toBe('function');
      expect(() => toGeminiSchema(by[n]!.inputSchema as never), n).not.toThrow();
    }
  });

  it('write › allowlisted repo → awaiting_approval with repo, branch/path and diff summary in the card', async () => {
    const { g, writes, mints } = rig({ repos: [repoWith] }, T, allow(WIDGETS));
    const { reg, c, approvals } = await webRig(g.tools, direct); // even a direct untainted human run: destructive always asks
    for (const [name, input] of WRITE_CALLS) expect((await reg.run(name, input, c)).content, name).toMatch(/^NOT DONE YET: waiting for approval of/);
    const [branch, file, pr] = reasons(approvals);
    expect(branch).toMatch(/^tool github_create_branch on acme\/widgets#777: create branch praw\/feat from main at aaaaaaa/);
    expect(file).toMatch(/^tool github_create_or_update_file on acme\/widgets#777: branch praw\/fix, path src\/a\.ts: update existing file at blob [0-9a-f]{7} \(3 -> 4 lines, \+2 -1, \d+ bytes\), commit "fix: update a"/);
    expect(pr).toMatch(/^tool github_create_pull_request on acme\/widgets#777: pull request praw\/fix -> main, title "Fix a", 12-character description/);
    expect(writes).toEqual([]);
    expect(mints.every((m) => Object.values(m.body.permissions ?? {}).every((v) => v === 'read'))).toBe(true); // no write token before approval
  });

  it('write › new file card says new file; quotes in model text are escaped', async () => {
    const { g } = rig({ repos: [repoWith] }, T, allow(WIDGETS));
    const { reg, c, approvals } = await webRig(g.tools);
    await reg.run('github_create_or_update_file', { owner: 'acme', repo: 'widgets', branch: 'praw/fix', path: './docs//new.md', content: 'a\nb', message: 'x", approved: "yes' }, c);
    expect(reasons(approvals)[0]).toMatch(/path docs\/new\.md: create new file \(2 lines, 3 bytes\), commit "x\\", approved: \\"yes"/);
  });

  it('write › approved call runs once; allowlist removal between approval and run refuses', async () => {
    const { g, writes, mints, cfg } = rig({ repos: [repoWith] }, T, allow(WIDGETS));
    const { reg, c } = await webRig(g.tools);
    const [, input] = WRITE_CALLS[1]!;
    expect((await reg.run('github_create_or_update_file', input, c)).content).toMatch(/^NOT DONE YET: waiting for approval of/);
    const ok = await reg.runApproved('github_create_or_update_file', input, c);
    expect(ok.isError, ok.content).toBeFalsy();
    expect(ok.content).toMatch(/^Committed src\/a\.ts to praw\/fix in acme\/widgets \(commit [0-9a-f]{7}\)\.$/);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ repo: 'acme/widgets', method: 'PUT', path: 'contents/src/a.ts', body: { branch: 'praw/fix', message: 'fix: update a', sha: blob(OLD), content: Buffer.from('one\nTWO\nthree\nfour\n').toString('base64') } });
    expect(mints.filter((m) => m.body.permissions?.['contents'] === 'write').map((m) => m.body)).toEqual([{ repository_ids: [777], permissions: { contents: 'write' } }]);
    // the grant cannot outlive a config change: removed from the allowlist after approval, before execution
    await cfg.set('github.repoAllowlist', [], 'test');
    const late = await reg.runApproved('github_create_or_update_file', input, c);
    expect(late.isError).toBe(true);
    expect(late.content).toMatch(/not on github\.repoAllowlist/);
    expect(writes).toHaveLength(1);
  });

  it('write › a push between approval and run refuses (blob sha changed)', async () => {
    const { g, writes } = rig({ repos: [repoWith] }, T, allow(WIDGETS));
    const { reg, c, approvals } = await webRig(g.tools);
    const [, input] = WRITE_CALLS[1]!;
    expect((await reg.run('github_create_or_update_file', input, c)).content).toMatch(/^NOT DONE YET: waiting for approval of/);
    const stored = (approvals.request.mock.calls[0] as unknown as [{ tool: { input: Record<string, unknown> } }])[0].tool.input;
    expect(stored).toEqual({ ...input, base_sha: blob(OLD) }); // the pin is in the stored (digested) call
    expect(reasons(approvals)[0]).toContain(`at blob ${blob(OLD).slice(0, 7)}`);
    // someone else pushes to the branch before the decision
    expect((await reg.runApproved('github_create_or_update_file', { ...input, content: 'other\n' }, c)).isError).toBeFalsy();
    const late = await reg.runApproved('github_create_or_update_file', stored, c);
    expect(late.isError).toBe(true);
    expect(late.content).toMatch(/changed since this call was checked/);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body['sha']).toBe(blob(OLD)); // the pin is also sent to GitHub, whose 409 enforces it
  });

  it('write › a new-file pin (base_sha null) refuses when the file appeared meanwhile', async () => {
    const { g, writes } = rig({ repos: [repoWith] }, T, allow(WIDGETS));
    const { reg, c, approvals } = await webRig(g.tools);
    const input = { ...WRITE_CALLS[1]![1], path: 'src/new.ts' };
    await reg.run('github_create_or_update_file', input, c);
    const stored = (approvals.request.mock.calls[0] as unknown as [{ tool: { input: Record<string, unknown> } }])[0].tool.input;
    expect(stored['base_sha']).toBeNull();
    expect((await reg.runApproved('github_create_or_update_file', input, c)).isError).toBeFalsy(); // created by another call
    expect((await reg.runApproved('github_create_or_update_file', stored, c)).content).toMatch(/changed since this call was checked/);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body['sha']).toBeUndefined();
  });

  it('write › branch head moved between approval and run refuses; create_branch uses the pinned head', async () => {
    let head = MAIN_SHA;
    const extraRoutes = { 'GET https://api.github.com/repos/acme/widgets/git/ref/heads/main': () => ({ body: { ref: 'refs/heads/main', object: { type: 'commit', sha: head } } }) };
    const { g, writes } = rig({ repos: [repoWith], extraRoutes }, T, allow(WIDGETS));
    const { reg, c, approvals } = await webRig(g.tools);
    await reg.run('github_create_branch', WRITE_CALLS[0]![1], c);
    const stored = (approvals.request.mock.calls[0] as unknown as [{ tool: { input: Record<string, unknown> } }])[0].tool.input;
    expect(stored['from_sha']).toBe(MAIN_SHA);
    head = 'c'.repeat(40); // main moved
    expect((await reg.runApproved('github_create_branch', stored, c)).content).toMatch(/changed since this call was checked/);
    expect(writes).toEqual([]);
    head = MAIN_SHA;
    expect((await reg.runApproved('github_create_branch', stored, c)).isError).toBeFalsy();
    expect(writes[0]!.body).toEqual({ ref: 'refs/heads/praw/feat', sha: MAIN_SHA });
  });

  it('write › pull request pins the praw/ head sha; a push after approval refuses the replay (MOVED)', async () => {
    let head = FIX_SHA;
    const extraRoutes = { 'GET https://api.github.com/repos/acme/widgets/git/ref/heads/praw/fix': () => ({ body: { ref: 'refs/heads/praw/fix', object: { type: 'commit', sha: head } } }) };
    const { g, writes } = rig({ repos: [repoWith], extraRoutes }, T, allow(WIDGETS));
    const { reg, c, approvals } = await webRig(g.tools);
    expect((await reg.run('github_create_pull_request', WRITE_CALLS[2]![1], c)).content).toMatch(/^NOT DONE YET: waiting for approval of/);
    const stored = (approvals.request.mock.calls[0] as unknown as [{ tool: { input: Record<string, unknown> } }])[0].tool.input;
    expect(stored['head_sha']).toBe(FIX_SHA);
    head = 'e'.repeat(40); // someone pushed to praw/fix
    expect((await reg.runApproved('github_create_pull_request', stored, c)).content).toMatch(/changed since this call was checked/);
    expect(writes).toEqual([]);
    head = FIX_SHA;
    expect((await reg.runApproved('github_create_pull_request', stored, c)).isError).toBeFalsy();
    expect(writes).toHaveLength(1);
  });

  it('write › a file GitHub does not return in full (large or other encoding) is not replaced', async () => {
    const big = { status: 200, body: { type: 'file', encoding: 'none', size: 2_000_000, content: '', sha: 'd'.repeat(40) } };
    const { g, writes } = rig({ repos: [repoWith], extraRoutes: { 'GET https://api.github.com/repos/acme/widgets/contents/src/big.bin': big } }, T, allow(WIDGETS));
    const { reg, c, approvals } = await webRig(g.tools);
    const r = await reg.run('github_create_or_update_file', { ...WRITE_CALLS[1]![1], path: 'src/big.bin' }, c);
    expect(r.content).toMatch(/too large or not returned in full/);
    expect(approvals.request).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('write › not on allowlist refused before any approval row exists', async () => {
    const { g, writes } = rig({ repos: [repoWith] }, T, allow({ id: 778, fullName: 'acme/widgets' })); // same name, other id
    const { reg, c, approvals } = await webRig(g.tools);
    for (const [name, input] of WRITE_CALLS) {
      const r = await reg.run(name, input, c);
      expect(r.isError, name).toBe(true);
      expect(r.content, name).toMatch(/not on github\.repoAllowlist/);
    }
    expect(approvals.request).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('write › repo of another owner than the installation account refused', async () => {
    const other = { ...repoWith, owner: 'evil', id: 9 };
    const { g, writes } = rig({ repos: [other] }, T, allow({ id: 9, fullName: 'evil/widgets' }));
    const { reg, c, approvals } = await webRig(g.tools);
    for (const [name, input] of on('evil', 'widgets')) expect((await reg.run(name, input, c)).content, name).toMatch(/not owned by the account the GitHub App is installed on/);
    expect(approvals.request).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('write › create_branch makes praw/<name> from the default branch head; an existing branch is refused before approval', async () => {
    const { g, writes, mints } = rig({ repos: [repoWith] }, T, allow(WIDGETS));
    const { reg, c, approvals } = await webRig(g.tools);
    const ok = await reg.runApproved('github_create_branch', { owner: 'acme', repo: 'widgets', name: 'feat' }, c);
    expect(ok.content).toBe('Created branch praw/feat in acme/widgets from main.');
    expect(writes).toEqual([{ repo: 'acme/widgets', method: 'POST', path: 'git/refs', body: { ref: 'refs/heads/praw/feat', sha: MAIN_SHA } }]);
    expect(mints.filter((m) => Object.values(m.body.permissions ?? {}).includes('write')).map((m) => m.body)).toEqual([{ repository_ids: [777], permissions: { contents: 'write' } }]);
    const again = await reg.run('github_create_branch', { owner: 'acme', repo: 'widgets', name: 'fix' }, c);
    expect(again.content).toMatch(/already exists/);
    expect(approvals.request).not.toHaveBeenCalled();
  });

  it('write › file and pull request need an existing praw/ branch', async () => {
    const { g, writes } = rig({ repos: [repoWith] }, T, allow(WIDGETS));
    const { reg, c, approvals } = await webRig(g.tools);
    const f = await reg.run('github_create_or_update_file', { ...WRITE_CALLS[1]![1], branch: 'praw/nope' }, c);
    expect(f.content).toMatch(/praw\/nope does not exist/);
    const p = await reg.run('github_create_pull_request', { ...WRITE_CALLS[2]![1], head: 'praw/nope' }, c);
    expect(p.content).toMatch(/praw\/nope does not exist/);
    expect(approvals.request).not.toHaveBeenCalled();
    const pr = await reg.runApproved('github_create_pull_request', WRITE_CALLS[2]![1], c);
    expect(pr.content).toBe('Opened pull request #101 in acme/widgets (praw/fix -> main): https://github.com/acme/widgets/pull/101');
    expect(writes).toEqual([{ repo: 'acme/widgets', method: 'POST', path: 'pulls', body: { title: 'Fix a', body: 'Changes a.ts', head: 'praw/fix', base: 'main' } }]);
  });

  it('write › a write error carries no token, JWT or Authorization', async () => {
    const { g, f } = rig({ repos: [repoWith] }, T, allow(WIDGETS));
    const { reg, c } = await webRig(g.tools);
    const stale = await reg.runApproved('github_create_or_update_file', { ...WRITE_CALLS[1]![1], path: 'src/new.ts' }, c); // fine
    expect(stale.isError, stale.content).toBeFalsy();
    const conflict = rig({ repos: [repoWith], resourceFail: { status: 500 } }, T, allow(WIDGETS));
    const w = await webRig(conflict.g.tools);
    const r = await w.reg.runApproved('github_create_branch', WRITE_CALLS[0]![1], w.c);
    expect(r.isError).toBe(true);
    expect(r.content).not.toMatch(/Bearer|ghs_|eyJ|authorization/i);
    expect(f.requests.length).toBeGreaterThan(0);
  });
});

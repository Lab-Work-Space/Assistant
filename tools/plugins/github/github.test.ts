import { describe, expect, it } from 'vitest';
import { toGeminiSchema } from '../../../providers/gemini/convert.js';
import { webRig } from '../web/test-helpers.js';
import { CONFIG_DEFAULTS } from '../../../config/defaults.js';
import { LWS, PEM, REPO, WRITE_CALLS, allow, lwsRepo, rig } from './test-helpers.js';

const READ = ['github_get_me', 'github_list_my_organizations', 'github_list_org_repositories', 'github_list_user_repositories', 'github_search_repositories', 'github_get_repository_info', 'github_list_repository_issues', 'github_list_repository_pulls', 'github_list_repository_commits', 'github_get_issue', 'github_get_pull_request'];
const CALLS: [string, Record<string, unknown>, RegExp, string][] = [
  ['github_get_me', {}, /Praw Bot[\s\S]*acme/, '/app/installations/'],
  ['github_list_my_organizations', {}, /acme/, '/app/installations/'],
  ['github_list_org_repositories', { org: 'acme' }, /acme\/widgets/, '/orgs/acme/repos'],
  ['github_list_user_repositories', { username: 'alice' }, /alice\/dots/, '/users/alice/repos'],
  ['github_search_repositories', { query: 'widgets language:ts' }, /acme\/widgets/, '/search/repositories'],
  ['github_get_repository_info', { owner: 'acme', repo: 'widgets' }, /acme\/widgets[\s\S]*TypeScript/, '/repos/acme/widgets'],
  ['github_list_repository_issues', { owner: 'acme', repo: 'widgets' }, /#1: Crash on start/, '/repos/acme/widgets/issues'],
  ['github_list_repository_pulls', { owner: 'acme', repo: 'widgets' }, /#2: Fix crash/, '/repos/acme/widgets/pulls'],
  ['github_list_repository_commits', { owner: 'acme', repo: 'widgets', branch: 'main', limit: 5 }, /abcdef1.*fix: crash.*alice/, '/repos/acme/widgets/commits'],
  ['github_get_issue', { owner: 'acme', repo: 'widgets', issue_number: 1 }, /Crash on start[\s\S]*steps to reproduce/, '/repos/acme/widgets/issues/1'],
  ['github_get_pull_request', { owner: 'acme', repo: 'widgets', pr_number: 2 }, /Fix crash[\s\S]*fix[\s\S]*main[\s\S]*\+10 -4/, '/repos/acme/widgets/pulls/2'],
];

describe('read', () => {
  it('each tool hits the expected fake endpoint; results wrapped untrusted', async () => {
    const { g, f } = rig();
    expect(g.tools.filter((t) => t.kind === 'read').map((t) => t.name)).toEqual(READ);
    for (const t of g.tools.filter((x) => x.kind === 'read')) {
      expect(t.kind, t.name).toBe('read');
      expect(t.untrustedOutput, t.name).toBe(true);
      expect(() => toGeminiSchema(t.inputSchema as never), t.name).not.toThrow();
    }
    const { reg, c } = await webRig(g.tools);
    for (const [name, args, re, path] of CALLS) {
      const before = f.requests.length;
      const r = await reg.run(name, args, c);
      expect(r.isError, `${name}: ${r.content}`).toBeFalsy();
      expect(r.content, name).toMatch(new RegExp(`^<untrusted-[0-9a-f]{16} source="github" author="${name}" kind="model">\\n`));
      expect(r.content, name).toMatch(re);
      const calls = f.requests.slice(before).filter((q) => q.method === 'GET' && !q.url.includes('/access_tokens'));
      expect(calls.some((q) => q.url.includes(path)), `${name} -> ${calls.map((q) => q.url).join(' ')}`).toBe(true);
      for (const q of calls) expect(q.headers['authorization'], name).toMatch(/^Bearer (ghs_\w+|[\w-]+\.[\w-]+\.[\w-]+)$/);
    }
    expect(c.tainted()).toBe(true);
  });

  it('issue list drops pull requests; commits limit and branch pass as query only', async () => {
    const { client, f } = rig();
    const issues = await client.listRepositoryIssues('acme', 'widgets', 'open');
    expect(issues.items.map((i) => i.number)).toEqual([1]);
    await client.listRepositoryCommits('acme', 'widgets', 'feature/x', 500);
    const q = new URL(f.requests.filter((r) => r.url.includes('/commits')).at(-1)!.url);
    expect(q.searchParams.get('sha')).toBe('feature/x');
    expect(Number(q.searchParams.get('per_page'))).toBeLessThanOrEqual(30);
  });

  it('read tokens are read-only and per-repo; repo-less reads get metadata only', async () => {
    const { client, mints } = rig();
    await client.getRepositoryInfo('acme', 'widgets');
    await client.listRepositoryIssues('acme', 'widgets', 'open');
    await client.listRepositoryPulls('acme', 'widgets', 'open');
    await client.listRepositoryCommits('acme', 'widgets', undefined, 5);
    await client.getIssue('acme', 'widgets', 1);
    await client.getPullRequest('acme', 'widgets', 2);
    await client.listOrgRepositories('acme');
    await client.searchRepositories('x');
    const scoped = mints.filter((m) => m.body.repositories);
    expect(scoped.length).toBe(4); // metadata, issues, pull_requests, contents; the same scope is reused within the token lifetime
    for (const m of scoped) {
      expect(m.body.repositories).toEqual(['widgets']);
      expect(Object.values(m.body.permissions!).every((v) => v === 'read')).toBe(true);
      expect(Object.keys(m.body.permissions!)).toContain('metadata');
      expect(Object.keys(m.body.permissions!)).not.toContain('workflows');
      expect(Object.keys(m.body.permissions!)).not.toContain('administration');
    }
    expect(mints.filter((m) => !m.body.repositories).map((m) => m.body)).toEqual([{ permissions: { metadata: 'read' } }]);
  });

  it('read › reads work on any repo the App can see (allowlist applies to writes only, Task 30)', async () => {
    const other = { ...REPO, name: 'secret-thing', id: 5, issues: [{ number: 9, title: 'Elsewhere', state: 'open', user: { login: 'z' } }] };
    const { client } = rig({ repos: [REPO, other] });
    expect((await client.getRepositoryInfo('acme', 'secret-thing')).fullName).toBe('acme/secret-thing');
    expect((await client.getIssue('acme', 'secret-thing', 9)).title).toBe('Elsewhere');
  });

  it('lists are capped at 3 pages and say so', async () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ full_name: `acme/r${i}`, private: false }));
    const { client, f } = rig({ orgRepos: { acme: many } });
    const r = await client.listOrgRepositories('acme');
    expect(r.items).toHaveLength(90);
    expect(r.truncated).toBe(true);
    expect(f.requests.filter((q) => q.url.includes('/orgs/acme/repos'))).toHaveLength(3);
  });
});

describe('defaults', () => {
  it('tools.byDept software and it list exactly the real read tools (and no write tool)', () => {
    for (const d of ['software', 'it'] as const) {
      const names = (CONFIG_DEFAULTS['tools.byDept'][d] ?? []).filter((n) => n.startsWith('github_'));
      expect([...names].sort()).toEqual([...READ].sort());
    }
  });
});

describe('github.test.ts', () => {
  it('owner/repo "a/../b" rejected; ids encoded', async () => {
    const { client, f } = rig();
    for (const [o, r] of [['a/..', 'b'], ['..', 'x'], ['acme', 'a..b'], ['acme', '../x'], ['ac me', 'x'], ['acme', 'x/y'], ['acme', 'x?y=1'], ['', 'x'], ['a'.repeat(101), 'x']] as const)
      await expect(client.getRepositoryInfo(o, r), `${o}/${r}`).rejects.toThrow('GitHub: invalid owner or repository name');
    await expect(client.getIssue('acme', 'widgets', 0)).rejects.toThrow(/invalid/);
    await expect(client.getIssue('acme', 'widgets', 1.5)).rejects.toThrow(/invalid/);
    await expect(client.listOrgRepositories('a/b')).rejects.toThrow(/invalid/);
    expect(f.requests).toHaveLength(0); // refused without a request, not even a token mint
    await expect(client.getRepositoryInfo('Acme', 'widgets')).rejects.toThrow('HTTP 404'); // a valid pattern is a plain request
  });

  it('error result has no Authorization header', async () => {
    const { client, g, f } = rig();
    const e = (await client.getRepositoryInfo('acme', 'nope').catch((x: unknown) => x)) as Error;
    expect(e.message).toBe('GitHub: repository not found or not visible to the App (HTTP 404)');
    const blob = JSON.stringify({ m: e.message, s: e.stack });
    expect(blob).not.toMatch(/Bearer|ghs_|authorization|eyJ/i);
    const { reg, c } = await webRig(g.tools);
    const r = await reg.run('github_get_issue', { owner: 'acme', repo: 'widgets', issue_number: 404 }, c);
    expect(r.isError).toBe(true);
    expect(r.content).not.toMatch(/Bearer|ghs_|eyJ|authorization/i);
    expect(f.requests.length).toBeGreaterThan(0);
  });

  it('rate limit (403/429 with x-ratelimit-remaining 0) gives one fixed error', async () => {
    for (const status of [403, 429]) {
      const { client } = rig({ resourceFail: { status, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000' } } });
      await expect(client.getRepositoryInfo('acme', 'widgets')).rejects.toThrow('GitHub rate limit reached, try again later');
    }
    const { client } = rig({ resourceFail: { status: 403, headers: { 'retry-after': '60' } } }); // secondary limit
    await expect(client.getRepositoryInfo('acme', 'widgets')).rejects.toThrow('GitHub rate limit reached, try again later');
    const plain = rig({ resourceFail: { status: 403 } });
    await expect(plain.client.getRepositoryInfo('acme', 'widgets')).rejects.toThrow('GitHub refused the request (HTTP 403)');
  });

  it('secrets › key, JWT and tokens never in outputs, audit, errors', async () => {
    const { g, mints, f } = rig();
    const { reg, c } = await webRig(g.tools);
    const outs: string[] = [];
    for (const [name, args] of CALLS) outs.push((await reg.run(name, args, c)).content);
    outs.push((await reg.run('github_get_issue', { owner: 'acme', repo: 'widgets', issue_number: 404 }, c)).content);
    const jwts = f.requests.filter((q) => q.url.includes('/access_tokens')).map((q) => q.headers['authorization']!.slice(7));
    expect(jwts.length).toBeGreaterThan(0);
    for (const o of outs) {
      expect(o).not.toContain('PRIVATE KEY');
      expect(o).not.toContain(PEM.split('\n')[1]!);
      for (const j of jwts) expect(o).not.toContain(j);
      for (const m of mints) expect(o).not.toContain(m.token);
    }
  });

  it('group is disabled with a reason when the client is absent', async () => {
    const { githubGroup } = await import('./index.js');
    expect(githubGroup({} as never)).toMatchObject({ id: 'github', disabled: expect.stringContaining('GITHUB_APP_ID') });
    expect(githubGroup({ githubDisabled: 'because' } as never)).toEqual({ id: 'github', disabled: 'because' });
  });
});

const T = { now: Date.UTC(2026, 10, 1, 12, 0, 0) };
const lwsCalls = (repo: string) => WRITE_CALLS.map(([n, i]) => [n, { ...i, owner: 'Lab-Work-Space', repo }] as [string, Record<string, unknown>]);
const FILE = WRITE_CALLS[1]![1];

describe('github.test.ts', () => {
  it('github.test.ts › write to Labworkspace_backend refused even if allowlisted', async () => {
    const { g, f, writes } = rig({ account: LWS, repos: [lwsRepo('Labworkspace_backend', 21)] }, T, allow({ id: 21, fullName: 'Lab-Work-Space/Labworkspace_backend' }));
    const { reg, c, approvals } = await webRig(g.tools);
    for (const [name, input] of [...lwsCalls('Labworkspace_backend'), ...lwsCalls('labworkspace_BACKEND')]) {
      const r = await reg.run(name, input, c);
      expect(r.isError, name).toBe(true);
      expect(r.content, name).toMatch(/never allowed/);
    }
    expect(approvals.request).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(f.requests).toEqual([]);
  });

  it('github.test.ts › renamed repo redirect to Assistant refused', async () => {
    // the old name is allowlisted by id; GitHub answers it with the canonical full_name Lab-Work-Space/Assistant
    const { g, f, writes } = rig({ account: LWS, repos: [lwsRepo('Assistant', 11, { aliases: ['helper-bot'] })] }, T, allow({ id: 11, fullName: 'Lab-Work-Space/helper-bot' }));
    const { reg, c, approvals } = await webRig(g.tools);
    for (const [name, input] of lwsCalls('helper-bot')) {
      const r = await reg.run(name, input, c);
      expect(r.content, name).toMatch(/never allowed/);
      expect((await reg.runApproved(name, input, c)).content, name).toMatch(/never allowed/);
    }
    expect(f.requests.some((q) => q.url.endsWith('/repos/Lab-Work-Space/helper-bot'))).toBe(true); // resolved through the API
    expect(approvals.request).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    // real GitHub answers a renamed repo with 301; the client never follows redirects, so this fails closed
    const moved = rig({ account: LWS, repos: [], extraRoutes: { 'GET https://api.github.com/repos/Lab-Work-Space/moved': { status: 301, headers: { location: 'https://api.github.com/repositories/11' } } } }, T, allow({ id: 11, fullName: 'Lab-Work-Space/moved' }));
    const m = await webRig(moved.g.tools);
    const r = await m.reg.run('github_create_branch', { owner: 'Lab-Work-Space', repo: 'moved', name: 'x' }, m.c);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/HTTP 301/);
    expect(moved.f.requests.filter((q) => q.url.includes('/repositories/'))).toEqual([]);
    expect(m.approvals.request).not.toHaveBeenCalled();
    expect(moved.writes).toEqual([]);
  });

  it('github.test.ts › a canonical name not denied but carrying a denied id is refused (rename scenario)', async () => {
    // Lab-Work-Space/Assistant was renamed to helper: the denied name still resolves (redirect) to id 11, which stays denied
    const { g, writes, client } = rig({ account: LWS, repos: [lwsRepo('helper', 11, { aliases: ['Assistant'] })] }, T, allow({ id: 11, fullName: 'Lab-Work-Space/helper' }));
    expect([...(await client.deniedIds())]).toEqual([11]);
    const { reg, c, approvals } = await webRig(g.tools);
    for (const [name, input] of lwsCalls('helper')) {
      expect((await reg.run(name, input, c)).content, name).toMatch(/never allowed/);
      expect((await reg.runApproved(name, input, c)).content, name).toMatch(/never allowed/);
    }
    expect(approvals.request).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('github.test.ts › denied ids that cannot be resolved refuse every write (fail closed); 404 means not installed', async () => {
    const extraRoutes = { 'GET https://api.github.com/repos/Lab-Work-Space/Discord_bot': { status: 500, body: {} } };
    const { g, writes } = rig({ repos: [{ ...REPO, branches: { main: 'a'.repeat(40), 'praw/fix': 'b'.repeat(40) } }], extraRoutes }, T, allow({ id: 777, fullName: 'acme/widgets' }));
    const { reg, c, approvals } = await webRig(g.tools);
    for (const [name, input] of WRITE_CALLS) expect((await reg.run(name, input, c)).content, name).toMatch(/could not be resolved to repository ids/);
    expect(approvals.request).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('github.test.ts › write to default branch refused', async () => {
    const { g, f } = rig({ repos: [{ ...REPO, branches: { main: 'a'.repeat(40), 'praw/fix': 'b'.repeat(40) } }] }, T, allow({ id: 777, fullName: 'acme/widgets' }));
    const { reg, c, approvals } = await webRig(g.tools);
    for (const b of ['main', 'refs/heads/main', 'MAIN']) expect((await reg.run('github_create_or_update_file', { ...FILE, branch: b }, c)).content, b).toMatch(/invalid input/);
    expect((await reg.run('github_create_pull_request', { ...WRITE_CALLS[2]![1], head: 'main' }, c)).content).toMatch(/invalid input/);
    expect(f.requests).toEqual([]);
    // a repository whose default branch itself is under praw/ is still refused
    const odd = rig({ repos: [{ ...REPO, info: { ...REPO.info, default_branch: 'praw/main' }, branches: { 'praw/main': 'a'.repeat(40) } }] }, T, allow({ id: 777, fullName: 'acme/widgets' }));
    const o = await webRig(odd.g.tools);
    for (const [name, input] of [['github_create_or_update_file', { ...FILE, branch: 'praw/main' }], ['github_create_branch', { owner: 'acme', repo: 'widgets', name: 'main' }], ['github_create_pull_request', { ...WRITE_CALLS[2]![1], head: 'praw/main' }]] as [string, Record<string, unknown>][]) {
      const r = await o.reg.run(name, input, o.c);
      expect(r.content, name).toMatch(/default branch/);
      expect((await o.reg.runApproved(name, input, o.c)).content, name).toMatch(/default branch/);
    }
    expect(o.approvals.request).not.toHaveBeenCalled();
    expect(odd.writes).toEqual([]);
    expect(approvals.request).not.toHaveBeenCalled();
  });

  it('github.test.ts › .github/workflows path refused', async () => {
    const { g, f } = rig({}, T, allow({ id: 777, fullName: 'acme/widgets' }));
    const { reg, c, approvals } = await webRig(g.tools);
    for (const path of ['.github/workflows/deploy.yml', './.github/workflows/x.yml', '.GitHub/workflows/x.yml', '//.github//workflows/x.yml', './/./.GITHUB/x', '.github', 'src/../.github/workflows/x.yml', '/etc/passwd', 'a\\b', 'a/\u0000b', 'src/.git/config', '.gitmodules', 'sub/.GITATTRIBUTES', '']) {
      const r = await reg.run('github_create_or_update_file', { ...FILE, path }, c);
      expect(r.isError, path).toBe(true);
      expect(r.content, path).toMatch(/invalid input/);
    }
    expect(approvals.request).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);
  });

  it('github.test.ts › branch not under praw/ refused', async () => {
    const { g, f } = rig({}, T, allow({ id: 777, fullName: 'acme/widgets' }));
    const { reg, c, approvals } = await webRig(g.tools);
    for (const b of ['feature/x', 'praw', 'praw/', 'praw/../main', 'praw/a/b', 'xpraw/a', 'PRAW/a', 'praw/-x', 'praw/a.lock', 'praw/a b', 'praw/a@{1}', 'acme:praw/x'])
      for (const [name, input] of [['github_create_or_update_file', { ...FILE, branch: b }], ['github_create_pull_request', { ...WRITE_CALLS[2]![1], head: b }]] as [string, Record<string, unknown>][])
        expect((await reg.run(name, input, c)).content, `${name} ${b}`).toMatch(/invalid input/);
    for (const n of ['praw/x', 'a/b', '-x', '..', 'a..b', 'x.lock', '', 'a b'])
      expect((await reg.run('github_create_branch', { owner: 'acme', repo: 'widgets', name: n }, c)).content, n).toMatch(/invalid input/);
    expect(approvals.request).not.toHaveBeenCalled();
    expect(f.requests).toEqual([]);
  });

  it('github.test.ts › token request scoped to one repo', async () => {
    const { g, mints } = rig({ repos: [{ ...REPO, branches: { main: 'a'.repeat(40), 'praw/fix': 'b'.repeat(40) }, files: { 'praw/fix:src/a.ts': 'x' } }] }, T, allow({ id: 777, fullName: 'acme/widgets' }));
    const { reg, c } = await webRig(g.tools);
    for (const [name, input] of WRITE_CALLS) {
      expect((await reg.run(name, input, c)).content, name).toMatch(/^NOT DONE YET: waiting for approval of/);
      const r = await reg.runApproved(name, input, c);
      expect(r.isError, `${name}: ${r.content}`).toBeFalsy();
    }
    for (const m of mints) {
      const repos = [...(m.body.repositories ?? []), ...(m.body.repository_ids ?? [])];
      expect(repos.length, JSON.stringify(m.body)).toBe(1); // every token of a write flow names exactly one repository
      expect(Object.keys(m.body.permissions!)).not.toContain('workflows');
      expect(Object.keys(m.body.permissions!)).not.toContain('administration');
      if (Object.values(m.body.permissions!).includes('write')) expect(m.body.repository_ids).toEqual([777]); // write tokens: by the resolved id
    }
    const writeMints = mints.filter((m) => Object.values(m.body.permissions!).includes('write')).map((m) => m.body.permissions);
    expect(writeMints).toEqual(expect.arrayContaining([{ contents: 'write' }, { pull_requests: 'write' }]));
    for (const p of writeMints) expect(Object.keys(p!)).toHaveLength(1);
  });
});

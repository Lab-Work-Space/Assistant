import { z } from 'zod';
import { redactText } from '../../../core/logger.js';
import { toolError, type ToolPlugin, type ToolResult } from '../../types.js';
import type { GroupFactory } from '../index.js';
import { GithubError } from './auth.js';
import { LIST_CAP, type GhIssue, type GhPull, type GhRepo } from './client.js';
import { denylistProblem } from './deny.js';
import { githubWriteTools } from './write.js';

const owner = z.string().min(1).max(100).describe('Repository owner (user or organisation login), letters, digits, - _ . only');
const repo = z.string().min(1).max(100).describe('Repository name');
const state = z.enum(['open', 'closed', 'all']).optional().describe('Default open');
const clip = (s: string | undefined, n: number) => (s ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').slice(0, n);
const repoLine = (r: GhRepo) => `- ${r.fullName}${r.isPrivate ? ' (private)' : ''}${r.language ? ` [${r.language}]` : ''}${r.description ? `: ${clip(r.description, 150)}` : ''}`;
const issueLine = (i: GhIssue) => `- #${i.number}: ${clip(i.title, 200)}${i.author ? ` (by ${i.author})` : ''}`;
const more = (truncated: boolean) => (truncated ? `\n(more than ${LIST_CAP} results; only the first ${LIST_CAP} were read, so this list may be incomplete)` : '');

/**
 * GitHub read tools (Task 29). The client mints a read-only installation token per call, scoped to the one target repository
 * (repo-less reads: metadata only), under the single configured installation (R18, P6). Everything returned is written by other people,
 * so every read tool's output is untrusted. The write tools (Task 30, write.ts) are destructive and gated by github.repoAllowlist
 * plus the hard denylist (deny.ts).
 */
export const githubGroup: GroupFactory = (deps) => {
  const gh = deps.github;
  if (!gh) return { id: 'github', disabled: deps.githubDisabled ?? 'GITHUB_APP_ID / GITHUB_INSTALLATION_ID / GITHUB_APP_PRIVATE_KEY (or GITHUB_APP_PRIVATE_KEY_PATH) not set or not valid' };

  const guarded = async (f: () => Promise<string>): Promise<ToolResult> => {
    try {
      return { content: redactText(await f()) }; // defence in depth: a credential-shaped string in vendor data never reaches the model
    } catch (err) {
      return toolError(err instanceof GithubError ? err.message : 'GitHub request failed'); // fixed text and status only
    }
  };
  const base = { kind: 'read', untrustedOutput: true, untrustedSource: 'github', requiresApproval: () => false } as const;
  const list = <T>(title: string, items: T[], line: (t: T) => string, truncated = false) => (items.length ? `${title}:\n${items.map(line).join('\n')}${more(truncated)}` : `${title}: none${more(truncated)}`);
  const pr = (p: GhPull) => `PR #${p.number}: ${clip(p.title, 200)}\nstate: ${p.state}${p.merged ? ' (merged)' : ''}\nfrom: ${p.head ?? '?'} -> into: ${p.base ?? '?'}\nauthor: ${p.author ?? 'unknown'}\ncreated: ${p.createdAt ?? '?'}\nchanges: ${p.changedFiles ?? 0} files, +${p.additions ?? 0} -${p.deletions ?? 0}\n---\n${clip(p.body, 1500) || '(no description)'}`;

  const tools: ToolPlugin<any>[] = [
    { ...base, name: 'github_get_me', description: 'Show the GitHub App this assistant uses and the account it is installed on.', inputSchema: z.object({}),
      run: () => guarded(async () => { const m = await gh.getMe(); return `GitHub App: ${m.app}${m.slug ? ` (${m.slug})` : ''}\ninstalled on: ${m.account}${m.accountType ? ` (${m.accountType})` : ''}, repositories: ${m.repositorySelection ?? '?'}\npermissions: ${m.permissions || 'none'}`; }) },
    { ...base, name: 'github_list_my_organizations', description: 'List the organisations or users the GitHub App is installed on.', inputSchema: z.object({}),
      run: () => guarded(async () => list('Installed on', await gh.listMyOrganizations(), (a) => `- ${a.login}${a.type ? ` (${a.type})` : ''}`)) },
    { ...base, name: 'github_list_org_repositories', description: 'List repositories of an organisation that the GitHub App can see.', inputSchema: z.object({ org: owner }),
      run: (i: { org: string }) => guarded(async () => { const p = await gh.listOrgRepositories(i.org); return list(`Repositories of ${i.org}`, p.items, repoLine, p.truncated); }) },
    { ...base, name: 'github_list_user_repositories', description: 'List repositories of a user that the GitHub App can see.', inputSchema: z.object({ username: owner }),
      run: (i: { username: string }) => guarded(async () => { const p = await gh.listUserRepositories(i.username); return list(`Repositories of ${i.username}`, p.items, repoLine, p.truncated); }) },
    { ...base, name: 'github_search_repositories', description: 'Search repositories on GitHub (GitHub search syntax, e.g. "org:acme language:ts").', inputSchema: z.object({ query: z.string().min(1).max(256) }),
      run: (i: { query: string }) => guarded(async () => { const r = await gh.searchRepositories(i.query); return list(`${r.total} match(es), showing ${r.items.length}`, r.items, repoLine); }) },
    { ...base, name: 'github_get_repository_info', description: 'Show details of one repository.', inputSchema: z.object({ owner, repo }),
      run: (i: { owner: string; repo: string }) => guarded(async () => { const r = await gh.getRepositoryInfo(i.owner, i.repo); return `${r.fullName}${r.isPrivate ? ' (private)' : ''}\n${clip(r.description, 300) || '(no description)'}\nhomepage: ${clip(r.homepage, 200) || 'none'}\nstars: ${r.stars ?? 0}, forks: ${r.forks ?? 0}\nlanguage: ${r.language ?? 'unknown'}, default branch: ${r.defaultBranch ?? '?'}\ncreated: ${r.createdAt ?? '?'}, updated: ${r.updatedAt ?? '?'}`; }) },
    { ...base, name: 'github_list_repository_issues', description: 'List issues of a repository (pull requests are not included).', inputSchema: z.object({ owner, repo, state }),
      run: (i: { owner: string; repo: string; state?: 'open' | 'closed' | 'all' }) => guarded(async () => { const p = await gh.listRepositoryIssues(i.owner, i.repo, i.state ?? 'open'); return list(`${i.state ?? 'open'} issues of ${i.owner}/${i.repo}`, p.items, issueLine, p.truncated); }) },
    { ...base, name: 'github_list_repository_pulls', description: 'List pull requests of a repository.', inputSchema: z.object({ owner, repo, state }),
      run: (i: { owner: string; repo: string; state?: 'open' | 'closed' | 'all' }) => guarded(async () => { const p = await gh.listRepositoryPulls(i.owner, i.repo, i.state ?? 'open'); return list(`${i.state ?? 'open'} pull requests of ${i.owner}/${i.repo}`, p.items, issueLine, p.truncated); }) },
    { ...base, name: 'github_list_repository_commits', description: 'List the latest commits of a repository, optionally of one branch.', inputSchema: z.object({ owner, repo, branch: z.string().max(200).optional().describe('Branch name; default branch when empty'), limit: z.number().int().min(1).max(30).optional().describe('Default 10') }),
      run: (i: { owner: string; repo: string; branch?: string; limit?: number }) => guarded(async () => list(`Latest commits of ${i.owner}/${i.repo}`, await gh.listRepositoryCommits(i.owner, i.repo, i.branch || undefined, i.limit ?? 10), (c) => `- ${c.sha} ${clip(c.message, 120)} - ${clip(c.author, 60)}${c.date ? ` (${c.date})` : ''}`)) },
    { ...base, name: 'github_get_issue', description: 'Show one issue.', inputSchema: z.object({ owner, repo, issue_number: z.number().int().min(1) }),
      run: (i: { owner: string; repo: string; issue_number: number }) => guarded(async () => { const x = await gh.getIssue(i.owner, i.repo, i.issue_number); return `#${x.number}: ${clip(x.title, 200)}\nstate: ${x.state}\nauthor: ${x.author ?? 'unknown'}\ncreated: ${x.createdAt ?? '?'}\n---\n${clip(x.body, 1500) || '(no description)'}`; }) },
    { ...base, name: 'github_get_pull_request', description: 'Show one pull request.', inputSchema: z.object({ owner, repo, pr_number: z.number().int().min(1) }),
      run: (i: { owner: string; repo: string; pr_number: number }) => guarded(async () => pr(await gh.getPullRequest(i.owner, i.repo, i.pr_number))) },
  ];
  const deny = denylistProblem();
  if (deny) deps.log.warn({ group: 'github' }, `${deny}; every GitHub write is refused until it is fixed`); // fail closed, reads stay on
  return { id: 'github', tools: [...tools, ...githubWriteTools(gh, deps.cfg, guarded)] };
};

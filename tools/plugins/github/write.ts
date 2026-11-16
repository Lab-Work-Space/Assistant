import { z } from 'zod';
import type { ConfigStore } from '../../../config/store.js';
import { GITHUB_NAME } from '../../../services/ids.js';
import type { ToolPlugin, ToolResult } from '../../types.js';
import { GithubError } from './auth.js';
import type { GhTarget, GithubClient } from './client.js';
import { DENIED, isDeniedRepo, repoWriteAllowed } from './deny.js';

const CONTENT_MAX = 100_000;
const MESSAGE_MAX = 200;
const TITLE_MAX = 200;
const BODY_MAX = 4000;
const CHANGE_MAX = 120;
const PATH_MAX = 400;
const DEPTH_MAX = 20;

/** The part after `praw/`: letters, digits, `-` and `_` only, so no `..`, `.lock`, `@{`, `/`, `:` or leading `-` (git ref rules). */
export const BRANCH_SUFFIX = /^[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;
/** The only branches the bot writes to (P6c): created by github_create_branch, never the default branch. */
export const PRAW_BRANCH = /^praw\/[A-Za-z0-9][A-Za-z0-9_-]{0,59}$/;
const SEGMENT = /^[A-Za-z0-9._@+-]{1,255}$/;
const SHA = /^[0-9a-f]{40}$/;
/** Never written: workflows (repository secrets), git internals, submodule and attribute files (filters/hooks-like behaviour). */
const FORBIDDEN = new Set(['.github', '.git', '.gitmodules', '.gitattributes']);

/**
 * A repository file path, normalised (`./`, `//` and `.` segments dropped) and checked lexically: no absolute path, `..`,
 * backslash or control character, allowed characters only, depth cap, and nothing under `.github/` or `.git/` in any case (P6c:
 * workflow files would run with repository secrets).
 */
export function repoPath(p: string): { ok: true; path: string } | { ok: false; why: string } {
  if (p.length === 0 || p.length > PATH_MAX || /[\\\u0000-\u001f\u007f]/.test(p)) return { ok: false, why: 'not a valid repository path' };
  if (p.startsWith('/')) return { ok: false, why: 'must be relative to the repository root' };
  const parts = p.split('/').filter((s) => s !== '' && s !== '.');
  if (parts.length === 0 || parts.length > DEPTH_MAX || parts.some((s) => s === '..' || !SEGMENT.test(s))) return { ok: false, why: 'not a valid repository path' };
  if (parts.some((s) => FORBIDDEN.has(s.toLowerCase()))) return { ok: false, why: 'files under .github/ (workflows) or .git/, .gitmodules and .gitattributes are never written' };
  return { ok: true, path: parts.join('/') };
}

const name = (what: string) => z.string().regex(GITHUB_NAME, 'letters, digits, - _ . only').refine((v) => !v.includes('..') && v !== '.', 'not a valid name').describe(what);
const owner = name('Repository owner (the account the GitHub App is installed on)');
const repo = name('Repository name');
const prawBranch = (what: string) => z.string().regex(PRAW_BRANCH, 'must be a praw/<name> branch created by github_create_branch').describe(what);
const filePath = z.string().min(1).max(PATH_MAX).superRefine((p, ctx) => { const r = repoPath(p); if (!r.ok) ctx.addIssue({ code: 'custom', message: r.why }); }).describe('File path from the repository root, e.g. src/index.ts');

/** Quoted with JSON escaping, so a `"` or newline in model text cannot fake the card's structure. */
const q = (s: string) => JSON.stringify(s.length > CHANGE_MAX ? `${s.slice(0, CHANGE_MAX)}...` : s);
const lines = (s: string) => (s === '' ? [] : s.replace(/\n$/, '').split('\n'));
/** Lines added and removed, counted as multisets (order-insensitive, enough for a card). */
function lineDiff(oldText: string, newText: string): { added: number; removed: number } {
  const left = new Map<string, number>();
  for (const l of lines(oldText)) left.set(l, (left.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of lines(newText)) {
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1);
    else added++;
  }
  return { added, removed: [...left.values()].reduce((a, b) => a + b, 0) };
}

const NOT_OWNER = 'GitHub: that repository is not owned by the account the GitHub App is installed on';
const DEFAULT_BRANCH = 'GitHub: writes to the default branch are never allowed; use a praw/ branch and a pull request';
const missing = (b: string) => `GitHub: branch ${b} does not exist; create it with github_create_branch first`;

type Ident = { owner: string; repo: string };
type BranchIn = Ident & { name: string; from_sha?: string };
type FileIn = Ident & { branch: string; path: string; content: string; message: string; base_sha?: string | null };
type PullIn = Ident & { head: string; title: string; body?: string; head_sha?: string };
type Card<I> = { summary: { target: string; change: string }; pin?: Partial<I> };
const pinField = (what: string) => z.string().regex(SHA).describe(`${what}. Filled in by the assistant when the call is checked; leave it out`);
const MOVED = 'GitHub: the target changed since this call was checked and approved (someone pushed), so nothing was written; ask again';

/**
 * GitHub write tools (Task 30, AC10, Gate P6). All `destructive`: the central policy always asks a person. Every call is checked in
 * `precheck` (before the approval card, and again when an approved call executes) AND in `run`, with fresh API data each time:
 * the target is resolved to its id and canonical full_name; the owner must be the installation account; the repo must not be on
 * the hard denylist and must be on github.repoAllowlist by id. Writes only touch praw/ branches, never the default branch nor .github/.
 * Tokens are minted per call for the one resolved repository id with the minimum permission; card reads use read tokens only.
 */
export function githubWriteTools(gh: GithubClient, cfg: Pick<ConfigStore, 'get'>, guarded: (f: () => Promise<string>) => Promise<ToolResult>): ToolPlugin<any>[] {
  const w = gh.writer;
  const target = async (i: Ident): Promise<GhTarget> => {
    if (isDeniedRepo({ fullName: `${i.owner}/${i.repo}`, id: -1 })) throw new GithubError(DENIED); // refused on the name, before any request
    const account = await gh.installationAccount();
    const deniedIds = await gh.deniedIds();
    const t = await gh.resolveRepo(i.owner, i.repo);
    if (t.owner.toLowerCase() !== account.toLowerCase()) throw new GithubError(NOT_OWNER);
    const ok = repoWriteAllowed(t, cfg.get('github.repoAllowlist'), deniedIds);
    if (!ok.ok) throw new GithubError(ok.why);
    return t;
  };
  const notDefault = (t: GhTarget, branch: string) => {
    if (branch.toLowerCase() === t.defaultBranch.toLowerCase()) throw new GithubError(DEFAULT_BRANCH);
  };
  const existing = async (t: GhTarget, branch: string, access: 'read' | 'write') => {
    notDefault(t, branch);
    if (!(await w.branchSha(t, branch, access))) throw new GithubError(missing(branch));
  };
  const card = async <I>(f: () => Promise<Card<I>>): Promise<Card<I> | { refuse: string }> => {
    try {
      return await f();
    } catch (err) {
      if (err instanceof GithubError) return { refuse: err.message };
      throw err;
    }
  };
  const on = (t: GhTarget) => `${t.fullName}#${t.id}`;
  const base = { kind: 'destructive', requiresApproval: () => false } as const;

  const branchCheck = async (i: BranchIn, access: 'read' | 'write') => {
    const t = await target(i);
    const branch = `praw/${i.name}`;
    notDefault(t, branch);
    if (await w.branchSha(t, branch, access)) throw new GithubError(`GitHub: branch ${branch} already exists`);
    const sha = await w.branchSha(t, t.defaultBranch, access);
    if (!sha) throw new GithubError('GitHub: the default branch has no commits to branch from');
    if (i.from_sha !== undefined && i.from_sha !== sha) throw new GithubError(MOVED); // P3: branch from the head the approver saw
    return { t, branch, sha };
  };
  const fileCheck = async (i: FileIn, access: 'read' | 'write') => {
    const p = repoPath(i.path);
    if (!p.ok) throw new GithubError(`GitHub: ${p.why}`);
    const t = await target(i);
    await existing(t, i.branch, access);
    const old = await w.getFile(t, p.path, i.branch, access);
    // P3: replace exactly the blob the approver saw (null = the file must still not exist)
    if (i.base_sha !== undefined && (old?.sha ?? null) !== i.base_sha) throw new GithubError(MOVED);
    return { t, path: p.path, old };
  };
  const pullCheck = async (i: PullIn) => {
    const t = await target(i);
    notDefault(t, i.head);
    const sha = await w.branchSha(t, i.head, 'read');
    if (!sha) throw new GithubError(missing(i.head));
    if (i.head_sha !== undefined && i.head_sha !== sha) throw new GithubError(MOVED); // P3: open the PR on the commits the approver saw
    return { t, sha };
  };

  return [
    {
      ...base, name: 'github_create_branch',
      description: 'Create a new branch praw/<name> from the head of the default branch, in a repository on the write allowlist. Give only <name> (letters, digits, - and _). Always needs a person to approve.',
      inputSchema: z.object({ owner, repo, name: z.string().regex(BRANCH_SUFFIX, 'letters, digits, - and _ only, without the praw/ prefix').describe('Branch name after praw/'), from_sha: pinField('Commit the branch starts from').optional() }),
      summary: (i: BranchIn) => ({ target: `${i.owner}/${i.repo}`, change: `create branch praw/${i.name}` }),
      precheck: (i: BranchIn) => card<BranchIn>(async () => { const c = await branchCheck(i, 'read'); return { summary: { target: on(c.t), change: `create branch ${c.branch} from ${c.t.defaultBranch} at ${c.sha.slice(0, 7)}` }, pin: { from_sha: c.sha } }; }),
      run: (i: BranchIn) => guarded(async () => {
        const c = await branchCheck(i, 'write');
        await w.createBranch(c.t, c.branch, i.from_sha ?? c.sha);
        return `Created branch ${c.branch} in ${c.t.fullName} from ${c.t.defaultBranch}.`;
      }),
    } satisfies ToolPlugin<BranchIn>,
    {
      ...base, name: 'github_create_or_update_file',
      description: 'Write one whole file (create or replace it) on an existing praw/ branch of a repository on the write allowlist, as one commit. Never the default branch, never .github/. Always needs a person to approve; then open a pull request with github_create_pull_request.',
      inputSchema: z.object({ owner, repo, branch: prawBranch('An existing praw/<name> branch'), path: filePath, content: z.string().max(CONTENT_MAX).describe('The complete new file content'), message: z.string().min(1).max(MESSAGE_MAX).describe('Commit message'), base_sha: pinField('Blob sha of the file being replaced, null for a new file').nullable().optional() }),
      summary: (i: FileIn) => ({ target: `${i.owner}/${i.repo}`, change: `branch ${i.branch}, path ${q(i.path)}: write ${Buffer.byteLength(i.content)} bytes` }),
      precheck: (i: FileIn) => card<FileIn>(async () => {
        const c = await fileCheck(i, 'read');
        const bytes = Buffer.byteLength(i.content);
        const what = c.old
          ? (({ added, removed }) => `update existing file at blob ${c.old!.sha.slice(0, 7)} (${lines(c.old!.text).length} -> ${lines(i.content).length} lines, +${added} -${removed}, ${bytes} bytes)`)(lineDiff(c.old.text, i.content))
          : `create new file (${lines(i.content).length} lines, ${bytes} bytes)`;
        return { summary: { target: on(c.t), change: `branch ${i.branch}, path ${c.path}: ${what}, commit ${q(i.message)}` }, pin: { base_sha: c.old?.sha ?? null } };
      }),
      run: (i: FileIn) => guarded(async () => {
        const c = await fileCheck(i, 'write');
        // the pinned sha goes to GitHub too, so its own 409 enforces it if the blob changes between our read and the PUT
        const pinned = i.base_sha === undefined ? c.old?.sha : i.base_sha ?? undefined;
        const sha = await w.putFile(c.t, { path: c.path, branch: i.branch, text: i.content, message: i.message, ...(pinned ? { sha: pinned } : {}) });
        return `Committed ${c.path} to ${i.branch} in ${c.t.fullName} (commit ${sha.slice(0, 7) || 'unknown'}).`;
      }),
    } satisfies ToolPlugin<FileIn>,
    {
      ...base, name: 'github_create_pull_request',
      description: 'Open a pull request from an existing praw/ branch into the default branch of a repository on the write allowlist. Always needs a person to approve; merging is left to people.',
      inputSchema: z.object({ owner, repo, head: prawBranch('The praw/<name> branch with the changes'), title: z.string().min(1).max(TITLE_MAX), body: z.string().max(BODY_MAX).optional().describe('Pull request description'), head_sha: pinField('Head commit of the branch').optional() }),
      summary: (i: PullIn) => ({ target: `${i.owner}/${i.repo}`, change: `pull request ${i.head}, title ${q(i.title)}` }),
      precheck: (i: PullIn) => card<PullIn>(async () => {
        const { t, sha } = await pullCheck(i);
        return { summary: { target: on(t), change: `pull request ${i.head} -> ${t.defaultBranch}, title ${q(i.title)}${i.body ? `, ${i.body.length}-character description` : ''}, head ${sha.slice(0, 7)}` }, pin: { head_sha: sha } };
      }),
      run: (i: PullIn) => guarded(async () => {
        const { t } = await pullCheck(i);
        const n = await w.createPull(t, { head: i.head, base: t.defaultBranch, title: i.title, body: i.body ?? '' });
        return `Opened pull request #${n} in ${t.fullName} (${i.head} -> ${t.defaultBranch}): https://github.com/${t.fullName}/pull/${n}`;
      }),
    } satisfies ToolPlugin<PullIn>,
  ];
}

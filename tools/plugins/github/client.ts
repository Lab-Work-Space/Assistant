import type { Env } from '../../../core/env.js';
import type { HttpClient } from '../../../services/http.js';
import { githubName } from '../../../services/ids.js';
import { GITHUB_HEADERS, GithubError, createGithubAuth, failure, loadPrivateKey, type GithubAuth, type TokenScope } from './auth.js';
import { createDeniedIdCache } from './deny.js';
import { createGithubWriter, type GithubWriter } from './writer.js';

const API = 'https://api.github.com';
const PAGE = 30;
const MAX_PAGES = 3;
export const LIST_CAP = PAGE * MAX_PAGES;
const COMMIT_MAX = 30;

export type Page<T> = { items: T[]; truncated: boolean };
export type GhRepo = { fullName: string; isPrivate: boolean; description?: string; language?: string; stars?: number; updatedAt?: string };
export type GhRepoInfo = GhRepo & { homepage?: string; forks?: number; createdAt?: string; defaultBranch?: string };
export type GhIssue = { number: number; title: string; state: string; author?: string; createdAt?: string; body?: string };
export type GhPull = GhIssue & { head?: string; base?: string; changedFiles?: number; additions?: number; deletions?: number; merged?: boolean };
export type GhCommit = { sha: string; message: string; author: string; date?: string };
/** A repository as the API names it now (canonical after a rename), for the write checks (P6a). */
export type GhTarget = { id: number; fullName: string; owner: string; name: string; defaultBranch: string };
export type GhMe = { app: string; slug?: string; appId?: number; account: string; accountType?: string; repositorySelection?: string; permissions: string };

/** Read-only GitHub client (Task 29). Writes arrive in Task 30 on the same auth. Every id is validated and encoded before a path is built; no tool input picks the installation. */
export interface GithubClient {
  getMe(): Promise<GhMe>;
  listMyOrganizations(): Promise<{ login: string; type?: string }[]>;
  listOrgRepositories(org: string): Promise<Page<GhRepo>>;
  listUserRepositories(user: string): Promise<Page<GhRepo>>;
  searchRepositories(query: string): Promise<{ items: GhRepo[]; total: number }>;
  getRepositoryInfo(owner: string, repo: string): Promise<GhRepoInfo>;
  listRepositoryIssues(owner: string, repo: string, state: 'open' | 'closed' | 'all'): Promise<Page<GhIssue>>;
  listRepositoryPulls(owner: string, repo: string, state: 'open' | 'closed' | 'all'): Promise<Page<GhPull>>;
  listRepositoryCommits(owner: string, repo: string, branch: string | undefined, limit: number): Promise<GhCommit[]>;
  getIssue(owner: string, repo: string, n: number): Promise<GhIssue>;
  getPullRequest(owner: string, repo: string, n: number): Promise<GhPull>;
  /** Login of the account the one installation is on (App JWT, cached after the first success). */
  installationAccount(): Promise<string>;
  /** id, canonical full_name, owner and default branch from GET /repos/{owner}/{repo}; anything missing is an error. */
  resolveRepo(owner: string, repo: string): Promise<GhTarget>;
  /** Ids the denied names resolve to (P6a), cached; throws when they cannot be resolved (writes are then refused). */
  deniedIds(): Promise<ReadonlySet<number>>;
  /** Raw write calls on the same auth (only write.ts uses them, after its checks). */
  readonly writer: GithubWriter;
}

type Raw = Record<string, unknown>;
const obj = (v: unknown): Raw => (v && typeof v === 'object' ? (v as Raw) : {});
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const put = <T extends object>(o: T, k: string, v: unknown): T => (v === undefined ? o : Object.assign(o, { [k]: v }));
const toRepo = (v: unknown): GhRepo => {
  const r = obj(v);
  const o: GhRepo = { fullName: str(r['full_name']) ?? '?', isPrivate: r['private'] === true };
  put(o, 'description', str(r['description'])); put(o, 'language', str(r['language'])); put(o, 'stars', num(r['stargazers_count'])); put(o, 'updatedAt', str(r['updated_at']));
  return o;
};
const toIssue = (v: unknown): GhIssue => {
  const r = obj(v);
  const o: GhIssue = { number: num(r['number']) ?? 0, title: str(r['title']) ?? '', state: str(r['state']) ?? 'unknown' };
  put(o, 'author', str(obj(r['user'])['login'])); put(o, 'createdAt', str(r['created_at'])); put(o, 'body', str(r['body']));
  return o;
};
const toPull = (v: unknown): GhPull => {
  const r = obj(v);
  const o: GhPull = toIssue(r);
  put(o, 'head', str(obj(r['head'])['ref'])); put(o, 'base', str(obj(r['base'])['ref']));
  put(o, 'changedFiles', num(r['changed_files'])); put(o, 'additions', num(r['additions'])); put(o, 'deletions', num(r['deletions']));
  if (typeof r['merged'] === 'boolean') o.merged = r['merged'];
  return o;
};
const R = (...names: string[]): TokenScope['permissions'] => Object.fromEntries(names.map((n) => [n, 'read' as const]));
const META = R('metadata');

export function createGithubClient(o: { http: HttpClient; auth: GithubAuth; clock?: () => number }): GithubClient {
  const call = async <T>(token: string, path: string, query: [string, string][] = []): Promise<T> => {
    try {
      return await o.http.getJson<T>(`${API}${path}`, { headers: { ...GITHUB_HEADERS, authorization: `Bearer ${token}` }, query });
    } catch (err) {
      throw failure(err);
    }
  };
  /** Validates both names first (no request, not even a token, for a bad one), then mints a read-only token for this one repo (R18, P6d). */
  const repoGet = async <T>(owner: string, repo: string, perm: string, sub: string, query: [string, string][] = []): Promise<T> => {
    let path: string;
    try {
      path = `/repos/${encodeURIComponent(githubName(owner))}/${encodeURIComponent(githubName(repo))}${sub}`;
    } catch (e) {
      throw failure(e);
    }
    return call<T>(await o.auth.tokenFor({ repoId: repo, permissions: R(perm, 'metadata') }), path, query);
  };
  const number = (n: number): string => {
    if (!Number.isSafeInteger(n) || n < 1) throw new GithubError('GitHub: invalid issue or pull request number');
    return String(n);
  };
  /** Repo-less reads: metadata:read only, no way to narrow the repositories (PF18). Up to MAX_PAGES pages of PAGE items. */
  const metaList = async (path: string): Promise<Page<GhRepo>> => {
    const token = await o.auth.tokenFor({ permissions: META });
    const items: GhRepo[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await call<unknown[]>(token, path, [['per_page', String(PAGE)], ['page', String(page)]]);
      if (!Array.isArray(batch)) break;
      items.push(...batch.map(toRepo));
      if (batch.length < PAGE) return { items, truncated: false };
    }
    return { items, truncated: true };
  };
  const repoList = async <T>(owner: string, repo: string, perm: string, sub: string, state: string, map: (v: unknown) => T): Promise<Page<T>> => {
    const items: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await repoGet<unknown[]>(owner, repo, perm, sub, [['state', state], ['per_page', String(PAGE)], ['page', String(page)]]);
      if (!Array.isArray(batch)) break;
      items.push(...batch);
      if (batch.length < PAGE) return { items: items.map(map), truncated: false };
    }
    return { items: items.map(map), truncated: true };
  };
  let account: string | null = null; // the installation is fixed at construction, so its account is too; a failure is never cached
  const self: GithubClient = {
    writer: createGithubWriter({ http: o.http, auth: o.auth }),
    deniedIds: () => denied.ids(),
    async installationAccount() {
      if (account) return account;
      const login = str(obj(obj(await call(o.auth.jwt(), `/app/installations/${o.auth.installationId}`))['account'])['login']);
      if (!login) throw new GithubError('GitHub returned no installation account');
      return (account = login);
    },
    async resolveRepo(owner, repo) {
      const r = obj(await repoGet(owner, repo, 'metadata', ''));
      const id = num(r['id']);
      const full = str(r['full_name']);
      const login = str(obj(r['owner'])['login']);
      const def = str(r['default_branch']);
      const [fo, fn, ...rest] = (full ?? '').split('/');
      if (!id || !Number.isSafeInteger(id) || id <= 0 || !fo || !fn || rest.length || !login || login.toLowerCase() !== fo.toLowerCase() || !def) throw new GithubError('GitHub returned an incomplete repository record');
      try {
        githubName(fo); githubName(fn);
      } catch {
        throw new GithubError('GitHub returned an incomplete repository record');
      }
      return { id, fullName: `${fo}/${fn}`, owner: fo, name: fn, defaultBranch: def };
    },
    async getMe() {
      const app = obj(await call(o.auth.jwt(), '/app'));
      const inst = obj(await call(o.auth.jwt(), `/app/installations/${o.auth.installationId}`));
      const account = obj(inst['account']);
      const me: GhMe = { app: str(app['name']) ?? '?', account: str(account['login']) ?? '?', permissions: Object.entries(obj(inst['permissions'])).filter(([, v]) => typeof v === 'string').map(([k, v]) => `${k}:${String(v)}`).join(', ') };
      put(me, 'slug', str(app['slug'])); put(me, 'appId', num(app['id'])); put(me, 'accountType', str(account['type'])); put(me, 'repositorySelection', str(inst['repository_selection']));
      return me;
    },
    async listMyOrganizations() {
      const a = obj(obj(await call(o.auth.jwt(), `/app/installations/${o.auth.installationId}`))['account']);
      return str(a['login']) ? [put({ login: str(a['login'])! } as { login: string; type?: string }, 'type', str(a['type']))] : [];
    },
    listOrgRepositories: async (org) => {
      try { return await metaList(`/orgs/${encodeURIComponent(githubName(org))}/repos`); } catch (e) { throw failure(e); }
    },
    listUserRepositories: async (user) => {
      try { return await metaList(`/users/${encodeURIComponent(githubName(user))}/repos`); } catch (e) { throw failure(e); }
    },
    async searchRepositories(query) {
      const r = obj(await call(await o.auth.tokenFor({ permissions: META }), '/search/repositories', [['q', query], ['per_page', '10']]));
      return { items: (Array.isArray(r['items']) ? r['items'] : []).slice(0, 10).map(toRepo), total: num(r['total_count']) ?? 0 };
    },
    async getRepositoryInfo(owner, repo) {
      const r = obj(await repoGet(owner, repo, 'metadata', ''));
      const info: GhRepoInfo = toRepo(r);
      put(info, 'homepage', str(r['homepage'])); put(info, 'forks', num(r['forks_count'])); put(info, 'createdAt', str(r['created_at'])); put(info, 'defaultBranch', str(r['default_branch']));
      return info;
    },
    async listRepositoryIssues(owner, repo, state) {
      const p = await repoList(owner, repo, 'issues', '/issues', state, (v) => ({ pr: 'pull_request' in obj(v), issue: toIssue(v) }));
      return { items: p.items.filter((x) => !x.pr).map((x) => x.issue), truncated: p.truncated }; // GitHub lists pull requests as issues too
    },
    listRepositoryPulls: (owner, repo, state) => repoList(owner, repo, 'pull_requests', '/pulls', state, toPull),
    async listRepositoryCommits(owner, repo, branch, limit) {
      const per = Math.max(1, Math.min(Math.trunc(limit) || 10, COMMIT_MAX));
      const raw = await repoGet<unknown[]>(owner, repo, 'contents', '/commits', [['per_page', String(per)], ...(branch ? [['sha', branch] as [string, string]] : [])]);
      return (Array.isArray(raw) ? raw : []).slice(0, per).map((v) => {
        const c = obj(v);
        const git = obj(obj(c['commit'])['author']);
        return put({ sha: (str(c['sha']) ?? '').slice(0, 7), message: (str(obj(c['commit'])['message']) ?? '').split('\n')[0]!.slice(0, 120), author: str(obj(c['author'])['login']) ?? str(git['name']) ?? 'unknown' } as GhCommit, 'date', str(git['date']));
      });
    },
    async getIssue(owner, repo, n) {
      return toIssue(await repoGet(owner, repo, 'issues', `/issues/${number(n)}`));
    },
    async getPullRequest(owner, repo, n) {
      return toPull(await repoGet(owner, repo, 'pull_requests', `/pulls/${number(n)}`));
    },
  };
  const denied = createDeniedIdCache({ account: () => self.installationAccount(), resolve: (ow, r) => self.resolveRepo(ow, r), ...(o.clock ? { clock: o.clock } : {}) });
  return self;
}

export type GithubBuild = { client: GithubClient } | { disabled: string };

/** Builds the client from validated env: a key problem (mode, owner, symlink, content) disables only the github group, with a reason that never holds the key or the path. */
export function githubFromEnv(g: NonNullable<Env['github']>, o: { http: HttpClient; clock: () => number; uid?: number | null }): GithubBuild {
  const k = loadPrivateKey({ ...(g.privateKeyPath ? { path: g.privateKeyPath } : g.privateKey ? { pem: g.privateKey } : {}), ...(o.uid === undefined ? {} : { uid: o.uid }) });
  if (!k.ok) return { disabled: k.reason };
  return { client: createGithubClient({ http: o.http, clock: o.clock, auth: createGithubAuth({ appId: g.appId, installationId: g.installationId, privateKey: k.key, http: o.http, clock: o.clock }) }) };
}

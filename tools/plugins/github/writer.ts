import { HttpError, type HttpClient } from '../../../services/http.js';
import { GITHUB_HEADERS, GithubError, failure, type GithubAuth } from './auth.js';
import type { GhTarget } from './client.js';

const API = 'https://api.github.com';
const SHA = /^[0-9a-f]{40}$/;

/**
 * The raw GitHub write calls (Task 30). Only write.ts calls these, after its checks: every token is minted for the ONE resolved
 * repository id with the minimum permission (P6d), and every path segment (branch, file path) is validated by the caller and
 * encoded here segment by segment. Reads that only feed the approval card use a read token, so no write token exists before approval.
 */
export interface GithubWriter {
  /** Head sha of a branch, or null when it does not exist. */
  branchSha(t: GhTarget, branch: string, access: 'read' | 'write'): Promise<string | null>;
  createBranch(t: GhTarget, branch: string, sha: string): Promise<void>;
  /** The file at `path` on `branch`: blob sha and text, or null when there is none. A directory or symlink is an error. */
  getFile(t: GhTarget, path: string, branch: string, access: 'read' | 'write'): Promise<{ sha: string; text: string } | null>;
  putFile(t: GhTarget, a: { path: string; branch: string; text: string; message: string; sha?: string }): Promise<string>;
  createPull(t: GhTarget, a: { head: string; base: string; title: string; body: string }): Promise<number>;
}

const seg = (p: string) => p.split('/').map(encodeURIComponent).join('/');

function writeFailure(err: unknown): GithubError {
  if (err instanceof HttpError && err.status === 409) return new GithubError('GitHub: the branch or file changed meanwhile, nothing was written (HTTP 409)', 409);
  if (err instanceof HttpError && err.status === 422) return new GithubError('GitHub refused the change as invalid (HTTP 422)', 422);
  return failure(err);
}

export function createGithubWriter(o: { http: HttpClient; auth: GithubAuth }): GithubWriter {
  const token = (t: GhTarget, permissions: Record<string, 'read' | 'write'>) => o.auth.tokenFor({ repoId: t.id, permissions });
  const repoUrl = (t: GhTarget) => `${API}/repos/${encodeURIComponent(t.owner)}/${encodeURIComponent(t.name)}`;
  const get = async <T>(t: GhTarget, perm: Record<string, 'read' | 'write'>, sub: string, query: [string, string][] = []): Promise<T | null> => {
    const tok = await token(t, perm);
    try {
      return await o.http.getJson<T>(`${repoUrl(t)}${sub}`, { headers: { ...GITHUB_HEADERS, authorization: `Bearer ${tok}` }, query });
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw failure(err);
    }
  };
  const send = async (t: GhTarget, perm: Record<string, 'read' | 'write'>, method: 'POST' | 'PUT', sub: string, body: unknown): Promise<Record<string, unknown>> => {
    const tok = await token(t, perm);
    try {
      const r = await o.http.sendJson<Record<string, unknown>>(method, `${repoUrl(t)}${sub}`, { headers: { ...GITHUB_HEADERS, authorization: `Bearer ${tok}` }, body });
      return r && typeof r === 'object' ? r : {};
    } catch (err) {
      throw writeFailure(err);
    }
  };
  const contents = (access: 'read' | 'write') => ({ contents: access });
  return {
    async branchSha(t, branch, access) {
      const r = await get<{ object?: { sha?: unknown } }>(t, contents(access), `/git/ref/heads/${seg(branch)}`);
      if (r === null) return null;
      const sha = r.object?.sha;
      if (typeof sha !== 'string' || !SHA.test(sha)) throw new GithubError('GitHub returned an unexpected branch record');
      return sha;
    },
    async createBranch(t, branch, sha) {
      if (!SHA.test(sha)) throw new GithubError('GitHub: invalid commit sha');
      await send(t, contents('write'), 'POST', '/git/refs', { ref: `refs/heads/${branch}`, sha });
    },
    async getFile(t, path, branch, access) {
      const r = await get<Record<string, unknown>>(t, contents(access), `/contents/${seg(path)}`, [['ref', branch]]);
      if (r === null) return null;
      if (Array.isArray(r) || r['type'] !== 'file' || typeof r['sha'] !== 'string' || !SHA.test(r['sha']) || typeof r['content'] !== 'string') throw new GithubError('GitHub: that path is not a regular file');
      // files over 1 MB come back with an empty `content` (or another encoding): never diff or replace what was not read in full
      const bytes = Buffer.from(r['content'], 'base64');
      if (r['encoding'] !== 'base64' || typeof r['size'] !== 'number' || bytes.length !== r['size']) throw new GithubError('GitHub: that file is too large or not returned in full, so it is not changed');
      return { sha: r['sha'], text: bytes.toString('utf8') };
    },
    async putFile(t, a) {
      const r = await send(t, contents('write'), 'PUT', `/contents/${seg(a.path)}`, { message: a.message, content: Buffer.from(a.text, 'utf8').toString('base64'), branch: a.branch, ...(a.sha ? { sha: a.sha } : {}) });
      const sha = (r['commit'] as { sha?: unknown } | undefined)?.sha;
      return typeof sha === 'string' ? sha : '';
    },
    async createPull(t, a) {
      const r = await send(t, { pull_requests: 'write' }, 'POST', '/pulls', { title: a.title, body: a.body, head: a.head, base: a.base });
      const n = r['number'];
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) throw new GithubError('GitHub returned an unexpected pull request record');
      return n;
    },
  };
}

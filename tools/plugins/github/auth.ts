import { createPrivateKey, createSign } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { HttpError, type HttpClient } from '../../../services/http.js';
import { InvalidIdError, githubName } from '../../../services/ids.js';

const API = 'https://api.github.com';
/** GitHub's documented headers; the JWT / token goes in `authorization` only. */
export const GITHUB_HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'praw-assistant' } as const;
const IAT_SKEW_S = 60; // docs: iat 60 s in the past for clock drift
const EXP_S = 9 * 60; // docs: exp at most 10 min ahead
const REUSE_MARGIN_MS = 5 * 60_000;
const CACHE_MAX = 50;

/** Fixed text plus a status code; it never carries the key, a JWT, a token, headers or a response body (P9, P10). */
export class GithubError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = 'GithubError';
  }
}

/** Any failure of a GitHub call -> fixed text plus status (never headers, body or config). */
export function failure(err: unknown): GithubError {
  if (err instanceof GithubError) return err;
  if (err instanceof InvalidIdError) return new GithubError('GitHub: invalid owner or repository name');
  if (err instanceof HttpError) {
    if (err.rateLimited) return new GithubError('GitHub rate limit reached, try again later', err.status);
    if (err.status === 401) return new GithubError('GitHub rejected the App credentials (HTTP 401)', 401);
    if (err.status === 404) return new GithubError('GitHub: repository not found or not visible to the App (HTTP 404)', 404);
    if (err.status !== null) return new GithubError(`GitHub refused the request (HTTP ${err.status})`, err.status);
    return new GithubError(`GitHub request failed (${err.message})`);
  }
  return new GithubError('GitHub request failed');
}

export type KeyResult = { ok: true; key: string } | { ok: false; reason: string };
const refuse = (why: string): KeyResult => ({ ok: false, reason: `GitHub App key refused: ${why}` });
const PEM_ONE_LINE = /\\n/g;

/**
 * The App private key: from env text (`pem`, `\n` escapes accepted) or from a file (`path`, which wins). A file must be a regular file,
 * not a symlink, mode 0600 (no group/other bits) and owned by the running user (P24). Reasons are fixed text: never the key, never the path.
 */
export function loadPrivateKey(o: { pem?: string; path?: string; uid?: number | null }): KeyResult {
  let text: string;
  if (o.path) {
    const uid = o.uid === undefined ? (process.getuid?.() ?? null) : o.uid;
    try {
      const l = lstatSync(o.path);
      if (l.isSymbolicLink()) return refuse('GITHUB_APP_PRIVATE_KEY_PATH must not be a symlink');
      if (!l.isFile()) return refuse('GITHUB_APP_PRIVATE_KEY_PATH must be a regular file');
      // open without following links, then check the opened file itself (no swap between check and read)
      const fd = openSync(o.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.ino !== l.ino || st.dev !== l.dev) return refuse('GITHUB_APP_PRIVATE_KEY_PATH changed while it was checked');
        if ((st.mode & 0o077) !== 0) return refuse('GITHUB_APP_PRIVATE_KEY_PATH must have mode 0600 (no group or other access)');
        if (uid !== null && st.uid !== uid) return refuse('GITHUB_APP_PRIVATE_KEY_PATH must be owned by the user running the assistant');
        text = readFileSync(fd, 'utf8');
      } finally {
        closeSync(fd);
      }
    } catch {
      return refuse('GITHUB_APP_PRIVATE_KEY_PATH cannot be read as a file');
    }
  } else if (o.pem) text = o.pem.includes('\n') ? o.pem : o.pem.replace(PEM_ONE_LINE, '\n');
  else return refuse('no key configured');
  try {
    createPrivateKey(text);
  } catch {
    return refuse('the key is not a valid PEM private key');
  }
  return { ok: true, key: text };
}

export type TokenScope = {
  /** A repository name (`repositories`) or numeric id (`repository_ids`); omit only for repo-less reads, which then can carry nothing beyond metadata:read (PF18). */
  repoId?: number | string;
  permissions: Record<string, 'read' | 'write'>;
};
export interface GithubAuth {
  /** The one configured installation: the only one this process ever talks to (R18). */
  readonly installationId: string;
  /** A fresh JWT for the few endpoints that need the App itself (`GET /app`, `GET /app/installations/{id}`). */
  jwt(): string;
  tokenFor(scope: TokenScope): Promise<string>;
}

const b64u = (v: string | Buffer) => Buffer.from(v).toString('base64url');

export function createGithubAuth(o: { appId: string; installationId: string; privateKey: string; http: HttpClient; clock: () => number }): GithubAuth {
  if (!/^[A-Za-z0-9]{1,40}$/.test(o.appId) || !/^\d{1,20}$/.test(o.installationId)) throw new Error('invalid GitHub App ids');
  const key = createPrivateKey(o.privateKey);
  const jwt = (): string => {
    const now = Math.floor(o.clock() / 1000);
    const data = `${b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64u(JSON.stringify({ iss: o.appId, iat: now - IAT_SKEW_S, exp: now + EXP_S }))}`;
    return `${data}.${createSign('RSA-SHA256').update(data).sign(key).toString('base64url')}`;
  };
  const cache = new Map<string, { token: string; expiresAt: number }>();
  return {
    installationId: o.installationId,
    jwt,
    async tokenFor(scope) {
      const perms = Object.entries(scope.permissions).sort(([a], [b]) => (a < b ? -1 : 1));
      let repo: { repositories: string[] } | { repository_ids: number[] } | undefined;
      try {
        if (perms.length === 0 || perms.some(([k, v]) => !/^[a-z_]{1,40}$/.test(k) || (v !== 'read' && v !== 'write'))) throw new Error('scope');
        if (typeof scope.repoId === 'number') {
          if (!Number.isSafeInteger(scope.repoId) || scope.repoId <= 0) throw new Error('scope');
          repo = { repository_ids: [scope.repoId] };
        } else if (scope.repoId !== undefined) repo = { repositories: [githubName(scope.repoId)] };
      } catch {
        throw new GithubError('GitHub: invalid token scope');
      }
      // the installation is the one configured id: nothing in `scope` can select another (P6f)
      const cacheKey = JSON.stringify([repo ?? null, perms]);
      const hit = cache.get(cacheKey);
      if (hit && o.clock() < hit.expiresAt - REUSE_MARGIN_MS) return hit.token;
      let res: { token?: unknown; expires_at?: unknown } | null;
      try {
        res = await o.http.sendJson('POST', `${API}/app/installations/${o.installationId}/access_tokens`, {
          headers: { ...GITHUB_HEADERS, authorization: `Bearer ${jwt()}` },
          body: { ...repo, permissions: Object.fromEntries(perms) },
        });
      } catch (err) {
        if (err instanceof HttpError && err.rateLimited) throw new GithubError('GitHub rate limit reached, try again later', err.status);
        if (err instanceof HttpError && err.status === 422) throw new GithubError('GitHub: the App cannot get that repository or permission (HTTP 422)', 422);
        throw new GithubError(err instanceof HttpError && err.status !== null ? `GitHub token request failed (HTTP ${err.status})` : 'GitHub token request failed', err instanceof HttpError ? err.status : null);
      }
      const expiresAt = typeof res?.expires_at === 'string' ? Date.parse(res.expires_at) : NaN;
      if (typeof res?.token !== 'string' || !/^[\w.-]{20,4000}$/.test(res.token) || !Number.isFinite(expiresAt)) throw new GithubError('GitHub returned an unexpected token response');
      if (cache.size >= CACHE_MAX) {
        for (const [k, v] of cache) if (o.clock() >= v.expiresAt - REUSE_MARGIN_MS) cache.delete(k); // expired entries first
        if (cache.size >= CACHE_MAX) cache.clear();
      }
      cache.set(cacheKey, { token: res.token, expiresAt });
      return res.token;
    },
  };
}

import { repoWriteAllowed } from '../tools/plugins/github/deny.js';

/**
 * The pull-request path for repositories other than the Assistant (Gate 1 self-code X23, OD-4a). The main application holds the GitHub App key, so
 * these checks are the guard (plus the card, branch protection and a human merge); LW Admin is not claimed to guard PR pushes.
 * The token is minted per push for ONE repository id with contents:write and pull_requests:write only (no `workflows`, so GitHub itself refuses a
 * push that touches workflow files), the branch is `bot/<job id>`, never the default branch, never force-pushed, and the token travels only in the
 * environment of the git child (GIT_CONFIG_COUNT/http.extraHeader), never in a URL or .git/config.
 */
export const BRANCH_RE = /^bot\/J-[0-9a-f]{16}$/;
export const PR_PERMISSIONS = { contents: 'write', pull_requests: 'write' } as const;

export interface RepoInfo { id: number; fullName: string; defaultBranch: string }
export interface PrPorts {
  repoInfo(fullName: string): Promise<RepoInfo>;
  branchExists(fullName: string, branch: string): Promise<boolean>;
  token(scope: { repoId: number; permissions: Record<string, 'read' | 'write'> }): Promise<string>;
  /** Runs `git push` with exactly this argv and environment (the caller supplies nothing else). */
  push(inv: { argv: string[]; env: Record<string, string> }): Promise<void>;
  openPr(o: { fullName: string; head: string; base: string; title: string }): Promise<{ url: string }>;
}

export function pushInvocation(o: { fullName: string; branch: string; sha: string; token: string }): { argv: string[]; env: Record<string, string> } {
  if (!BRANCH_RE.test(o.branch) || !/^[0-9a-f]{40}$/.test(o.sha) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(o.fullName)) throw new Error('bad push input');
  const basic = Buffer.from(`x-access-token:${o.token}`).toString('base64');
  return {
    // no `+` in the refspec: a force push is impossible; the URL carries no credential
    argv: ['push', '--no-verify', `https://github.com/${o.fullName}.git`, `${o.sha}:refs/heads/${o.branch}`],
    env: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  };
}

export async function pushAndOpenPr(o: {
  ports: PrPorts; fullName: string; jobId: string; sha: string; changedPaths: readonly string[]; title: string;
  allowlist: readonly { id: number; fullName: string }[]; deniedIds: ReadonlySet<number>;
}): Promise<{ ok: true; url: string } | { ok: false; why: string }> {
  const branch = `bot/${o.jobId}`;
  if (!BRANCH_RE.test(branch)) return { ok: false, why: 'bad job id' };
  if (o.changedPaths.some((p) => /^\.github\//i.test(p.normalize('NFC')))) return { ok: false, why: 'workflow files (.github/) are never pushed' };
  const info = await o.ports.repoInfo(o.fullName);
  if (info.fullName.toLowerCase() !== o.fullName.toLowerCase()) return { ok: false, why: 'the repository name does not match its id' };
  const allowed = repoWriteAllowed({ fullName: info.fullName, id: info.id }, o.allowlist, o.deniedIds);
  if (!allowed.ok) return { ok: false, why: allowed.why };
  // Both by name and by the API-resolved default branch (X23).
  if (['main', 'master', info.defaultBranch].includes(branch)) return { ok: false, why: 'pushes to the default branch are refused' };
  if (await o.ports.branchExists(info.fullName, branch)) return { ok: false, why: 'that branch already exists (a branch is never overwritten)' };
  const token = await o.ports.token({ repoId: info.id, permissions: { ...PR_PERMISSIONS } });
  await o.ports.push(pushInvocation({ fullName: info.fullName, branch, sha: o.sha, token }));
  const pr = await o.ports.openPr({ fullName: info.fullName, head: branch, base: info.defaultBranch, title: o.title.slice(0, 200) });
  return { ok: true, url: pr.url };
}

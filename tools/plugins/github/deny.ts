import { readFileSync } from 'node:fs';
import { GithubError } from './auth.js';

/**
 * Hard denylist for GitHub writes (Gate P6a/b). A second layer only: L13 (installation on selected repos, branch protection on
 * `main` of every allowlisted repo) still binds. The list comes from deploy-repos.json, generated from the lw-git `REPO=` sources
 * by scripts/gen-deploy-denylist.ts. Checks run on the canonical `full_name` and id the API returned at call time.
 */
export const DENY_PATTERN = /infra|deploy|secrets/i;
const NAME = /^[a-z0-9_.-]{1,100}$/;

type List = { fullNames: Set<string>; names: Set<string>; ids: Set<number>; spelled: { fullNames: string[]; names: string[] } };
let cached: List | Error | null = null;

/** Loaded once; a missing or malformed file is an Error, and then every repo is denied (fail closed). */
function list(): List | Error {
  if (cached) return cached;
  try {
    const raw = JSON.parse(readFileSync(new URL('./deploy-repos.json', import.meta.url), 'utf8')) as { fullNames?: unknown; names?: unknown; ids?: unknown };
    const strs = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null);
    const full = strs(raw.fullNames);
    const names = strs(raw.names);
    const ids = Array.isArray(raw.ids) && raw.ids.every((x) => Number.isSafeInteger(x)) ? (raw.ids as number[]) : null;
    if (!full || full.length === 0 || !names || !ids) throw new Error('shape');
    cached = { fullNames: new Set(full.map(normalizeRepoSpec)), names: new Set(names.map((n) => n.toLowerCase())), ids: new Set(ids), spelled: { fullNames: full.map(cleanRepoSpec), names } };
  } catch {
    cached = new Error('the GitHub deploy denylist (deploy-repos.json) is missing or malformed');
  }
  return cached;
}

/** null when the denylist loaded, else the reason (the github group reports it; writes are refused meanwhile). */
export const denylistProblem = (): string | null => {
  const l = list();
  return l instanceof Error ? l.message : null;
};

/** `Owner/Name`, a github.com url, `.git` and a trailing `/`, any case -> `owner/name` (lowercase). Not validated here. */
export const normalizeRepoSpec = (s: string): string => cleanRepoSpec(s).toLowerCase();
/** The same without lowercasing (what an API call is made with). */
export function cleanRepoSpec(s: string): string {
  return s.trim().replace(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/i, '').replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
}

/**
 * True when a write to this repository is never allowed: a deploy source or fixed entry by full name (case-insensitive), a fixed
 * bare name under any owner, a known id, the regex on the full name, or anything that does not look like one `owner/name` (fail closed).
 */
export function isDeniedRepo(r: { fullName: string; id: number }, resolvedIds: ReadonlySet<number> = new Set()): boolean {
  const l = list();
  if (l instanceof Error) return true;
  if (resolvedIds.has(r.id)) return true; // the id a denied name resolved to: a later rename keeps it denied
  const full = normalizeRepoSpec(r.fullName);
  const [owner, name, ...rest] = full.split('/');
  if (!owner || !name || rest.length || !NAME.test(owner) || !NAME.test(name) || full.includes('..')) return true; // a bare or odd name is never a write target
  return l.fullNames.has(full) || l.names.has(name) || l.ids.has(r.id) || DENY_PATTERN.test(full);
}

export const DENIED = 'GitHub: writes to that repository are never allowed (deploy source, infrastructure or the bots themselves)';
export const NOT_ALLOWLISTED = 'GitHub: that repository is not on github.repoAllowlist (a Bot Admin adds it with /github allow add)';

/** Not denied AND on the allowlist by id (the stored name is display only, so a rename neither grants nor loses access). */
export function repoWriteAllowed(r: { fullName: string; id: number }, allowlist: readonly { id: number; fullName: string }[], deniedIds: ReadonlySet<number> = new Set()): { ok: true } | { ok: false; why: string } {
  if (isDeniedRepo(r, deniedIds)) return { ok: false, why: DENIED };
  if (!allowlist.some((a) => a.id === r.id)) return { ok: false, why: NOT_ALLOWLISTED };
  return { ok: true };
}

const IDS_TTL_MS = 6 * 3_600_000;
export const IDS_UNAVAILABLE = 'GitHub: the deploy denylist could not be resolved to repository ids, so writes are refused for now (if a denied repository was renamed, run scripts/gen-deploy-denylist.ts)';

/**
 * P6a "denied by id": every denied full name (and each bare name under the installation account) is resolved to its repository id
 * through the API and cached for IDS_TTL_MS, so a deploy source renamed while the process runs stays denied by id. 404/422 mean the
 * App cannot see that repository (not installed there), so it is skipped; any other failure throws (writes refused, fail closed).
 * The static `ids` of deploy-repos.json are always included.
 */
export function createDeniedIdCache(o: { account(): Promise<string>; resolve(owner: string, repo: string): Promise<{ id: number }>; clock?: () => number }) {
  const now = o.clock ?? Date.now;
  let cur: { at: number; ids: ReadonlySet<number> } | null = null;
  let inflight: Promise<ReadonlySet<number>> | null = null;
  const load = async (): Promise<ReadonlySet<number>> => {
    const l = list();
    if (l instanceof Error) throw new GithubError(l.message);
    const account = await o.account();
    const targets = new Map<string, [string, string]>();
    for (const f of l.spelled.fullNames) { const [a, b] = f.split('/'); if (a && b) targets.set(f.toLowerCase(), [a, b]); }
    for (const n of l.spelled.names) if (!targets.has(`${account}/${n}`.toLowerCase())) targets.set(`${account}/${n}`.toLowerCase(), [account, n]);
    const ids = new Set(l.ids);
    for (const [owner, repo] of targets.values()) {
      try {
        ids.add((await o.resolve(owner, repo)).id);
      } catch (err) {
        if (err instanceof GithubError && (err.status === 404 || err.status === 422)) continue;
        throw new GithubError(IDS_UNAVAILABLE);
      }
    }
    cur = { at: now(), ids };
    return ids;
  };
  return {
    ids(): Promise<ReadonlySet<number>> {
      if (cur && now() - cur.at < IDS_TTL_MS) return Promise.resolve(cur.ids);
      return (inflight ??= load().finally(() => { inflight = null; }));
    },
  };
}

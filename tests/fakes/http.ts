import { createHash, verify, type KeyObject } from 'node:crypto';
/**
 * Socket-free injectable `fetch` (spec §12 item 14) for vendor clients that use a fixed base URL (ClickUp,
 * GitHub, later tasks). It never binds a port. Routes are matched on `METHOD url-without-query` first, then on
 * `url-without-query`, then on `METHOD prefix*` keys; unknown routes answer 404. Every request is recorded.
 */
export type RecordedRequest = { method: string; url: string; headers: Record<string, string>; body: string | null };
export type HttpRoute = { status?: number; headers?: Record<string, string>; body?: unknown } | ((r: RecordedRequest) => HttpRoute);

export function fakeFetch(routes: Record<string, HttpRoute>): typeof fetch & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const f = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const rec: RecordedRequest = { method, url, headers, body: typeof init?.body === 'string' ? init.body : null };
    requests.push(rec);
    const bare = url.split('?')[0]!;
    let route: HttpRoute | undefined = routes[`${method} ${bare}`] ?? routes[bare];
    if (route === undefined) {
      // `METHOD prefix*` keys match any url that starts with the prefix (longest prefix wins), for path-shaped vendor routes
      const hit = Object.keys(routes).filter((k) => k.endsWith('*') && `${method} ${bare}`.startsWith(k.slice(0, -1))).sort((a, b) => b.length - a.length)[0];
      route = hit === undefined ? undefined : routes[hit];
    }
    route ??= { status: 404, body: { error: 'not found' } };
    while (typeof route === 'function') route = route(rec);
    const body = typeof route.body === 'string' ? route.body : JSON.stringify(route.body ?? null);
    const type = typeof route.body === 'string' ? 'text/plain' : 'application/json';
    const status = route.status ?? 200;
    if (status === 204) return new Response(null, { status, headers: route.headers }); // a 204 has no body (the platform Response refuses one)
    return new Response(body, { status, headers: { 'content-type': type, ...route.headers } });
  }) as typeof fetch & { requests: RecordedRequest[] };
  f.requests = requests;
  return f;
}

/** A DuckDuckGo HTML results page (shape observed live 2026-11-01, see the T14 report) for the web_search backend. */
export function ddgResultsHtml(results: { title: string; url: string; snippet: string; ad?: boolean; redirect?: boolean }[]): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const items = results.map((r) => {
    const href = r.redirect ? `//duckduckgo.com/l/?uddg=${encodeURIComponent(r.url)}&amp;rut=abc` : esc(r.url);
    return `<div class="result results_links results_links_deep web-result ${r.ad ? 'result--ad' : ''}">
  <div class="links_main links_deep result__body">
    <h2 class="result__title"><a rel="nofollow" class="result__a" href="${href}">${esc(r.title)}</a></h2>
    <div class="result__extras"><a class="result__url" href="${href}">${esc(r.url)}</a></div>
    <a class="result__snippet" href="${href}">${esc(r.snippet)}</a>
  </div>
</div>`;
  });
  return `<html><body><div class="serp__results"><div id="links" class="results">${items.join('\n')}</div></div></body></html>`;
}

/** ClickUp API v2 (shapes verified against developer.clickup.com, T25 report). Every route demands the raw token in `Authorization`. */
export const CLICKUP_BASE = 'https://api.clickup.com/api/v2';
export type CuFakeTask = { id: string; name: string; status: { status: string; type: string }; assignees?: { id: number; username: string; email?: string }[]; due_date?: string | null; priority?: { priority: string } | null; description?: string; url?: string; list?: { id: string }; subtasks?: { id: string; name: string }[] };
export type ClickUpFake = { token: string; listId: string; listName?: string; tasks?: CuFakeTask[]; comments?: Record<string, { id: string; comment_text: string; user: { username: string }; date: string }[]>; members?: { id: number; username: string; email: string }[]; pageSize?: number };

export function clickupRoutes(o: ClickUpFake): Record<string, HttpRoute> {
  const guard = (f: (r: RecordedRequest) => HttpRoute): HttpRoute => (r) =>
    r.headers['authorization'] === o.token ? f(r) : { status: 401, body: { err: 'Token invalid', ECODE: 'OAUTH_025' } };
  const tasks = o.tasks ?? [];
  const routes: Record<string, HttpRoute> = {
    [`GET ${CLICKUP_BASE}/list/${o.listId}`]: guard(() => ({ body: { id: o.listId, name: o.listName ?? 'Sprint', folder: { id: 'f1', name: 'Eng', hidden: false, access: true }, space: { id: 's1', name: 'Space', access: true }, statuses: [{ status: 'to do', type: 'open', orderindex: 0 }, { status: 'in progress', type: 'custom', orderindex: 1 }, { status: 'complete', type: 'closed', orderindex: 2 }] } })),
    [`GET ${CLICKUP_BASE}/list/${o.listId}/task`]: guard((r) => {
      const u = new URL(r.url);
      const page = Number(u.searchParams.get('page') ?? '0');
      const size = o.pageSize ?? 100;
      const closed = u.searchParams.get('include_closed') === 'true';
      const all = tasks.filter((t) => closed || t.status.type !== 'closed');
      return { body: { tasks: all.slice(page * size, page * size + size), last_page: (page + 1) * size >= all.length } };
    }),
    // write routes (ClickUp API v2, developer.clickup.com: createtask, updatetask, createtaskcomment, deletetask)
    [`POST ${CLICKUP_BASE}/list/${o.listId}/task`]: guard((r) => ({ body: { id: 'new1', name: (JSON.parse(r.body ?? '{}') as { name?: string }).name, list: { id: o.listId }, status: { status: 'to do', type: 'open' }, url: 'https://app.clickup.com/t/new1' } })),
    [`GET ${CLICKUP_BASE}/list/${o.listId}/member`]: guard(() => ({ body: { members: o.members ?? [] } })),
  };
  for (const t of tasks) {
    routes[`GET ${CLICKUP_BASE}/task/${t.id}`] = guard((r) => {
      const { subtasks, ...rest } = t; // like ClickUp: subtasks only come back with include_subtasks=true
      return { body: { list: { id: o.listId }, assignees: [], ...rest, ...(new URL(r.url).searchParams.get('include_subtasks') === 'true' ? { subtasks: subtasks ?? [] } : {}) } };
    });
    routes[`PUT ${CLICKUP_BASE}/task/${t.id}`] = guard(() => ({ body: { ...t, list: { id: o.listId } } }));
    routes[`DELETE ${CLICKUP_BASE}/task/${t.id}`] = guard(() => ({ status: 204 }));
    routes[`POST ${CLICKUP_BASE}/task/${t.id}/comment`] = guard(() => ({ body: { id: 'c9', hist_id: 'h9', date: 1 } }));
    routes[`GET ${CLICKUP_BASE}/task/${t.id}/comment`] = guard(() => ({ body: { comments: o.comments?.[t.id] ?? [] } }));
  }
  return routes;
}

/**
 * GitHub REST (docs.github.com, T29 report). App JWT (RS256) on /app*, installation tokens from POST /app/installations/{id}/access_tokens
 * (body `repositories` / `repository_ids` / `permissions`), then `Bearer ghs_...` on the resource routes. The fake VERIFIES the JWT signature
 * and claims and enforces the minted token's repository list and permission for every route, so a wrongly scoped call fails like the real API.
 */
export const GITHUB_BASE = 'https://api.github.com';
export type GhFakeRepo = {
  owner: string; name: string; id?: number; info?: Record<string, unknown>; issues?: Record<string, unknown>[]; pulls?: Record<string, unknown>[]; commits?: Record<string, unknown>[];
  /** branch -> head sha (default: the default branch at a fixed sha); files: `branch:path` -> text. Copied per rig, then changed by the fake write routes. */
  branches?: Record<string, string>; files?: Record<string, string>;
  /** old names that answer GET /repos/{owner}/{alias} with this repo's canonical body (a followed rename redirect) */
  aliases?: string[];
};
export type GhFakeWrite = { repo: string; method: string; path: string; body: Record<string, unknown> };
export type GithubFake = {
  appId: string; installationId: string; publicKey: KeyObject; now?: () => number;
  account?: { login: string; type: string }; repos?: GhFakeRepo[]; orgRepos?: Record<string, Record<string, unknown>[]>; userRepos?: Record<string, Record<string, unknown>[]>; search?: Record<string, unknown>[];
  /** respond to every resource call with this (rate limit tests) */
  resourceFail?: { status: number; headers?: Record<string, string> };
  /** routes added last (override the generated ones), e.g. a 301 for a renamed repo */
  extraRoutes?: Record<string, HttpRoute>;
  /** installation token lifetime in ms (default one hour) */
  ttlMs?: number;
};
export type GhMint = { body: { repositories?: string[]; repository_ids?: number[]; permissions?: Record<string, string> }; claims: { iss?: string; iat?: number; exp?: number }; token: string };

export function githubRoutes(o: GithubFake) {
  const now = o.now ?? Date.now;
  const mints: GhMint[] = [];
  const writes: GhFakeWrite[] = [];
  const live = new Map<string, GhMint['body']>();
  const b64 = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Record<string, unknown>;
  const jwtClaims = (auth: string | undefined): GhMint['claims'] | null => {
    const m = /^Bearer ([\w-]+)\.([\w-]+)\.([\w-]+)$/.exec(auth ?? '');
    if (!m) return null;
    const ok = verify('RSA-SHA256', Buffer.from(`${m[1]}.${m[2]}`), o.publicKey, Buffer.from(m[3]!, 'base64url'));
    const head = b64(m[1]!);
    const claims = b64(m[2]!) as GhMint['claims'];
    const t = Math.floor(now() / 1000);
    return ok && head['alg'] === 'RS256' && claims.iss === o.appId && typeof claims.iat === 'number' && typeof claims.exp === 'number' && claims.iat <= t && claims.exp > t && claims.exp - t <= 600 ? claims : null;
  };
  const asApp = (f: (claims: GhMint['claims']) => HttpRoute): HttpRoute => (r) => { const c = jwtClaims(r.headers['authorization']); return c ? f(c) : { status: 401, body: { message: 'A JSON web token could not be decoded' } }; };
  const paged = (list: Record<string, unknown>[], r: RecordedRequest) => {
    const u = new URL(r.url);
    const per = Number(u.searchParams.get('per_page') ?? '30');
    const page = Number(u.searchParams.get('page') ?? '1');
    return list.slice((page - 1) * per, page * per);
  };
  /** a resource route: needs a live installation token with permission `perm` and, when the token is repo-scoped, `repo` in it */
  /** like `res`, but `f` returns the whole route (status included); `level` write requires a write permission (read accepts either) */
  const resRoute = (perm: string, repo: GhFakeRepo | null, f: (r: RecordedRequest) => HttpRoute, level: 'read' | 'write' = 'read'): HttpRoute => (r) => {
    const tok = /^Bearer (ghs_\w+)$/.exec(r.headers['authorization'] ?? '')?.[1];
    const scope = tok ? live.get(tok) : undefined;
    if (!scope) return { status: 401, body: { message: 'Bad credentials' } };
    if (o.resourceFail) return { status: o.resourceFail.status, ...(o.resourceFail.headers ? { headers: o.resourceFail.headers } : {}), body: { message: 'API rate limit exceeded for installation' } };
    if (!scope.permissions?.[perm] || (level === 'write' && scope.permissions[perm] !== 'write')) return { status: 403, body: { message: 'Resource not accessible by integration' } };
    if (repo && scope.repositories && !scope.repositories.includes(repo.name)) return { status: 404, body: { message: 'Not Found' } };
    if (repo && scope.repository_ids && !scope.repository_ids.includes(repo.id ?? -1)) return { status: 404, body: { message: 'Not Found' } };
    return f(r);
  };
  const res = (perm: string, repo: GhFakeRepo | null, f: (r: RecordedRequest) => unknown): HttpRoute => resRoute(perm, repo, (r) => ({ body: f(r) }));
  const routes: Record<string, HttpRoute> = {
    [`GET ${GITHUB_BASE}/app`]: asApp(() => ({ body: { id: 4242, slug: 'praw-bot', name: 'Praw Bot', owner: { login: 'acme' }, permissions: { metadata: 'read', issues: 'read' } } })),
    [`GET ${GITHUB_BASE}/app/installations/${o.installationId}`]: asApp(() => ({ body: { id: Number(o.installationId), account: o.account ?? { login: 'acme', type: 'Organization' }, repository_selection: 'selected', permissions: { metadata: 'read', issues: 'read', contents: 'read' } } })),
    [`POST ${GITHUB_BASE}/app/installations/${o.installationId}/access_tokens`]: asApp((claims) => (r) => {
      const body = JSON.parse(r.body ?? '{}') as GhMint['body'];
      const token = `ghs_${String(mints.length + 1).padStart(2, '0')}${'Ab1'.repeat(12)}`;
      mints.push({ body, claims, token });
      live.set(token, body);
      return { status: 201, body: { token, expires_at: new Date(now() + (o.ttlMs ?? 3_600_000)).toISOString(), permissions: body.permissions ?? {}, repository_selection: 'selected' } };
    }),
    [`GET ${GITHUB_BASE}/search/repositories`]: res('metadata', null, (r) => ({ total_count: (o.search ?? []).length, items: paged(o.search ?? [], r) })),
  };
  for (const [org, list] of Object.entries(o.orgRepos ?? {})) routes[`GET ${GITHUB_BASE}/orgs/${org}/repos`] = res('metadata', null, (r) => paged(list, r));
  for (const [user, list] of Object.entries(o.userRepos ?? {})) routes[`GET ${GITHUB_BASE}/users/${user}/repos`] = res('metadata', null, (r) => paged(list, r));
  for (const rp of o.repos ?? []) {
    const P = `${GITHUB_BASE}/repos/${rp.owner}/${rp.name}`;
    const canonical = () => ({ id: rp.id ?? null, full_name: `${rp.owner}/${rp.name}`, owner: { login: rp.owner }, default_branch: 'main', ...(rp.info ?? {}) });
    routes[`GET ${P}`] = res('metadata', rp, canonical);
    for (const a of rp.aliases ?? []) routes[`GET ${GITHUB_BASE}/repos/${rp.owner}/${a}`] = res('metadata', { ...rp, name: a }, canonical);
    const def = String(rp.info?.['default_branch'] ?? 'main');
    const branches: Record<string, string> = { ...(rp.branches ?? { [def]: 'a'.repeat(40) }) }; // per-rig copies: a shared fixture is never mutated
    const files: Record<string, string> = { ...(rp.files ?? {}) };
    const tail = (r: RecordedRequest, prefix: string) => new URL(r.url).pathname.slice(new URL(prefix).pathname.length).split('/').map(decodeURIComponent).join('/');
    const json = (r: RecordedRequest) => JSON.parse(r.body ?? '{}') as Record<string, unknown>;
    const blob = (text: string) => createHash('sha1').update(text).digest('hex');
    const full = `${rp.owner}/${rp.name}`;
    routes[`GET ${P}/git/ref/heads/*`] = resRoute('contents', rp, (r) => {
      const b = tail(r, `${P}/git/ref/heads/`);
      return branches[b] ? { body: { ref: `refs/heads/${b}`, object: { type: 'commit', sha: branches[b] } } } : { status: 404, body: { message: 'Not Found' } };
    });
    routes[`POST ${P}/git/refs`] = resRoute('contents', rp, (r) => {
      const b = json(r);
      writes.push({ repo: full, method: 'POST', path: 'git/refs', body: b });
      const name = String(b['ref']).replace(/^refs\/heads\//, '');
      if (branches[name]) return { status: 422, body: { message: 'Reference already exists' } };
      branches[name] = String(b['sha']);
      return { status: 201, body: { ref: b['ref'], object: { type: 'commit', sha: b['sha'] } } };
    }, 'write');
    routes[`GET ${P}/contents/*`] = resRoute('contents', rp, (r) => {
      const ref = new URL(r.url).searchParams.get('ref') ?? def;
      const text = files[`${ref}:${tail(r, `${P}/contents/`)}`];
      return text === undefined ? { status: 404, body: { message: 'Not Found' } } : { body: { type: 'file', encoding: 'base64', size: Buffer.byteLength(text), sha: blob(text), content: Buffer.from(text).toString('base64') } };
    });
    routes[`PUT ${P}/contents/*`] = resRoute('contents', rp, (r) => {
      const b = json(r);
      const path = tail(r, `${P}/contents/`);
      writes.push({ repo: full, method: 'PUT', path: `contents/${path}`, body: b });
      const branch = String(b['branch'] ?? def);
      if (!branches[branch]) return { status: 404, body: { message: 'Branch not found' } };
      const key = `${branch}:${path}`;
      const old = files[key];
      if (old !== undefined && b['sha'] !== blob(old)) return { status: 409, body: { message: 'sha does not match' } };
      if (old === undefined && b['sha'] !== undefined) return { status: 422, body: { message: 'sha given for a new file' } };
      files[key] = Buffer.from(String(b['content']), 'base64').toString('utf8');
      branches[branch] = blob(`${branches[branch]}${files[key]}`);
      return { status: old === undefined ? 201 : 200, body: { content: { sha: blob(files[key]!) }, commit: { sha: branches[branch] } } };
    }, 'write');
    routes[`POST ${P}/pulls`] = resRoute('pull_requests', rp, (r) => {
      const b = json(r);
      writes.push({ repo: full, method: 'POST', path: 'pulls', body: b });
      if (!branches[String(b['head'])] || !branches[String(b['base'])]) return { status: 422, body: { message: 'Validation Failed' } };
      return { status: 201, body: { number: 101, html_url: `https://github.com/${full}/pull/101`, state: 'open' } };
    }, 'write');
    routes[`GET ${P}/issues`] = res('issues', rp, (r) => paged(rp.issues ?? [], r));
    routes[`GET ${P}/pulls`] = res('pull_requests', rp, (r) => paged(rp.pulls ?? [], r));
    routes[`GET ${P}/commits`] = res('contents', rp, (r) => paged(rp.commits ?? [], r));
    for (const i of rp.issues ?? []) routes[`GET ${P}/issues/${i['number']}`] = res('issues', rp, () => i);
    for (const p of rp.pulls ?? []) routes[`GET ${P}/pulls/${p['number']}`] = res('pull_requests', rp, () => p);
  }
  Object.assign(routes, o.extraRoutes ?? {});
  return { routes, mints, writes };
}

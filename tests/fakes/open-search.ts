import { gzipSync } from 'node:zlib';
import type { TransportRequest } from '../../net/fetch.js';
import { fakeTransport, type FakeRoute } from './net.js';

/** SEARCH-1 fixtures: upstream response shapes of the six open streams, plus a host-routing fake transport route. */

export const PUBLIC = '93.184.215.14';
export const HOSTS = ['en.wikipedia.org', 'th.wikipedia.org', 'hn.algolia.com', 'api.stackexchange.com', 'registry.npmjs.org', 'api.github.com'] as const;
export const resolverTable = () => Object.fromEntries(HOSTS.map((h) => [h, [PUBLIC]]));

const json = (body: unknown, headers: Record<string, string> = {}): FakeRoute => ({ status: 200, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
export const ok = json;
export const gz = (body: unknown, extra: Record<string, string> = {}): FakeRoute => ({ status: 200, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip', ...extra }, body: [gzipSync(Buffer.from(JSON.stringify(body)))] });
export const status = (s: number, body: unknown = {}, headers: Record<string, string> = {}): FakeRoute => ({ status: s, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

export const wikiBody = (items: { title: string; snippet: string }[]) => ({ query: { search: items } });
export const hnBody = (hits: unknown[]) => ({ hits });
export const seBody = (items: unknown[], extra: Record<string, unknown> = {}) => ({ items, has_more: false, quota_max: 300, quota_remaining: 250, ...extra });
export const npmBody = (pkgs: unknown[]) => ({ objects: pkgs.map((p) => ({ package: p })), total: pkgs.length });
export const ghBody = (items: unknown[]) => ({ total_count: items.length, items });

export const wikiEn = wikiBody([
  { title: 'Rust (programming language)', snippet: 'Rust is a <span class="searchmatch">language</span> &amp; more &quot;fast&quot;' },
  { title: 'AC/DC', snippet: 'band' },
]);
export const wikiTh = wikiBody([{ title: 'กรุงเทพมหานคร', snippet: 'เมืองหลวง' }]);
export const hnOne = hnBody([
  { objectID: '111', title: 'Show HN: a thing', url: 'https://example.org/thing', points: 120, num_comments: 33, created_at: '2026-01-02T03:04:05Z' },
  { objectID: '222', title: 'Ask HN: x', url: null, points: null, num_comments: null, created_at: '2026-02-03T00:00:00Z' },
]);
export const seOne = seBody([
  { question_id: 42, title: 'How to use &quot;async&quot; &amp; await?', score: 7, answer_count: 2, is_answered: true, tags: ['javascript', 'async', 'a', 'b', 'c', 'd'] },
]);
export const npmOne = npmBody([{ name: '@scope/pkg', version: '1.2.3', description: 'A  pkg\nwith lines' }, { name: 'left-pad', version: '1.0.0' }]);
export const ghOne = ghBody([{ full_name: 'rust-lang/rust', description: 'Empowering everyone', stargazers_count: 100000, language: 'Rust', html_url: 'https://evil.example/' }]);

/** A fake transport that answers by host (any path): `handler(url)` returns the route. Requests are recorded. */
export function hostTransport(handler: (u: URL) => FakeRoute) {
  const routes = new Proxy({} as Record<string, FakeRoute>, { get: () => (r: TransportRequest) => handler(r.url) });
  return fakeTransport(routes);
}
export const byHost = (table: Partial<Record<(typeof HOSTS)[number], FakeRoute>>) => (u: URL): FakeRoute => table[u.hostname as (typeof HOSTS)[number]] ?? { status: 404, body: 'nf' };

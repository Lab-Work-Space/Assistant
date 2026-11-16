/**
 * SEARCH-1 live probe (opt-in, real network, one query per stream). It deviates from the loopback-only `net` project on purpose:
 *   OPEN_SEARCH_PROBE=1 npx vitest run --project net tools/plugins/web/openSearch.net.test.ts
 * Without the variable every case is skipped. Prints one line per stream: status, item count and, for Stack Exchange, the gzip and quota fields.
 */
import { describe, expect, it } from 'vitest';
import { systemResolver, systemTransport } from '../../../net/system.js';
import { safeFetch } from '../../../net/guard.js';
import { gunzipSync } from 'node:zlib';
import { parseGh, parseHn, parseNpm, parseSe, parseWiki, UA } from './openSearch.js';

const live = process.env.OPEN_SEARCH_PROBE === '1';
const run = live ? it : it.skip;
const H = { 'user-agent': UA, accept: 'application/json' };
const get = async (url: string, headers: Record<string, string> = H) => {
  const u = new URL(url);
  const res = await safeFetch(url, { resolver: systemResolver, transport: systemTransport, extraPorts: [], allowHosts: [u.hostname], timeoutMs: 15000, maxBytes: 524288, headers });
  const gz = res.body[0] === 0x1f && res.body[1] === 0x8b;
  const text = (gz ? gunzipSync(res.body, { maxOutputLength: 1048576 }) : res.body).toString('utf8');
  return { res, gz, json: JSON.parse(text) as Record<string, any> };
};
const line = (id: string, s: number, n: number, extra = '') => console.info(`PROBE ${id}: status=${s} items=${n}${extra ? ' ' + extra : ''}`);

describe('open search live probe', () => {
  run('wikipedia en + th: envelope and slash-title url resolves', async () => {
    for (const [lang, q] of [['en', 'rust programming language'], ['th', 'กรุงเทพมหานคร']] as const) {
      const { res, json } = await get(`https://${lang}.wikipedia.org/w/api.php?${new URLSearchParams({ action: 'query', list: 'search', srsearch: q, srlimit: '5', srprop: 'snippet', format: 'json', formatversion: '2', utf8: '1' })}`);
      const hits = parseWiki(json, lang);
      line(`wikipedia-${lang}`, res.status, hits.length);
      expect(res.status).toBe(200);
      expect(hits.length).toBeGreaterThan(0);
    }
    const page = await safeFetch(parseWiki({ query: { search: [{ title: 'AC/DC', snippet: '' }] } }, 'en')[0]!.url, { resolver: systemResolver, transport: systemTransport, extraPorts: [], allowHosts: ['en.wikipedia.org'], headers: H, timeoutMs: 15000 });
    line('wikipedia-slash-title', page.status, 1, `final=${page.finalUrl}`);
    expect(page.status).toBe(200);
  }, 60000);
  run('hackernews', async () => {
    const { res, json } = await get(`https://hn.algolia.com/api/v1/search?${new URLSearchParams({ query: 'rust', tags: 'story', hitsPerPage: '5' })}`);
    const hits = parseHn(json);
    line('hackernews', res.status, hits.length);
    expect(res.status).toBe(200);
    expect(hits.length).toBeGreaterThan(0);
  }, 30000);
  run('stackoverflow: envelope, gzip and quota fields', async () => {
    const { res, gz, json } = await get(`https://api.stackexchange.com/2.3/search/advanced?${new URLSearchParams({ order: 'desc', sort: 'relevance', q: 'async await', site: 'stackoverflow', pagesize: '5', filter: 'default' })}`);
    const hits = parseSe(json);
    line('stackoverflow', res.status, hits.length, `gzip=${gz} content-encoding=${res.headers['content-encoding'] ?? '-'} quota_remaining=${json.quota_remaining} quota_max=${json.quota_max} backoff=${json.backoff ?? '-'}`);
    expect(res.status).toBe(200);
    expect(hits.length).toBeGreaterThan(0);
    expect(typeof json.quota_remaining).toBe('number');
  }, 30000);
  run('npm', async () => {
    const { res, json } = await get(`https://registry.npmjs.org/-/v1/search?${new URLSearchParams({ text: 'express', size: '5' })}`);
    const hits = parseNpm(json);
    line('npm', res.status, hits.length);
    expect(res.status).toBe(200);
    expect(hits.length).toBeGreaterThan(0);
  }, 30000);
  run('github', async () => {
    const { res, json } = await get(`https://api.github.com/search/repositories?${new URLSearchParams({ q: 'rust language', per_page: '5' })}`, { ...H, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' });
    const hits = parseGh(json);
    line('github', res.status, hits.length, `ratelimit-remaining=${res.headers['x-ratelimit-remaining'] ?? '-'}`);
    expect(res.status).toBe(200);
    expect(hits.length).toBeGreaterThan(0);
  }, 30000);
});

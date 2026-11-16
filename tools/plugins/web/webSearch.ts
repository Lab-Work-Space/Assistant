import { z } from 'zod';
import { decodeEntities, htmlToText } from '../../../net/html.js';
import { safeFetch } from '../../../net/guard.js';
import { urlKey } from '../../urls.js';
import { toolError, type ToolPlugin } from '../../types.js';
import { readPage, type WebNetOptions } from './browser.js';

export type SearchHit = { title: string; url: string; snippet: string };
/** Where web_search gets results; swap the implementation without touching the tool. */
export type SourceId = 'wikipedia' | 'hackernews' | 'stackoverflow' | 'npm' | 'github';
export interface SearchBackend {
  search(q: string, n: number, opts?: { source?: SourceId }): Promise<SearchHit[]>;
}
const SOURCE_IDS = ['wikipedia', 'hackernews', 'stackoverflow', 'npm', 'github'] as const;
const LABEL: Record<SourceId, string> = { wikipedia: 'Wikipedia', hackernews: 'Hacker News', stackoverflow: 'Stack Overflow', npm: 'npm', github: 'GitHub' };

/** `source` was given while `web.search.openSources` is off (SEARCH-1). */
export class SourceOff extends Error {
  constructor() { super('the source option is off'); this.name = 'SourceOff'; }
}

export const MAX_RESULTS = 10;
const DEFAULT_RESULTS = 5;
const TITLE_MAX = 200;
const SNIPPET_MAX = 400;

/**
 * DuckDuckGo's HTML endpoint (the old bot used DuckDuckGo through `ddgs`). Fetched with our own guarded safeFetch, no
 * new dependency. There is no official API doc or published rate limit for this endpoint: the shape below was observed
 * live (T14 report), `kp=1` is safe search "on" per DuckDuckGo's URL-parameter help page, a bot challenge page or a
 * 202 is treated as a backend error.
 */
const DDG_URL = 'https://html.duckduckgo.com/html/';

const TAG_MAX = 4000;
const INNER_MAX = 8000;

/** `name="v"` or `name='v'` inside one start tag (the tag is length-capped by the caller). */
function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s{0,8}=\\s{0,8}("([^"]{0,${TAG_MAX}})"|'([^']{0,${TAG_MAX}})')`, 'i').exec(tag);
  return m ? (m[2] ?? m[3] ?? '') : null;
}

/** DuckDuckGo result link -> target url: direct hrefs, or the `//duckduckgo.com/l/?uddg=` redirect form. Null unless http(s). */
function targetOf(href: string): string | null {
  const h = decodeEntities(href.trim());
  try {
    const u = new URL(h, 'https://duckduckgo.com/');
    if ((u.hostname === 'duckduckgo.com' || u.hostname.endsWith('.duckduckgo.com')) && u.pathname === '/l/') {
      const t = u.searchParams.get('uddg');
      return t ? urlKey(t) : null;
    }
    return /^https?:\/\//i.test(h) ? urlKey(h) : null;
  } catch {
    return null;
  }
}

/**
 * The element whose start tag carries `marker` (e.g. `class="result__a"`): its start tag and inner html. indexOf only
 * (linear on hostile input); null when the tag or its content is over the caps or not closed.
 */
function element(block: string, marker: string): { tag: string; inner: string } | null {
  const at = block.indexOf(marker);
  if (at === -1) return null;
  const lt = block.lastIndexOf('<', at);
  const gt = block.indexOf('>', at);
  if (lt === -1 || gt === -1 || gt - lt > TAG_MAX) return null;
  const name = /^<([a-zA-Z][a-zA-Z0-9]{0,15})/.exec(block.slice(lt, lt + 17))?.[1];
  if (!name) return null;
  const end = block.indexOf(`</${name}>`, gt);
  if (end === -1 || end - gt > INNER_MAX) return null;
  return { tag: block.slice(lt, gt + 1), inner: block.slice(gt + 1, end) };
}

/** Parses a DuckDuckGo HTML results page. Ads (`result--ad`) and non-http(s) links are skipped. Linear time. */
export function parseDdgHtml(html: string): SearchHit[] {
  const out: SearchHit[] = [];
  const flat = (s: string) => htmlToText(s).replace(/\s+/g, ' ').trim();
  for (const block of html.split('<div class="result ').slice(1)) {
    const q = block.indexOf('"');
    if (/\bresult--ad\b/.test(block.slice(0, q === -1 ? 0 : Math.min(q, TAG_MAX)))) continue;
    const a = element(block, 'class="result__a"');
    if (!a) continue;
    const url = targetOf(attr(a.tag, 'href') ?? '');
    if (!url) continue;
    const sn = element(block, 'class="result__snippet"');
    out.push({ title: flat(a.inner).slice(0, TITLE_MAX), url, snippet: sn ? flat(sn.inner).slice(0, SNIPPET_MAX) : '' });
  }
  return out;
}

/** The search provider refused this client (bot check). Retrying soon does not help, so the tool says so. */
export class SearchRefused extends Error {
  constructor() { super('search backend refused the request (bot check)'); this.name = 'SearchRefused'; }
}

export function ddgBackend(o: WebNetOptions): SearchBackend {
  return {
    async search(q, n) {
      // Chrome renders a GET results page; the guarded HTTP path (VPS, tests) keeps the form POST.
      const res = o.browser ? await readPage(o, `${DDG_URL}?${new URLSearchParams({ q, kp: '1' }).toString()}`) : await safeFetch(DDG_URL, {
        resolver: o.resolver, transport: o.transport, extraPorts: o.extraPorts(), method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ q, kp: '1' }).toString(),
      });
      if (res.status === 202) throw new SearchRefused(); // DuckDuckGo answers its bot-check page with 202
      if (res.status !== 200) throw new Error(`search backend answered ${res.status}`);
      const html = res.body.toString('utf8');
      const hits = parseDdgHtml(html);
      if (hits.length === 0 && /challenge-form|bots use DuckDuckGo|anomaly/i.test(html)) throw new SearchRefused();
      return hits.slice(0, n);
    },
  };
}

/** Format, private-use, tag and variation-selector code points: text a person cannot see on a card. */
export const HIDDEN = /[\p{Cf}\p{Co}\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/u;

const Input = z.object({
  query: z.string().trim().min(1).max(400).describe('What to search the web for'),
  count: z.number().int().min(1).max(MAX_RESULTS).optional().describe(`How many results (1-${MAX_RESULTS}, default ${DEFAULT_RESULTS})`),
  source: z.enum(SOURCE_IDS).optional().describe('Search only this open source: wikipedia, hackernews, stackoverflow, npm or github'),
});

const T1 = "web search failed: blocked by the search provider (bot check), and no open source (Wikipedia, Hacker News, Stack Overflow, npm, GitHub) answered; it will not work in this run, so do not retry it. Read known pages directly with fetch_page instead (for example a vendor's official pricing or docs page).";
const T2 = 'web search failed: the search backend is unavailable, try again later';
const T4 = 'web search failed: the source option is off (web.search.openSources is false); call web_search without source';

/** Raw text out (the registry wraps it untrusted, PF11). Each url is on its own line, verbatim, so the registry records it (R17). */
export function webSearchTool(backend: SearchBackend): ToolPlugin<{ query: string; count?: number | undefined; source?: SourceId | undefined }> {
  return {
    name: 'web_search',
    description: 'Search the web. Returns titles, urls and snippets; read a result with fetch_page. When the general search is unavailable, results come from Wikipedia, Hacker News, Stack Overflow, npm and GitHub (each title starts with its [source]); set source to search only one of them.',
    kind: 'read',
    untrustedOutput: true,
    untrustedSource: 'web',
    inputSchema: Input,
    // G2-05: after the run read outside text, an injected page could steer the query text (private data) to the search backend,
    // so a tainted run asks first. The card shows the whole query in its own Query fields (discord/embeds/approval.ts), JSON-escaped.
    // A tainted query with invisible characters (tag-encoded text, zero width) is refused: a human cannot check what they cannot read.
    async precheck(input, ctx) {
      return ctx.tainted() && HIDDEN.test(input.query) ? { refuse: 'web_search: the query holds invisible characters, nothing was searched' } : null;
    },
    requiresApproval: (input, ctx) => {
      if (!ctx.tainted()) return false;
      const n = Math.max(1, Math.min(MAX_RESULTS, Math.trunc(input.count ?? DEFAULT_RESULTS)));
      if (input.source) return { reason: `tool web_search: send the query below to ${LABEL[input.source]} (${n} results)` };
      return { reason: `tool web_search: send the query below to the search backend (DuckDuckGo; Wikipedia, Hacker News, Stack Exchange, npm and GitHub when it is blocked) (${n} results)` };
    },
    async run(input) {
      const n = Math.max(1, Math.min(MAX_RESULTS, Math.trunc(input.count ?? DEFAULT_RESULTS)));
      let hits: SearchHit[];
      try {
        hits = (await (input.source ? backend.search(input.query, n, { source: input.source }) : backend.search(input.query, n))).slice(0, n);
      } catch (e) {
        if (e instanceof SearchRefused) return toolError(T1);
        if (e instanceof SourceOff) return toolError(T4);
        return toolError(T2); // the error text may hold anything: not shown
      }
      if (hits.length === 0) return { content: 'No results.' };
      return { content: hits.map((h, i) => `${i + 1}. ${h.title}\n${h.url}\n${h.snippet}`).join('\n\n') };
    },
  };
}

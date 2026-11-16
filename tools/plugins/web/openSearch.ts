import { gunzipSync, inflateSync } from 'node:zlib';
import { z } from 'zod';
import { decodeEntities, htmlToText } from '../../../net/html.js';
import { urlKey } from '../../urls.js';
import { readPage, type WebNetOptions } from './browser.js';
import { SearchRefused, SourceOff, type SearchBackend, type SearchHit, type SourceId } from './webSearch.js';

/**
 * SEARCH-1: keyless open-source fallback for web_search (Gate 1 SR-C1..C12). Six fixed hosts, GET only, URLs built by code from
 * validated fields. Nothing here logs: upstream bodies, headers, errors and the query are never written anywhere.
 */
export { SourceOff };

export const UA = 'PrawAssistant/1.0 (keyless open search; bot)';
const TITLE_MAX = 200;
const SNIPPET_MAX = 400;
const MAX_BYTES = 524288; // SR-C3: per response
const MAX_INFLATED = 1048576; // SR-C3: after gunzip / inflate
const STREAM_MS = 8000;
const OVERALL_MS = 20000;
const BROWSER_PARALLEL = 2; // SR-C8: Chrome has Slots(2,8)
const DEFAULT_COOL_MS = 60_000;
const MAX_COOL_MS = 24 * 3600_000; // SR-C7
const DAY_MS = 86_400_000;

const HIDDEN_G = /[\p{Cf}\p{Co}\u{E0000}-\u{E007F}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu;
/** One line, no control characters, no invisible format characters (SR-C4). */
const fold = (s: string): string => s.replace(HIDDEN_G, '').replace(/[\p{Cc}\s]+/gu, ' ').trim();
/** Html in, one plain line out. */
const flat = (s: string): string => fold(htmlToText(s));

type StreamId = 'wikipedia-en' | 'wikipedia-th' | 'hackernews' | 'stackoverflow' | 'npm' | 'github';
const ORDER: StreamId[] = ['wikipedia-en', 'wikipedia-th', 'hackernews', 'stackoverflow', 'npm', 'github'];

const hit = (label: string, title: string, url: string, snippet: string): SearchHit => ({
  title: `[${label}] ${title}`.slice(0, TITLE_MAX), url, snippet: snippet.slice(0, SNIPPET_MAX),
});
/** Items that fail validation are skipped; the envelope was checked by the caller. */
function each<T>(items: unknown[], schema: z.ZodType<T>, f: (t: T) => SearchHit | null): SearchHit[] {
  const out: SearchHit[] = [];
  for (const raw of items) {
    const r = schema.safeParse(raw);
    if (!r.success) continue;
    const h = f(r.data);
    if (h) out.push(h);
  }
  return out;
}
const envelope = (json: unknown, key: string): unknown[] => {
  const r = z.object({ [key]: z.array(z.unknown()) }).safeParse(json);
  if (!r.success) throw new Error('bad envelope');
  return (r.data as Record<string, unknown[]>)[key] as unknown[];
};

// ---- parsers (pure, for fixtures). Each throws on a bad envelope and skips bad items. ----

const WikiItem = z.object({ title: z.string().min(1), snippet: z.string() });
export function parseWiki(json: unknown, lang: 'en' | 'th'): SearchHit[] {
  const q = z.object({ query: z.object({ search: z.array(z.unknown()) }) }).safeParse(json);
  if (!q.success) throw new Error('bad envelope');
  return each(q.data.query.search, WikiItem, (i) => {
    const title = fold(i.title);
    if (!title) return null;
    return hit(lang === 'th' ? 'Wikipedia TH' : 'Wikipedia', title, `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(i.title.replaceAll(' ', '_'))}`, flat(i.snippet));
  });
}

const HnItem = z.object({
  objectID: z.string().regex(/^\d{1,12}$/), title: z.string().min(1), url: z.string().nullish(),
  points: z.number().nullish(), num_comments: z.number().nullish(), created_at: z.string().optional(),
});
export function parseHn(json: unknown): SearchHit[] {
  return each(envelope(json, 'hits'), HnItem, (i) => {
    const title = fold(i.title);
    if (!title) return null;
    // SR-C2: the story url only when urlKey accepts it (protocol exactly http: or https:); else the HN item page.
    const url = (i.url ? urlKey(i.url) : null) ?? `https://news.ycombinator.com/item?id=${i.objectID}`;
    return hit('Hacker News', title, url, fold(`${i.points ?? 0} points, ${i.num_comments ?? 0} comments, ${(i.created_at ?? '').slice(0, 10)}`));
  });
}

const SeItem = z.object({
  question_id: z.number().int().positive(), title: z.string().min(1), score: z.number().int(), answer_count: z.number().int(),
  is_answered: z.boolean(), tags: z.array(z.string()),
});
export function parseSe(json: unknown): SearchHit[] {
  return each(envelope(json, 'items'), SeItem, (i) => {
    const title = fold(decodeEntities(i.title));
    if (!title) return null;
    const tags = i.tags.slice(0, 5).map((t) => fold(decodeEntities(t))).join(', ');
    return hit('Stack Overflow', title, `https://stackoverflow.com/questions/${i.question_id}`,
      fold(`score ${i.score}, ${i.answer_count} answers${i.is_answered ? ' (answered)' : ''}; tags: ${tags}`));
  });
}

const NpmItem = z.object({
  package: z.object({
    name: z.string().max(214).regex(/^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/), version: z.string(), description: z.string().optional(),
  }),
});
export function parseNpm(json: unknown): SearchHit[] {
  return each(envelope(json, 'objects'), NpmItem, ({ package: p }) =>
    hit('npm', p.name, `https://www.npmjs.com/package/${p.name}`, fold(`v${p.version} - ${p.description ?? ''}`)));
}

const GhItem = z.object({
  full_name: z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/), description: z.string().nullish(),
  stargazers_count: z.number().int(), language: z.string().nullish(),
});
export function parseGh(json: unknown): SearchHit[] {
  return each(envelope(json, 'items'), GhItem, (i) =>
    hit('GitHub', i.full_name, `https://github.com/${i.full_name}`, fold(`${i.stargazers_count} stars, ${i.language ?? '-'}: ${i.description ?? ''}`)));
}

// ---- limiter ----

type Limit = { perMin: number; perDay?: number };
const LIMITS: Record<StreamId, Limit> = {
  github: { perMin: 8 }, stackoverflow: { perMin: 25, perDay: 250 }, 'wikipedia-en': { perMin: 60 },
  'wikipedia-th': { perMin: 60 }, hackernews: { perMin: 60 }, npm: { perMin: 60 },
};

/** In-memory sliding window per stream plus a cool-down timestamp. Never waits (SR-C7). */
class Limiter {
  private win = new Map<StreamId, number[]>();
  private day = new Map<StreamId, { key: number; n: number }>();
  private until = new Map<StreamId, number>();
  constructor(private now: () => number) {}
  take(id: StreamId): boolean {
    const t = this.now();
    if (t < (this.until.get(id) ?? 0)) return false;
    const lim = LIMITS[id];
    const w = (this.win.get(id) ?? []).filter((x) => t - x < 60_000);
    if (w.length >= lim.perMin) { this.win.set(id, w); return false; }
    if (lim.perDay !== undefined) {
      const key = Math.floor(t / DAY_MS);
      const d = this.day.get(id);
      const cur = d && d.key === key ? d : { key, n: 0 };
      if (cur.n >= lim.perDay) { this.day.set(id, cur); return false; }
      cur.n += 1;
      this.day.set(id, cur);
    }
    w.push(t);
    this.win.set(id, w);
    return true;
  }
  coolFor(id: StreamId, ms: number): void {
    const c = Math.min(MAX_COOL_MS, Math.max(1, ms));
    this.until.set(id, Math.max(this.until.get(id) ?? 0, this.now() + c));
  }
}

/** Seconds from a header or body field to a cool-down in ms: non-numeric, negative or zero falls back to 60 s; clamped to 24 h. */
const secondsToMs = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,15}$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(MAX_COOL_MS, n * 1000) : DEFAULT_COOL_MS;
};
const untilMidnightMs = (t: number): number => DAY_MS - (t % DAY_MS);

// ---- streams ----

type Stream = {
  id: StreamId; source: SourceId; host: string; maxQ: number; accept: string; extra?: Record<string, string>;
  url: (q: string, n: number) => string; parse: (json: unknown) => SearchHit[];
};
const qs = (o: Record<string, string>) => new URLSearchParams(o).toString(); // SR-C2: q only through URLSearchParams
const wiki = (lang: 'en' | 'th'): Stream => ({
  id: `wikipedia-${lang}`, source: 'wikipedia', host: `${lang}.wikipedia.org`, maxQ: 300, accept: 'application/json',
  url: (q, n) => `https://${lang}.wikipedia.org/w/api.php?${qs({ action: 'query', list: 'search', srsearch: q, srlimit: String(n), srprop: 'snippet', format: 'json', formatversion: '2', utf8: '1' })}`,
  parse: (j) => parseWiki(j, lang),
});
const STREAMS: Record<StreamId, Stream> = {
  'wikipedia-en': wiki('en'),
  'wikipedia-th': wiki('th'),
  hackernews: {
    id: 'hackernews', source: 'hackernews', host: 'hn.algolia.com', maxQ: 400, accept: 'application/json',
    url: (q, n) => `https://hn.algolia.com/api/v1/search?${qs({ query: q, tags: 'story', hitsPerPage: String(n) })}`, parse: parseHn,
  },
  stackoverflow: {
    id: 'stackoverflow', source: 'stackoverflow', host: 'api.stackexchange.com', maxQ: 400, accept: 'application/json',
    url: (q, n) => `https://api.stackexchange.com/2.3/search/advanced?${qs({ order: 'desc', sort: 'relevance', q, site: 'stackoverflow', pagesize: String(n), filter: 'default' })}`, parse: parseSe,
  },
  npm: {
    id: 'npm', source: 'npm', host: 'registry.npmjs.org', maxQ: 400, accept: 'application/json',
    url: (q, n) => `https://registry.npmjs.org/-/v1/search?${qs({ text: q, size: String(n) })}`, parse: parseNpm,
  },
  github: {
    id: 'github', source: 'github', host: 'api.github.com', maxQ: 256, accept: 'application/vnd.github+json', extra: { 'x-github-api-version': '2022-11-28' },
    url: (q, n) => `https://api.github.com/search/repositories?${qs({ q, per_page: String(n) })}`, parse: parseGh,
  },
};

type Outcome = { ok: true; hits: SearchHit[]; coolMs?: number } | { ok: false; coolMs?: number };

function decode(o: WebNetOptions, body: Buffer, enc: string | undefined): Buffer {
  if (o.browser) return body; // Chrome decodes the body itself
  if (body.length >= 2 && body[0] === 0x1f && body[1] === 0x8b) return gunzipSync(body, { maxOutputLength: MAX_INFLATED });
  if (enc?.trim().toLowerCase() === 'deflate') return inflateSync(body, { maxOutputLength: MAX_INFLATED });
  if (body.length > MAX_INFLATED) throw new Error('too large');
  return body;
}

/** Cool-down a stream wants after this answer: GitHub reset header, Stack Exchange backoff / quota / throttle, else 60 s on 429. */
function coolOf(s: Stream, status: number, headers: Record<string, string>, json: unknown, now: number): number | undefined {
  const obj = json && typeof json === 'object' ? (json as Record<string, unknown>) : {};
  if (s.id === 'stackoverflow') {
    if ('backoff' in obj && obj.backoff !== null && obj.backoff !== 0) return secondsToMs(obj.backoff);
    if (status === 400 && obj.error_id === 502) return untilMidnightMs(now);
    if (obj.quota_remaining === 0) return untilMidnightMs(now);
  }
  if (status === 429 || (s.id === 'github' && status === 403)) {
    const reset = s.id === 'github' ? headers['x-ratelimit-reset'] : undefined;
    if (reset !== undefined) {
      const at = /^\d{1,15}$/.test(reset.trim()) ? Number(reset) * 1000 : NaN;
      return Number.isFinite(at) && at > now ? Math.min(MAX_COOL_MS, at - now) : DEFAULT_COOL_MS; // SR-C7: past / junk -> 60 s
    }
    return DEFAULT_COOL_MS;
  }
  return undefined;
}

/** One stream's fetch, decode and parse. Pure with respect to limiter state: the caller applies the cool-down (a late result is dropped, SR-C8). */
async function fetchStream(o: WebNetOptions, s: Stream, q: string, n: number, now: () => number): Promise<Outcome> {
  try {
    const headers = { 'user-agent': UA, accept: s.accept, ...(s.extra ?? {}) }; // SR-C11
    const res = await readPage(o, s.url(q, n), { allowHosts: [s.host], timeoutMs: STREAM_MS, maxBytes: MAX_BYTES, headers }); // SR-C1
    if (o.browser && new URL(res.finalUrl).hostname !== s.host) return { ok: false };
    if (res.truncated) return { ok: false };
    let json: unknown;
    try { json = JSON.parse(decode(o, res.body, res.headers['content-encoding']).toString('utf8')); } catch { json = undefined; } // SR-C12
    const cool = coolOf(s, res.status, res.headers, json, now());
    if (res.status !== 200 || json === undefined) return { ok: false, ...(cool !== undefined ? { coolMs: cool } : {}) };
    return { ok: true, hits: s.parse(json), ...(cool !== undefined ? { coolMs: cool } : {}) };
  } catch {
    return { ok: false };
  }
}

export type OpenSearchOpts = { now?: () => number; streamMs?: number; overallMs?: number };

export interface OpenBackend {
  search(q: string, n: number, sources?: SourceId[]): Promise<SearchHit[]>;
}

export function openSearchBackend(o: WebNetOptions, opts: OpenSearchOpts = {}): OpenBackend {
  const now = opts.now ?? Date.now;
  const streamMs = opts.streamMs ?? STREAM_MS;
  const overallMs = opts.overallMs ?? OVERALL_MS;
  const limiter = new Limiter(now);
  return {
    async search(q, n, sources) {
      n = Math.max(1, Math.min(10, Math.trunc(n))); // SR-C2
      const thai = /\p{Script=Thai}/u.test(q);
      const want = new Set<StreamId>();
      for (const src of sources ?? ['wikipedia', 'hackernews', 'stackoverflow', 'npm', 'github'] as SourceId[]) {
        if (src === 'wikipedia') { want.add('wikipedia-en'); if (thai) want.add('wikipedia-th'); } else want.add(src);
      }
      const order = ORDER.filter((id) => want.has(id));
      if (thai && want.has('wikipedia-th')) { order.splice(order.indexOf('wikipedia-th'), 1); order.unshift('wikipedia-th'); }
      const results = new Map<StreamId, Outcome>();
      let closed = false;
      const run = async (id: StreamId): Promise<void> => {
        const s = STREAMS[id];
        if (closed || q.length > s.maxQ || !limiter.take(id)) return; // skipped: never waits
        let timer: ReturnType<typeof setTimeout> | undefined;
        const out = await Promise.race([
          fetchStream(o, s, q, n, now),
          new Promise<Outcome>((r) => { timer = setTimeout(() => r({ ok: false }), streamMs); }),
        ]);
        clearTimeout(timer);
        if (closed) return; // SR-C8: a result after the deadline is discarded
        if (out.coolMs !== undefined) limiter.coolFor(id, out.coolMs);
        results.set(id, out);
      };
      const width = o.browser ? BROWSER_PARALLEL : order.length || 1;
      const queue = [...order];
      const worker = async () => { for (let id = queue.shift(); id; id = queue.shift()) await run(id); };
      let dl: ReturnType<typeof setTimeout> | undefined;
      const all = Promise.all(Array.from({ length: Math.min(width, order.length) }, worker));
      if (o.browser) await Promise.race([all, new Promise<void>((r) => { dl = setTimeout(r, overallMs); })]);
      else await all;
      clearTimeout(dl);
      closed = true;

      const lists = order.map((id) => results.get(id)).map((r) => (r && r.ok ? r.hits : null));
      if (!lists.some((l) => l !== null)) throw new Error('no open source answered');
      const seen = new Set<string>();
      const out: SearchHit[] = [];
      for (let rank = 0; out.length < n; rank++) {
        let more = false;
        for (const l of lists) {
          const h = l?.[rank];
          if (!h) continue;
          more = true;
          const k = urlKey(h.url) ?? h.url;
          if (seen.has(k) || out.length >= n) continue;
          seen.add(k);
          out.push(h);
        }
        if (!more) break;
      }
      return out;
    },
  };
}

const SIX_HOURS = 6 * 3600_000;

export function searchChain(ddg: SearchBackend, open: OpenBackend, o: { enabled: () => boolean; now?: () => number }): SearchBackend {
  const now = o.now ?? Date.now;
  let ddgSkipUntil = 0;
  const enabled = (): boolean => { try { return o.enabled() === true; } catch { return false; } };
  return {
    async search(q, n, opts) {
      const on = enabled();
      if (opts?.source) {
        if (!on) throw new SourceOff();
        return open.search(q, n, [opts.source]);
      }
      if (!on) return ddg.search(q, n);
      let refused = false;
      if (now() < ddgSkipUntil) refused = true;
      else {
        try {
          const hits = await ddg.search(q, n);
          if (hits.length > 0) return hits;
        } catch (e) {
          if (e instanceof SearchRefused) { ddgSkipUntil = now() + SIX_HOURS; refused = true; }
        }
      }
      try {
        return await open.search(q, n);
      } catch (e) {
        if (refused) throw new SearchRefused();
        throw e instanceof Error ? e : new Error('open search failed');
      }
    },
  };
}

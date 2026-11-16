import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The model proxy (Gate 1 self-code X1). The dev-job model key lives in THIS process only; a sandbox gets ANTHROPIC_BASE_URL pointing here and a
 * random per-job credential. The proxy:
 *  - allows only POST /v1/messages and /v1/messages/count_tokens, with a model allowlist and a max_tokens cap;
 *  - refuses a body that carries server tools or remote resources (web_search*, web_fetch*, code_execution*, mcp, container, file or URL sources),
 *    because those reach the internet from Anthropic's side and bypass every egress rule;
 *  - drops every inbound auth header and sets the real key itself; forwards only an allowlist of headers and beta flags;
 *  - meters `usage` from every response (JSON or SSE) and cuts the job at its cap and at the monthly cap. The numbers are the proxy's, not the agent's.
 * The control API (register / close / read a job) is on a separate listener the sandbox network cannot reach, and needs a bearer token.
 */
export interface Price { inUsd: number; outUsd: number; cacheReadUsd?: number; cacheWriteUsd?: number }
export interface UpstreamRequest { method: 'POST'; path: string; headers: Record<string, string>; body: Buffer }
export interface UpstreamResponse { status: number; headers: Record<string, string>; body: AsyncIterable<Buffer> }
export type Upstream = (r: UpstreamRequest) => Promise<UpstreamResponse>;

export interface ProxyOptions {
  upstream: Upstream;
  /** The real key, read per request (never logged, never returned). */
  apiKey: () => string;
  /** USD per million tokens. The keys are the model allowlist. */
  prices: Record<string, Price>;
  maxTokensCap?: number;
  maxBodyBytes?: number;
  /** `anthropic-beta` values that may be forwarded. */
  betaAllow?: readonly string[];
  /** G2SC-08: the monthly cap is the proxy's own setting (its environment), never the caller's. 0 refuses everything. */
  monthlyCapUsd: number;
  /** Persists the month's spend across restarts. */
  ledgerPath?: string;
  now?: () => Date;
  log?: (msg: string) => void;
}

interface JobEntry { jobId: string; capUsd: number; spentUsd: number; reservedUsd: number; inflight: number; requests: number; expiresAt: number; refused: number }
/** G2SC-01: at most this many requests of one job in flight, and this many in total. */
export const MAX_INFLIGHT = 2;
export const MAX_JOB_REQUESTS = 600;

export const DEFAULT_BETA_ALLOW: readonly string[] = ['claude-code-20250219', 'interleaved-thinking-2025-05-14', 'fine-grained-tool-streaming-2025-05-14', 'prompt-caching-2024-07-31', 'token-counting-2024-11-01', 'context-management-2025-06-27'];
const FORBIDDEN_TOOL = /^(?:web_search|web_fetch|code_execution|mcp|computer)/;
const FORBIDDEN_KEYS = new Set(['mcp_servers', 'container', 'file_id', 'files']);
const SECRETISH = /^(?:authorization|x-api-key|api-key|cookie|proxy-authorization)$/i;
const eq = (a: string, b: string): boolean => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** A refusal reason for a parsed request body, or null. Walks the whole tree: a URL or file source can sit anywhere in a message. */
export function bodyProblem(body: unknown, o: { models: ReadonlySet<string>; maxTokensCap: number; needMaxTokens: boolean }): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'the body is not a JSON object';
  const b = body as Record<string, unknown>;
  if (typeof b.model !== 'string' || !o.models.has(b.model)) return 'model is not on the allowlist';
  if (o.needMaxTokens) {
    if (!Number.isInteger(b.max_tokens) || (b.max_tokens as number) < 1) return 'max_tokens is required';
    if ((b.max_tokens as number) > o.maxTokensCap) return `max_tokens above the cap of ${o.maxTokensCap}`;
  }
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number): string | null => {
    if (depth > 40) return 'the body is nested too deeply';
    if (!v || typeof v !== 'object' || seen.has(v)) return null;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const x of v) { const r = walk(x, depth + 1); if (r) return r; }
      return null;
    }
    const r = v as Record<string, unknown>;
    for (const k of Object.keys(r)) if (FORBIDDEN_KEYS.has(k)) return `the body carries ${k}`;
    if (typeof r.type === 'string' && FORBIDDEN_TOOL.test(r.type)) return `server tool or remote resource: ${r.type.slice(0, 40)}`;
    if (typeof r.type === 'string' && /^mcp_/.test(r.type)) return `remote resource: ${r.type.slice(0, 40)}`;
    if (r.source && typeof r.source === 'object' && ['url', 'file'].includes(String((r.source as { type?: unknown }).type))) return 'a URL or file source';
    if (r.type === 'url' || r.type === 'file') return 'a URL or file source';
    for (const k of Object.keys(r)) { const x = walk(r[k], depth + 1); if (x) return x; }
    return null;
  };
  return walk(b, 0);
}

export const costOf = (p: Price, u: { input: number; output: number; cacheRead: number; cacheWrite: number }): number =>
  (u.input * p.inUsd + u.output * p.outUsd + u.cacheRead * (p.cacheReadUsd ?? p.inUsd * 0.1) + u.cacheWrite * (p.cacheWriteUsd ?? p.inUsd * 1.25)) / 1_000_000;

/** Incremental SSE reader: only `message_start` and `message_delta` usage numbers are kept. */
export class UsageMeter {
  input = 0; output = 0; cacheRead = 0; cacheWrite = 0;
  private buf = '';
  feedSse(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      try { this.take(JSON.parse(line.slice(5)) as unknown); } catch { /* not JSON */ }
    }
    if (this.buf.length > 1 << 20) this.buf = '';
  }
  take(ev: unknown): void {
    const e = ev as { type?: string; usage?: Record<string, number>; message?: { usage?: Record<string, number> } };
    const u = e.type === 'message_start' ? e.message?.usage : e.type === 'message_delta' ? e.usage : e.type === undefined || e.type === 'message' ? e.usage : undefined;
    if (!u) return;
    if (typeof u.input_tokens === 'number') this.input = Math.max(this.input, u.input_tokens);
    if (typeof u.output_tokens === 'number') this.output = Math.max(this.output, u.output_tokens);
    if (typeof u.cache_read_input_tokens === 'number') this.cacheRead = Math.max(this.cacheRead, u.cache_read_input_tokens);
    if (typeof u.cache_creation_input_tokens === 'number') this.cacheWrite = Math.max(this.cacheWrite, u.cache_creation_input_tokens);
  }
}

export function createModelProxy(o: ProxyOptions) {
  const jobs = new Map<string, JobEntry>(); // credential -> job
  const models = new Set(Object.keys(o.prices));
  const maxBody = o.maxBodyBytes ?? 8 * 1024 * 1024;
  const cap = o.maxTokensCap ?? 16_000;
  const beta = new Set(o.betaAllow ?? DEFAULT_BETA_ALLOW);
  const now = o.now ?? (() => new Date());
  let monthly = { month: '', spentUsd: 0, reservedUsd: 0, capUsd: o.monthlyCapUsd };
  const monthKey = () => now().toISOString().slice(0, 7);
  const load = () => {
    if (!o.ledgerPath) return;
    try { const l = JSON.parse(readFileSync(o.ledgerPath, 'utf8')) as { month?: string; spentUsd?: number }; if (l.month === monthKey() && typeof l.spentUsd === 'number') monthly = { ...monthly, month: l.month, spentUsd: l.spentUsd }; } catch { /* first run */ }
  };
  load();
  const save = () => { if (!o.ledgerPath) return; try { writeFileSync(`${o.ledgerPath}.tmp`, JSON.stringify({ month: monthly.month, spentUsd: monthly.spentUsd })); renameSync(`${o.ledgerPath}.tmp`, o.ledgerPath); } catch { /* best effort */ } };
  const rollMonth = () => { if (monthly.month !== monthKey()) { monthly = { ...monthly, month: monthKey(), spentUsd: 0, reservedUsd: 0 }; save(); } };

  const send = (res: ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' }).end(text);
  };
  const deny = (res: ServerResponse, status: number, why: string, j?: JobEntry) => {
    if (j) j.refused++;
    o.log?.(`refused ${status}: ${why.slice(0, 80)}`);
    send(res, status, { type: 'error', error: { type: 'invalid_request_error', message: `refused by the dev-job proxy: ${why}` } });
  };
  const readBody = (req: IncomingMessage): Promise<Buffer | null> => new Promise((resolve) => {
    const parts: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => { n += c.length; if (n > maxBody) { resolve(null); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', () => resolve(null));
  });
  const credOf = (req: IncomingMessage): string => {
    const k = req.headers['x-api-key'];
    if (typeof k === 'string' && k) return k;
    const a = req.headers.authorization;
    return typeof a === 'string' && a.startsWith('Bearer ') ? a.slice(7) : '';
  };

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    rollMonth();
    const url = new URL(req.url ?? '/', 'http://x');
    const cred = credOf(req);
    let job: JobEntry | undefined;
    for (const [c, j] of jobs) if (eq(c, cred)) job = j;
    // 401 first: an unknown or expired credential learns nothing else.
    if (!job || job.expiresAt < now().getTime()) return deny(res, 401, 'unknown or expired job credential');
    if (req.method !== 'POST') return deny(res, 405, 'only POST is allowed', job);
    const counting = url.pathname === '/v1/messages/count_tokens';
    if (!(url.pathname === '/v1/messages' || counting)) return deny(res, 404, 'path not allowed', job);
    for (const [k, v] of url.searchParams) if (!(k === 'beta' && v === 'true')) return deny(res, 400, 'query not allowed', job);
    const ct = String(req.headers['content-type'] ?? '');
    if (!/^application\/json\b/i.test(ct)) return deny(res, 415, 'content-type must be application/json', job);
    const raw = await readBody(req);
    if (!raw) return deny(res, 413, 'body too large', job);
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString('utf8')); } catch { return deny(res, 400, 'body is not JSON', job); }
    const why = bodyProblem(parsed, { models, maxTokensCap: cap, needMaxTokens: !counting });
    if (why) return deny(res, 400, why, job);
    const model = (parsed as { model: string }).model;
    const price = o.prices[model]!;
    // Budget: the worst case of this request must fit under both caps before it is forwarded.
    const maxOut = counting ? 0 : (parsed as { max_tokens: number }).max_tokens;
    const worst = costOf(price, { input: Math.ceil(raw.length / 3), output: maxOut, cacheRead: 0, cacheWrite: 0 });
    // G2SC-01: the worst case is RESERVED at admission (spent + everything in flight + this request must fit) and settled when the answer ends.
    if (job.inflight >= MAX_INFLIGHT) return deny(res, 429, 'too many requests in flight for this job', job);
    if (job.requests >= MAX_JOB_REQUESTS) return deny(res, 429, 'the request limit of this job is reached', job);
    if (job.spentUsd + job.reservedUsd + worst > job.capUsd) return deny(res, 429, 'the per-job spend cap would be exceeded', job);
    if (!(monthly.capUsd > 0) || monthly.spentUsd + monthly.reservedUsd + worst > monthly.capUsd) return deny(res, 429, 'the monthly dev-job budget would be exceeded', job);
    job.inflight++;
    job.reservedUsd += worst;
    monthly.reservedUsd += worst;
    let settled = false;
    const settle = (usd: number) => {
      if (settled) return;
      settled = true;
      job.inflight--;
      job.reservedUsd -= worst;
      monthly.reservedUsd -= worst;
      job.spentUsd += usd;
      monthly.spentUsd += usd;
      save();
    };
    const headers: Record<string, string> = { 'content-type': 'application/json', 'x-api-key': o.apiKey(), 'anthropic-version': String(req.headers['anthropic-version'] ?? '2023-06-01').slice(0, 20) };
    const wantBeta = String(req.headers['anthropic-beta'] ?? '').split(',').map((s) => s.trim()).filter((s) => beta.has(s));
    if (wantBeta.length) headers['anthropic-beta'] = wantBeta.join(',');
    const accept = req.headers.accept;
    if (typeof accept === 'string' && /^[\w/+*;=, .-]{1,80}$/.test(accept)) headers.accept = accept;
    job.requests++;
    // G2SC-03: forward what was CHECKED. The canonical re-serialisation of the parsed body replaces the raw bytes, so a duplicate key or any other parser differential cannot carry something the filter did not see.
    const canonical = Buffer.from(JSON.stringify(parsed), 'utf8');
    let up: UpstreamResponse;
    try { up = await o.upstream({ method: 'POST', path: `${url.pathname}${url.search}`, headers, body: canonical }); } catch { settle(0); return deny(res, 502, 'the model API could not be reached', job); }
    const out: Record<string, string> = { 'cache-control': 'no-store' };
    for (const k of ['content-type', 'request-id', 'retry-after']) if (up.headers[k]) out[k] = up.headers[k]!;
    res.writeHead(up.status, out);
    const meter = new UsageMeter();
    const sse = /text\/event-stream/i.test(up.headers['content-type'] ?? '');
    const whole: Buffer[] = [];
    let wholeBytes = 0;
    try {
      for await (const chunk of up.body) {
        res.write(chunk);
        if (sse) meter.feedSse(chunk.toString('utf8'));
        else if ((wholeBytes += chunk.length) <= 8 * 1024 * 1024) whole.push(chunk);
      }
    } catch { /* the client or upstream went away: whatever was metered still counts */ }
    finally { /* settled below */ }
    if (!sse) { try { meter.take(JSON.parse(Buffer.concat(whole).toString('utf8'))); } catch { /* not JSON (an error page) */ } }
    // The meter is updated BEFORE the response ends, so a client that has seen the end of one answer can never get another past the cap.
    settle(costOf(price, meter));
    res.end();
  }

  /** The control listener: register a job credential, read the meter, close the job. Bearer token required; the caller's address is judged by `allowed`. */
  function onControl(token: string, allowed: (remote: string) => boolean) {
    return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
      const remote = req.socket.remoteAddress ?? '';
      if (!allowed(remote)) return send(res, 403, { error: 'forbidden' });
      const a = req.headers.authorization;
      if (typeof a !== 'string' || !eq(a, `Bearer ${token}`)) return send(res, 401, { error: 'unauthorized' });
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'POST' && url.pathname === '/jobs') {
        const raw = await readBody(req);
        let b: { jobId?: unknown; capUsd?: unknown; ttlSec?: unknown } = {};
        try { b = JSON.parse((raw ?? Buffer.alloc(0)).toString('utf8')) as typeof b; } catch { return send(res, 400, { error: 'bad json' }); }
        if (typeof b.jobId !== 'string' || !/^J-[0-9a-f]{16}$/.test(b.jobId) || typeof b.capUsd !== 'number' || !(b.capUsd > 0) || b.capUsd > 100 || typeof b.ttlSec !== 'number' || !(b.ttlSec > 0) || b.ttlSec > 3600) return send(res, 400, { error: 'bad request' });
        if (jobs.size >= 4) return send(res, 429, { error: 'too many open jobs' });
        rollMonth();
        const credential = `dj-${randomBytes(24).toString('hex')}`;
        jobs.set(credential, { jobId: b.jobId, capUsd: b.capUsd, spentUsd: 0, reservedUsd: 0, inflight: 0, requests: 0, expiresAt: now().getTime() + b.ttlSec * 1000, refused: 0 });
        return send(res, 200, { credential });
      }
      const m = /^\/jobs\/(J-[0-9a-f]{16})$/.exec(url.pathname);
      if (m && (req.method === 'GET' || req.method === 'DELETE')) {
        const entry = [...jobs].find(([, j]) => j.jobId === m[1]);
        if (!entry) return send(res, 404, { error: 'unknown job' });
        const j = entry[1];
        if (req.method === 'DELETE') jobs.delete(entry[0]);
        return send(res, 200, { jobId: j.jobId, spentUsd: j.spentUsd, requests: j.requests, refused: j.refused, monthSpentUsd: monthly.spentUsd });
      }
      return send(res, 404, { error: 'not found' });
    };
  }

  return {
    handler: (req: IncomingMessage, res: ServerResponse) => { onRequest(req, res).catch(() => { if (!res.headersSent) deny(res, 500, 'internal error'); else res.end(); }); },
    controlHandler: (token: string, allowed: (remote: string) => boolean) => { const h = onControl(token, allowed); return (req: IncomingMessage, res: ServerResponse) => { h(req, res).catch(() => { if (!res.headersSent) send(res, 500, { error: 'internal' }); }); }; },
    openJobs: () => jobs.size,
    monthly: () => ({ ...monthly }),
  };
}

/** The real upstream: HTTPS to one fixed host. Nothing in the request chooses the host. */
export function httpsUpstream(host: string, request: typeof import('node:https').request): Upstream {
  return (r) => new Promise((resolve, reject) => {
    const req = request({ host, port: 443, method: r.method, path: r.path, headers: { ...r.headers, 'content-length': String(r.body.length), host }, timeout: 300_000 }, (res: IncomingMessage) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string' && !SECRETISH.test(k)) headers[k] = v;
      resolve({ status: res.statusCode ?? 502, headers, body: res });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(r.body);
  });
}


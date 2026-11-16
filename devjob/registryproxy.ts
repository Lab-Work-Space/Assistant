import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * The registry reverse proxy for the prep container (Gate 1 self-code X3). The leg from prep to here is plain HTTP, so method and path are visible;
 * the upstream host is fixed (registry.npmjs.org) and nothing in a request chooses it. Only GET and HEAD of package documents and tarballs pass:
 * `npm publish` (PUT), any POST (the advisory and login endpoints), DELETE, search and every `/-/...` endpoint other than a tarball are refused.
 * Authorization and cookie headers are dropped, so a token planted in the repo cannot be used from here.
 */
export interface RegistryUpstream { (r: { method: 'GET' | 'HEAD'; path: string; headers: Record<string, string> }): Promise<{ status: number; headers: Record<string, string>; body: AsyncIterable<Buffer> }> }

const NAME = '(?:@[a-z0-9][a-z0-9._-]{0,213}(?:%2[fF]|/))?[a-z0-9][a-z0-9._-]{0,213}';
const META = new RegExp(`^/${NAME}$`);
const TARBALL = new RegExp(`^/(?:@[a-z0-9][a-z0-9._-]{0,213}/)?[a-z0-9][a-z0-9._-]{0,213}/-/[a-z0-9][a-z0-9._-]{0,213}-\\d[0-9A-Za-z.+-]{0,100}\\.tgz$`);

export function pathAllowed(p: string): boolean {
  if (p.length > 600 || p.includes('..') || p.includes('?') || p.includes('#')) return false;
  return META.test(p) || TARBALL.test(p);
}

export function createRegistryProxy(o: { upstream: RegistryUpstream; maxBytes?: number; log?: (m: string) => void }) {
  let bytes = 0;
  const cap = o.maxBytes ?? 512 * 1024 * 1024;
  return (req: IncomingMessage, res: ServerResponse): void => {
    const refuse = (status: number, why: string) => { o.log?.(`refused ${req.method} ${status}: ${why}`); res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `refused by the registry proxy: ${why}` })); };
    const method = req.method ?? '';
    if (method !== 'GET' && method !== 'HEAD') return refuse(405, 'only GET and HEAD are allowed');
    const raw = req.url ?? '';
    // A query string is allowed for nothing: npm ci does not need one.
    if (!pathAllowed(raw)) return refuse(404, 'path not allowed');
    if (bytes > cap) return refuse(429, 'byte cap reached');
    const accept = req.headers.accept;
    void (async () => {
      try {
        const up = await o.upstream({ method, path: raw, headers: { accept: typeof accept === 'string' && /^[\w/+*;=, .-]{1,120}$/.test(accept) ? accept : 'application/json' } });
        const h: Record<string, string> = {};
        for (const k of ['content-type', 'content-length', 'etag', 'cache-control']) if (up.headers[k]) h[k] = up.headers[k]!;
        res.writeHead(up.status, h);
        for await (const c of up.body) { bytes += c.length; res.write(c); }
        res.end();
      } catch {
        if (!res.headersSent) refuse(502, 'upstream unreachable'); else res.end();
      }
    })();
  };
}

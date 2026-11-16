import type { SupplyPort } from './supply.js';

/**
 * The live side of the supply-chain checks (Gate 1 self-code X14): publish dates from the npm registry, advisories from the npm bulk-advisory
 * endpoint cross-checked with OSV. Fixed hosts, fixed paths, bounded bodies and a timeout; run by the executor and the main application, never
 * from a sandbox. Any failure throws (the caller refuses). The fetch is injected so tests use a fake.
 */
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
const REGISTRY = 'https://registry.npmjs.org';
const OSV = 'https://api.osv.dev/v1/querybatch';
const NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,213}\/)?[a-z0-9][a-z0-9._-]{0,213}$/;
const VER = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?(?:\+[0-9A-Za-z.-]{1,64})?$/;

export function makeSupplyPort(fetchFn: FetchLike, now: () => Date = () => new Date()): SupplyPort {
  const call = async (url: string, init?: Parameters<FetchLike>[1]): Promise<unknown> => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 20_000);
    try {
      const r = await fetchFn(url, { ...init, signal: ac.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  };
  return {
    // The FULL packument: the abbreviated one has no `time`.
    async publishedAt(name, version) {
      if (!NAME.test(name) || !VER.test(version)) return null;
      const doc = (await call(`${REGISTRY}/${name.replace('/', '%2F')}`, { headers: { accept: 'application/json' } })) as { time?: Record<string, unknown> };
      const t = doc.time?.[version];
      return typeof t === 'string' ? t : null;
    },
    async integrity(name, version) {
      if (!NAME.test(name) || !VER.test(version)) return null;
      const doc = (await call(`${REGISTRY}/${name.replace('/', '%2F')}`, { headers: { accept: 'application/json' } })) as { versions?: Record<string, { dist?: { integrity?: unknown } }> };
      const i = doc.versions?.[version]?.dist?.integrity;
      return typeof i === 'string' ? i : null;
    },
    async audit(pkgs) {
      const date = now().toISOString().slice(0, 10);
      if (pkgs.length === 0) return { high: 0, critical: 0, databaseDate: date };
      for (const p of pkgs) if (!NAME.test(p.name) || !VER.test(p.version)) throw new Error('bad package id');
      const body: Record<string, string[]> = {};
      for (const p of pkgs) (body[p.name] ??= []).push(p.version);
      const adv = (await call(`${REGISTRY}/-/npm/v1/security/advisories/bulk`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })) as Record<string, { severity?: string }[]>;
      let high = 0;
      let critical = 0;
      for (const list of Object.values(adv)) for (const a of Array.isArray(list) ? list : []) { if (a.severity === 'high') high++; else if (a.severity === 'critical') critical++; }
      const osv = (await call(OSV, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ queries: pkgs.map((p) => ({ package: { name: p.name, ecosystem: 'npm' }, version: p.version })) }) })) as { results?: { vulns?: unknown[] }[] };
      const osvHits = (osv.results ?? []).reduce((n, r) => n + (r.vulns?.length ?? 0), 0);
      return { high, critical, databaseDate: date, note: `OSV cross-check: ${osvHits} advisory id(s)` };
    },
  };
}

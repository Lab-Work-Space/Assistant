import { describe, expect, it } from 'vitest';
import { makeSupplyPort, type FetchLike } from './supply-net.js';

const reply = (v: unknown, ok = true): ReturnType<FetchLike> => Promise.resolve({ ok, status: ok ? 200 : 500, json: async () => v });
const now = () => new Date('2026-11-02T10:00:00Z');

describe('supply-net', () => {
  it('reads the publish time of an exact version from the registry document', async () => {
    const urls: string[] = [];
    const p = makeSupplyPort(async (u) => { urls.push(u); return reply({ time: { '1.2.3': '2025-05-05T00:00:00.000Z' } }); }, now);
    expect(await p.publishedAt('@scope/pkg', '1.2.3')).toBe('2025-05-05T00:00:00.000Z');
    expect(urls).toEqual(['https://registry.npmjs.org/@scope%2Fpkg']);
    expect(await p.publishedAt('pkg', '9.9.9')).toBeNull();
    expect(await p.publishedAt('../x', '1.0.0')).toBeNull();
    expect(await p.publishedAt('pkg', 'latest')).toBeNull();
  });
  it('reads dist.integrity of an exact version from the full packument', async () => {
    const accepts: (string | undefined)[] = [];
    const p = makeSupplyPort(async (_u, i) => (accepts.push(i?.headers?.accept), reply({ versions: { '1.2.3': { dist: { integrity: 'sha512-ZZZ' } } } })), now);
    expect(await p.integrity('pkg', '1.2.3')).toBe('sha512-ZZZ');
    expect(await p.integrity('pkg', '9.9.9')).toBeNull();
    expect(accepts.every((a) => a === 'application/json')).toBe(true); // the abbreviated document has no `time`
  });
  it('counts high and critical advisories and reports the OSV cross-check', async () => {
    const calls: string[] = [];
    const p = makeSupplyPort(async (u, i) => {
      calls.push(`${i?.method} ${u}`);
      return u.includes('osv') ? reply({ results: [{ vulns: [{ id: 'a' }, { id: 'b' }] }] }) : reply({ x: [{ severity: 'high' }, { severity: 'low' }, { severity: 'critical' }] });
    }, now);
    expect(await p.audit([{ name: 'x', version: '1.0.0' }])).toEqual({ high: 1, critical: 1, databaseDate: '2026-11-02', note: 'OSV cross-check: 2 advisory id(s)' });
    expect(calls).toEqual(['POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', 'POST https://api.osv.dev/v1/querybatch']);
  });
  it('an unreachable database throws; an empty list needs no call; a bad id is refused', async () => {
    const down = makeSupplyPort(async () => reply({}, false), now);
    await expect(down.audit([{ name: 'x', version: '1.0.0' }])).rejects.toThrow(/HTTP 500/);
    await expect(down.publishedAt('x', '1.0.0')).rejects.toThrow();
    expect(await makeSupplyPort(async () => { throw new Error('no call'); }, now).audit([])).toMatchObject({ high: 0, critical: 0 });
    await expect(makeSupplyPort(async () => reply({}), now).audit([{ name: 'a b', version: '1.0.0' }])).rejects.toThrow(/bad package/);
  });
});

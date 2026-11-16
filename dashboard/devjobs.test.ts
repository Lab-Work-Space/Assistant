import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { DevJob } from '../db/repos/devjobs.js';
import { allowLoopbackForTest } from '../vitest.setup.no-network.js';
import { http, rig } from './test-helpers.js';

const HEAD = 'b'.repeat(40);
const EVIL = '<script>alert(1)</script> ‮evil​ </pre><h1>x</h1>';
const job = (over: Partial<DevJob> = {}): DevJob => ({
  id: 'J-0123456789abcdef', repo: 'Lab-Work-Space/Assistant', kind: 'assistant', requesterId: '1'.repeat(18), channelId: null, status: 'ready', request: EVIL, tainted: true,
  baseSha: 'a'.repeat(40), headSha: HEAD, bundleSha256: 'c'.repeat(64), spendUsd: 0.42, outcome: null, createdAt: new Date(), updatedAt: new Date(), finishedAt: null, cardId: null,
  facts: { commits: 1, lowRiskOnly: false, refusals: [EVIL], flags: [EVIL], files: [{ path: 'tools/a.ts', status: 'A', protected: true, closure: false, test: false }], deps: [{ name: 'left-pad', version: '1.0.0', hasInstallScript: true, publishedAt: '2025-01-01T00:00:00Z' }], auditNote: 'note', tests: { before: 10, after: 11, typecheck: true, build: true } },
  verdicts: { code: 'APPROVE', security: 'CONDITIONAL', findings: [{ severity: 'low', file: 'x.ts', note: EVIL }] },
  report: `log ${EVIL}`, diff: `+${'x'.repeat(5000)}\n+${EVIL}`, ...over,
});

beforeAll(allowLoopbackForTest);
let r: Awaited<ReturnType<typeof rig>>;
afterEach(async () => { await r?.close(); });

describe('Dev jobs pages (self-code X21)', () => {
  it('lists jobs and shows the diff page for the exact head sha, all escaped, invisible characters visible, CSP kept, no inline script', async () => {
    r = await rig({ devjobs: { list: async () => [job()], byHead: async (h) => (h === HEAD ? job() : null) } });
    const { cookie } = await r.login();
    const list = await http(r.port, { path: '/devjobs', headers: { cookie } });
    expect(list.status).toBe(200);
    expect(list.body).toContain(`href="/devjobs/${HEAD}"`);
    const page = await http(r.port, { path: `/devjobs/${HEAD}`, headers: { cookie } });
    expect(page.status).toBe(200);
    expect(page.body).not.toMatch(/<script/i);
    expect(page.body).not.toMatch(/<h1>x/i);
    expect(page.body).not.toContain('‮');
    expect(page.body).not.toContain('​');
    expect(page.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page.body).toContain('\\u{202E}'); // the existing visible marker of the dashboard (S49)
    expect(page.body).toContain('x'.repeat(5000)); // long lines are never cut
    expect(page.body).toContain('HAS AN INSTALL SCRIPT');
    expect(page.body).toContain('the owner only');
    expect(page.body).toContain('model-written, unverified');
    expect(String(page.headers['content-security-policy'])).toContain("default-src 'self'");
    expect(page.body).not.toMatch(/ on\w+=/i);
  });
  it('needs a Bot Admin session; unknown or malformed shas and a missing store are 404', async () => {
    r = await rig({ devjobs: { list: async () => [], byHead: async () => null } });
    expect((await http(r.port, { path: '/devjobs' })).status).not.toBe(200);
    const { cookie } = await r.login();
    expect((await http(r.port, { path: `/devjobs/${'c'.repeat(40)}`, headers: { cookie } })).status).toBe(404);
    expect((await http(r.port, { path: '/devjobs/not-a-sha', headers: { cookie } })).status).toBe(404);
    await r.close();
    r = await rig({});
    const l = await r.login();
    expect((await http(r.port, { path: '/devjobs', headers: { cookie: l.cookie } })).status).toBe(404);
  });
  it('is read only: a POST to a dev-jobs path is not routed', async () => {
    r = await rig({ devjobs: { list: async () => [], byHead: async () => null } });
    const { cookie, csrf } = await r.login();
    const res = await http(r.port, { method: 'POST', path: '/devjobs', headers: { cookie, origin: `http://127.0.0.1:${r.port}`, 'content-type': 'application/x-www-form-urlencoded' }, body: `_csrf=${csrf}` });
    expect(res.status).not.toBe(200);
  });
});

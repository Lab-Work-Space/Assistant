import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { allowLoopbackForTest } from '../vitest.setup.no-network.js';
import { ADMIN_USER, http, rig } from './test-helpers.js';
import type { KnowledgeOverview } from '../knowledge/dashboard.js';
import type { Proposal } from '../db/repos/knowledge.js';

const EVIL = '<script>alert(1)</script> [click](javascript:alert(1)) <img src=x onerror=alert(1)> data:text/html,<b>x</b> </pre><h1>x</h1>';
const proposal = (over: Partial<Proposal> = {}): Proposal => ({
  id: 7, deptId: 'software', kind: 'kb_create', ref: null, payload: {}, baseVersion: 0, tainted: false, sources: [], proposer: 'head:software', via: 'tool', verdict: null, status: 'open',
  reviewedBy: null, reviewedAt: null, cardId: null, outcome: null, createdAt: new Date(), decidedAt: null, ...over,
});
const view = (p: Proposal) => ({ proposal: p, title: `New document: ${EVIL}`, facts: ['Scope: software', EVIL], diff: `-old ${EVIL}\n+new ${EVIL}`, text: EVIL, sources: [{ label: 'note #1 (software) TAINTED', tainted: true, text: EVIL }], warnings: p.tainted ? ['TAINTED: read it'] : [] });
const overview = (p: Proposal): KnowledgeOverview => ({
  waiting: [view(p)], decided: [],
  docs: [{ doc: { id: 3, scope: 'software', title: EVIL, body: EVIL, version: 2, status: 'active', sources: [], tainted: true, createdBy: 'x', createdAt: new Date(), updatedAt: new Date() }, versions: [{ id: 1, docId: 3, version: 1, title: EVIL, body: EVIL, sources: [], tainted: false, createdBy: 'x', createdAt: new Date() }] }],
  notes: [{ id: 1, deptId: 'software', taskId: null, body: EVIL, pinned: true, tainted: true, source: 'reflect', createdAt: new Date() }],
  lessons: [{ tainted: false, id: 1, text: EVIL, source: 'manual', authorId: 'u', origin: 'chat', active: true, legacyId: null, createdAt: new Date() }],
  prompts: [{ ref: 'heads/software', versions: [{ id: 5, ref: 'heads/software', body: EVIL, version: 1, createdBy: 'x', createdAt: new Date(), active: true, tombstone: false, restoredFrom: null }] }],
});

beforeAll(allowLoopbackForTest);
let r: Awaited<ReturnType<typeof rig>>;
afterEach(async () => { await r?.close(); });

function knowledge(p: Proposal) {
  const calls: string[] = [];
  return {
    calls,
    impl: {
      overview: async () => overview(p),
      review: async (u: string, id: number) => (calls.push(`review ${u} ${id}`), true),
      reject: async (u: string, id: number) => (calls.push(`reject ${u} ${id}`), true),
      rollback: async (u: string, ref: string, to: number | null) => (calls.push(`rollback ${u} ${ref} ${String(to)}`), { ok: true as const, id: 1, tainted: false, text: 'ok' }),
      purge: async (u: string, d: number) => (calls.push(`purge ${u} ${d}`), { ok: true as const, id: 1, tainted: false, text: 'ok' }),
    },
  };
}

describe('Knowledge page (K18)', () => {
  it('shows model-written text as inert escaped text: no raw tags, no links built from body text, CSP kept', async () => {
    const k = knowledge(proposal({ tainted: true }));
    r = await rig({ knowledge: k.impl });
    const { cookie } = await r.login();
    const page = await http(r.port, { path: '/knowledge', headers: { cookie } });
    expect(page.status).toBe(200);
    expect(page.body).not.toMatch(/<script/i);
    expect(page.body).not.toMatch(/<img/i);
    expect(page.body).not.toMatch(/<h1>x/i);
    expect(page.body).not.toMatch(/<a [^>]*href="(javascript|data):/i);
    expect(page.body).not.toMatch(/href="[^"]*alert/i);
    expect(page.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page.body).toContain('javascript:alert(1)'); // visible as text only
    expect(String(page.headers['content-security-policy'])).toContain("default-src 'self'");
    expect(page.body).not.toMatch(/dangerouslySetInnerHTML/);
  });

  it('a tainted proposal offers only the review step; after it, the card button; both show every source verbatim', async () => {
    const k = knowledge(proposal({ tainted: true }));
    r = await rig({ knowledge: k.impl });
    const { cookie } = await r.login();
    const get = async () => (await http(r.port, { path: '/knowledge', headers: { cookie } })).body;
    let body = await get();
    expect(body).toContain('I have read the sources');
    expect(body).not.toContain('Make card');
    expect(body).toContain('note #1 (software) TAINTED');
    k.impl.overview = async () => overview(proposal({ tainted: true, reviewedBy: ADMIN_USER, reviewedAt: new Date() }));
    body = await get();
    expect(body).toContain('Make card');
    expect(body).not.toContain('I have read the sources');
  });

  it('a clean proposal goes straight to Make card; a carded one shows Apply bound to the card id', async () => {
    const k = knowledge(proposal());
    r = await rig({ knowledge: k.impl });
    const { cookie } = await r.login();
    expect((await http(r.port, { path: '/knowledge', headers: { cookie } })).body).toContain('Make card');
    k.impl.overview = async () => overview(proposal({ status: 'card', cardId: 'a'.repeat(32) }));
    const body = (await http(r.port, { path: '/knowledge', headers: { cookie } })).body;
    expect(body).toMatch(/action="\/cards\/apply"[^]*name="card" value="a{32}"/);
  });

  it('POSTs need the session, the same origin and the CSRF token, and run the right step with the session user', async () => {
    const k = knowledge(proposal());
    const minted: [string, number][] = [];
    r = await rig({ knowledge: k.impl, mint: async (u, p) => (minted.push([u, p]), { ok: true, cardId: 'c'.repeat(32) }) });
    const { cookie, csrf } = await r.login();
    expect((await r.post('/knowledge/card', { proposal: '7', _csrf: csrf })).status).toBe(401); // no cookie
    expect((await r.post('/knowledge/card', { proposal: '7', _csrf: 'x'.repeat(64) }, { cookie })).status).toBe(403); // bad csrf
    expect((await r.post('/knowledge/card', { proposal: '7', _csrf: csrf }, { cookie, origin: 'http://evil.example' })).status).toBe(403);
    expect(minted).toEqual([]);
    expect((await r.post('/knowledge/card', { proposal: '7', _csrf: csrf }, { cookie })).status).toBe(200);
    expect(minted).toEqual([[ADMIN_USER, 7]]);
    await r.post('/knowledge/review', { proposal: '7', _csrf: csrf }, { cookie });
    await r.post('/knowledge/reject', { proposal: '7', _csrf: csrf }, { cookie });
    await r.post('/knowledge/purge', { doc: '3', _csrf: csrf }, { cookie });
    await r.post('/knowledge/rollback', { ref: 'heads/software', version: '5', _csrf: csrf }, { cookie });
    await r.post('/knowledge/rollback', { ref: 'heads/software', version: 'default', _csrf: csrf }, { cookie });
    expect(k.calls).toEqual([`review ${ADMIN_USER} 7`, `reject ${ADMIN_USER} 7`, `purge ${ADMIN_USER} 3`, `rollback ${ADMIN_USER} heads/software 5`, `rollback ${ADMIN_USER} heads/software null`]);
  });

  it('refuses odd input without calling anything (ids, refs)', async () => {
    const k = knowledge(proposal());
    r = await rig({ knowledge: k.impl, mint: async () => ({ ok: true, cardId: 'c'.repeat(32) }) });
    const { cookie, csrf } = await r.login();
    for (const [path, f] of [['/knowledge/review', { proposal: '7;drop' }], ['/knowledge/purge', { doc: '-1' }], ['/knowledge/rollback', { ref: 'system/safety', version: '5' }], ['/knowledge/rollback', { ref: 'heads/x', version: 'abc' }], ['/knowledge/card', { proposal: '' }]] as const) {
      const res = await r.post(path, { ...f, _csrf: csrf }, { cookie });
      expect(res.status, path).toBe(409);
    }
    expect(k.calls).toEqual([]);
  });

  it('is absent (404) without the knowledge store', async () => {
    r = await rig();
    const { cookie } = await r.login();
    expect((await http(r.port, { path: '/knowledge', headers: { cookie } })).status).toBe(404);
  });
});

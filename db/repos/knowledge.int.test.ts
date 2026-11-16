import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { DeptNoteRepo, PromptOverrideRepo } from './ledger.js';
import { KbRepo, KnowledgeStateRepo, ProposalRepo } from './knowledge.js';
import { DepartmentRepo } from './org.js';

let db: TestDb;
beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'), 'up');
  const d = new DepartmentRepo(db.pool);
  for (const id of ['hq', 'software', 'hr']) await d.upsert({ id, name: id, categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true } as never);
});
afterAll(async () => { await db.close(); });

describe('DeptNoteRepo (K1, K13, flow A)', () => {
  it('a writer that does not say is tainted; pinned and tainted come back', async () => {
    const r = new DeptNoteRepo(db.pool);
    expect(await r.add('hq', null, 'The release train leaves on Thursdays')).toBe('added');
    expect(await r.add('hq', null, 'Alice owns the billing service', { tainted: false })).toBe('added');
    const n = await r.latest('hq', 5);
    expect(n.find((x) => x.body.includes('Thursdays'))).toMatchObject({ tainted: true, pinned: false, source: 'task' });
    expect(n.find((x) => x.body.includes('Alice'))).toMatchObject({ tainted: false });
  });

  it('skips exact and near duplicates (overlap >= 0.9)', async () => {
    const r = new DeptNoteRepo(db.pool);
    expect(await r.add('software', null, 'Deploys go through the staging cluster first, always.', { tainted: false })).toBe('added');
    expect(await r.add('software', null, 'deploys go through the STAGING cluster first always', { tainted: false })).toBe('duplicate');
    expect(await r.add('software', null, 'Deploys go through the staging cluster first, always!!', { tainted: false })).toBe('duplicate');
    expect(await r.add('software', null, 'Code review needs two approvals', { tainted: false })).toBe('added');
  });

  it('refuses secret-shaped text and invisible characters, masks PII', async () => {
    const r = new DeptNoteRepo(db.pool);
    expect(await r.add('hr', null, 'the key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789')).toBe('refused');
    expect(await r.add('hr', null, 'zero​width')).toBe('refused');
    expect(await r.add('hr', null, 'Contact somebody@example.com or +66 81 234 5678 about payroll', { tainted: false })).toBe('added');
    const [n] = await r.latest('hr', 1);
    expect(n!.body).toBe('Contact [email] or [phone] about payroll');
  });

  it('keeps at most 200 per department: the oldest unpinned roll off, pinned stay', async () => {
    const r = new DeptNoteRepo(db.pool);
    await r.add('hq', null, 'PINNED-FACT unique alpha', { tainted: false });
    const [pin] = await r.latest('hq', 1);
    await r.setPinned(pin!.id, true);
    for (let i = 0; i < 205; i++) await r.add('hq', null, `fact number ${i} word${i} extra${i}`, { tainted: false });
    const n = (await db.pool.query<{ c: number; p: number }>("SELECT count(*)::int c, count(*) FILTER (WHERE pinned)::int p FROM dept_notes WHERE dept_id = 'hq'")).rows[0]!;
    expect(n.c).toBe(200);
    expect(n.p).toBe(1);
    const ctx = await r.forContext('hq', 5);
    expect(ctx.filter((x) => x.pinned).map((x) => x.body)).toEqual(['PINNED-FACT unique alpha']);
    expect(ctx.length).toBe(6);
  });

  it('byIds respects department scope (K11) and hides other departments tainted notes from Praw', async () => {
    const r = new DeptNoteRepo(db.pool);
    await r.add('software', null, 'software tainted note zzz', { tainted: true });
    await r.add('software', null, 'software clean note yyy', { tainted: false });
    const all = await r.latest('software', 10);
    const ids = all.map((x) => x.id);
    expect((await r.byIds(ids, { dept: 'hr', praw: false })).length).toBe(0);
    const praw = await r.byIds(ids, { dept: 'praw', praw: true });
    expect(praw.every((x) => !x.tainted)).toBe(true);
    expect(praw.length).toBeGreaterThan(0);
    expect((await r.byIds(ids, { dept: 'software', praw: false })).length).toBe(ids.length);
  });

  it('counts reflect notes of the UTC day', async () => {
    const r = new DeptNoteRepo(db.pool);
    await r.add('hr', null, 'reflected one qqq', { source: 'reflect', tainted: false });
    expect(await r.reflectedToday('hr')).toBe(1);
  });
});

describe('PromptOverrideRepo (K10)', () => {
  it('rejects UPDATE and DELETE of past rows', async () => {
    const r = new PromptOverrideRepo(db.pool);
    await r.upsert('heads/software', 'a', 'u');
    await expect(db.pool.query("UPDATE prompt_overrides SET body = 'x' WHERE ref = 'heads/software'")).rejects.toThrow(/append-only/);
    await expect(db.pool.query("DELETE FROM prompt_overrides WHERE ref = 'heads/software'")).rejects.toThrow(/append-only/);
  });

  it('append is a compare-and-swap on the newest version; a stale base is refused', async () => {
    const r = new PromptOverrideRepo(db.pool);
    expect((await r.append('heads/hr', 'one', 'u', 0)).ok).toBe(true);
    expect(await r.append('heads/hr', 'two', 'u', 0)).toEqual({ ok: false, reason: 'stale' });
    const ok = await r.append('heads/hr', 'two', 'u', 1);
    expect(ok.ok && ok.row.version).toBe(2);
    expect(await r.append('heads/hr', 'three', 'u', 1)).toEqual({ ok: false, reason: 'stale' });
  });

  it('a rollback restores an exact earlier version by id as a new row, and to the file default with a tombstone', async () => {
    const r = new PromptOverrideRepo(db.pool);
    const v1 = (await r.history('heads/hr')).find((x) => x.version === 1)!;
    const back = await r.append('heads/hr', v1.body, 'u', 2, { restoredFrom: v1.id });
    expect(back.ok && back.row).toMatchObject({ version: 3, body: 'one', restoredFrom: v1.id });
    const none = await r.append('heads/hr', '', 'u', 3, { tombstone: true });
    expect(none.ok).toBe(true);
    expect(await r.getActive('heads/hr')).toBeNull();
  });
});

describe('KbRepo', () => {
  const kb = () => new KbRepo(db.pool);
  it('create, revise with compare-and-swap, archive, versions kept; purge removes versions too (K14)', async () => {
    const doc = await kb().create({ scope: 'software', title: 'Release process', body: 'We release on Thursdays after QA.', sources: [], tainted: false, createdBy: 'head:software' });
    expect(doc.version).toBe(1);
    const r2 = await kb().revise(doc.id, 1, { body: 'We release on Thursdays after QA and a smoke test.', sources: [], tainted: false, by: 'user:1' });
    expect(r2.ok && r2.doc.version).toBe(2);
    expect(await kb().revise(doc.id, 1, { body: 'stale', sources: [], tainted: false, by: 'user:1' })).toEqual({ ok: false, reason: 'stale' });
    expect((await kb().versions(doc.id)).map((v) => v.version)).toEqual([2, 1]);
    const tainted = await kb().revise(doc.id, 2, { sources: [], tainted: true, by: 'user:1' });
    expect(tainted.ok && tainted.doc.tainted).toBe(true);
    const back = await kb().revise(doc.id, 3, { sources: [], tainted: false, by: 'user:1' });
    expect(back.ok && back.doc.tainted).toBe(true); // taint is sticky
    expect(await kb().purge(doc.id)).toBe(true);
    expect((await db.pool.query('SELECT count(*)::int n FROM kb_versions WHERE doc_id = $1', [doc.id])).rows[0].n).toBe(0);
  });

  it('search is scoped in SQL: own department + company; Praw reads all but other departments tainted docs (K11, K17)', async () => {
    const mk = (scope: string, title: string, tainted: boolean) => kb().create({ scope, title, body: `The zebra policy of ${title}`, sources: [], tainted, createdBy: 'x' });
    await mk('software', 'sw-clean', false);
    await mk('hr', 'hr-clean', false);
    await mk('hr', 'hr-tainted', true);
    await mk('company', 'co-clean', false);
    const titles = async (v: { dept: string; praw: boolean }) => (await kb().search('zebra', v)).map((h) => h.title).sort();
    expect(await titles({ dept: 'software', praw: false })).toEqual(['co-clean', 'sw-clean']);
    expect(await titles({ dept: 'hr', praw: false })).toEqual(['co-clean', 'hr-clean', 'hr-tainted']);
    expect(await titles({ dept: 'praw', praw: true })).toEqual(['co-clean', 'hr-clean', 'sw-clean']);
  });

  it('search treats operators and quotes as plain text, caps the query and the snippet', async () => {
    await kb().create({ scope: 'hq', title: 'long', body: `needle ${'x'.repeat(5000)}`, sources: [], tainted: false, createdBy: 'x' });
    const hits = await kb().search(`needle' | !(&) ${'y'.repeat(500)}`, { dept: 'hq', praw: false });
    expect(Array.isArray(hits)).toBe(true);
    const one = await kb().search('needle', { dept: 'hq', praw: false });
    expect(one[0]!.snippet.length).toBeLessThanOrEqual(600);
    expect(await kb().search('   ', { dept: 'hq', praw: false })).toEqual([]);
  });
});

describe('ProposalRepo and claims', () => {
  const base = { deptId: 'software', kind: 'prompt_set' as const, ref: 'heads/software', payload: {}, tainted: false, sources: [], proposer: 'head:software', via: 'tool' as const };
  it('allows one pending prompt proposal per ref (K8c)', async () => {
    const p = new ProposalRepo(db.pool);
    const a = await p.create(base);
    expect(a.ok).toBe(true);
    expect(await p.create(base)).toEqual({ ok: false, reason: 'pending' });
    if (a.ok) await p.finish(a.proposal.id, 'rejected', 'no');
    expect((await p.create(base)).ok).toBe(true);
  });

  it('refuses a prompt proposal that names another department, a system doc or a fragment (K5, repo layer)', async () => {
    const p = new ProposalRepo(db.pool);
    for (const ref of ['heads/hr', 'system/safety', 'fragments/approval-request', 'heads/../x', 'members/Foo'])
      await expect(p.create({ ...base, ref }), ref).rejects.toThrow(/not allowed/);
    await expect(p.create({ ...base, kind: 'kb_create' })).rejects.toThrow(/not allowed/); // a ref on a non-prompt kind
    // and the table itself refuses what the repo would miss
    await expect(db.pool.query("INSERT INTO kb_proposals (dept_id, kind, ref, payload, tainted, proposer, via) VALUES ('software','prompt_set','system/safety','{}',false,'x','tool')")).rejects.toThrow(/check/i);
    await expect(db.pool.query("INSERT INTO kb_proposals (dept_id, kind, ref, payload, tainted, proposer, via) VALUES ('software','prompt_set','heads/hr','{}',false,'x','tool')")).rejects.toThrow(/check/i);
  });

  it('with the department member list, a member of another department is refused at the repo (G2K-03)', async () => {
    const p = new ProposalRepo(db.pool, (dept) => (dept === 'software' ? ['members/pair-programmer'] : []));
    await expect(p.create({ ...base, ref: 'members/legal-and-contracts' })).rejects.toThrow(/not allowed/);
    await expect(p.create({ ...base, deptId: 'hr', ref: 'members/pair-programmer' })).rejects.toThrow(/not allowed/);
    const ok = await p.create({ ...base, ref: 'members/pair-programmer' });
    expect(ok.ok).toBe(true);
  });

  it('stops at maxOpen per department (K16)', async () => {
    const p = new ProposalRepo(db.pool);
    const mk = () => p.create({ deptId: 'hr', kind: 'kb_create', payload: {}, tainted: true, sources: [], proposer: 'weekly', via: 'weekly', maxOpen: 2 });
    expect((await mk()).ok).toBe(true);
    expect((await mk()).ok).toBe(true);
    expect(await mk()).toEqual({ ok: false, reason: 'full' });
  });

  it('card binding and review are one-way', async () => {
    const p = new ProposalRepo(db.pool);
    const { ref: _r, ...noRef } = base;
    const a = await p.create({ ...noRef, deptId: 'hq', kind: 'kb_create' });
    if (!a.ok) throw new Error('x');
    expect(await p.attachCard(a.proposal.id, 'c1')).toBe(true);
    expect(await p.attachCard(a.proposal.id, 'c2')).toBe(false);
    expect(await p.markReviewed(a.proposal.id, 'u1')).toBe(true);
    await p.releaseCard('c1');
    expect((await p.get(a.proposal.id))?.status).toBe('open');
    expect(await p.finish(a.proposal.id, 'applied', 'ok')).toBe(true);
    expect(await p.finish(a.proposal.id, 'rejected', 'again')).toBe(false);
  });

  it('claims are once per task and once per department-week (K15, K16)', async () => {
    const s = new KnowledgeStateRepo(db.pool);
    expect(await s.claimReflection('t1')).toBe(true);
    expect(await s.claimReflection('t1')).toBe(false);
    expect(await s.claimWeek('hq', '2026-W45')).toBe(true);
    expect(await s.claimWeek('hq', '2026-W45')).toBe(false);
    expect(await s.claimWeek('hq', '2026-W46')).toBe(true);
  });

  it('bootNoteChanged: changed only when the digest differs from the previous boot (A, A, B, A)', async () => {
    const s = new KnowledgeStateRepo(db.pool);
    expect(await s.bootNoteChanged('tool-groups', 'aaa')).toBe(true);
    expect(await s.bootNoteChanged('tool-groups', 'aaa')).toBe(false);
    expect(await s.bootNoteChanged('tool-groups', 'bbb')).toBe(true);
    expect(await s.bootNoteChanged('tool-groups', 'aaa')).toBe(true);
    expect(await s.bootNoteChanged('other', 'aaa')).toBe(true); // keys are independent
    const rows = (await db.pool.query("SELECT week FROM kb_review_runs WHERE dept_id = 'boot:tool-groups'")).rows;
    expect(rows).toHaveLength(1);
  });
});

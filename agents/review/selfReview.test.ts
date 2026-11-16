import { describe, expect, it } from 'vitest';
import { smallRig } from '../../knowledge/test-helpers.js';
import { FakeProvider } from '../../providers/index.js';
import { isoWeek, REVIEW_MAX_PROPOSALS, SelfReview } from './selfReview.js';

// 2026-11-02 is a Monday. schedule.timezone defaults to Asia/Bangkok (UTC+7): 09:00 local = 02:00 UTC.
const at = (iso: string) => Date.parse(iso);
const MON_0930 = at('2026-11-02T02:30:00Z');
const MON_0800 = at('2026-11-02T01:00:00Z');
const TUE_1000 = at('2026-11-03T03:00:00Z');
const SAT = at('2026-11-07T04:00:00Z');

const note = (id: number, tainted = false) => ({ id, deptId: 'software', taskId: null, body: `fact ${id}`, pinned: false, tainted, source: 'task' as const, createdAt: new Date() });
const four = JSON.stringify([1, 2, 3, 4].map((i) => ({ title: `Doc ${i}`, body: `Body ${i}`, noteIds: [i] })));

function rig(o: { replies?: string[]; notes?: ReturnType<typeof note>[]; now?: number; off?: boolean; open?: number; canRun?: boolean; depts?: string[]; claimed?: string[]; cost?: number } = {}) {
  const p = new FakeProvider((o.replies ?? [four]).map((text) => ({ text })), 'claude');
  const s = smallRig([p], {}, o.cost);
  const created: { deptId: string; tainted: boolean; sources: { type: string; tainted: boolean }[]; via: string; payload: Record<string, unknown> }[] = [];
  const claimed = new Set<string>(o.claimed ?? []);
  const audits: unknown[] = [];
  const review = new SelfReview({
    small: s.d,
    org: { heads: () => (o.depts ?? ['software']).map((id) => ({ id, enabled: true })) as never },
    notes: { since: async () => o.notes ?? [note(1), note(2), note(3, true), note(4)] } as never,
    proposals: { countOpen: async () => o.open ?? 0, create: async (c: never) => { created.push(c); return { ok: true as const, proposal: { id: created.length } as never }; } } as never,
    state: { claimWeek: async (d: string, w: string) => (claimed.has(`${d}:${w}`) ? false : (claimed.add(`${d}:${w}`), true)) },
    cfg: s.d.cfg, offDay: () => ({ off: o.off ?? false }), canRun: () => o.canRun ?? true, audit: async (e) => void audits.push(e), secrets: [], now: () => o.now ?? MON_0930, log: { error: () => undefined },
  });
  return { review, p, created, audits, claimed, s };
}

describe('weekly self-review (K2, K16)', () => {
  it('SPEND-1 SP-14: the review names itself `review` in the spend rollup', async () => {
    const t = rig();
    await t.review.tick();
    expect((t.s.log.reqs[0] as { attribution?: unknown }).attribution).toMatchObject({ tool: 'review' });
  });

  it('isoWeek labels', () => {
    expect(isoWeek('2026-11-02')).toBe('2026-W45');
    expect(isoWeek('2027-01-01')).toBe('2026-W53');
    expect(isoWeek('2026-12-28')).toBe('2026-W53');
  });

  it('proposes at most 3 per department, always tainted, with the run as a tainted source, via weekly', async () => {
    const r = rig();
    expect(await r.review.tick()).toBe(REVIEW_MAX_PROPOSALS);
    expect(r.created).toHaveLength(3);
    for (const c of r.created) {
      expect(c).toMatchObject({ deptId: 'software', tainted: true, via: 'weekly' });
      expect(c.sources.some((s) => s.type === 'run' && s.tainted)).toBe(true);
    }
    expect(r.created[0]!.sources.filter((s) => s.type === 'note')).toHaveLength(1);
  });

  it('carries the taint even when every source note is verified (a model-written note is outside content to the weekly job)', async () => {
    const r = rig({ notes: [note(1), note(2), note(3), note(4)] });
    await r.review.tick();
    expect(r.created.every((c) => c.tainted)).toBe(true);
  });

  it('sends the notes wrapped untrusted, marks unverified ones, and uses no tools and a token cap', async () => {
    const r = rig();
    await r.review.tick();
    const req = r.p.calls[0]!;
    expect(JSON.stringify(req.messages)).toMatch(/untrusted-[0-9a-f]+/);
    expect(JSON.stringify(req.messages)).toContain('#3 UNVERIFIED');
    expect(req.tools).toEqual([]);
    expect(req.maxTokens).toBeLessThanOrEqual(1500);
  });

  it('only notes the code showed it can be cited; secret-shaped or empty items are dropped', async () => {
    const r = rig({ replies: [JSON.stringify([{ title: 'Ghost', body: 'b', noteIds: [99] }, { title: 'Key', body: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789', noteIds: [1] }, { title: 'Ok', body: 'fine', noteIds: [1, 99] }])] });
    await r.review.tick();
    expect(r.created).toHaveLength(1);
    expect(r.created[0]!.payload).toMatchObject({ title: 'Ok', sourceNoteIds: [1] });
  });

  it('runs once per department and ISO week', async () => {
    const r = rig({ replies: [four, four] });
    await r.review.tick();
    expect(await r.review.tick()).toBe(0);
    expect(r.p.calls).toHaveLength(1);
  });

  it('respects the time of day, weekends, off days and a halted company', async () => {
    for (const o of [{ now: MON_0800 }, { now: SAT }, { off: true }, { canRun: false }]) {
      const r = rig(o);
      expect(await r.review.tick(), JSON.stringify(o)).toBe(0);
      expect(r.p.calls).toHaveLength(0);
      expect(r.claimed.size).toBe(0); // nothing is claimed, so the next workday still runs
    }
    expect(await rig({ now: TUE_1000 }).review.tick()).toBe(3); // Monday off => the catch-up runs on Tuesday
  });

  it('skips a department with no new notes or with 10 open proposals, and costs nothing then', async () => {
    const none = rig({ notes: [] });
    expect(await none.review.tick()).toBe(0);
    expect(none.p.calls).toHaveLength(0);
    const full = rig({ open: 10 });
    expect(await full.review.tick()).toBe(0);
    expect(full.p.calls).toHaveLength(0);
  });

  it('creates no task and posts nothing: it only writes proposals', async () => {
    const r = rig();
    await r.review.tick();
    expect(Object.keys(r.review)).not.toContain('tasks');
    expect(r.audits.every((a) => (a as { action: string }).action === 'knowledge.propose')).toBe(true);
  });

  it('stops spending once the pass cost cap is reached', async () => {
    const r = rig({ depts: ['software', 'hr', 'it'], replies: ['[]', '[]', '[]'], cost: 0.06 });
    await r.review.tick();
    await r.review.tick();
    expect(r.p.calls).toHaveLength(2); // 0.06 + 0.06 >= 0.10: the third department waits for next week, also across ticks
  });
});

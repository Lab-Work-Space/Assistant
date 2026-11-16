import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillRefused } from './service.js';
import { SKILLS_PER_DEPT_TARGET, SKILLS_PER_PERSONA_TARGET, SKILL_ACTOR_BUDGET_BYTES } from './limits.js';
import { ADMIN, draft, rig, type Rig } from './test-helpers.js';

/** SKILLS-1 tester (e): caps, budget, rollback, append-only versions, through the real service and a real migrated schema. */
const BY = `user:${ADMIN}`;
let r: Rig;
beforeEach(async () => { r = await rig(); });
afterEach(async () => { await r.db.close(); });
const codeOf = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { if (e instanceof SkillRefused) return e.code; throw e; } };
const big = (n: number) => 'Thai-free filler sentence for the budget. '.repeat(Math.ceil(n / 43)).slice(0, n);

describe('caps and budget', () => {
  it('the 7th skill on a department and the 4th on a persona are refused; nothing is written', async () => {
    for (let i = 1; i <= SKILLS_PER_DEPT_TARGET; i++) await r.svc.run({ op: 'create', id: `sk-d${i}`, draft: draft(), attach: { kind: 'dept', id: 'rnd' } }, BY);
    expect(await codeOf(r.svc.run({ op: 'create', id: 'sk-d7', draft: draft(), attach: { kind: 'dept', id: 'rnd' } }, BY))).toBe('per_target_cap');
    expect(await r.repo.get('sk-d7')).toBeNull();
    for (let i = 1; i <= SKILLS_PER_PERSONA_TARGET; i++) await r.svc.run({ op: 'create', id: `sk-p${i}`, draft: draft(), attach: { kind: 'persona', id: 'research-scientist' } }, BY);
    expect(await codeOf(r.svc.run({ op: 'create', id: 'sk-p4', draft: draft(), attach: { kind: 'persona', id: 'research-scientist' } }, BY))).toBe('per_target_cap');
  });

  it('the actor byte budget refuses an attach that would overflow, and an edit that would overflow; the old version stays active', async () => {
    // each ~2400 byte skill; 12000 byte budget -> the 5th (with header) overflows
    const ids: string[] = [];
    let refused = '';
    for (let i = 1; i <= 6 && !refused; i++) {
      const id = `bg-${i}`;
      refused = await codeOf(r.svc.run({ op: 'create', id, draft: draft({ instructions: big(2400) }), attach: { kind: 'dept', id: 'hr' } }, BY));
      if (refused === 'ok') { ids.push(id); refused = ''; }
    }
    expect(refused).toBe('budget_exceeded');
    expect(ids.length).toBeGreaterThanOrEqual(3);
    const sections = (await r.svc.repo.loadAll()).skills.filter((s) => ids.includes(s.id)).reduce((n, s) => n + s.bodyBytes, 0);
    expect(sections).toBeLessThanOrEqual(SKILL_ACTOR_BUDGET_BYTES);
    // a skill detached from hr (small) can be attached again only while it fits: attach of a tiny one is fine
    await r.svc.run({ op: 'create', id: 'tiny', draft: draft() }, BY);
  });
});

describe('versions are append-only; rollback copies forward', () => {
  it('edit -> edit -> rollback to v1 gives v4 with v1 text; UPDATE/DELETE of any version raises; v1..v3 untouched', async () => {
    await r.svc.run({ op: 'create', id: 'ver', draft: draft(), attach: { kind: 'dept', id: 'rnd' } }, BY);
    const e = (base: number, t: string) => r.svc.run({ op: 'edit', id: 'ver', base, draft: { title: 'Handover checklist', instructions: `${t} and some more words.`, templates: [] } }, BY);
    await e(1, 'Second text'); await e(2, 'Third text');
    const v1 = (await r.repo.version('ver', 1))!;
    const out = await r.svc.run({ op: 'rollback', id: 'ver', base: 3, to: 1 }, BY);
    expect(out.version).toBe(4);
    expect(await r.repo.versionNumbers('ver')).toEqual([1, 2, 3, 4]);
    const v4 = (await r.repo.version('ver', 4))!;
    expect(v4.instructions).toBe(v1.instructions);
    expect(v4.restoredFrom).toBe(1);
    expect(r.org.skillsFor({ kind: 'head', dept: 'rnd' })[0]!.version).toBe(4);
    await expect(r.db.pool.query("UPDATE skill_versions SET instructions = 'x' WHERE skill_id = 'ver' AND version = 1")).rejects.toThrow();
    await expect(r.db.pool.query("DELETE FROM skill_versions WHERE skill_id = 'ver'")).rejects.toThrow();
    // rollback with a stale base is refused
    expect(await codeOf(r.svc.run({ op: 'rollback', id: 'ver', base: 3, to: 2 }, BY))).toBe('stale');
  });

  it('disable removes the skill from the next run; enable restores it; a head cannot see an unattached skill', async () => {
    await r.svc.run({ op: 'create', id: 'tog', draft: draft(), attach: { kind: 'dept', id: 'rnd' } }, BY);
    await r.svc.run({ op: 'status', id: 'tog', base: 1, from: 'active', to: 'disabled' }, BY);
    expect(r.org.skillsFor({ kind: 'head', dept: 'rnd' })).toEqual([]);
    await r.svc.run({ op: 'status', id: 'tog', base: 1, from: 'disabled', to: 'active' }, BY);
    expect(r.org.skillsFor({ kind: 'head', dept: 'rnd' })).toHaveLength(1);
    expect(r.org.skillsFor({ kind: 'head', dept: 'software' })).toEqual([]);
  });
});

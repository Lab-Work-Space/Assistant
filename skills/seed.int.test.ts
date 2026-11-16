import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SEED_SKILLS, type SeedSkill } from './seed-data.js';
import { seedSkills } from './seed.js';
import { rig, type Rig } from './test-helpers.js';

let r: Rig;
const log = { error: vi.fn() };
const q = async <T = Record<string, unknown>>(sql: string, args: unknown[] = []) => (await r.db.pool.query(sql, args)).rows as T[];

beforeEach(async () => { r = await rig(); r.cfg.values.set('skills.seed.enabled', true); });
afterEach(async () => { await r.db.close(); });

describe('seedSkills on a real database', () => {
  it('inserts every seed with owner_dept = dept, source seed and a dept attachment', async () => {
    const out = await seedSkills(r.svc, SEED_SKILLS, r.cfg as never, log);
    expect(out).toEqual({ created: SEED_SKILLS.length, skipped: 0, refused: 0 });
    for (const s of SEED_SKILLS) {
      expect(await q('SELECT owner_dept, created_by, status FROM skills WHERE id = $1', [s.id])).toEqual([{ owner_dept: s.dept, created_by: 'system:seed', status: 'active' }]);
      expect(await q('SELECT source, tools FROM skill_versions WHERE skill_id = $1', [s.id])).toEqual([{ source: 'seed', tools: [] }]);
      expect(await q('SELECT target_kind, target_id FROM skill_attachments WHERE skill_id = $1', [s.id])).toEqual([{ target_kind: 'dept', target_id: s.dept }]);
    }
    expect(r.audits.filter((a) => a.action === 'skill.seed' && a.outcome === 'ok v1')).toHaveLength(SEED_SKILLS.length);
  });

  it('a second boot is a no-op', async () => {
    await seedSkills(r.svc, SEED_SKILLS, r.cfg as never, log);
    r.audits.length = 0;
    expect(await seedSkills(r.svc, SEED_SKILLS, r.cfg as never, log)).toEqual({ created: 0, skipped: SEED_SKILLS.length, refused: 0 });
    expect(r.audits).toEqual([]);
    expect(Number((await q('SELECT count(*)::int AS n FROM skill_versions'))[0]!.n)).toBe(SEED_SKILLS.length);
  });

  it('a disabled or archived seed is not recreated', async () => {
    await seedSkills(r.svc, SEED_SKILLS, r.cfg as never, log);
    const [a, b] = [SEED_SKILLS[0]!.id, SEED_SKILLS[1]!.id];
    await r.db.pool.query("UPDATE skills SET status = 'disabled' WHERE id = $1", [a]);
    await r.db.pool.query("UPDATE skills SET status = 'archived' WHERE id = $1", [b]);
    expect((await seedSkills(r.svc, SEED_SKILLS, r.cfg as never, log)).created).toBe(0);
    expect(await q('SELECT id, status FROM skills WHERE id = ANY($1) ORDER BY id', [[a, b]])).toEqual([{ id: a, status: 'disabled' }, { id: b, status: 'archived' }].sort((x, y) => x.id.localeCompare(y.id)));
  });

  it('the switch off (or a config read error) inserts nothing', async () => {
    r.cfg.values.set('skills.seed.enabled', false);
    expect((await seedSkills(r.svc, SEED_SKILLS, r.cfg as never, log)).created).toBe(0);
    expect(await q('SELECT 1 FROM skills')).toEqual([]);
    expect((await seedSkills(r.svc, SEED_SKILLS, { get: () => { throw new Error('x'); } } as never, log)).created).toBe(0);
  });

  it('a refused seed (unknown dept, praw) is audited and the others continue; it never throws', async () => {
    const good = SEED_SKILLS[0]!;
    const bad = (id: string, dept: string): SeedSkill => ({ ...good, id, dept });
    const defs = [bad('nowhere-skill', 'nowhere'), bad('praw-skill', 'praw'), good];
    const out = await seedSkills(r.svc, defs, r.cfg as never, log);
    expect(out).toEqual({ created: 1, skipped: 0, refused: 2 });
    expect(r.audits.filter((a) => a.action === 'skill.seed').map((a) => `${a.tool}:${a.outcome}`)).toEqual(['nowhere-skill:refused:unknown_target', 'praw-skill:refused:unknown_target', `${good.id}:ok v1`]);
    expect(await q('SELECT 1 FROM skills WHERE id IN ($1,$2)', ['nowhere-skill', 'praw-skill'])).toEqual([]);
  });

  it('bad_seed: the owner dept must equal the dept attachment', async () => {
    await expect(r.svc.run({ op: 'create', id: 'x-skill', draft: { title: 'T', instructions: 'Write the handover note before closing a task.', templates: [], tools: [] }, attach: { kind: 'dept', id: 'hr' }, seed: { ownerDept: 'software' } }, 'system:seed')).rejects.toMatchObject({ code: 'bad_seed' });
    await expect(r.svc.run({ op: 'create', id: 'x-skill', draft: { title: 'T', instructions: 'Write the handover note before closing a task.', templates: [], tools: [] }, seed: { ownerDept: 'software' } }, 'system:seed')).rejects.toMatchObject({ code: 'bad_seed' });
  });
});

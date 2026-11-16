import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ADMIN_CARD_KINDS } from '../db/repos/adminCards.js';
import { migrate } from '../db/migrate.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
let db: TestDb;
beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, dir, 'up');
});
afterAll(async () => { await db.close(); });

const kindsInConstraint = async (): Promise<string[]> => {
  const def = (await db.pool.query<{ d: string }>("SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = 'admin_cards_kind_check' AND conrelid = 'admin_cards'::regclass")).rows[0]!.d;
  return [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]!).sort();
};
const seedSkill = async (id: string) => {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("INSERT INTO skills (id, title, active_version, created_by) VALUES ($1, 't', 1, 'user:1')", [id]);
    await c.query(`INSERT INTO skill_versions (skill_id, version, instructions, body_bytes, body_sha256, source, created_by) VALUES ($1, 1, 'at least ten chars', 20, $2, 'admin', 'user:1')`, [id, 'a'.repeat(64)]);
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
};

describe('031_skills (SK10)', () => {
  it('after up, admin_cards_kind_check lists exactly ADMIN_CARD_KINDS', async () => {
    expect(await kindsInConstraint()).toEqual([...ADMIN_CARD_KINDS].sort());
  });

  it('UPDATE, DELETE and TRUNCATE on skill_versions raise', async () => {
    await seedSkill('append-only');
    await expect(db.pool.query("UPDATE skill_versions SET instructions = 'changed after the fact' WHERE skill_id = 'append-only'")).rejects.toThrow(/append-only/);
    await expect(db.pool.query("DELETE FROM skill_versions WHERE skill_id = 'append-only'")).rejects.toThrow(/append-only/);
    await expect(db.pool.query('TRUNCATE skill_versions CASCADE')).rejects.toThrow(/append-only/);
  });

  it('a second open or card proposal for one skill violates skill_proposals_one_pending; a closed one does not', async () => {
    const ins = (status: string) => db.pool.query(`INSERT INTO skill_proposals (dept_id, kind, skill_id, base_version, payload, verdict, proposer, status) VALUES ('software', 'edit', 'one-pending', 1, '{}', '{}', 'heads/software', $1)`, [status]);
    await ins('rejected');
    await ins('open');
    await expect(ins('open')).rejects.toThrow(/skill_proposals_one_pending/);
    await expect(ins('card')).rejects.toThrow(/skill_proposals_one_pending/);
    await ins('applied');
  });

  it('a skill row without a version fails at COMMIT (deferred foreign key)', async () => {
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("INSERT INTO skills (id, title, active_version, created_by) VALUES ('no-version', 't', 1, 'user:1')");
      await expect(c.query('COMMIT')).rejects.toThrow(/skills_active_version_fk/);
    } finally { await c.query('ROLLBACK').catch(() => undefined); c.release(); }
  });

  it('proposals: tainted is refused by the table, a target id must have the id format, a dept target is the proposer dept', async () => {
    const base = (taint: boolean, tid: string, dept = 'software', tkind = 'persona') => db.pool.query(`INSERT INTO skill_proposals (dept_id, kind, skill_id, target_kind, target_id, payload, verdict, proposer, tainted) VALUES ($1, 'create', $2, $3, $4, '{}', '{}', 'heads/software', $5)`, [dept, `p-${Math.random().toString(36).slice(2, 8)}`, tkind, tid, taint]);
    await expect(base(true, 'alice')).rejects.toThrow(/tainted/);
    await expect(base(false, 'Bad Id!')).rejects.toThrow(/target_format|check/);
    await expect(base(false, 'hr', 'software', 'dept')).rejects.toThrow(/dept_target/);
    await base(false, 'software', 'software', 'dept');
  });

  it('down restores the pre-031 kind list, removes skill cards and the tables; up again restores the union', async () => {
    await db.pool.query("INSERT INTO admin_cards (id, proposer_id, kind, payload, snapshot, tainted, channel_id, expires_at) VALUES ('s'||repeat('0',31), '1', 'skill', '{}', '{}', false, '1', now() + interval '1 minute')");
    await db.pool.query(readFileSync(join(dir, '031_skills.down.sql'), 'utf8'));
    expect(await kindsInConstraint()).toEqual([...ADMIN_CARD_KINDS].filter((k) => k !== 'skill').sort());
    expect((await db.pool.query("SELECT 1 FROM admin_cards WHERE kind = 'skill'")).rowCount).toBe(0);
    expect((await db.pool.query("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name LIKE 'skill%'")).rowCount).toBe(0);
    await db.pool.query(readFileSync(join(dir, '031_skills.up.sql'), 'utf8'));
    expect(await kindsInConstraint()).toEqual([...ADMIN_CARD_KINDS].sort());
  });
});

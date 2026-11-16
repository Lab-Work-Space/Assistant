import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { AuditRepo } from '../db/index.js';
import { createAudit } from './audit.js';

let db: TestDb;
beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'), 'up');
});
afterAll(async () => { await db.close(); });

describe('audit', () => {
  it('stores spec columns only and never message bodies', async () => {
    const audit = createAudit(new AuditRepo(db.pool));
    await audit({ actor: 'head:hq', action: 'llm.call', model: 'm', tokensIn: 10, tokensOut: 5, costUsd: 0.01, outcome: 'ok',
      content: 'SECRET BODY', body: 'SECRET BODY' } as never);
    const rows = (await db.pool.query('SELECT * FROM audit_log')).rows;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('SECRET BODY');
    expect(rows[0]).toMatchObject({ actor: 'head:hq', action: 'llm.call', model: 'm', tokens_in: 10, tokens_out: 5, cost_usd: 0.01, outcome: 'ok' });
  });

  it('caps free-text fields so a body cannot be smuggled into outcome', async () => {
    const audit = createAudit(new AuditRepo(db.pool));
    await audit({ actor: 'a', action: 'x', outcome: 'z'.repeat(5000) });
    const r = await db.pool.query('SELECT outcome FROM audit_log ORDER BY id DESC LIMIT 1');
    expect(r.rows[0].outcome.length).toBeLessThanOrEqual(200);
  });

  it('a failing store is logged, not thrown', async () => {
    const errs: unknown[] = [];
    const audit = createAudit({ append: async () => { throw new Error('db'); } }, { error: (o) => { errs.push(o); } });
    await expect(audit({ actor: 'a', action: 'x' })).resolves.toBeUndefined();
    expect(errs).toHaveLength(1);
  });

  it('HEAL-1 latestOutcome: the newest row of an action, null when none', async () => {
    const repo = new AuditRepo(db.pool);
    const audit = createAudit(repo);
    expect(await repo.latestOutcome('clickup.mode.test')).toBeNull();
    await audit({ actor: 'a', action: 'clickup.mode.test', outcome: 'workspace' });
    await audit({ actor: 'a', action: 'clickup.mode.test', outcome: 'workspace-all' });
    await audit({ actor: 'a', action: 'other', outcome: 'zzz' });
    expect(await repo.latestOutcome('clickup.mode.test')).toBe('workspace-all');
  });
});

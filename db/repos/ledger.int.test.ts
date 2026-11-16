import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import {
  ApprovalRepo, AuditRepo, BudgetDayRepo, ConfigRepo, DeptNoteRepo, PromptOverrideRepo, ProviderKeyRepo,
} from './ledger.js';
import { DepartmentRepo } from './org.js';
import { TaskRepo } from './tasks.js';

let db: TestDb;
let taskId: string;
beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'), 'up');
  await new DepartmentRepo(db.pool).upsert({ id: 'hq', name: 'HQ', categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
  taskId = (await new TaskRepo(db.pool).create({ title: 't', deptId: 'hq', owner: { kind: 'head', dept: 'hq' }, requester: { kind: 'human', userId: '1' }, origin: 'chat' })).id;
});
afterAll(async () => { await db.close(); });

describe('ledger repos', () => {
  it('DeptNoteRepo add/latest ordering and limit', async () => {
    const r = new DeptNoteRepo(db.pool);
    await r.add('hq', taskId, 'one');
    await r.add('hq', null, 'two');
    await r.add('hq', null, 'three');
    const n = await r.latest('hq', 2);
    expect(n.map((x) => x.body)).toEqual(['three', 'two']);
    expect(n[0]).toMatchObject({ deptId: 'hq', taskId: null });
  });

  it('ConfigRepo upsert increments version; get/list/delete', async () => {
    const r = new ConfigRepo(db.pool);
    await r.upsert('limits', { a: 1 }, 'u1');
    await r.upsert('limits', { a: 2 }, 'u2');
    await r.upsert('halted', false, null);
    expect(await r.get('limits')).toMatchObject({ key: 'limits', value: { a: 2 }, version: 2, updatedBy: 'u2' });
    expect((await r.get('halted'))?.value).toBe(false);
    expect((await r.list()).map((x) => x.key)).toEqual(['halted', 'limits']);
    await r.delete('halted');
    expect(await r.get('halted')).toBeNull();
  });

  it('PromptOverrideRepo upsert appends versions (never updates a row); delete appends a tombstone (K10)', async () => {
    const r = new PromptOverrideRepo(db.pool);
    await r.upsert('heads/hq', 'v1', 'u');
    await r.upsert('heads/hq', 'v2', 'u');
    expect(await r.getActive('heads/hq')).toMatchObject({ body: 'v2', version: 2 });
    expect((await r.history('heads/hq')).map((x) => x.version)).toEqual([2, 1]);
    await r.delete('heads/hq');
    expect(await r.getActive('heads/hq')).toBeNull();
    expect((await r.newest('heads/hq'))).toMatchObject({ version: 3, tombstone: true });
    expect((await r.history('heads/hq')).map((x) => x.body)).toEqual(['', 'v2', 'v1']); // nothing was lost
  });

  it('ProviderKeyRepo upsert/get/list/delete roundtrips bytes', async () => {
    const r = new ProviderKeyRepo(db.pool);
    await r.upsert({ provider: 'anthropic', ciphertext: Buffer.from([1, 2]), iv: Buffer.from([3]), tag: Buffer.from([4]) });
    await r.upsert({ provider: 'anthropic', ciphertext: Buffer.from([9]), iv: Buffer.from([3]), tag: Buffer.from([4]) });
    expect((await r.get('anthropic'))?.ciphertext).toEqual(Buffer.from([9]));
    expect(await r.list()).toEqual(['anthropic']);
    await r.delete('anthropic');
    expect(await r.get('anthropic')).toBeNull();
  });

  it('AuditRepo append stores row with null defaults', async () => {
    const r = new AuditRepo(db.pool);
    await r.append({ actor: 'hq', action: 'llm', taskId, costUsd: 0.5, tokensIn: 3 });
    const row = (await db.pool.query('SELECT * FROM audit_log')).rows[0];
    expect(row).toMatchObject({ actor: 'hq', action: 'llm', task_id: taskId, cost_usd: 0.5, tokens_in: 3, tool: null });
  });

  it('ApprovalRepo create/get/listByStatus', async () => {
    const r = new ApprovalRepo(db.pool);
    const a = await r.create({ taskId, reason: 'big', estCostUsd: 1.5, requestedBy: 'hq' });
    expect(a).toMatchObject({ taskId, reason: 'big', estCostUsd: 1.5, status: 'pending', decidedBy: null, decidedAt: null });
    expect(a.createdAt).toBeInstanceOf(Date);
    expect(await r.get(a.id)).toEqual(a);
    expect((await r.listByStatus('pending')).map((x) => x.id)).toEqual([a.id]);
    expect(await r.listByStatus('approved')).toEqual([]);
    expect(await r.get(99999)).toBeNull();
  });

  it('BudgetDayRepo get', async () => {
    await db.pool.query("INSERT INTO budget_days (day, scope, scope_id, reserved_usd, spent_usd) VALUES ('2026-10-31','bot','hq',0.25,0.5)");
    expect(await new BudgetDayRepo(db.pool).get('2026-10-31', 'bot', 'hq')).toEqual({ day: '2026-10-31', scope: 'bot', scopeId: 'hq', reservedUsd: 0.25, spentUsd: 0.5 });
    expect(await new BudgetDayRepo(db.pool).get('2026-10-31', 'bot', 'x')).toBeNull();
  });
});

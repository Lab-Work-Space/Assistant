import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ActorRef } from '../../company/types.js';
import { PRAW_DEFAULT_MODEL } from '../../company/seed.js';
import { AuditRepo, TaskRepo } from '../../db/index.js';
import { migrate } from '../../db/migrate.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { usageCmd } from '../../discord/commands/usage.js';
import { createAudit } from '../../governance/audit.js';
import { Budget, Halt } from '../../governance/index.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeProvider, ProviderRegistry } from '../../providers/index.js';
import { createMeteredModel } from './metered.js';
import { newBus } from '../test-helpers.js';

let db: TestDb;
const PRAW: ActorRef = { kind: 'head', dept: 'praw' };
const media = { role: 'user' as const, content: [{ type: 'media' as const, mimeType: 'image/png', data: 'iVBORw0KGgo=' }, { type: 'text' as const, text: 'OCR' }] };

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations'), 'up');
});
beforeEach(async () => {
  await db.pool.query('DELETE FROM budget_days');
  await db.pool.query('DELETE FROM audit_log');
});
afterAll(async () => {
  await db.close();
});

function mk(cfgInit: ConstructorParameters<typeof FakeConfig>[0] = {}) {
  const cfg = new FakeConfig({ 'budget.botDailyUsd': 100, 'budget.companyDailyUsd': 100, ...cfgInit });
  const bus = newBus();
  const budget = new Budget(db.pool, cfg, bus, () => new Date());
  const provider = new FakeProvider([{ text: 'ร้านกาแฟ 120 บาท', usage: { inputTokens: 1200, outputTokens: 30 } }], 'gemini');
  const providers = new ProviderRegistry();
  providers.register(provider);
  const halt = new Halt(cfg, new TaskRepo(db.pool), bus);
  const metered = createMeteredModel({ providers, cfg, budget, audit: createAudit(new AuditRepo(db.pool)), halt });
  return { metered, budget, provider };
}

describe('metered', () => {
  it('OCR spend appears in /usage as head:praw and an llm.call audit row exists', async () => {
    const t = mk();
    const r = await t.metered.call({ actor: PRAW, task: null, system: 'ocr', messages: [media], maxTokens: 1024 });
    expect(r.text).toBe('ร้านกาแฟ 120 บาท');
    const reply = await usageCmd({ options: { string: () => null } } as never, { budget: t.budget } as never);
    const fields = JSON.stringify(reply);
    expect(fields).toContain('bot: head:praw');
    const bot = (await t.budget.usage(new Date().toISOString().slice(0, 10))).find((u) => u.scope === 'bot');
    expect(bot).toMatchObject({ scopeId: 'head:praw' });
    expect(Number(bot!.spentUsd)).toBeCloseTo(r.costUsd, 6);
    expect(Number(bot!.reservedUsd)).toBe(0);
    const rows = (await db.pool.query("SELECT actor, provider, model, tokens_in, tokens_out, outcome FROM audit_log WHERE action = 'llm.call'")).rows;
    expect(rows).toEqual([{ actor: 'head:praw', provider: 'gemini', model: PRAW_DEFAULT_MODEL, tokens_in: 1200, tokens_out: 30, outcome: 'end_turn' }]);
  });

  it('refused (no provider call) once the bot daily budget is used up', async () => {
    const t = mk({ 'budget.botDailyUsd': 0.000001 });
    await expect(t.metered.call({ actor: PRAW, task: null, system: 'ocr', messages: [media], maxTokens: 1024 })).rejects.toThrow(/bot daily budget is used up/);
    expect(t.provider.calls).toHaveLength(0);
    const rows = (await db.pool.query("SELECT outcome FROM audit_log WHERE action = 'budget.reserve'")).rows;
    expect(rows).toEqual([{ outcome: 'refused:bot' }]);
  });
});

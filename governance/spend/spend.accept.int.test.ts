import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { budgetText } from '../../agents/call/call.js';
import type { OutboundPayload } from '../../agents/loop/payload.js';
import { createCalendar } from '../../company/calendar.js';
import type { ActorRef } from '../../company/types.js';
import { EventBus, type AppEvents } from '../../core/events.js';
import { migrate } from '../../db/migrate.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { AdminOp } from '../../admin/ops.js';
import { ADMIN_CONFIG_KEYS, isAdminConfigKey, isAdminReadKey } from '../../admin/keys.js';
import { ConfigSchema } from '../../config/schema.js';
import { buildMessage } from '../../discord/embeds/index.js';
import { configReply } from '../../discord/commands/types.js';
import { planDeptBudget } from '../../discord/commands/plans.js';
import { Budget, LOCAL_PROVIDER } from '../budget.js';
import { SpendAlerts, SpendOverrides, SpendRepo, SpendWatch, bindSpendStop, effectiveDeptCap, spendReport, summaryRenderer } from './spend.js';
import { FakeConfig } from '../test-helpers.js';

/**
 * SPEND-1 Stage 6 (tester): independent acceptance probes (a) to (h) of the brief, wired like app.ts: real Budget + bus + bindSpendStop + SpendOverrides
 * + SpendAlerts + SpendWatch over the real test database, with recorders for the two Discord channels.
 */
const CONFIG_CH = '1565667791938387969';
const hq: ActorRef = { kind: 'head', dept: 'hq' };
const MODEL = 'claude-sonnet-5-5';
let db: TestDb;
let clock = Date.parse('2026-11-10T05:00:00Z');

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations'), 'up');
});
beforeEach(async () => {
  clock = Date.parse('2026-11-10T05:00:00Z');
  for (const t of ['spend_overrides', 'spend_alerts', 'spend_days', 'budget_days']) await db.pool.query(`DELETE FROM ${t}`);
});
afterAll(async () => { await db.close(); });

function rig(init: ConstructorParameters<typeof FakeConfig>[0] = {}) {
  const cfg = new FakeConfig({ 'spend.deptMonthlyUsd': { hq: 0.01 }, 'budget.companyDailyUsd': 1000, 'budget.botDailyUsd': 1000, 'budget.taskUsd': 1000, ...init });
  const cards: OutboundPayload[] = [];
  const botLog: OutboundPayload[] = [];
  const repo = new SpendRepo(db.pool);
  const alerts = new SpendAlerts(repo, { alert: async (p) => void botLog.push(p) }, { error: () => undefined }, undefined, (r) => summaryRenderer(repo, overrides, cfg, () => clock)(r));
  const overrides = new SpendOverrides({
    pool: db.pool, cfg, clock: () => clock, configChannelId: CONFIG_CH, alerts, log: { error: () => undefined }, audit: async () => undefined,
    ports: { postCard: async (p) => { cards.push(p); return `msg${cards.length}`; } },
  });
  const bus = new EventBus<AppEvents>();
  const budget = new Budget(db.pool, cfg, bus, () => new Date(clock), { deptCap: (d, m, c) => effectiveDeptCap(cfg, d, m, c) });
  bindSpendStop(bus, overrides, { error: () => undefined });
  const watch = new SpendWatch({ repo, cfg, overrides, alerts, clock: () => clock, offDay: (t) => createCalendar(cfg).isOffDay(t), log: { error: () => undefined } });
  return { cfg, cards, botLog, repo, alerts, overrides, bus, budget, watch };
}
const settleN = async (b: Budget, usd: number, o: { actor?: ActorRef; est?: number } = {}) => {
  const r = await b.reserve({ actor: o.actor ?? hq, estUsd: o.est ?? usd, model: MODEL });
  if (r.ok) await b.settle(r.reservationId, usd);
  return r;
};
const waitFor = async (f: () => boolean | Promise<boolean>) => { for (let i = 0; i < 300 && !(await f()); i++) await new Promise((r) => setTimeout(r, 10)); expect(await f()).toBe(true); };
const pending = async () => (await db.pool.query<{ id: string; status: string; message_id: string | null; old: number; neu: number }>("SELECT id, status, message_id, old_cap_usd::float8 AS old, new_cap_usd::float8 AS neu FROM spend_overrides ORDER BY created_at")).rows;

describe('SPEND-1 tester acceptance', () => {
  it('(a) dept cap $0.01: metered call refused with dept text; one card in #setting, one alert in #bot-log; approve -> next call allowed', async () => {
    const t = rig();
    const r = await t.budget.reserve({ actor: hq, estUsd: 0.02, model: MODEL });
    expect(r).toEqual({ ok: false, scope: 'dept' });
    expect(budgetText({ kind: 'refused', scope: 'dept', est: 0.02 }, MODEL)).toBe('The department monthly budget is used up. A Bot Admin can approve a raise in #⚙️-setting.');
    await waitFor(() => t.cards.length === 1 && t.botLog.length === 1);
    for (let i = 0; i < 5; i++) expect(await t.budget.reserve({ actor: hq, estUsd: 0.02, model: MODEL })).toEqual({ ok: false, scope: 'dept' }); // every refusal reports
    await new Promise((x) => setTimeout(x, 150));
    expect(t.cards).toHaveLength(1); // one pending index
    expect(t.botLog).toHaveLength(1); // one stop claim
    expect(t.cards[0]).toMatchObject({ type: 'approval', spendOverrideId: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(t.botLog[0]!.type).toBe('config'); // never an admin-role ping
    const [row] = await pending();
    expect(row).toMatchObject({ status: 'pending', message_id: 'msg1', old: 0.01, neu: 1.25 });
    // approval click from a different message id / channel is refused, the right one wins, a second one loses
    expect(await t.overrides.decide({ id: row!.id, action: 'approve', userId: 'u1', channelId: CONFIG_CH, messageId: 'other' })).toMatchObject({ ok: false });
    expect(await t.overrides.decide({ id: row!.id, action: 'approve', userId: 'u1', channelId: 'not-config', messageId: 'msg1' })).toMatchObject({ ok: false });
    expect(await t.overrides.decide({ id: row!.id, action: 'approve', userId: 'u1', channelId: CONFIG_CH, messageId: 'msg1' })).toMatchObject({ ok: true });
    expect(await t.overrides.decide({ id: row!.id, action: 'approve', userId: 'u2', channelId: CONFIG_CH, messageId: 'msg1' })).toMatchObject({ ok: false });
    expect((await t.budget.reserve({ actor: hq, estUsd: 0.02, model: MODEL })).ok).toBe(true);
  });

  it('(b) 80% warn once; anomaly with a zero median uses the USD floor; projection fires once', async () => {
    const t = rig({ 'spend.deptMonthlyUsd': { hq: 10 } });
    await settleN(t.budget, 8.2);
    await t.watch.tick();
    await t.watch.tick();
    await t.watch.tick();
    expect(t.botLog.filter((p) => p.title === 'Department budget warning')).toHaveLength(1);
    // the 8.2 spent today with no history: median 0 -> level = floor 0.5 -> an anomaly for hq and _company, once each
    const an = t.botLog.filter((p) => p.title === 'Unusual spend today');
    expect(an).toHaveLength(2);
    // a tiny spend under the floor does not fire (a different dept)
    await db.pool.query("INSERT INTO spend_days (day, dept_id, provider, tool, spent_usd) VALUES ('2026-11-10','rnd','gemini','ocr',0.4)");
    clock += 6 * 60_000;
    await t.watch.tick();
    expect(t.botLog.filter((p) => p.title === 'Unusual spend today')).toHaveLength(2); // rnd 0.4 is under the 0.5 floor; hq and _company are already claimed today
  });

  it('(b2) projection: pace over the cap with MTD below it fires once per month', async () => {
    const t = rig({ 'spend.deptMonthlyUsd': { hq: 10 }, 'spend.alertsEnabled': true });
    for (let d = 1; d <= 7; d++) await db.pool.query("INSERT INTO spend_days (day, dept_id, provider, tool, spent_usd) VALUES (('2026-11-10'::date - $1::int),'hq','gemini','ocr',1)", [d]);
    await db.pool.query("INSERT INTO budget_days (day, scope, scope_id, spent_usd) VALUES ('2026-11-01','dept','hq',3)");
    await t.watch.tick();
    clock += 61 * 60_000;
    await t.watch.tick();
    expect(t.botLog.filter((p) => p.title === 'Department budget projection')).toHaveLength(1);
  });

  it('(c) weekly summary with a Monday holiday: nothing Monday, nothing before 09:00 Tuesday, one at 09:00 Tuesday, none Wednesday (real calendar)', async () => {
    const t = rig({ 'schedule.holidays': [{ date: '2026-11-09' }], 'spend.alertsEnabled': false, 'spend.deptMonthlyUsd': {} });
    const at = async (iso: string) => { clock = Date.parse(iso); await t.watch.tick(); return t.botLog.filter((p) => p.title === 'Weekly spend summary').length; };
    expect(await at('2026-11-09T03:00:00Z')).toBe(0);
    expect(await at('2026-11-10T01:59:00Z')).toBe(0);
    expect(await at('2026-11-10T02:00:00Z')).toBe(1);
    expect(await at('2026-11-11T05:00:00Z')).toBe(1);
    expect(await at('2026-11-14T05:00:00Z')).toBe(1); // Saturday: off day
    expect(await at('2026-11-16T02:30:00Z')).toBe(2); // next Monday
    const claims = (await db.pool.query<{ period: string }>("SELECT period FROM spend_alerts WHERE kind = 'summary' ORDER BY period")).rows.map((r) => r.period);
    expect(claims).toEqual(['2026-W46', '2026-W47']);
  });

  it('(d) /usage trend with 12 depts x 120 tools x 40 providers: embed limits hold for every `by`', async () => {
    const t = rig({ 'spend.deptMonthlyUsd': {} });
    const depts = ['hq', 'rnd', 'software', 'it', 'marketing', 'sales', 'hr', 'finance', 'ops', 'praw', 'legal', 'support'];
    const values: unknown[][] = [];
    for (let d = 0; d < 30; d++) for (const [i, dept] of depts.entries()) for (let k = 0; k < 6; k++)
      values.push([d, dept, `prov_${(i * 7 + k * 5 + d) % 40}${'x'.repeat(50)}`.slice(0, 64), `tool_${(i * 11 + k * 13 + d) % 120}`, 0.01 + ((i + k + d) % 9) / 10]);
    for (const v of values) await db.pool.query("INSERT INTO spend_days (day, dept_id, provider, tool, spent_usd) VALUES (('2026-11-10'::date - $1::int), $2, $3, $4, $5) ON CONFLICT (day, dept_id, provider, model, tool, root_id) DO UPDATE SET spent_usd = spend_days.spent_usd + $5", v);
    for (const by of ['dept', 'provider', 'tool'] as const) {
      const rep = await spendReport(t.repo, t.overrides, t.cfg, clock, by);
      expect(rep.fields.length).toBeLessThanOrEqual(25);
      for (const f of rep.fields) { expect(f.value.length).toBeLessThanOrEqual(1024); expect(f.name.length).toBeLessThanOrEqual(256); expect(f.name.length).toBeGreaterThan(0); expect(f.value.length).toBeGreaterThan(0); }
      const reply = configReply('Spend trend', rep.body, { fields: rep.fields });
      const embeds = reply.embeds ?? [];
      let total = 0;
      for (const e of embeds as { toJSON?: () => unknown }[]) {
        const j = (e.toJSON ? e.toJSON() : e) as { title?: string; description?: string; footer?: { text: string }; fields?: { name: string; value: string }[] };
        total += (j.title?.length ?? 0) + (j.description?.length ?? 0) + (j.footer?.text.length ?? 0) + (j.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
        expect((j.fields ?? []).length).toBeLessThanOrEqual(25);
      }
      expect(total).toBeLessThanOrEqual(6000);
      expect(embeds.length).toBeLessThanOrEqual(10);
      // configReply keeps only message 0: the builder must never have produced a second message (it would be silently dropped)
      expect(buildMessage({ type: 'config', title: 'Spend trend', body: rep.body, fields: rep.fields, origin: 'governance' }, { deptColor: 0x95a5a6 })).toHaveLength(1);
    }
  });

  it('(e) model paths: no spend.* key via config_propose/config_set surface, no AdminOp for dept or spend, read-only visibility only', () => {
    const keys = Object.keys(ConfigSchema).filter((k) => k.startsWith('spend.'));
    expect(keys.length).toBe(9);
    for (const k of keys) { expect(isAdminConfigKey(k)).toBe(false); expect((ADMIN_CONFIG_KEYS as readonly string[]).includes(k)).toBe(false); expect(isAdminReadKey(k)).toBe(true); }
    for (const op of [{ op: 'budget_set', scope: 'dept', usd: 5 }, { op: 'budget_set', scope: 'dept', dept: 'hq', usd: 5 }, { op: 'spend_set', dept: 'hq', usd: 5 }, { op: 'spend_override_approve', id: 'a'.repeat(32) }, { op: 'config_set', key: 'spend.warnPct', value: 99 }, { op: 'limits_set', limit: 'spend.warnPct', value: 99 }])
      expect(AdminOp.safeParse(op).success).toBe(false);
    expect(AdminOp.safeParse({ op: 'budget_set', scope: 'daily', usd: 5 }).success).toBe(true); // the old scopes are unchanged
  });

  it('(f) approved raise, then a human lowers the cap: the new cap is enforced at once and the override no longer applies', async () => {
    const t = rig({ 'spend.deptMonthlyUsd': { hq: 10 } });
    await settleN(t.budget, 10);
    expect(await t.budget.reserve({ actor: hq, estUsd: 1, model: MODEL })).toEqual({ ok: false, scope: 'dept' });
    await waitFor(async () => (await pending()).length === 1);
    const row = (await pending())[0]!;
    await waitFor(async () => (await pending())[0]!.message_id !== null);
    expect((await t.overrides.decide({ id: row.id, action: 'approve', userId: 'u1', channelId: CONFIG_CH, messageId: 'msg1' })).ok).toBe(true);
    expect((await settleN(t.budget, 2)).ok).toBe(true); // within 12.5
    // the human lowers the cap to 5 via the real plan
    const closed: string[] = [];
    const out = { superseded: 0 };
    const plan = planDeptBudget('hq', 5, 'admin1', { cfg: t.cfg as never, spend: { supersede: (d: string, u: string) => t.overrides.supersede(d, u) } as never, cards: { close: async (_c: string, m: string) => void closed.push(m) } as never }, out);
    if ('error' in plan) throw new Error(plan.error);
    await t.cfg.set('spend.deptMonthlyUsd', { hq: 5 }, 'admin1'); // what applyPlan's writes do
    await plan.run!();
    expect(out.superseded).toBe(1);
    expect(await t.overrides.effectiveCap('hq', '2026-11-01')).toBe(5);
    expect(await t.budget.reserve({ actor: hq, estUsd: 0.01, model: MODEL })).toEqual({ ok: false, scope: 'dept' }); // spent 12 > 5
    expect((await pending()).map((r) => r.status)).toEqual(['expired']);
  });

  it('(g) settle after local midnight / month end books to the reserve-time month and day, and the next reserve uses the new month', async () => {
    const t = rig({ 'spend.deptMonthlyUsd': { hq: 100 } });
    clock = Date.parse('2026-11-30T16:59:59Z');
    const r = await t.budget.reserve({ actor: hq, estUsd: 1, model: MODEL, attribution: { provider: 'gemini', tool: 'ocr' } });
    expect(r.ok).toBe(true);
    clock = Date.parse('2026-11-30T17:00:01Z');
    if (r.ok) await t.budget.settle(r.reservationId, 0.7);
    const dept = (await db.pool.query<{ day: string; spent: number; reserved: number }>("SELECT to_char(day,'YYYY-MM-DD') AS day, spent_usd::float8 AS spent, reserved_usd::float8 AS reserved FROM budget_days WHERE scope='dept' ORDER BY day")).rows;
    expect(dept).toEqual([{ day: '2026-11-01', spent: 0.7, reserved: 0 }]);
    const sd = (await db.pool.query<{ day: string; usd: number }>("SELECT to_char(day,'YYYY-MM-DD') AS day, spent_usd::float8 AS usd FROM spend_days")).rows;
    expect(sd).toEqual([{ day: '2026-11-30', usd: 0.7 }]);
    expect((await t.budget.reserve({ actor: hq, estUsd: 0.1, model: MODEL })).ok).toBe(true);
    expect((await db.pool.query("SELECT 1 FROM budget_days WHERE scope='dept' AND day='2026-12-01'")).rowCount).toBe(1);
  });

  it('(h) local-mode calls count calls but not USD, never touch or are refused by the dept row', async () => {
    const t = rig({ 'spend.deptMonthlyUsd': { hq: 0 }, 'limits.localUnlimited': false });
    const ac = new AbortController();
    const r = await t.budget.reserve({ actor: hq, estUsd: 0, model: 'local/claude-sonnet-5-5', provider: LOCAL_PROVIDER, signal: ac.signal });
    expect(r.ok).toBe(true); // a $0 dept cap does not stop a local call
    if (r.ok) { await t.budget.onLocalAttempt(1, ac.signal); await t.budget.release(r.reservationId); }
    expect((await db.pool.query("SELECT 1 FROM budget_days WHERE scope='dept'")).rowCount).toBe(0);
    const sd = (await db.pool.query<{ usd: number; calls: number; provider: string }>('SELECT spent_usd::float8 AS usd, calls, provider FROM spend_days')).rows;
    expect(sd).toEqual([{ usd: 0, calls: 1, provider: LOCAL_PROVIDER }]);
    // while a metered call for the same dept is refused (cap 0)
    expect(await t.budget.reserve({ actor: hq, estUsd: 0.001, model: MODEL })).toEqual({ ok: false, scope: 'dept' });
  });
});

import { describe, expect, it } from 'vitest';
import { ADMIN_CONFIG_KEYS, HANDLER_KEYS, configRisk, isAdminConfigKey, isAdminReadKey } from '../../admin/keys.js';
import { AdminOp } from '../../admin/ops.js';
import { PANEL_LIVE_KEYS } from '../../admin/panel.js';
import { ConfigSchema } from '../../config/schema.js';
import { buildReport, type TrendRow } from '../../governance/spend/spend.js';
import { COMMANDS, handleInteraction } from './index.js';
import { BUDGET_SCOPES } from './plans.js';
import { ADMIN_ROLE, cmd, interaction, makeDeps, text } from './test-helpers.js';
import { CONFIG_CHANNEL_ID, type CommandDeps } from './types.js';

const SPEND_KEYS = Object.keys(ConfigSchema).filter((k) => k.startsWith('spend.'));
const ID = 'ab'.repeat(16);
const settings = (key: string, value: string, extra = {}) => cmd('settings', 'set', { strings: { key, value }, ...extra });
const spendFake = (over: Partial<NonNullable<CommandDeps['spend']>> = {}) => {
  const decided: unknown[] = [];
  const superseded: [string, string][] = [];
  const spend: NonNullable<CommandDeps['spend']> = {
    report: async () => ({ body: 'b', fields: [] }),
    effectiveCap: async () => 42,
    supersede: async (d, u) => { superseded.push([d, u]); return { count: 2, cards: [{ channelId: CONFIG_CHANNEL_ID, messageId: 'mm' }] }; },
    decide: async (c) => { decided.push(c); return { ok: true, row: { id: c.id, deptId: 'hq', month: '2026-11-01', oldCapUsd: 10, newCapUsd: 12.5, status: 'approved', channelId: CONFIG_CHANNEL_ID, messageId: 'm1', createdAt: new Date(), expiresAt: new Date(), decidedBy: c.userId, decidedAt: null } }; },
    ...over,
  };
  return { spend, decided, superseded };
};
const button = (customId: string, o: { channelId?: string; roles?: string[]; messageId?: string } = {}) =>
  interaction({ kind: 'button', customId, channelId: o.channelId ?? CONFIG_CHANNEL_ID, roles: o.roles ?? [ADMIN_ROLE], messageId: o.messageId ?? 'm1' });

describe('SPEND-1 S1: no model path to any spend.* key', () => {
  it('every spend.* key is a handler key, never an admin config key, still readable, and not on the panel', () => {
    expect(SPEND_KEYS).toHaveLength(9);
    for (const k of SPEND_KEYS) {
      expect(isAdminConfigKey(k), k).toBe(false);
      expect((HANDLER_KEYS as readonly string[]).includes(k), k).toBe(true);
      expect((ADMIN_CONFIG_KEYS as readonly string[]).includes(k), k).toBe(false);
      expect(isAdminReadKey(k), k).toBe(true); // Praw may read the values (no secret)
      expect((PANEL_LIVE_KEYS as readonly string[]).includes(k), k).toBe(false);
    }
  });

  it('AdminOp has no budget_set for dept and no op with spend in its name; BUDGET_SCOPES has no dept', () => {
    expect(AdminOp.safeParse({ op: 'budget_set', scope: 'dept', usd: 5 }).success).toBe(false);
    expect(AdminOp.safeParse({ op: 'budget_set', scope: 'dept', dept: 'hq', usd: 5 }).success).toBe(false);
    expect(AdminOp.safeParse({ op: 'spend_set', dept: 'hq', usd: 5 }).success).toBe(false);
    expect(AdminOp.safeParse({ op: 'spend_override_approve', id: ID }).success).toBe(false);
    expect(Object.keys(BUDGET_SCOPES)).toEqual(['daily', 'bot', 'task']);
    expect(COMMANDS.find((c) => c.name === 'budget')!.options!.map((o) => o.name)).toEqual(['set', 'dept']);
  });
});

describe('SPEND-1 S2: the override decision path', () => {
  it('an admin click in #setting reaches decide() with the stored-card facts, answers privately and closes the card', async () => {
    const t = await makeDeps();
    const f = spendFake();
    const closed: unknown[] = [];
    t.deps.spend = f.spend;
    t.deps.cards = { close: async (c, m, n) => { closed.push([c, m, n]); } };
    const i = button(`spendovr:${ID}:approve`);
    const r = await handleInteraction(i, t.deps);
    expect(i.deferred).toEqual({ ephemeral: true });
    expect(f.decided).toEqual([{ id: ID, action: 'approve', userId: 'u1', channelId: CONFIG_CHANNEL_ID, messageId: 'm1' }]);
    expect(text(r)).toContain('Raised');
    expect(JSON.stringify(closed)).toContain('Approved by');
    expect(JSON.stringify(closed)).toContain('12.50');
  });

  it('reject goes the same way; a refused decide is an ephemeral line and the card is left alone', async () => {
    const t = await makeDeps();
    const f = spendFake({ decide: async () => ({ ok: false, text: 'That raise expired or was already decided.' }) });
    const closed: unknown[] = [];
    t.deps.spend = f.spend;
    t.deps.cards = { close: async (...a) => { closed.push(a); } };
    expect(text(await handleInteraction(button(`spendovr:${ID}:reject`), t.deps))).toContain('expired or was already decided');
    expect(closed).toEqual([]);
  });

  it('an off-channel click, a non-admin click, a malformed id and a foreign prefix never reach decide()', async () => {
    const t = await makeDeps();
    const f = spendFake();
    t.deps.spend = f.spend;
    expect(text(await handleInteraction(button(`spendovr:${ID}:approve`, { channelId: '999' }), t.deps))).toContain('#⚙️-setting');
    expect(text(await handleInteraction(button(`spendovr:${ID}:approve`, { roles: [] }), t.deps))).toContain('Only Bot Admins');
    for (const bad of ['spendovr:xyz:approve', `spendovr:${ID}:delete`, `spendovr:${ID.toUpperCase()}:approve`, `spendovr:${ID}`, `spendovr:${ID}:approve:x`])
      expect(text(await handleInteraction(button(bad), t.deps)), bad).toContain('Unknown action');
    expect(f.decided).toEqual([]);
  });

  it('spendovr is not in the early admincfg or category-room branches: an off-channel click is refused by the guard', async () => {
    const t = await makeDeps();
    t.deps.spend = spendFake().spend;
    const r = await handleInteraction(button(`spendovr:${ID}:approve`, { channelId: '1570000000000000555' }), t.deps);
    expect(text(r)).toContain('Use this in #⚙️-setting');
  });
});

describe('SPEND-1 S8 and S19: /budget dept and the spend.* settings', () => {
  it('/budget dept sets the cap, ends this month\'s raises (audited by the service), closes their cards and shows the cap now enforced', async () => {
    const t = await makeDeps();
    const f = spendFake();
    const closed: unknown[] = [];
    t.deps.spend = f.spend;
    t.deps.cards = { close: async (...a) => { closed.push(a); } };
    const r = await handleInteraction(cmd('budget', 'dept', { strings: { dept: 'hq' }, numbers: { usd: 100 } }), t.deps);
    expect(t.deps.cfg.get('spend.deptMonthlyUsd')).toEqual({ hq: 100 });
    expect(f.superseded).toEqual([['hq', 'u1']]);
    expect(closed).toHaveLength(1);
    expect(text(r)).toContain('Enforced now: $42.00');
    expect(text(r)).toContain('2 raise override');
    expect(t.audits.at(-1)).toMatchObject({ action: 'config.set', tool: 'spend.deptMonthlyUsd[hq]', outcome: 'ok' });
    // clear
    const c = await handleInteraction(cmd('budget', 'dept', { strings: { dept: 'hq' }, bools: { clear: true } }), t.deps);
    expect(t.deps.cfg.get('spend.deptMonthlyUsd')).toEqual({});
    expect(text(c)).toContain('(none)');
    expect(f.superseded).toHaveLength(2);
  });

  it('/budget dept refuses both or neither of usd and clear, an unknown department and an out-of-range figure', async () => {
    const t = await makeDeps();
    t.deps.spend = spendFake().spend;
    expect(text(await handleInteraction(cmd('budget', 'dept', { strings: { dept: 'hq' } }), t.deps))).toContain('usd or clear');
    expect(text(await handleInteraction(cmd('budget', 'dept', { strings: { dept: 'hq' }, numbers: { usd: 5 }, bools: { clear: true } }), t.deps))).toContain('usd or clear');
    expect(text(await handleInteraction(cmd('budget', 'dept', { strings: { dept: 'nope' }, numbers: { usd: 5 } }), t.deps))).toContain('Unknown department');
    for (const usd of [-1, 1_000_000, Number.NaN, Number.POSITIVE_INFINITY, 1e308])
      expect(text(await handleInteraction(cmd('budget', 'dept', { strings: { dept: 'hq' }, numbers: { usd } }), t.deps)), String(usd)).toMatch(/between 0 and|usd or clear/);
    expect(t.sets).toHaveLength(0);
  });

  it('a non-admin /budget dept is refused by the guard', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(cmd('budget', 'dept', { strings: { dept: 'hq' }, numbers: { usd: 5 }, roles: [] }), t.deps))).toContain('Only Bot Admins');
    expect(t.sets).toHaveLength(0);
  });

  it('/settings set spend.deptMonthlyUsd <dept> <usd|none> is the same plan, and raising or clearing a cap posts the risk notice', async () => {
    const notices: string[] = [];
    const t = await makeDeps({ settings: { notice: async (x) => void notices.push(x), channels: async () => [] } });
    const f = spendFake();
    t.deps.spend = f.spend;
    await handleInteraction(settings('spend.deptMonthlyUsd', 'hq 50'), t.deps);
    expect(t.deps.cfg.get('spend.deptMonthlyUsd')).toEqual({ hq: 50 });
    expect(notices).toHaveLength(0); // a new cap tightens
    await handleInteraction(settings('spend.deptMonthlyUsd', 'hq 20'), t.deps);
    expect(notices).toHaveLength(0); // lowered: no notice
    await handleInteraction(settings('spend.deptMonthlyUsd', 'hq 60'), t.deps);
    expect(notices).toHaveLength(1); // raised
    await handleInteraction(settings('spend.deptMonthlyUsd', 'hq none'), t.deps);
    expect(notices).toHaveLength(2); // cleared
    expect(f.superseded).toHaveLength(4);
    expect(text(await handleInteraction(settings('spend.deptMonthlyUsd', 'hq'), t.deps))).toContain('<dept> <usd|none>');
    expect(text(await handleInteraction(settings('spend.deptMonthlyUsd', 'hq abc'), t.deps))).toContain('Invalid');
  });

  it('every scalar spend.* key rejects NaN, Infinity, 1e308, negatives and out-of-range values, and accepts a valid one', async () => {
    const t = await makeDeps();
    const bad: Record<string, string[]> = {
      'spend.warnPct': ['NaN', 'Infinity', '1e308', '-5', '49', '100', '80.5'],
      'spend.anomalyMultiplier': ['NaN', 'Infinity', '1e308', '-1', '1.4', '21'],
      'spend.anomalyMinUsd': ['NaN', 'Infinity', '1e308', '-1', '0.04', '1001'],
      'spend.alertsEnabled': ['NaN', 'maybe', '1'],
      'spend.weeklySummary': ['NaN', 'maybe', '0'],
      'spend.weeklySummaryTime': ['9:00', '24:00', '09:60', 'NaN', '09:00:00'],
      'spend.overrideStepPct': ['NaN', 'Infinity', '1e308', '-1', '4', '101'],
      'spend.retentionDays': ['NaN', 'Infinity', '1e308', '-1', '89', '1831'],
    };
    for (const [key, values] of Object.entries(bad))
      for (const v of values) {
        const r = await handleInteraction(settings(key, v), t.deps);
        expect(text(r), `${key}=${v}`).toMatch(/Invalid value|No change/);
      }
    expect(t.sets).toHaveLength(0);
    for (const [key, v, want] of [['spend.warnPct', '90', 90], ['spend.anomalyMultiplier', '4.5', 4.5], ['spend.anomalyMinUsd', '1', 1], ['spend.alertsEnabled', 'false', false], ['spend.weeklySummary', 'false', false], ['spend.weeklySummaryTime', '08:30', '08:30'], ['spend.overrideStepPct', '50', 50], ['spend.retentionDays', '120', 120]] as const) {
      await handleInteraction(settings(key, v), t.deps);
      expect(t.deps.cfg.get(key), key).toEqual(want);
    }
  });

  it('S19: only loosening changes post the risk notice (raised thresholds and step, switched off alerts, shortened retention, timezone)', async () => {
    const notices: string[] = [];
    const t = await makeDeps({ settings: { notice: async (x) => void notices.push(x), channels: async () => [] } });
    const go = async (k: string, v: string) => { const n = notices.length; await handleInteraction(settings(k, v), t.deps); return notices.length - n; };
    expect(await go('spend.warnPct', '70')).toBe(0); // lowered: earlier warning
    expect(await go('spend.warnPct', '90')).toBe(1);
    expect(await go('spend.anomalyMultiplier', '2')).toBe(0);
    expect(await go('spend.anomalyMultiplier', '5')).toBe(1);
    expect(await go('spend.anomalyMinUsd', '0.1')).toBe(0);
    expect(await go('spend.anomalyMinUsd', '2')).toBe(1);
    expect(await go('spend.overrideStepPct', '10')).toBe(0);
    expect(await go('spend.overrideStepPct', '60')).toBe(1);
    expect(await go('spend.retentionDays', '500')).toBe(0);
    expect(await go('spend.retentionDays', '100')).toBe(1);
    expect(await go('spend.alertsEnabled', 'false')).toBe(1);
    expect(await go('spend.alertsEnabled', 'true')).toBe(0);
    expect(await go('spend.weeklySummary', 'false')).toBe(1);
    expect(await go('spend.weeklySummaryTime', '10:00')).toBe(0);
    // SP-09: a timezone change is risky (it moves the department month)
    expect(configRisk('schedule.timezone', 'Asia/Bangkok', 'UTC')).toBe(true);
    expect(configRisk('schedule.timezone', 'UTC', 'UTC')).toBe(false);
    expect(await go('schedule.timezone', 'UTC')).toBe(1);
    expect(notices.every((n) => n.includes('<@u1>'))).toBe(true);
  });
});

describe('SPEND-1 S16: /usage trend and the " (UTC)" titles', () => {
  const rows = (): TrendRow[] => {
    const out: TrendRow[] = [];
    for (let d = 0; d < 30; d++)
      for (const dept of ['hq', 'rnd', 'software', 'it', 'marketing', 'sales', 'hr', 'finance', 'ops', 'praw', '_unattributed', '_company_x'])
        for (const provider of ['gemini', 'claude', 'claude-code-local', 'p4', 'p5'])
          out.push({ day: `2026-11-${String(Math.min(d + 1, 28)).padStart(2, '0')}`, deptId: dept, provider: `${provider}${'x'.repeat(40)}`, tool: `tool_${d}_${dept}`.slice(0, 40), usd: 1 + d, calls: 1 });
    return out;
  };

  it('is a Bot-Admin configReply embed with at most 25 fields, each value at most 1024 and the whole at most 6000, for every grouping', async () => {
    const t = await makeDeps();
    for (const by of ['dept', 'provider', 'tool'] as const) {
      t.deps.spend = spendFake({ report: async (b) => buildReport({ rows: rows(), today: '2026-11-28', by: b, budgets: [{ dept: 'hq', mtd: 5, cap: 10 }], roots: [{ rootId: 'f'.repeat(32), deptId: 'hq', usd: 9 }] }) }).spend;
      const i = cmd('usage', null, { strings: { range: 'trend', by } });
      const r = await handleInteraction(i, t.deps);
      expect(i.deferred).toEqual({ ephemeral: false }); // an admin card in #⚙️-setting, not a private reply
      const embeds = r!.embeds!;
      expect(embeds[0]!.title).toBe('Spend trend');
      const fields = embeds.flatMap((e) => e.fields ?? []);
      expect(fields.length).toBeLessThanOrEqual(25);
      expect(fields.length).toBeGreaterThan(3);
      expect(fields.every((f) => f.value.length <= 1024)).toBe(true);
      const total = embeds.reduce((n, e) => n + (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.fields ?? []).reduce((m, f) => m + f.name.length + f.value.length, 0), 0);
      expect(total).toBeLessThanOrEqual(6000);
      expect(r!.ephemeral).toBe(false);
    }
  });

  it('a non-admin or off-channel /usage trend is refused', async () => {
    const t = await makeDeps();
    t.deps.spend = spendFake().spend;
    expect(text(await handleInteraction(cmd('usage', null, { strings: { range: 'trend' }, roles: [] }), t.deps))).toContain('Only Bot Admins');
    expect(text(await handleInteraction(cmd('usage', null, { strings: { range: 'trend' }, channelId: '999' }), t.deps))).toContain('#⚙️-setting');
  });

  it('range today and week keep their numbers and gain " (UTC)" in the title; trend without the service says so', async () => {
    const t = await makeDeps();
    expect(JSON.stringify((await handleInteraction(cmd('usage', null, {}), t.deps))!.embeds![0]!.title)).toBe('"Usage today (UTC)"');
    expect(JSON.stringify((await handleInteraction(cmd('usage', null, { strings: { range: 'week' } }), t.deps))!.embeds![0]!.title)).toBe('"Usage last 7 days (UTC)"');
    expect(text(await handleInteraction(cmd('usage', null, { strings: { range: 'trend' } }), t.deps))).toContain('not available');
  });

  it('the usage command offers trend and by', () => {
    const def = COMMANDS.find((c) => c.name === 'usage')!;
    const range = def.options!.find((o) => o.name === 'range') as unknown as { choices: { value: string }[] };
    expect(range.choices.map((c) => c.value)).toEqual(['today', 'week', 'quota', 'trend']);
    const by = def.options!.find((o) => o.name === 'by') as unknown as { choices: { value: string }[] };
    expect(by.choices.map((c) => c.value)).toEqual(['dept', 'provider', 'tool']);
  });
});

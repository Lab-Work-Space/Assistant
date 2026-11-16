import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { allowLoopbackForTest } from '../vitest.setup.no-network.js';
import { isAdminConfigKey } from '../admin/keys.js';
import type { SpendView } from '../governance/spend/spend.js';
import { http, rig } from './test-helpers.js';

beforeAll(allowLoopbackForTest);
let x: Awaited<ReturnType<typeof rig>> | null = null;
afterEach(async () => { await x?.close(); x = null; });

const view = (over: Partial<SpendView> = {}): SpendView => ({
  today: '2026-11-08',
  days: [{ day: '2026-11-07', deptId: 'hq', usd: 1.5 }, { day: '2026-11-08', deptId: 'hq', usd: 2 }, { day: '2026-11-08', deptId: 'rnd', usd: 0.25 }],
  providers: [{ provider: 'gemini', usd: 3.5 }],
  tools: [{ tool: 'image_generate', usd: 3.5 }],
  budgets: [{ dept: 'hq', mtd: 3.5, cap: 12.5, raisedFrom: 10 }],
  overrides: [{ dept: 'hq', month: '2026-11', oldCap: 10, newCap: 12.5, status: 'approved', expiresAt: '2026-11-09T05:00:00.000Z' }],
  alerts: [{ period: '2026-11', kind: 'warn', scope: 'hq', posted: true, attempts: 1, summary: 'pct=85 spentUsd=8.5' }],
  ...over,
});

describe('SPEND-1 S17: the dashboard /spend page', () => {
  it('needs a session like /audit (no session: the sign-in page, no data)', async () => {
    x = await rig({ data: { spend: async () => view() } });
    const r = await http(x.port, { path: '/spend' });
    expect(r.status).toBe(401);
    expect(r.body).not.toContain('gemini');
    expect((await http(x.port, { path: '/audit' })).status).toBe(401);
  });

  it('shows the day x department table, provider and tool totals, budgets, overrides and alerts, read only', async () => {
    x = await rig({ data: { spend: async () => view() } });
    const s = await x.login();
    const r = await http(x.port, { path: '/spend', headers: { cookie: s.cookie } });
    expect(r.status).toBe(200);
    for (const t of ['2026-11-08', '$2.00', 'gemini', 'image_generate', '$12.50', 'raised from $10.00', 'approved', 'pct=85 spentUsd=8.5']) expect(r.body, t).toContain(t);
    expect(r.body).not.toMatch(/<form[^>]*action="\/spend/i); // the only forms are the layout's logout; this page has none of its own
    expect(r.body.slice(r.body.indexOf('Last 30 days'))).not.toMatch(/<form|<script|<input|<button/i);
    expect(r.body).toMatch(/href="\/spend"/); // in the navigation
  });

  it('escapes every string: a script in a provider, tool, scope or alert summary renders as text', async () => {
    const bad = '<script>alert(1)</script>';
    x = await rig({ data: { spend: async () => view({ providers: [{ provider: bad, usd: 1 }], tools: [{ tool: '"><img src=x onerror=alert(1)>', usd: 1 }], days: [{ day: '2026-11-08', deptId: bad, usd: 1 }], budgets: [{ dept: bad, mtd: 1, cap: 2 }], alerts: [{ period: bad, kind: bad, scope: bad, posted: false, attempts: 3, summary: bad }] }) } });
    const s = await x.login();
    const r = await http(x.port, { path: '/spend', headers: { cookie: s.cookie } });
    expect(r.status).toBe(200);
    expect(r.body).not.toContain('<script>alert(1)</script>');
    expect(r.body).not.toContain('<img src=x');
    expect(r.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('POST /spend is refused (no write route), with or without a valid csrf token', async () => {
    x = await rig({ data: { spend: async () => view() } });
    const s = await x.login();
    expect((await x.post('/spend', { _csrf: s.csrf, dept: 'hq', usd: '5' }, { cookie: s.cookie })).status).toBe(404);
    expect((await x.post('/spend', { dept: 'hq' }, { cookie: s.cookie })).status).toBe(403);
    expect(x.proposals).toEqual([]);
    expect(x.applied).toEqual([]);
  });

  it('S1: /propose has no action for a spend.* key: a posted config key or op is refused (422) and nothing is proposed', async () => {
    x = await rig({ data: { spend: async () => view() } });
    const s = await x.login();
    const forms: Record<string, string>[] = [{ action: 'config_set', f_key: 'spend.warnPct', f_value: '99' }, { action: 'spend_set', f_dept: 'hq', f_usd: '999' }, { action: 'budget_set', f_scope: 'dept', f_usd: '5' }, { action: 'budget_dept', f_dept: 'hq', f_usd: '5' }];
    for (const f of forms)
      expect((await x.post('/propose', { _csrf: s.csrf, ...f }, { cookie: s.cookie })).status, JSON.stringify(f)).toBe(422);
    expect(x.proposals).toEqual([]);
  });

  it('without the spend service the page says it is unavailable; /propose never offers a spend.* key', async () => {
    x = await rig();
    const s = await x.login();
    expect((await http(x.port, { path: '/spend', headers: { cookie: s.cookie } })).body).toContain('not available in this process');
    const p = await http(x.port, { path: '/propose', headers: { cookie: s.cookie } });
    expect(p.body).not.toContain('spend.');
    for (const k of ['spend.deptMonthlyUsd', 'spend.warnPct', 'spend.alertsEnabled']) expect(isAdminConfigKey(k)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { AdminOp } from './ops.js';
import { PermOp } from '../discord/perm/perm-ops.js';
import { SettingsRegistry, SECTIONS, builtinActions, type Built } from './settings.js';

const reg = () => new SettingsRegistry();
const ok = (b: ReturnType<SettingsRegistry['build']>): Built => { if (!b.ok) throw new Error(b.error); return b; };

describe('SPEND-1 S1: no settings action reaches a spend.* key or a department budget', () => {
  it('no action builds a spend op, the budget_set op stays daily|bot|task, and dept is refused', () => {
    const r = reg();
    for (const id of ['budget_dept', 'spend_set', 'spend_override', 'dept_budget']) expect(r.build(id, { dept: 'hq', usd: '5' }).ok, id).toBe(false);
    expect(r.build('budget_set', { scope: 'dept', usd: '5' }).ok).toBe(false);
    expect(AdminOp.safeParse({ op: 'budget_set', scope: 'dept', usd: 5 }).success).toBe(false);
    expect(JSON.stringify(SECTIONS)).not.toMatch(/spend\./);
    expect(Object.keys(builtinActions ?? {}).join(' ')).not.toMatch(/spend/);
  });
});

describe('settings actions (S37c: every field is parsed by code into the existing structured op)', () => {
  it('builds ops that the real AdminOp schema accepts', () => {
    const r = reg();
    const cases: [string, Record<string, string>][] = [
      ['holiday_add', { date: '2026-12-31', name: 'NYE' }], ['holiday_remove', { date: '2026-12-31' }], ['holiday_weekdays', { days: 'sat,sun' }],
      ['budget_set', { scope: 'daily', usd: '3.5' }], ['limits_set', { limit: 'turns', value: '12' }], ['approval_set', { usd: '2' }],
      ['bot_toggle', { dept: 'hr', enabled: 'off' }], ['bot_model', { dept: 'hr', provider: 'claude', model: 'm' }],
      ['channel_map', { channel: '700000000000000001', dept: 'hr', work: 'yes' }], ['channel_unmap', { channel: '700000000000000001' }],
    ];
    for (const [id, v] of cases) {
      const b = ok(r.build(id, v));
      expect(b.kind, id).toBe('admin_op');
      expect(AdminOp.safeParse(b.raw).success, id).toBe(true);
    }
  });

  it('builds perm ops that the real PermOp schema accepts', () => {
    const r = reg();
    const cases: [string, Record<string, string>][] = [
      ['perm_role_assign', { member: '700000000000000001', role: '700000000000000002' }],
      ['perm_role_remove', { member: '700000000000000001', role: '700000000000000002' }],
      ['perm_channel_create', { name: 'new', category: '', type: 'text', sync: 'yes' }],
      ['perm_overwrite_clear', { channel: '700000000000000001', targetType: 'role', target: '700000000000000002' }],
      ['perm_overwrite_set', { channel: '700000000000000001', targetType: 'member', target: '700000000000000002', allow: '1024', deny: '0' }],
    ];
    for (const [id, v] of cases) {
      const b = ok(r.build(id, v));
      expect(b.kind, id).toBe('perm');
      expect(PermOp.safeParse((b.raw as unknown[])[0]).success, id).toBe(true);
    }
  });

  it('refuses out-of-range, unknown and malformed input before anything is proposed', () => {
    const r = reg();
    const bad: [string, Record<string, string>][] = [
      ['budget_set', { scope: 'daily', usd: 'abc' }], ['budget_set', { scope: 'daily', usd: '1e400' }], ['budget_set', { scope: 'nope', usd: '1' }],
      ['limits_set', { limit: 'turns', value: '-1' }], ['limits_set', { limit: 'zzz', value: '1' }],
      ['bot_toggle', { dept: 'nope', enabled: 'on' }], ['bot_toggle', { dept: 'hr', enabled: 'maybe' }],
      ['channel_map', { channel: '12', dept: 'hr', work: 'no' }], ['perm_role_assign', { member: 'x', role: '1' }],
      ['perm_overwrite_set', { channel: '700000000000000001', targetType: 'role', target: '700000000000000002', allow: '-1', deny: '0' }],
      ['holiday_add', { date: '2026-12-31', name: 'x'.repeat(500) }], ['nope', {}],
    ];
    for (const [id, v] of bad) expect(r.build(id, v).ok, `${id} ${JSON.stringify(v)}`).toBe(false);
  });

  it('a modal fits Discord: at most 5 inputs, each under 4000 characters', () => {
    for (const a of builtinActions()) {
      expect(a.fields.length, a.id).toBeLessThanOrEqual(5);
      for (const f of a.fields) expect(f.maxLength, `${a.id}.${f.id}`).toBeLessThanOrEqual(4000);
    }
  });

  it('Discord limits: modal titles and input labels fit in 45 characters (nothing is cut silently)', () => {
    for (const a of builtinActions()) {
      expect(a.label.length, a.id).toBeLessThanOrEqual(45);
      for (const f of a.fields) expect(f.label.length, `${a.id}.${f.id}`).toBeLessThanOrEqual(45);
    }
  });

  it('halted, provider add and secrets are not actions', () => {
    const ids = builtinActions().map((a) => a.id);
    for (const id of ids) expect(id).not.toMatch(/halt|provider_add|secret|token|key/);
  });
});

describe('capabilities: server-management sections wait for the merge', () => {
  it('the server family is unavailable until a handler is registered; its actions say so and never build', async () => {
    const r = reg();
    const caps = await r.capabilities();
    expect(caps.server).toBe('available after server management is enabled');
    const welcome = r.action('welcome_set')!;
    expect(welcome.family).toBe('server');
    expect(r.build('welcome_set', {})).toEqual({ ok: false, error: 'available after server management is enabled' });
    expect(SECTIONS.map((s) => s.id)).toEqual(['holidays', 'budget', 'bots', 'channels', 'welcome', 'automod', 'permissions', 'server', 'moderation']);
  });

  it('after a family handler registers, its action builds and proposes through that handler', async () => {
    const r = reg();
    const seen: unknown[] = [];
    r.registerFamily('server', { available: async () => null, propose: async (_w, kind, raw) => { seen.push([kind, raw]); return { ok: true, text: 't', cardId: 'c' }; } });
    r.addActions([{ id: 'welcome_set', section: 'welcome', family: 'server', label: 'Welcome', fields: [], build: () => ({ ok: true, kind: 'server', raw: { x: 1 } }) }]);
    expect((await r.capabilities()).server).toBeNull();
    const b = ok(r.build('welcome_set', {}));
    expect(await r.propose({ userId: 'u', tainted: false, via: 'panel' }, b)).toEqual({ ok: true, text: 't', cardId: 'c' });
    expect(seen).toEqual([['server', { x: 1 }]]);
  });

  it('an unavailable family refuses to propose', async () => {
    const r = reg();
    expect(await r.propose({ userId: 'u', tainted: false }, { ok: true, kind: 'server', raw: {} })).toMatchObject({ ok: false });
  });
});

describe('C11 / S37d: panel and dashboard proposals share the per-admin cap', () => {
  it('slots are taken once per proposal across front ends; over the cap is refused before the console and audited', async () => {
    const taken: string[] = [];
    const audits: unknown[] = [];
    let left = 2;
    const r = new SettingsRegistry({ takeSlot: (u) => { taken.push(u); return left-- > 0; }, audit: async (e) => void audits.push(e) });
    const seen: unknown[] = [];
    r.registerFamily('admin_op', { available: async () => null, propose: async (w) => { seen.push(w); return { ok: true, text: 't' }; } });
    const b = ok(r.build('approval_set', { usd: '2' }));
    expect((await r.propose({ userId: 'u1', tainted: false, via: 'panel' }, b)).ok).toBe(true);
    expect((await r.propose({ userId: 'u1', tainted: false, via: 'dashboard' }, b)).ok).toBe(true);
    const third = await r.propose({ userId: 'u1', tainted: false, via: 'panel' }, b);
    expect(third).toMatchObject({ ok: false, error: expect.stringContaining('limit') });
    expect(seen).toHaveLength(2);
    expect(taken).toEqual(['u1', 'u1', 'u1']);
    expect(audits).toEqual([expect.objectContaining({ actor: 'user:u1 via panel', outcome: 'refused: proposal cap' })]);
  });
});

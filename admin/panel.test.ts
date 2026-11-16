import { beforeEach, describe, expect, it } from 'vitest';
import type { PanelPayload, PanelPort } from '../discord/panel-port.js';
import { handlePrawInteraction } from '../discord/praw/commands.js';
import { ADMIN_ROLE, GUILD, interaction, type Call } from '../discord/commands/test-helpers.js';
import { CONFIG_CHANNEL_ID, type Reply } from '../discord/commands/types.js';
import { handleInteraction } from '../discord/commands/index.js';
import { makeDeps } from '../discord/commands/test-helpers.js';
import { SERVER_OFF, SettingsRegistry } from './settings.js';
import { ADMIN_READ_KEYS } from './keys.js';
import { PANEL_LIVE_KEYS, SettingsPanel } from './panel.js';

const HQ = '800000000000000001';
const ADMIN = '900000000000000001';
const PANEL_MSG = '555000000000000001';

class FakePort implements PanelPort {
  posts: PanelPayload[] = [];
  edits: { id: string; p: PanelPayload }[] = [];
  pins: string[] = [];
  next = 'ok' as 'ok' | 'missing' | 'error';
  author = HQ;
  failEdit = false;
  seq = 0;
  async fetch() { return this.next === 'ok' ? { state: 'ok' as const, authorId: this.author } : { state: this.next }; }
  async post(_c: string, p: PanelPayload) { this.posts.push(p); return `66600000000000000${++this.seq}`; }
  async edit(_c: string, id: string, p: PanelPayload) { if (this.failEdit) throw new Error('boom'); this.edits.push({ id, p }); }
  async pin(_c: string, id: string) { this.pins.push(id); }
}

async function rig(over: { stored?: boolean; values?: () => { name: string; value: unknown }[] } = {}) {
  const t = await makeDeps();
  const port = new FakePort();
  const settings = new SettingsRegistry();
  const proposed: { who: unknown; kind: string; raw: unknown }[] = [];
  const ok = async () => null;
  const propose = async (who: unknown, kind: string, raw: unknown) => { proposed.push({ who, kind, raw }); return { ok: true as const, text: 'internal text for the model', cardId: 'c'.repeat(32) }; };
  settings.registerFamily('admin_op', { available: ok, propose: propose as never });
  settings.registerFamily('perm', { available: async () => 'permission operations are off: test', propose: propose as never });
  let state: { channelId: string; messageId: string; postedAt: Date } | null = over.stored === false ? null : { channelId: CONFIG_CHANNEL_ID, messageId: PANEL_MSG, postedAt: new Date(0) };
  let clock = 1_000_000_000_000;
  const errors: unknown[] = [];
  const audits: Record<string, unknown>[] = [];
  const panel = new SettingsPanel({
    guildId: GUILD, adminRoleId: ADMIN_ROLE, settings, cfg: t.deps.cfg, port, hqUserId: () => HQ,
    state: { get: async () => state, set: async (channelId, messageId) => { state = { channelId, messageId, postedAt: new Date(clock) }; } },
    bots: () => 'hr, it (off)', ...(over.values ? { values: over.values } : {}), audit: async (e) => void audits.push(e as never), log: { error: (o) => void errors.push(o), info: () => undefined }, now: () => clock,
  });
  t.deps.panel = panel;
  const click = (c: Call) => handleInteraction(interaction({ userId: ADMIN, messageId: PANEL_MSG, messageAuthorId: HQ, ...c }), t.deps);
  return { t, port, panel, proposed, click, errors, audits, state: () => state, tick: (ms: number) => { clock += ms; } };
}

const text = (r: Reply | null) => (r?.content ?? '') + JSON.stringify(r?.embeds ?? []);

// A select-menu interaction is a button-like fake with values.
function select(value: string, c: Call = {}) {
  const i = interaction({ kind: 'button', customId: 'panel:all:pick', userId: ADMIN, messageId: PANEL_MSG, messageAuthorId: HQ, ...c });
  return Object.assign(i, { isButton: () => false, isStringSelectMenu: () => true, values: [value] });
}
const submit = (action: string, section: string, fields: Record<string, string>, c: Call = {}) =>
  interaction({ kind: 'modal', customId: `panel:${section}:${action}`, fields, userId: ADMIN, messageId: PANEL_MSG, messageAuthorId: HQ, ...c });

describe('settings panel: render (S37e)', () => {
  it('shows only code-chosen live values, hides a masked one, and is at most 5 rows with no more than 25 options each', async () => {
    const x = await rig();
    await x.t.deps.cfg.set('budget.taskUsd', 2, 'test');
    const p = await x.panel.render();
    const body = JSON.stringify(p.embeds);
    expect(body).toContain('budget');
    expect(body).toContain('hr, it');
    expect(p.components.length).toBeLessThanOrEqual(5);
    for (const row of p.components) for (const c of (row.components as { options?: unknown[] }[])) expect((c.options ?? []).length).toBeLessThanOrEqual(25);
    const ids = p.components.flatMap((r) => r.components.map((c) => (c as { custom_id: string }).custom_id));
    expect(ids.every((id) => /^panel:[a-z]+:[a-z_]+$/.test(id))).toBe(true);
  });

  it('a value the masker would change is shown as (hidden)', async () => {
    const x = await rig({ values: () => [{ name: 'k', value: 'sk-ant-abcdefgh12345678' }, { name: 'n', value: 4 }] });
    const p = await x.panel.render();
    expect(JSON.stringify(p.embeds)).not.toContain('sk-ant');
    expect(JSON.stringify(p.embeds)).toContain('(hidden)');
    expect(JSON.stringify(p.embeds)).toContain('4');
  });
});

describe('settings panel: scope (S37e)', () => {
  it('the live values come only from ADMIN_READ_KEYS', () => {
    for (const k of PANEL_LIVE_KEYS) expect(ADMIN_READ_KEYS as readonly string[], k).toContain(k);
    expect(['schedule.holidays', ...PANEL_LIVE_KEYS]).not.toContain('halted');
    expect(PANEL_LIVE_KEYS.filter((k) => k.startsWith('spend.'))).toEqual([]); // SPEND-1 S1: no spend.* key on the panel
  });
});

describe('settings panel: clicks (S37a, S37b)', () => {
  it('a select opens a modal from the action fields; nothing is written', async () => {
    const x = await rig();
    const i = select('holiday_add');
    const out = await handleInteraction(i, x.t.deps);
    expect(out).toBeNull();
    expect(i.modals[0]).toMatchObject({ customId: 'panel:holidays:holiday_add' });
    expect(i.deferred).toBeNull(); // a modal cannot follow a deferral
    expect(i.modals[0]!.inputs.map((f) => f.id)).toEqual(['date', 'name']);
    expect(x.proposed).toEqual([]);
  });

  it('refuses a non-admin, another channel, another guild, an old panel message id, and an hq approval card carrying a panel: id', async () => {
    const x = await rig();
    const cases: [string, Call][] = [
      ['Only Bot Admins', { roles: [] }], ['#', { channelId: '123' }], ['Panel', { messageId: '555000000000000099' }], ['Panel', { messageAuthorId: '1' }], ['Panel', { messageId: null }],
    ];
    for (const [needle, c] of cases) {
      const i = select('holiday_add', c);
      await handleInteraction(i, x.t.deps);
      expect(text(i.replies[0] ?? null), JSON.stringify(c)).toContain(needle);
      expect(i.modals).toEqual([]);
    }
    const other = select('holiday_add', { guildId: 'other' });
    expect(await handleInteraction(other, x.t.deps)).toBeNull();
    expect(other.replies).toEqual([]);
    // a modal submit from a different message is refused too, with nothing proposed
    const s = submit('holiday_add', 'holidays', { date: '2026-12-31', name: '' }, { messageId: '555000000000000099' });
    await handleInteraction(s, x.t.deps);
    expect(x.proposed).toEqual([]);
  });

  it('when no panel message is stored every panel: interaction is refused', async () => {
    const x = await rig({ stored: false });
    const i = select('holiday_add');
    await handleInteraction(i, x.t.deps);
    expect(i.modals).toEqual([]);
    expect(text(i.replies[0] ?? null)).toContain('Panel');
  });

  it('a select value that is not in the rendered option set is refused', async () => {
    const x = await rig();
    for (const v of ['nope', 'halt', 'provider_add', '../x', '']) {
      const i = select(v);
      await handleInteraction(i, x.t.deps);
      expect(i.modals, v).toEqual([]);
    }
  });

  it('a server-management action answers "available after server management is enabled" and opens no modal', async () => {
    const x = await rig();
    for (const a of ['welcome_set', 'mod_ban', 'automod_rule']) {
      const i = select(a, { customId: 'panel:srv:pick' });
      await handleInteraction(i, x.t.deps);
      expect(i.modals).toEqual([]);
      expect(text(i.replies[0] ?? null)).toContain(SERVER_OFF);
    }
  });

  it('the permissions section says why when permission ops are off', async () => {
    const x = await rig();
    const i = select('perm_role_assign');
    await handleInteraction(i, x.t.deps);
    expect(i.modals).toEqual([]);
    expect(text(i.replies[0] ?? null)).toContain('permission operations are off');
  });

  it('a panel: interaction on the Praw path changes nothing', async () => {
    const x = await rig();
    const prawDeps = { guildId: GUILD, adminRoleId: ADMIN_ROLE } as never;
    for (const i of [select('holiday_add'), interaction({ kind: 'button', customId: 'panel:all:refresh', userId: ADMIN }), submit('holiday_add', 'holidays', { date: '2026-12-31', name: '' })]) {
      expect(await handlePrawInteraction(i, prawDeps)).toBeNull();
      expect(i.replies).toEqual([]);
    }
    expect(x.proposed).toEqual([]);
  });
});

describe('settings panel: modal submit (S37c, S37d)', () => {
  it('builds the structured op by code and proposes it as the submitter, via the panel, never tainted', async () => {
    const x = await rig();
    const i = submit('budget_set', 'budget', { scope: 'daily', usd: '3' });
    await handleInteraction(i, x.t.deps);
    expect(x.proposed).toEqual([{ who: { userId: ADMIN, tainted: false, via: 'panel' }, kind: 'admin_op', raw: { op: 'budget_set', scope: 'daily', usd: 3 } }]);
    expect(i.deferred).toEqual({ ephemeral: true });
    const reply = text(i.edits[0] ?? null);
    expect(reply).toContain('Confirm');
    expect(reply).not.toContain('internal text for the model');
  });

  it('an out-of-range number, an unknown value and an over-long reason are refused before the console', async () => {
    const x = await rig();
    for (const [a, s, f] of [
      ['budget_set', 'budget', { scope: 'daily', usd: '-1' }], ['budget_set', 'budget', { scope: 'daily', usd: '9'.repeat(30) }], ['bot_toggle', 'bots', { dept: 'zzz', enabled: 'on' }],
      ['holiday_add', 'holidays', { date: '2026-12-31', name: 'x'.repeat(300) }],
    ] as const) {
      const i = submit(a, s, { ...f });
      await handleInteraction(i, x.t.deps);
      expect(text(i.edits[0] ?? null), a).toMatch(/Not proposed/);
    }
    expect(x.proposed).toEqual([]);
  });

  it('a modal id naming an unknown action, a server stub, or the wrong section proposes nothing', async () => {
    const x = await rig();
    for (const [a, s] of [['halt', 'budget'], ['mod_ban', 'moderation'], ['budget_set', 'holidays'], ['budget_set', 'x y']] as const) {
      const i = submit(a, s, { scope: 'daily', usd: '3' });
      await handleInteraction(i, x.t.deps);
    }
    expect(x.proposed).toEqual([]);
  });

  it('never calls the model: the only collaborators are the settings registry and the port', async () => {
    const x = await rig();
    await handleInteraction(submit('bot_model', 'bots', { dept: 'hr', provider: 'claude', model: 'claude-sonnet-5-5' }), x.t.deps);
    expect(x.proposed).toHaveLength(1);
  });
});

describe('settings panel: message lifecycle (S37b, S37e)', () => {
  it('boot with the stored message present refreshes it (an edit, no new post)', async () => {
    const x = await rig();
    await x.panel.ensure();
    expect(x.port.posts).toEqual([]);
    expect(x.port.edits.map((e) => e.id)).toEqual([PANEL_MSG]);
  });

  it('boot with the stored message gone re-posts once, stores the new id, pins it; the old id is then refused', async () => {
    const x = await rig();
    x.port.next = 'missing';
    await x.panel.ensure();
    expect(x.port.posts).toHaveLength(1);
    expect(x.state()!.messageId).toBe('666000000000000001');
    expect(x.port.pins).toEqual(['666000000000000001']);
    const old = select('holiday_add', { messageId: PANEL_MSG });
    await handleInteraction(old, x.t.deps);
    expect(old.modals).toEqual([]);
    const fresh = select('holiday_add', { messageId: '666000000000000001' });
    await handleInteraction(fresh, x.t.deps);
    expect(fresh.modals).toHaveLength(1);
  });

  it('no stored id posts a first panel; a stored message authored by someone else is not trusted', async () => {
    const a = await rig({ stored: false });
    await a.panel.ensure();
    expect(a.port.posts).toHaveLength(1);
    const b = await rig();
    b.port.author = '1';
    await b.panel.ensure();
    expect(b.port.posts).toHaveLength(1);
  });

  it('an unknown fetch error never re-posts; a failed edit is logged and never loops; re-posts are at most one per 10 minutes', async () => {
    const x = await rig();
    x.port.next = 'error';
    await x.panel.ensure();
    expect(x.port.posts).toEqual([]);
    x.port.next = 'missing';
    await x.panel.ensure();
    expect(x.port.posts).toHaveLength(1);
    await x.panel.ensure();
    await x.panel.ensure();
    expect(x.port.posts).toHaveLength(1); // throttled
    x.tick(10 * 60_000 + 1);
    x.port.next = 'ok';
    x.port.failEdit = true;
    await x.panel.refresh();
    expect(x.port.posts).toHaveLength(1);
    expect(x.errors.length).toBeGreaterThan(0);
  });

  it('Refresh edits the stored message only', async () => {
    const x = await rig();
    const i = interaction({ kind: 'button', customId: 'panel:all:refresh', userId: ADMIN, messageId: PANEL_MSG, messageAuthorId: HQ });
    await handleInteraction(i, x.t.deps);
    await x.panel.idle();
    expect(x.port.edits.map((e) => e.id)).toEqual([PANEL_MSG]);
    expect(i.replies[0]?.ephemeral).toBe(true);
  });

  it('opening a form also edits the message, so the same option can be picked again', async () => {
    const x = await rig();
    await handleInteraction(select('holiday_add'), x.t.deps);
    await x.panel.idle();
    expect(x.port.edits.map((e) => e.id)).toEqual([PANEL_MSG]);
  });
});

beforeEach(() => undefined);

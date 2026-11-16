import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConfigStore } from '../config/store.js';
import { CONFIG_DEFAULTS } from '../config/defaults.js';
import { EventBus, type AppEvents } from '../core/events.js';
import { migrate } from '../db/migrate.js';
import { AdminCardRepo } from '../db/repos/adminCards.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { ADMIN_ROLE, GUILD, makeDeps } from '../discord/commands/test-helpers.js';
import { CONFIG_CHANNEL_ID, type Reply } from '../discord/commands/types.js';
import { FakeDiscordPort } from '../tests/fakes/discordPort.js';
import { LWS, lwsRepo, rig } from '../tools/plugins/github/test-helpers.js';
import { AdminConsole, type Click, type PermPort } from './console.js';

const ADMIN = '900000000000000001';
const OTHER = '900000000000000002';
const HQ = '800000000000000001';

let db: TestDb;
let store: ConfigStore;
beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'), 'up');
});
afterAll(async () => { await store?.close(); await db.close(); });
beforeEach(async () => {
  await store?.close();
  await db.pool.query('TRUNCATE admin_cards RESTART IDENTITY');
  await db.pool.query('DELETE FROM config');
  store = await ConfigStore.open(db.pool, new EventBus<AppEvents>()); // a clean cache per test
});

async function rigUp(over: { perms?: PermPort; afterApply?: () => void; github?: boolean; guildChannels?: { id: string; name: string; parentId: string | null; type: number }[] } = {}) {
  const gh = over.github ? rig({ account: LWS, repos: [lwsRepo('tools', 31), lwsRepo('Labworkspace_backend', 21)] }) : null;
  const t = await makeDeps({ cfg: store as never, ...(gh ? { github: gh.client } : {}) });
  const port = new FakeDiscordPort();
  port.channels = over.guildChannels ?? [{ id: '700000000000000001', name: 'general', parentId: null, type: 0 }];
  const cards = new AdminCardRepo(db.pool);
  const logs: unknown[] = [];
  const records: unknown[] = [];
  const c = new AdminConsole({
    guildId: GUILD, adminRoleId: ADMIN_ROLE, cards, cfg: store, cmd: t.deps, port, audit: t.deps.audit, log: { error: (o) => void logs.push(o) },
    hqUserId: () => HQ, provenance: { record: async (...a) => void records.push(a) }, ...(over.perms ? { perms: over.perms } : {}), ...(over.afterApply ? { afterApply: over.afterApply } : {}),
  });
  const click = (cardId: string, action: 'confirm' | 'cancel', over: Partial<Click> = {}) =>
    c.click({ cardId, action, guildId: GUILD, channelId: CONFIG_CHANNEL_ID, userId: ADMIN, memberRoleIds: [ADMIN_ROLE], messageId: 'msg-1', messageAuthorId: HQ, ...over });
  const lastCard = () => port.posts.at(-1)!;
  const idOf = () => lastCard().payload.adminCardId!;
  return { c, t, port, cards, click, idOf, lastCard, logs, records, gh };
}
const P = { userId: ADMIN, tainted: false };
const body = (r: Reply) => JSON.stringify(r.embeds ?? []) + (r.content ?? '');

describe('config proposals (Gate 1 C1, C8)', () => {
  it('posts one hq card with Confirm/Cancel, stores the validated change, flags a raise with the warning sign, and changes nothing yet', async () => {
    const x = await rigUp();
    const r = await x.c.proposeConfig(P, { changes: [{ key: 'budget.taskUsd', value: 3 }, { key: 'voice.silenceMs', value: 1000 }], note: 'as asked' });
    expect(r.ok).toBe(true);
    expect(x.port.posts).toHaveLength(1);
    expect(x.lastCard().actor).toEqual({ kind: 'head', dept: 'hq' });
    expect(x.lastCard().target).toEqual({ channelId: CONFIG_CHANNEL_ID });
    expect(x.lastCard().payload.adminCardId).toMatch(/^[0-9a-f]{32}$/);
    const f = x.lastCard().payload.fields!;
    expect(f[0]!.name).toBe('⚠ budget.taskUsd'); // raised 0.5 -> 3
    expect(f[0]!.value).toBe('0.5 → 3');
    expect(f[1]!.name).toBe('voice.silenceMs'); // not a raise of spend or reach
    expect(f.at(-1)).toEqual({ name: "Praw's note (not part of the change)", value: 'as asked' });
    expect(store.get('budget.taskUsd')).toBe(CONFIG_DEFAULTS['budget.taskUsd']);
    expect((await x.cards.get(x.idOf()))!.status).toBe('pending');
    expect(x.records).toHaveLength(1); // the card message is recorded as this admin's run output
  });

  it('refuses before any card exists: halted, an unknown key, a handler-guarded key, an invalid value, a duplicate', async () => {
    const x = await rigUp();
    for (const bad of [
      [{ key: 'halted', value: false }], [{ key: 'nope', value: 1 }], [{ key: 'github.repoAllowlist', value: [{ id: 1, fullName: 'a/b' }] }],
      [{ key: 'ocr.autoChannelId', value: '1565715069969502310' }], [{ key: 'tools.byDept', value: {} }], [{ key: 'provider.default', value: { provider: 'x', model: 'y' } }],
      [{ key: 'budget.taskUsd', value: -1 }], [{ key: 'budget.taskUsd', value: 'a lot' }], [{ key: 'budget.taskUsd', value: 1 }, { key: 'budget.taskUsd', value: 2 }],
    ]) {
      const r = await x.c.proposeConfig(P, { changes: bad });
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
    expect(x.port.posts).toEqual([]);
    expect((await db.pool.query('SELECT 1 FROM admin_cards')).rowCount).toBe(0);
  });

  it('SPEND-1 S1: config_propose refuses every spend.* key (they are handler keys), and a spend.* key in a card payload never applies', async () => {
    const x = await rigUp();
    const keys = { 'spend.deptMonthlyUsd': { hq: 999999 }, 'spend.warnPct': 99, 'spend.anomalyMultiplier': 20, 'spend.anomalyMinUsd': 1000, 'spend.alertsEnabled': false, 'spend.weeklySummary': false, 'spend.weeklySummaryTime': '10:00', 'spend.overrideStepPct': 100, 'spend.retentionDays': 90 };
    for (const [key, value] of Object.entries(keys)) {
      const r = await x.c.proposeConfig(P, { changes: [{ key, value }] });
      expect(r.ok, key).toBe(false);
    }
    expect(x.port.posts).toEqual([]);
    expect((await db.pool.query('SELECT 1 FROM admin_cards')).rowCount).toBe(0);
    // the same through admin_op_propose: there is no op for it
    const op = await x.c.proposeOp(P, { op: 'budget_set', scope: 'dept', usd: 5 });
    expect(op.ok).toBe(false);
  });

  it('lowering a price shows the warning sign; raising lessons.promptChars does too', async () => {
    const x = await rigUp();
    const pricing = { ...CONFIG_DEFAULTS.pricing, 'claude-sonnet-5-5': { inPerMTok: 1, outPerMTok: 10, cacheReadPerMTok: 0.2 } };
    await x.c.proposeConfig(P, { changes: [{ key: 'pricing', value: pricing }, { key: 'lessons.promptChars', value: 9000 }] });
    expect(x.lastCard().payload.fields!.map((f) => f.name)).toEqual(['⚠ pricing', '⚠ lessons.promptChars']);
  });

  it('an over-long value is refused, never cut; hidden characters are shown', async () => {
    const x = await rigUp();
    const r = await x.c.proposeConfig(P, { changes: [{ key: 'net.extraPorts', value: [8080] }, { key: 'voice.ttsVoice', value: 'th-TH-NiwatNeural' }] });
    expect(r.ok).toBe(true);
    const big = { ...CONFIG_DEFAULTS.pricing };
    for (let i = 0; i < 40; i++) big[`model-${i}-${'z'.repeat(60)}`] = { inPerMTok: 1, outPerMTok: 1 };
    const refused = await x.c.proposeConfig(P, { changes: [{ key: 'pricing', value: big }] });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('too large') });
    expect(x.port.posts).toHaveLength(1); // only the first, small proposal
  });
});

describe('the click (Gate 1 C5, C6, C7)', () => {
  async function proposed() {
    const x = await rigUp();
    await x.c.proposeConfig(P, { changes: [{ key: 'budget.taskUsd', value: 3 }] });
    const id = x.idOf();
    await x.cards.setMessage(id, 'msg-1');
    return { ...x, id };
  }

  it('Confirm by the proposer applies the stored change in one step, audits it as "user:<id> via praw", closes the card', async () => {
    const x = await proposed();
    const r = await x.click(x.id, 'confirm');
    expect(r.ephemeral).toBe(true);
    expect(store.get('budget.taskUsd')).toBe(3);
    expect((await db.pool.query("SELECT updated_by FROM config WHERE key = 'budget.taskUsd'")).rows[0].updated_by).toBe(`user:${ADMIN} via praw`);
    const audit = x.t.audits.find((a) => (a as { action: string }).action === 'config.set') as { actor: string; tool: string; outcome: string };
    expect(audit).toMatchObject({ actor: `user:${ADMIN} via praw tier:bot_admin`, tool: 'budget.taskUsd' });
    expect(audit.outcome).toContain(`card:${x.id}`);
    expect(audit.outcome).toContain('old=0.5 new=3');
    expect(x.port.closed).toEqual([{ channelId: CONFIG_CHANNEL_ID, messageId: 'msg-1', note: `Confirmed by <@${ADMIN}>: applied.` }]);
    expect((await x.cards.get(x.id))).toMatchObject({ status: 'confirmed', outcome: 'applied' });
    // single use
    expect(body(await x.click(x.id, 'confirm'))).toContain('already used');
    expect(x.t.sets).toEqual([]); // the slash-path set() was never used; the apply is the compare-and-swap
  });

  it('refuses another admin, a click whose role was removed, a wrong message, a message not from hq, a wrong channel or guild; each is audited', async () => {
    const x = await proposed();
    expect(body(await x.click(x.id, 'confirm', { userId: OTHER }))).toContain('Only the admin whose request');
    expect(body(await x.click(x.id, 'confirm', { memberRoleIds: [] }))).toContain('Only Bot Admins');
    expect(body(await x.click(x.id, 'confirm', { messageId: 'msg-other' }))).toContain('does not belong');
    expect(body(await x.click(x.id, 'confirm', { messageAuthorId: '1' }))).toContain('does not belong');
    expect(body(await x.click(x.id, 'confirm', { channelId: '123' }))).toContain('#');
    expect(body(await x.click(x.id, 'confirm', { guildId: 'other' }))).toContain('Not available');
    expect(store.get('budget.taskUsd')).toBe(CONFIG_DEFAULTS['budget.taskUsd']);
    expect((await x.cards.get(x.id))!.status).toBe('pending');
    const refused = x.t.audits.filter((a) => /^refused:/.test((a as { outcome: string }).outcome));
    expect(refused).toHaveLength(6);
    expect(refused.every((a) => (a as { actor: string }).actor.includes(' via praw'))).toBe(true);
  });

  it('a newer proposal supersedes the older card, whose buttons are closed', async () => {
    const x = await proposed();
    await x.c.proposeConfig(P, { changes: [{ key: 'budget.taskUsd', value: 4 }] });
    expect(x.port.closed.map((c) => c.note)).toEqual(['Superseded by a newer proposal.']);
    expect(x.t.audits.some((a) => (a as { action: string; outcome: string }).action === 'admin.card' && (a as { outcome: string }).outcome === `superseded card:${x.id}`)).toBe(true);
    expect(body(await x.click(x.id, 'confirm'))).toContain('newer proposal');
    expect(store.get('budget.taskUsd')).toBe(CONFIG_DEFAULTS['budget.taskUsd']);
  });

  it('expiry is enforced in SQL: a confirm after 15 minutes is refused, audited, and the sweep closes the card', async () => {
    const x = await proposed();
    await db.pool.query(`UPDATE admin_cards SET expires_at = now() - interval '1 second'`);
    expect(body(await x.click(x.id, 'confirm'))).toContain('expired');
    expect(store.get('budget.taskUsd')).toBe(CONFIG_DEFAULTS['budget.taskUsd']);
    expect((await x.cards.get(x.id))!.status).toBe('expired');
    expect(x.port.closed.at(-1)!.note).toContain('Expired');
    expect(x.t.audits.some((a) => (a as { outcome: string }).outcome === `expired card:${x.id}`)).toBe(true);
  });

  it('Cancel changes nothing and is audited', async () => {
    const x = await proposed();
    expect(body(await x.click(x.id, 'cancel'))).toContain('Cancelled');
    expect(store.get('budget.taskUsd')).toBe(CONFIG_DEFAULTS['budget.taskUsd']);
    expect(x.t.audits.some((a) => (a as { outcome: string }).outcome === `cancelled card:${x.id}`)).toBe(true);
    expect(body(await x.click(x.id, 'confirm'))).toContain('already used');
  });

  it('two parallel confirms apply once', async () => {
    const x = await proposed();
    await Promise.all([x.click(x.id, 'confirm'), x.click(x.id, 'confirm')]);
    expect(x.t.audits.filter((a) => (a as { action: string }).action === 'config.set')).toHaveLength(1);
    expect(store.get('budget.taskUsd')).toBe(3);
  });

  it('a value changed by a slash command between propose and confirm refuses the whole card', async () => {
    const x = await rigUp();
    await x.c.proposeConfig(P, { changes: [{ key: 'budget.botDailyUsd', value: 2 }, { key: 'approval.thresholdUsd', value: 5 }] });
    const id = x.idOf();
    await x.cards.setMessage(id, 'msg-1');
    await store.set('approval.thresholdUsd', 9, 'user:slash');
    const r = await x.click(id, 'confirm');
    expect(body(r)).toContain('changed since the proposal');
    expect(store.get('approval.thresholdUsd')).toBe(9);
    expect(store.get('budget.botDailyUsd')).toBe(CONFIG_DEFAULTS['budget.botDailyUsd']); // all or nothing
    expect(x.t.audits.some((a) => /^refused card:/.test((a as { outcome: string }).outcome))).toBe(true);
  });

  it('apply re-validates the stored payload (a tampered row is refused)', async () => {
    const x = await proposed();
    await db.pool.query(`UPDATE admin_cards SET payload = '{"changes":[{"key":"halted","value":false}]}'::jsonb`);
    expect(body(await x.click(x.id, 'confirm'))).toContain('no longer an allowed key');
    await db.pool.query(`UPDATE admin_cards SET status = 'pending', payload = '{"changes":[{"key":"budget.taskUsd","value":-5}]}'::jsonb WHERE id = $1`, [x.id]);
    expect(body(await x.click(x.id, 'confirm'))).toContain('no longer valid');
    expect(store.get('budget.taskUsd')).toBe(CONFIG_DEFAULTS['budget.taskUsd']);
  });

  it('a card that survives a restart keeps its expiry (a fresh console over the same rows)', async () => {
    const x = await proposed();
    const again = new AdminConsole({ guildId: GUILD, adminRoleId: ADMIN_ROLE, cards: new AdminCardRepo(db.pool), cfg: store, cmd: x.t.deps, port: x.port, audit: x.t.deps.audit, log: { error() {} }, hqUserId: () => HQ });
    await db.pool.query(`UPDATE admin_cards SET expires_at = now() - interval '1 second'`);
    expect(await again.sweep()).toBe(1);
    const r = await again.click({ cardId: x.id, action: 'confirm', guildId: GUILD, channelId: CONFIG_CHANNEL_ID, userId: ADMIN, memberRoleIds: [ADMIN_ROLE], messageId: 'msg-1', messageAuthorId: HQ });
    expect(body(r)).toContain('already used');
  });
});

describe('admin operations (Gate 1 C2)', () => {
  it('a denied channel is refused at propose, and a channel that left the guild is refused again at apply', async () => {
    const x = await rigUp();
    for (const id of ['1565715069969502310', '1565649677280485457']) {
      expect(await x.c.proposeOp(P, { op: 'autoocr_channel', channel: id })).toMatchObject({ ok: false, error: 'That channel is off limits.' });
      expect(await x.c.proposeOp(P, { op: 'channel_map', channel: id, dept: 'software' })).toMatchObject({ ok: false });
    }
    expect(await x.c.proposeOp(P, { op: 'autoocr_channel', channel: '700000000000000009' })).toMatchObject({ ok: false, error: expect.stringContaining('not found') });
    expect((await x.c.proposeOp(P, { op: 'autoocr_channel', channel: '700000000000000001' })).ok).toBe(true);
    const id = x.idOf();
    await x.cards.setMessage(id, 'msg-1');
    x.port.channels = []; // the state changed
    expect(body(await x.click(id, 'confirm'))).toContain('not found');
    expect(store.get('ocr.autoChannelId')).toBeNull();
  });

  it('Teamwork D: the console maps a forum to a department, refuses it as a work channel and refuses the goals forum', async () => {
    const forum = { id: '700000000000000050', name: 'ideas', parentId: null, type: 15 };
    const goals = { id: '1565652418383847514', name: 'company-goals', parentId: null, type: 15 };
    const x = await rigUp({ guildChannels: [forum, goals] });
    expect((await x.c.proposeOp(P, { op: 'channel_map', channel: forum.id, dept: 'software' })).ok).toBe(true);
    expect(await x.c.proposeOp(P, { op: 'channel_map', channel: forum.id, dept: 'software', work: true })).toMatchObject({ ok: false, error: expect.stringContaining('forum') });
    expect(await x.c.proposeOp(P, { op: 'channel_map', channel: goals.id, dept: 'software' })).toMatchObject({ ok: false });
  });

  it('confirm applies the op through the same plan, audit action admin.<op>, and the stale check refuses a changed list', async () => {
    const x = await rigUp();
    expect((await x.c.proposeOp(P, { op: 'holiday_add', date: '2026-12-31', name: 'NYE' })).ok).toBe(true);
    const id = x.idOf();
    await x.cards.setMessage(id, 'msg-1');
    await store.set('schedule.holidays', [{ date: '2026-12-25' }], 'user:slash'); // changed after the proposal
    expect(body(await x.click(id, 'confirm'))).toContain('changed since the proposal');
    expect(store.get('schedule.holidays')).toEqual([{ date: '2026-12-25' }]);

    expect((await x.c.proposeOp(P, { op: 'holiday_add', date: '2026-12-31', name: 'NYE' })).ok).toBe(true);
    const id2 = x.idOf();
    await x.cards.setMessage(id2, 'msg-2');
    await x.click(id2, 'confirm', { messageId: 'msg-2' });
    expect(store.get('schedule.holidays')).toEqual([{ date: '2026-12-25' }, { date: '2026-12-31', name: 'NYE' }]);
    expect(x.t.audits.find((a) => (a as { action: string }).action === 'admin.holiday_add')).toMatchObject({ actor: `user:${ADMIN} via praw tier:bot_admin`, tool: '2026-12-31', outcome: expect.stringMatching(/^ok card:[0-9a-f]{32} old=.* new=.*NYE/) });
  });

  it('a hard-denied or foreign GitHub repository is refused at propose; an allowed one needs a click and is flagged', async () => {
    const x = await rigUp({ github: true });
    expect(await x.c.proposeOp(P, { op: 'github_allow', action: 'add', repo: 'Lab-Work-Space/Labworkspace_backend' })).toMatchObject({ ok: false, error: expect.stringMatching(/never allowed/) });
    expect(store.get('github.repoAllowlist')).toEqual([]);
    expect((await x.c.proposeOp(P, { op: 'github_allow', action: 'add', repo: 'Lab-Work-Space/tools' })).ok).toBe(true);
    expect(x.lastCard().payload.fields![0]!.name).toContain('⚠');
    expect(store.get('github.repoAllowlist')).toEqual([]);
  });

  it('a repository that becomes hard-denied after the proposal is refused again at apply', async () => {
    const denied = new Set<number>();
    const repo = { id: 31, fullName: 'Lab-Work-Space/tools', owner: 'Lab-Work-Space' };
    const github = { installationAccount: async () => 'Lab-Work-Space', resolveRepo: async () => repo, deniedIds: async () => denied as ReadonlySet<number> };
    const t = await makeDeps({ cfg: store as never, github: github as never });
    const port = new FakeDiscordPort();
    const cards = new AdminCardRepo(db.pool);
    const c = new AdminConsole({ guildId: GUILD, adminRoleId: ADMIN_ROLE, cards, cfg: store, cmd: t.deps, port, audit: t.deps.audit, log: { error() {} }, hqUserId: () => HQ });
    expect((await c.proposeOp(P, { op: 'github_allow', action: 'add', repo: 'Lab-Work-Space/tools' })).ok).toBe(true);
    const id = port.posts.at(-1)!.payload.adminCardId!;
    await cards.setMessage(id, 'msg-1');
    denied.add(31); // the deploy denylist now resolves to this id
    const r = await c.click({ cardId: id, action: 'confirm', guildId: GUILD, channelId: CONFIG_CHANNEL_ID, userId: ADMIN, memberRoleIds: [ADMIN_ROLE], messageId: 'msg-1', messageAuthorId: HQ });
    expect(body(r)).toMatch(/never allowed/);
    expect(store.get('github.repoAllowlist')).toEqual([]);
    expect(t.audits.some((a) => /^refused card:/.test((a as { outcome: string }).outcome))).toBe(true);
  });

  it('an op outside the set, a bad shape or a bot-set provider id is refused', async () => {
    const x = await rigUp();
    expect((await x.c.proposeOp(P, { op: 'provider_add', provider: 'gemini', key: 'x' })).ok).toBe(false);
    expect((await x.c.proposeOp(P, { op: 'budget_set', scope: 'daily', usd: 'many' })).ok).toBe(false);
    expect((await x.c.proposeOp(P, { op: 'bot_tools', dept: 'software', action: 'add', tool: 'not_registered' })).ok).toBe(false);
    expect((await x.c.proposeOp(P, { op: 'bot_model', dept: 'software', provider: 'claude', model: 'no-price-model' })).ok).toBe(false);
    expect(x.port.posts).toEqual([]);
  });
});

describe('permission cards (Gate 1 Part B through the console)', () => {
  function permRig(over: { ready?: string | null; apply?: PermPort['apply'] } = {}) {
    const calls: { propose: unknown[]; apply: unknown[] } = { propose: [], apply: [] };
    const perms = {
      readiness: async () => (over.ready === undefined ? null : over.ready),
      propose: async (ops: unknown) => (calls.propose.push(ops), {
        ok: true as const, payload: { ops }, snapshot: { snaps: [{ held: false }] },
        items: [{ label: 'Assign role', old: 'does not hold "Staff"', neu: 'holds "Staff"', refs: [{ kind: 'user' as const, id: OTHER }, { kind: 'role' as const, id: '700000000000000005' }] }],
      }),
      apply: over.apply ?? (async (payload: unknown, snapshot: unknown, who: unknown) => (calls.apply.push([payload, snapshot, who]), { kind: 'done' as const, ok: true, applied: 1, total: 1, lines: ['done: Assign role'] })),
      read: async () => ({ ok: true as const, text: '[]' }),
    };
    return { perms, calls };
  }
  const consoleWith = (perms: PermPort) => rigUp({ perms });

  it('a perm card is always flagged, shows live ids, and applies the STORED ops through the permission service on Confirm', async () => {
    const { perms, calls } = permRig();
    const x = await consoleWith(perms as PermPort);
    const ops = [{ kind: 'role.assign', member: OTHER, role: '700000000000000005' }];
    expect((await x.c.proposePerm(P, ops)).ok).toBe(true);
    expect(x.lastCard().payload.title).toContain('Discord permission change');
    expect(x.lastCard().payload.fields![0]).toEqual({ name: '⚠ Assign role', value: `<@${OTHER}> (\`${OTHER}\`) <@&700000000000000005> (\`700000000000000005\`)\ndoes not hold "Staff" → holds "Staff"` });
    expect(calls.apply).toEqual([]);
    const id = x.idOf();
    await x.cards.setMessage(id, 'msg-1');
    const r = await x.click(id, 'confirm');
    expect(body(r)).toContain('Permissions changed');
    expect(calls.apply).toEqual([[{ ops }, { snaps: [{ held: false }] }, { userId: ADMIN, cardId: id, via: 'praw' }]]);
    expect(x.t.audits.some((a) => (a as { outcome: string }).outcome === `applied card:${id}`)).toBe(true);
    expect((await x.cards.get(id))!.outcome).toBe('applied');
  });

  it('while permission ops are off the model gets the reason and no card exists', async () => {
    const { perms } = permRig({ ready: 'the owner constants are not filled in' });
    const x = await consoleWith(perms as PermPort);
    expect(await x.c.proposePerm(P, [])).toEqual({ ok: false, error: 'permission operations are off: the owner constants are not filled in' });
    expect(x.port.posts).toEqual([]);
    const none = await rigUp();
    expect((await none.c.proposePerm(P, [])).ok).toBe(false); // no permission service at all
  });

  it('a limit that now refuses the stored ops refuses the whole card, audited; a partial failure is reported as such', async () => {
    const refused = permRig({ apply: async () => ({ kind: 'refused' as const, why: 'role 7 is at or above Praw\'s own top role' }) });
    const x = await consoleWith(refused.perms as PermPort);
    await x.c.proposePerm(P, [{ kind: 'role.assign', member: OTHER, role: '700000000000000005' }]);
    const id = x.idOf();
    await x.cards.setMessage(id, 'msg-1');
    expect(body(await x.click(id, 'confirm'))).toContain('at or above');
    expect(x.t.audits.some((a) => /^refused card:/.test((a as { outcome: string }).outcome))).toBe(true);

    const partial = permRig({ apply: async () => ({ kind: 'done' as const, ok: false, applied: 1, total: 3, lines: ['done: a', 'FAILED: b (Discord error 50013). The remaining 1 operation(s) were not run.'] }) });
    const y = await consoleWith(partial.perms as PermPort);
    await y.c.proposePerm(P, [{ kind: 'role.assign', member: OTHER, role: '700000000000000005' }]);
    const id2 = y.idOf();
    await y.cards.setMessage(id2, 'msg-1');
    const r = await y.click(id2, 'confirm');
    expect(body(r)).toContain('Stopped at the first failure');
    expect(body(r)).toContain('FAILED: b');
    expect(y.port.closed.at(-1)!.note).toBe(`Confirmed by <@${ADMIN}>: 1 of 3 applied, then stopped.`);
    expect((await y.cards.get(id2))!.outcome).toBe('failed:1/3');
  });
});

describe('Gate 2 follow-ups', () => {
  it('G2A-08: refused proposals are audited', async () => {
    const x = await rigUp();
    await x.c.proposeConfig(P, { changes: [{ key: 'halted', value: false }] });
    await x.c.proposeOp(P, { op: 'autoocr_channel', channel: '1565715069969502310' });
    await x.c.proposePerm(P, []);
    const rows = x.t.audits.filter((a) => (a as { action: string }).action === 'admin.propose') as { actor: string; tool: string; outcome: string }[];
    expect(rows.map((r) => r.tool)).toEqual(['config', 'admin_op', 'perm']);
    expect(rows.every((r) => r.actor === `user:${ADMIN} via praw tier:bot_admin` && r.outcome.startsWith('refused: '))).toBe(true);
  });

  it('G2A-06: an op whose planned items changed since the proposal (same before) is refused at apply', async () => {
    const x = await rigUp({ github: true });
    expect((await x.c.proposeOp(P, { op: 'github_allow', action: 'add', repo: 'Lab-Work-Space/tools' })).ok).toBe(true);
    const id = x.idOf();
    await x.cards.setMessage(id, 'msg-1');
    await db.pool.query(`UPDATE admin_cards SET snapshot = jsonb_set(snapshot, '{items,0,neu}', '"[\\"other/repo#9\\"]"') WHERE id = $1`, [id]);
    expect(body(await x.click(id, 'confirm'))).toContain('changed since the proposal');
    expect(store.get('github.repoAllowlist')).toEqual([]);
  });

  it('G2A-05: a secret-looking value is refused at propose', async () => {
    const x = await rigUp();
    const r = await x.c.proposeConfig(P, { changes: [{ key: 'schedule.timezone', value: 'sk-ant-abcdefgh12345678' }] });
    expect(r.ok).toBe(false);
    expect(x.port.posts).toEqual([]);
  });
});

describe('the after-apply hook (S37e)', () => {
  it('runs after a Discord confirm and after a dashboard Apply, and a throwing hook never fails the apply', async () => {
    let n = 0;
    const x = await rigUp({ afterApply: () => { n++; throw new Error('panel down'); } });
    await x.c.proposeConfig(P, { changes: [{ key: 'budget.taskUsd', value: 3 }] });
    const id = x.idOf();
    await x.cards.setMessage(id, 'msg-1');
    await x.click(id, 'confirm');
    expect(n).toBe(1);
    expect(store.get('budget.taskUsd')).toBe(3);
    const d = (await x.c.proposeConfig({ userId: ADMIN, tainted: false, via: 'dashboard' }, { changes: [{ key: 'budget.taskUsd', value: 4 }] })) as { cardId: string };
    expect(await x.c.applyFromDashboard(d.cardId, ADMIN)).toMatchObject({ ok: true });
    expect(n).toBe(2);
    expect(store.get('budget.taskUsd')).toBe(4);
  });
});

describe('the dashboard path (Gate 1 S46): the same card and apply path, no second writer', () => {
  const D = { userId: ADMIN, tainted: false, via: 'dashboard' as const };

  it('a dashboard proposal posts nothing to Discord, stores an origin=dashboard card, and Apply runs the same CAS and audit as "user:<id> via dashboard"', async () => {
    const x = await rigUp();
    const r = await x.c.proposeConfig(D, { changes: [{ key: 'budget.taskUsd', value: 2 }] });
    expect(r).toMatchObject({ ok: true, cardId: expect.stringMatching(/^[0-9a-f]{32}$/) });
    expect(x.port.posts).toEqual([]);
    const id = (r as { cardId: string }).cardId;
    expect(await x.cards.get(id)).toMatchObject({ origin: 'dashboard', status: 'pending', messageId: null });
    expect(store.get('budget.taskUsd')).toBe(0.5);
    const a = await x.c.applyFromDashboard(id, ADMIN);
    expect(a).toMatchObject({ ok: true, outcome: 'applied' });
    expect(store.get('budget.taskUsd')).toBe(2);
    expect((await db.pool.query("SELECT updated_by FROM config WHERE key = 'budget.taskUsd'")).rows[0].updated_by).toBe(`user:${ADMIN} via dashboard`);
    expect(x.t.audits.some((e) => (e as { action: string; actor: string }).action === 'config.set' && (e as { actor: string }).actor === `user:${ADMIN} via dashboard tier:bot_admin`)).toBe(true);
    expect(await x.c.applyFromDashboard(id, ADMIN)).toMatchObject({ ok: false, why: expect.stringContaining('already used') });
  });

  it('two parallel Applies give one apply; another admin and a Discord-made card are refused', async () => {
    const x = await rigUp();
    const id = ((await x.c.proposeConfig(D, { changes: [{ key: 'budget.taskUsd', value: 2 }] })) as { cardId: string }).cardId;
    expect((await x.c.applyFromDashboard(id, OTHER))).toMatchObject({ ok: false, why: expect.stringContaining('Only the admin') });
    const r = await Promise.all([x.c.applyFromDashboard(id, ADMIN), x.c.applyFromDashboard(id, ADMIN)]);
    expect(r.filter((v) => v.ok)).toHaveLength(1);
    await x.c.proposeConfig(P, { changes: [{ key: 'budget.taskUsd', value: 3 }] });
    const discordId = x.idOf();
    expect(await x.c.applyFromDashboard(discordId, ADMIN)).toMatchObject({ ok: false, why: expect.stringContaining('created in Discord') });
    expect(store.get('budget.taskUsd')).toBe(2);
  });

  it('a state change between propose and apply is refused (compare-and-swap), and a Discord click cannot consume a dashboard card', async () => {
    const x = await rigUp();
    const id = ((await x.c.proposeConfig(D, { changes: [{ key: 'budget.taskUsd', value: 2 }] })) as { cardId: string }).cardId;
    await store.set('budget.taskUsd', 1.5, 'someone');
    expect(await x.c.applyFromDashboard(id, ADMIN)).toMatchObject({ ok: true, outcome: expect.stringContaining('refused') });
    expect(store.get('budget.taskUsd')).toBe(1.5);
    const id2 = ((await x.c.proposeConfig(D, { changes: [{ key: 'budget.taskUsd', value: 2 }] })) as { cardId: string }).cardId;
    expect(body(await x.click(id2, 'confirm', { messageId: null }))).toContain('does not belong');
    expect(store.get('budget.taskUsd')).toBe(1.5);
  });

  it('a refused dashboard proposal is audited with the dashboard actor', async () => {
    const x = await rigUp();
    await x.c.proposeConfig(D, { changes: [{ key: 'halted', value: true }] });
    expect(x.t.audits.some((e) => (e as { actor: string; outcome: string }).actor === `user:${ADMIN} via dashboard tier:bot_admin` && (e as { outcome: string }).outcome.startsWith('refused'))).toBe(true);
  });
});

describe('G2SP-02: the apply path passes its front end to the permission service', () => {
  it('a dashboard Apply of a perm card tells the service via=dashboard', async () => {
    const seen: unknown[] = [];
    const perms: PermPort = {
      readiness: async () => null, read: async () => ({ ok: true, text: '' }),
      propose: async () => ({ ok: true, payload: { ops: [] }, snapshot: {}, items: [{ label: 'x', old: 'a', neu: 'b' }] }),
      apply: async (_p, _s, who) => { seen.push(who); return { kind: 'done', ok: true, lines: [], applied: 1, total: 1 }; },
    };
    const x = await rigUp({ perms });
    const r = (await x.c.proposePerm({ userId: ADMIN, tainted: false, via: 'dashboard' }, [])) as { cardId: string };
    await x.c.applyFromDashboard(r.cardId, ADMIN);
    expect(seen).toEqual([{ userId: ADMIN, cardId: r.cardId, via: 'dashboard' }]);
  });
});

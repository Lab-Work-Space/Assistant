import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OutboundPayload } from '../../agents/loop/payload.js';
import type { ActorRef } from '../../company/types.js';
import { EventBus, type AppEvents } from '../../core/events.js';
import { migrate } from '../../db/migrate.js';
import { DepartmentRepo, TaskRepo } from '../../db/repos/index.js';
import { OtRequestRepo } from '../../db/repos/ot-requests.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { otGrantedPayload, otRequestPayload } from '../../discord/embeds/approval.js';
import { OtService, type OtDeps } from './ot.js';
import { FakeConfig } from '../test-helpers.js';

const CH = '1565667791938387969';
const ADMIN = '123456789012345678';
const REQUESTER = '223456789012345678';
const hq: ActorRef = { kind: 'head', dept: 'hq' };
let db: TestDb;
let tasks: TaskRepo;
let msg = 200000000000000000n;

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations'), 'up');
  await new DepartmentRepo(db.pool).upsert({ id: 'hq', name: 'HQ', categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
  tasks = new TaskRepo(db.pool);
});
beforeEach(async () => {
  await db.pool.query('DELETE FROM ot_requests');
  await db.pool.query('DELETE FROM budget_days');
  await db.pool.query('DELETE FROM tasks');
});
afterAll(async () => { await db.close(); });

type Rig = ReturnType<typeof rig>;
function rig(over: { cfg?: Partial<Record<string, unknown>>; secrets?: readonly string[] } = {}) {
  const cfg = new FakeConfig({ 'schedule.timezone': 'Asia/Bangkok', ...(over.cfg as object) });
  const s = {
    off: true, halted: false, haltAfterCalls: null as number | null, haltCalls: 0,
    posted: [] as { channelId: string; messageId: string; payload: OutboundPayload }[],
    edits: [] as { channelId: string; messageId: string; payload: OutboundPayload }[],
    closed: [] as { channelId: string; messageId: string; note: string }[],
    lines: [] as { rootId: string; text: string }[],
    audits: [] as { actor: string; action: string; outcome?: string | null; taskId?: string | null }[],
    incidents: [] as { stage: string; err: unknown }[],
    events: [] as string[],
    failPost: false, failSetCard: false,
  };
  const bus = new EventBus<AppEvents>({ error: () => undefined });
  bus.on('ot.approved', (e) => { s.events.push(e.rootId); });
  let svcRef: OtService | null = null;
  const realRepo = new OtRequestRepo(db.pool, { onRevoked: (rows) => void svcRef?.closeRevoked(rows, 'the company was halted'), gate: () => (s.halted ? 'halted' : cfg.get('ot.enabled') === true ? null : 'disabled'), onFault: (e) => s.incidents.push({ stage: 'repo', err: e }) });
  const repo = new Proxy(realRepo, { get: (t, k) => (k === 'setCard' ? async (...a: Parameters<OtRequestRepo['setCard']>) => { if (s.failSetCard) throw new Error('db down'); return t.setCard(...a); } : Reflect.get(t, k).bind?.(t) ?? Reflect.get(t, k)) });
  const halt = { isHalted: () => { s.haltCalls++; return s.halted || (s.haltAfterCalls !== null && s.haltCalls > s.haltAfterCalls); } };
  const deps: OtDeps = {
    repo, cfg, calendar: { isOffDay: () => (s.off ? { off: true, reason: 'weekday' } : { off: false }) }, halt, bus, clock: Date.now, configChannelId: CH, secrets: over.secrets ?? [],
    audit: async (e) => void s.audits.push(e as never), log: { error: () => undefined }, incidents: { report: (i) => (s.incidents.push({ stage: i.stage, err: i.err }), '') },
    tasks, render: { request: otRequestPayload, granted: otGrantedPayload },
    ports: {
      postCard: async (payload) => {
        if (s.failPost) throw new Error('discord down');
        const messageId = String(msg++);
        s.posted.push({ channelId: CH, messageId, payload });
        return { channelId: CH, messageId };
      },
      editCard: async (channelId, messageId, payload) => (s.edits.push({ channelId, messageId, payload }), true),
      closeCard: async (channelId, messageId, note) => void s.closed.push({ channelId, messageId, note }),
      threadLine: async (root, text) => void s.lines.push({ rootId: root.id, text }),
    },
  };
  const svc = new OtService(deps);
  svcRef = svc;
  return { s, svc, repo: realRepo, cfg };
}

const newRoot = (o: { origin?: 'chat' | 'delegated'; threadId?: string | null; title?: string; userId?: string } = {}) =>
  tasks.create({ title: o.title ?? 'Quarterly report', deptId: 'hq', owner: hq, requester: { kind: 'human', userId: o.userId ?? REQUESTER }, origin: o.origin ?? 'chat', ...(o.threadId === null ? {} : { threadId: o.threadId ?? '1570000000000000009' }), channelId: '1570000000000000001' });
const held = async () => ({ tasks: 1, depts: ['Software'], rollups: 0, botTalk: 0 });
const raised = async (r: Rig, o: Parameters<typeof newRoot>[0] = {}) => {
  const root = await newRoot(o);
  expect(await r.svc.raise(root, held)).toBe(true);
  const row = (await db.pool.query<{ id: number }>('SELECT id FROM ot_requests WHERE root_id = $1 ORDER BY id DESC LIMIT 1', [root.id])).rows[0]!;
  return { root, row: (await r.repo.get(row.id))! };
};
const click = (row: { id: number; digest: string; cardChannelId: string | null; cardMessageId: string | null }, over: Record<string, unknown> = {}) =>
  ({ id: row.id, digest: row.digest, userId: ADMIN, channelId: row.cardChannelId, messageId: row.cardMessageId, ...over });

describe('OtService.raise', () => {
  it('posts one card in the config channel, stores its ids, audits ot.request; a second raise while pending posts nothing', async () => {
    const r = rig();
    const { root, row } = await raised(r);
    expect(r.s.posted).toHaveLength(1);
    expect(row).toMatchObject({ status: 'pending', cardChannelId: CH, cardMessageId: r.s.posted[0]!.messageId, requestedBy: REQUESTER });
    const p = r.s.posted[0]!.payload;
    expect(p.origin).toBe('governance');
    expect(p.title).toBe(`OT request #${row.id}`);
    expect(p.mentionUsers).toBeUndefined(); // no pings
    expect(r.s.audits).toEqual([expect.objectContaining({ actor: 'system', action: 'ot.request', taskId: root.id })]);
    expect(await r.svc.raise(root, held)).toBe(true); // pending
    expect(r.s.posted).toHaveLength(1);
  });

  it('the card says what is held and who asked; the audit never carries the title', async () => {
    const r = rig();
    const { row } = await raised(r, { title: 'Secret plan @everyone' });
    const text = JSON.stringify(r.s.posted[0]!.payload);
    expect(text).toContain(`<@${REQUESTER}>`);
    expect(text).toContain('1 task (Software)');
    expect(JSON.stringify(r.s.audits)).not.toContain('Secret plan');
    expect(row.digest).toMatch(/^[0-9a-f]{12}$/);
  });

  it('no card when OT is switched off, today is a workday, the company is halted, the tree was not started by a person, or it has no thread', async () => {
    for (const [name, setup] of [
      ['disabled', (r: Rig) => void r.cfg.values.set('ot.enabled' as never, false)],
      ['workday', (r: Rig) => { r.s.off = false; }],
      ['halted', (r: Rig) => { r.s.halted = true; }],
    ] as const) {
      const r = rig();
      setup(r);
      expect(await r.svc.raise(await newRoot(), held), name).toBe(false);
      expect(r.s.posted, name).toHaveLength(0);
    }
    const r = rig();
    expect(await r.svc.raise(await newRoot({ origin: 'delegated' }), held)).toBe(false);
    expect(await r.svc.raise(await newRoot({ threadId: null }), held)).toBe(false);
    expect(r.s.posted).toHaveLength(0);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM ot_requests')).rows[0]).toEqual({ n: 0 });
  });

  it('OT-C11: three card-post failures on one root make at most perRoot (2) attempts, and each is an incident, not a throw', async () => {
    const r = rig();
    r.s.failPost = true;
    const root = await newRoot();
    for (let i = 0; i < 3; i++) expect(await r.svc.raise(root, held)).toBe(false);
    expect((await db.pool.query('SELECT count(*)::int AS n FROM ot_requests')).rows[0]).toEqual({ n: 2 });
    expect(r.s.incidents.filter((i) => i.stage === 'card post')).toHaveLength(2);
    r.s.failPost = false;
    expect(await r.svc.raise(root, held)).toBe(false); // still capped for the day
    expect(r.s.posted).toHaveLength(0);
  });

  it('OT-C11: a store fault after a successful post leaves one orphan card with its buttons stripped, and no second card on the next raise', async () => {
    const r = rig();
    r.s.failSetCard = true;
    const root = await newRoot();
    expect(await r.svc.raise(root, held)).toBe(false);
    expect(r.s.posted).toHaveLength(1);
    expect(r.s.closed).toEqual([expect.objectContaining({ messageId: r.s.posted[0]!.messageId, note: expect.stringContaining('could not be recorded') })]);
    r.s.failSetCard = false;
    expect(await r.svc.raise(root, held)).toBe(false);
    expect(await r.svc.raise(root, held)).toBe(false);
    expect(r.s.posted).toHaveLength(1);
    const orphan = (await db.pool.query<{ id: number; status: string; card_message_id: string | null }>('SELECT id, status, card_message_id FROM ot_requests')).rows[0]!;
    expect(orphan).toMatchObject({ status: 'pending', card_message_id: null });
    expect(await r.svc.decide({ id: orphan.id, digest: 'abcdef012345', action: 'approve', userId: ADMIN, channelId: CH, messageId: r.s.posted[0]!.messageId })).toEqual({ ok: false, error: 'wrong_card' });
  });

  it('OT-C9: the daily cap hit makes no card and one incident per day, however many roots hit it', async () => {
    const r = rig({ cfg: { 'ot.requestsPerDay': 1 } });
    await raised(r);
    for (let i = 0; i < 3; i++) expect(await r.svc.raise(await newRoot({ title: `t${i}` }), held)).toBe(false);
    expect(r.s.posted).toHaveLength(1);
    expect(r.s.incidents.filter((i) => i.stage === 'daily cap')).toHaveLength(1);
  });

  it('OT-C9: the per-person cap counts by the person who started the tree', async () => {
    const r = rig({ cfg: { 'ot.requestsPerPersonPerDay': 2 } });
    await raised(r, { userId: REQUESTER });
    await raised(r, { userId: REQUESTER });
    expect(await r.svc.raise(await newRoot({ userId: REQUESTER }), held)).toBe(false);
    expect(await r.svc.raise(await newRoot({ userId: '323456789012345678' }), held)).toBe(true);
    expect(r.s.posted).toHaveLength(3);
  });

  it('OT-C6: an unswept pending row of yesterday is expired by the next raise (its card closed) and a new card is made without waiting for the sweep', async () => {
    const r = rig();
    const { root, row } = await raised(r);
    await db.pool.query("UPDATE ot_requests SET created_at = now() - interval '24 hours', expires_at = now() - interval '1 minute', local_day = local_day - 1 WHERE id = $1", [row.id]);
    expect(await r.svc.raise(root, held)).toBe(true);
    expect(r.s.posted).toHaveLength(2);
    expect(r.s.closed).toEqual([expect.objectContaining({ messageId: row.cardMessageId })]);
    expect((await r.repo.get(row.id))!.status).toBe('expired');
  });

  it('a raise fault is reported as a fixed-text incident and never thrown', async () => {
    const r = rig();
    const root = await newRoot();
    await db.pool.query('DROP TABLE ot_requests');
    await expect(r.svc.raise(root, held)).resolves.toBe(false);
    expect(r.s.incidents.some((i) => i.stage === 'raise')).toBe(true);
    await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations'), 'down');
    await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations'), 'up');
    await new DepartmentRepo(db.pool).upsert({ id: 'hq', name: 'HQ', categoryNamePattern: '', workChannelId: null, color: 0, model: null, provider: null, enabled: true });
  });
});

describe('OtService.decide (approve and deny)', () => {
  it('approve: the grant is committed, ot.approved carries the ROW\'s root id, the card is edited to the grant with a Revoke button, the thread line is posted, ot.approve is audited', async () => {
    const r = rig();
    const { root, row } = await raised(r);
    const d = await r.svc.decide({ ...click(row), action: 'approve' });
    expect(d.ok).toBe(true);
    expect(r.s.events).toEqual([root.id]);
    expect(r.s.edits).toHaveLength(1);
    expect(r.s.edits[0]).toMatchObject({ channelId: CH, messageId: row.cardMessageId });
    expect(r.s.edits[0]!.payload.otButtons).toMatchObject({ mode: 'granted', id: row.id });
    expect(r.s.edits[0]!.payload.otButtons!.note).toMatch(/runs 0\/30, up to \$2\.00/);
    expect(r.s.lines).toEqual([{ rootId: root.id, text: expect.stringMatching(/^✅ อนุมัติ OT ถึง \d{2}:\d{2}$/) }]);
    expect(r.s.audits.at(-1)).toMatchObject({ actor: `user:${ADMIN}`, action: 'ot.approve', taskId: root.id });
    expect(await r.svc.usable(root.id)).toBe(true);
    expect(await r.svc.until(root.id)).toBeInstanceOf(Date);
  });

  it('OT-C16: a digest tamper, a wrong message, a wrong channel and null ids change nothing and emit nothing', async () => {
    const r = rig();
    const { row } = await raised(r);
    for (const patch of [{ digest: '000000000000' }, { messageId: '999999999999999999' }, { channelId: '1565667791938387970' }, { messageId: null }, { channelId: null }]) {
      expect(await r.svc.decide({ ...click(row, patch), action: 'approve' }), JSON.stringify(patch)).toEqual({ ok: false, error: 'wrong_card' });
    }
    expect(r.s.events).toEqual([]);
    expect((await r.repo.get(row.id))!.status).toBe('pending');
    expect(r.s.closed).toEqual([]);
  });

  it('deny: closes the card, posts the thread line, audits; sticky: the next raise makes no card', async () => {
    const r = rig();
    const { root, row } = await raised(r);
    expect((await r.svc.decide({ ...click(row), action: 'deny' })).ok).toBe(true);
    expect(r.s.closed).toEqual([expect.objectContaining({ messageId: row.cardMessageId, note: expect.stringContaining('denied') })]);
    expect(r.s.lines).toEqual([{ rootId: root.id, text: 'งานจะเริ่มวันทำงานถัดไป' }]);
    expect(r.s.audits.at(-1)).toMatchObject({ action: 'ot.deny' });
    expect(await r.svc.raise(root, held)).toBe(false);
    expect(r.s.posted).toHaveLength(1);
  });

  it('expired at midnight: approve, deny and day are refused, the card is closed as expired, and the workday is NOT opened', async () => {
    const r = rig();
    const { row } = await raised(r);
    await db.pool.query("UPDATE ot_requests SET created_at = now() - interval '24 hours', expires_at = now() - interval '1 second', local_day = local_day - 1 WHERE id = $1", [row.id]);
    const days: string[] = [];
    expect(await r.svc.decide({ ...click(row), action: 'approve' })).toEqual({ ok: false, error: 'expired' });
    expect(await r.svc.decideDay(click(row), async (d) => (days.push(d), { ok: true }))).toEqual({ ok: false, error: 'expired' });
    expect((await r.svc.decide({ ...click(row), action: 'deny' })).ok).toBe(false);
    expect(days).toEqual([]);
    expect(r.s.closed.some((c) => c.note.includes('has ended'))).toBe(true);
    expect((await r.repo.get(row.id))!.status).toBe('pending');
  });

  it('OT-C6: a request of yesterday that is still unswept cannot open TODAY: "day" refuses expired and the plan is never run', async () => {
    const r = rig();
    const { row } = await raised(r);
    await db.pool.query("UPDATE ot_requests SET local_day = local_day - 1, expires_at = now() + interval '1 hour', created_at = now() - interval '5 hours' WHERE id = $1", [row.id]);
    let opened = false;
    expect(await r.svc.decideDay(click(row), async () => ((opened = true), { ok: true }))).toEqual({ ok: false, error: 'expired' });
    expect(await r.svc.decide({ ...click(row), action: 'approve' })).toEqual({ ok: false, error: 'expired' });
    expect(opened).toBe(false);
  });

  it('halted: approve is refused before anything commits; whole day is still allowed while halted', async () => {
    const r = rig();
    const { row } = await raised(r);
    r.s.halted = true;
    expect(await r.svc.decide({ ...click(row), action: 'approve' })).toEqual({ ok: false, error: 'halted' });
    expect((await r.repo.get(row.id))!.status).toBe('pending');
    const days: string[] = [];
    expect((await r.svc.decideDay(click(row), async (d) => (days.push(d), { ok: true }))).ok).toBe(true);
    expect(days).toEqual([row.localDay]);
  });

  it('halted-after-commit: the grant is revoked (halt) BEFORE ot.approved could be emitted, and nothing is released', async () => {
    const r = rig();
    const { root, row } = await raised(r);
    r.s.haltCalls = 0;
    r.s.haltAfterCalls = 1; // the gate inside the transaction reads not halted, the check after the commit reads halted
    expect(await r.svc.decide({ ...click(row), action: 'approve' })).toMatchObject({ ok: false, error: 'halted_after_commit' });
    expect(r.s.events).toEqual([]);
    expect(await r.repo.get(row.id)).toMatchObject({ status: 'approved', revokeReason: 'halt' });
    expect(await r.svc.usable(root.id)).toBe(false);
    expect(r.s.audits.at(-1)).toMatchObject({ action: 'ot.approve', outcome: expect.stringContaining('halted_after_commit') });
  });

  it('moot: a day that is a workday refuses approve, and closeMoot closes the pending cards and audits once', async () => {
    const r = rig();
    const { row } = await raised(r);
    r.s.off = false;
    expect(await r.svc.decide({ ...click(row), action: 'approve' })).toEqual({ ok: false, error: 'moot' });
    expect(r.s.closed.some((c) => c.note.includes('already a workday'))).toBe(true);
    await r.svc.closeMoot();
    expect((await r.repo.get(row.id))!.status).toBe('moot');
    expect(r.s.closed.some((c) => c.note.includes('workday now'))).toBe(true);
    expect(r.s.audits.at(-1)).toMatchObject({ action: 'ot.moot', outcome: 'n=1' });
    expect(await r.svc.decide({ ...click(row), action: 'approve' })).toEqual({ ok: false, error: 'moot' });
  });

  it('root ended and switched off refuse', async () => {
    const r = rig();
    const a = await raised(r);
    await db.pool.query("UPDATE tasks SET status = 'cancelled' WHERE id = $1", [a.root.id]);
    expect(await r.svc.decide({ ...click(a.row), action: 'approve' })).toEqual({ ok: false, error: 'root_ended' });
    const b = await raised(r);
    r.cfg.values.set('ot.enabled' as never, false);
    expect(await r.svc.decide({ ...click(b.row), action: 'approve' })).toEqual({ ok: false, error: 'disabled' });
  });

  it('approve, deny and day race: exactly one wins and ot.approved is emitted at most once', async () => {
    for (let n = 0; n < 5; n++) {
      const r = rig();
      const { row } = await raised(r);
      const res = await Promise.all([
        r.svc.decide({ ...click(row), action: 'approve' }), r.svc.decide({ ...click(row), action: 'approve' }), r.svc.decide({ ...click(row), action: 'deny' }),
        r.svc.decideDay(click(row), async () => ({ ok: true })),
      ]);
      expect(res.filter((x) => x.ok)).toHaveLength(1);
      expect(r.s.events.length).toBeLessThanOrEqual(1);
      expect((await db.pool.query("SELECT count(*)::int AS n FROM ot_requests WHERE status <> 'pending'")).rows[0]).toEqual({ n: 1 });
      await db.pool.query('DELETE FROM ot_requests');
    }
  });

  it('supersede: approving a second request revokes the first grant', async () => {
    const r = rig();
    const a = await raised(r);
    await r.svc.decide({ ...click(a.row), action: 'approve' });
    await db.pool.query('UPDATE ot_requests SET runs_used = max_runs, status = status WHERE id = $1', [a.row.id]).catch(() => undefined);
    // use up the grant, then a new request is raised and approved
    const max = (await r.repo.get(a.row.id))!.maxRuns!;
    await db.pool.query('UPDATE ot_requests SET runs_used = $2 WHERE id = $1', [a.row.id, max]);
    expect(await r.svc.raise(a.root, held)).toBe(true);
    const second = (await db.pool.query<{ id: number }>("SELECT id FROM ot_requests WHERE status = 'pending'")).rows[0]!;
    const row2 = (await r.repo.get(second.id))!;
    expect(row2.seq).toBe(2);
    expect((await r.svc.decide({ ...click(row2), action: 'approve' })).ok).toBe(true);
    expect(await r.repo.get(a.row.id)).toMatchObject({ revokeReason: 'superseded' });
    expect(await r.svc.usable(a.root.id)).toBe(true);
  });
});

describe('OtService.decideDay', () => {
  it('claims the row, opens the request\'s OWN day, audits ot.workday, closes the card', async () => {
    const r = rig();
    const { root, row } = await raised(r);
    const days: { date: string; by: string }[] = [];
    const d = await r.svc.decideDay(click(row), async (date, by) => (days.push({ date, by }), { ok: true }));
    expect(d.ok).toBe(true);
    expect(days).toEqual([{ date: row.localDay, by: ADMIN }]);
    expect((await r.repo.get(row.id))!.status).toBe('workday');
    expect(r.s.audits.at(-1)).toMatchObject({ action: 'ot.workday', taskId: root.id });
    expect(r.s.closed.at(-1)!.note).toContain('workday');
  });

  it('only in the config channel: a card whose stored channel is another is refused wrong_card', async () => {
    const r = rig();
    const { row } = await raised(r);
    await db.pool.query("UPDATE ot_requests SET card_channel_id = '1570000000000000777' WHERE id = $1", [row.id]);
    let opened = false;
    expect(await r.svc.decideDay({ ...click(row), channelId: '1570000000000000777' }, async () => ((opened = true), { ok: true }))).toEqual({ ok: false, error: 'wrong_card' });
    expect(opened).toBe(false);
  });

  it('"already a workday" from the plan is success; any other plan error gives the claim back and the card stays decidable', async () => {
    const r = rig();
    const a = await raised(r);
    expect((await r.svc.decideDay(click(a.row), async () => ({ ok: false, error: 'x is already a workday.', already: true }))).ok).toBe(true);
    const b = await raised(r);
    const bad = await r.svc.decideDay(click(b.row), async () => ({ ok: false, error: 'at most 20 extra workdays' }));
    expect(bad).toEqual({ ok: false, error: 'day_failed', text: 'at most 20 extra workdays' });
    expect((await r.repo.get(b.row.id))!.status).toBe('pending');
    const thrown = await r.svc.decideDay(click(b.row), async () => { throw new Error('config write failed'); });
    expect(thrown).toMatchObject({ ok: false, error: 'day_failed' });
    expect((await r.repo.get(b.row.id))!.status).toBe('pending');
  });
});

describe('OtService revoke, sweep and the switches', () => {
  it('revoke works only on the grant\'s own card; a second revoke says it ended; the card is closed; ot.revoke audited', async () => {
    const r = rig();
    const { root, row } = await raised(r);
    await r.svc.decide({ ...click(row), action: 'approve' });
    expect(await r.svc.revoke({ ...click(row), messageId: '999999999999999999' })).toEqual({ ok: false, error: 'wrong_card' });
    expect(await r.svc.revoke({ ...click(row), digest: '000000000000' })).toEqual({ ok: false, error: 'wrong_card' });
    expect(await r.svc.usable(root.id)).toBe(true);
    expect((await r.svc.revoke(click(row))).ok).toBe(true);
    expect(await r.svc.usable(root.id)).toBe(false);
    expect(r.s.audits.at(-1)).toMatchObject({ action: 'ot.revoke', outcome: `admin #${row.id}` });
    expect(await r.svc.revoke(click(row))).toEqual({ ok: false, error: 'ended' });
    expect(await r.svc.revoke({ ...click(row), id: 999999 })).toEqual({ ok: false, error: 'not_found' });
  });

  it('the revoke button of a request that was never approved does nothing', async () => {
    const r = rig();
    const { row } = await raised(r);
    expect(await r.svc.revoke(click(row))).toEqual({ ok: false, error: 'not_pending' });
  });

  it('sweep: a pending row past its day ends and its card closes (ot.expire); a grant on an ended tree is revoked root_ended', async () => {
    const r = rig();
    const a = await raised(r);
    await db.pool.query("UPDATE ot_requests SET created_at = now() - interval '24 hours', expires_at = now() - interval '1 second' WHERE id = $1", [a.row.id]);
    const b = await raised(r);
    await r.svc.decide({ ...click(b.row), action: 'approve' });
    await db.pool.query("UPDATE tasks SET status = 'done' WHERE id = $1", [b.root.id]);
    await r.svc.sweep();
    expect((await r.repo.get(a.row.id))!.status).toBe('expired');
    expect((await r.repo.get(b.row.id))!.revokeReason).toBe('root_ended');
    expect(r.s.closed.some((c) => c.messageId === a.row.cardMessageId)).toBe(true);
    expect(r.s.audits.map((x) => x.action)).toEqual(expect.arrayContaining(['ot.expire', 'ot.revoke']));
  });

  it('OT-C7: switching ot.enabled off stops the grant at once (usable false) even before any revoke; revokeAll closes the cards', async () => {
    const r = rig();
    const { root, row } = await raised(r);
    await r.svc.decide({ ...click(row), action: 'approve' });
    expect(await r.svc.usable(root.id)).toBe(true);
    r.cfg.values.set('ot.enabled' as never, false);
    expect(await r.svc.usable(root.id)).toBe(false);
    expect(await r.svc.consume(root.id)).toBe(false);
    expect(await r.svc.revokeAll('admin', ADMIN)).toBe(1);
    expect(r.s.closed.at(-1)!.note).toContain('switched off');
    expect(r.s.audits.at(-1)).toMatchObject({ action: 'ot.revoke', actor: `user:${ADMIN}` });
  });

  it('halt: revokeAll(halt) ends every grant and the cards say why; a halted company has no usable grant', async () => {
    const r = rig();
    const a = await raised(r);
    await r.svc.decide({ ...click(a.row), action: 'approve' });
    r.s.halted = true;
    expect(await r.svc.revokeAll('halt')).toBe(1); // the halt hook
    expect(r.s.closed.at(-1)!.note).toContain('halted');
    expect(await r.svc.usable(a.root.id)).toBe(false);
    r.s.halted = false; // resume restores nothing
    expect(await r.svc.usable(a.root.id)).toBe(false);
  });

  it('consume: the grant ends after max runs with ot.exhausted audited once', async () => {
    const r = rig({ cfg: { 'ot.maxRuns': 2 } });
    const { root, row } = await raised(r);
    await r.svc.decide({ ...click(row), action: 'approve' });
    expect(await r.svc.consume(root.id)).toBe(true);
    expect(await r.svc.consume(root.id)).toBe(true);
    expect(await r.svc.consume(root.id)).toBe(false);
    expect(await r.svc.consume(root.id)).toBe(false);
    expect(r.s.audits.filter((x) => x.action === 'ot.exhausted')).toHaveLength(1);
    expect(await r.svc.usable(root.id)).toBe(false);
    expect(await r.svc.until(root.id)).toBeInstanceOf(Date); // unexpired though used up (create_task says "while runs remain")
  });

  it('a grant of another tree is not usable for this one', async () => {
    const r = rig();
    const a = await raised(r);
    const b = await newRoot({ title: 'other' });
    await r.svc.decide({ ...click(a.row), action: 'approve' });
    expect(await r.svc.usable(b.id)).toBe(false);
    expect(await r.svc.consume(b.id)).toBe(false);
    expect(await r.svc.until(b.id)).toBeNull();
  });
});

describe('OT-C10: the root title is masked before the neutraliser', () => {
  it('a title cut off in the middle of a secret literal shows [REDACTED], on the request card and on the granted card', async () => {
    const SECRET = 'sk-live-ABCDEFGH12345678';
    const r = rig({ secrets: [SECRET] });
    const { row } = await raised(r, { title: `Deploy with ${SECRET.slice(0, 12)}` }); // the literal is cut after 12 characters
    expect(JSON.stringify(r.s.posted[0]!.payload)).not.toContain('sk-live-ABCD');
    expect(JSON.stringify(r.s.posted[0]!.payload)).toContain('REDACTED');
    await r.svc.decide({ ...click(row), action: 'approve' });
    expect(JSON.stringify(r.s.edits[0]!.payload)).not.toContain('sk-live-ABCD');
    expect(JSON.stringify(r.s.edits[0]!.payload)).toContain('REDACTED');
  });
});

describe('Gate 2 follow-ups: no card keeps showing an ended grant (G2OT-01)', () => {
  it('supersede closes the first grant\'s card', async () => {
    const r = rig();
    const a = await raised(r);
    await r.svc.decide({ ...click(a.row), action: 'approve' });
    const max = (await r.repo.get(a.row.id))!.maxRuns!;
    await db.pool.query('UPDATE ot_requests SET runs_used = $2 WHERE id = $1', [a.row.id, max]);
    expect(await r.svc.raise(a.root, held)).toBe(true);
    const second = (await db.pool.query<{ id: number }>("SELECT id FROM ot_requests WHERE status = 'pending'")).rows[0]!;
    const row2 = (await r.repo.get(second.id))!;
    r.s.closed.length = 0;
    expect((await r.svc.decide({ ...click(row2), action: 'approve' })).ok).toBe(true);
    expect(r.s.closed).toEqual([expect.objectContaining({ messageId: a.row.cardMessageId, note: expect.stringContaining('replaced') })]);
    expect(r.s.audits.some((x) => x.action === 'ot.revoke' && x.outcome === `superseded #${a.row.id}`)).toBe(true);
  });

  it('a refused call while halted starts the repo\'s halt revoke and the card is closed through the service', async () => {
    const r = rig();
    const a = await raised(r);
    await r.svc.decide({ ...click(a.row), action: 'approve' });
    r.s.closed.length = 0;
    r.s.halted = true;
    expect(await r.svc.usable(a.root.id)).toBe(false);
    await vi.waitFor(() => expect(r.s.closed.map((c) => c.messageId)).toEqual([a.row.cardMessageId]));
    expect(r.s.closed[0]!.note).toContain('halted');
  });

  it('closeRevoked (the boot path) closes the cards of the rows the boot revoke returned', async () => {
    const r = rig();
    const a = await raised(r);
    await r.svc.decide({ ...click(a.row), action: 'approve' });
    await db.pool.query("INSERT INTO config (key, value, updated_by) VALUES ('halted', 'false'::jsonb, 'test') ON CONFLICT (key) DO UPDATE SET updated_at = now() + interval '1 minute'");
    const rows = await r.repo.revokeBeforeHaltedRow();
    r.s.closed.length = 0;
    await r.svc.closeRevoked(rows, 'the company was halted');
    expect(r.s.closed).toEqual([expect.objectContaining({ messageId: a.row.cardMessageId, note: expect.stringContaining('halted') })]);
    await db.pool.query("DELETE FROM config WHERE key = 'halted'");
  });
});

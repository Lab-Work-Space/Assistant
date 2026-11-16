import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OutboundPayload } from '../agents/loop/payload.js';
import { ConfigStore } from '../config/store.js';
import { EventBus, type AppEvents } from '../core/events.js';
import { migrate } from '../db/migrate.js';
import { ToolIdeaRepo, ToolRequestRepo } from '../db/repos/grow.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { CONFIG_CHANNEL_ID } from '../discord/commands/types.js';
import type { ToolKind } from '../tools/policy-approval.js';
import { ToolIdeaInput, ToolIdeaService } from './tool-ideas.js';
import { DECIDE_TEXT, REQUEST_TEXT, ToolRequestService, type ToolRequestDeps } from './tool-requests.js';

const HEAD = { kind: 'head', dept: 'software' } as const;
const CLEAN = { tainted: false, task: { id: 'abcdef012345', tainted: false } };
const ADMIN = '900000000000000001';
const MSG = '800000000000000011';
const dir = dirname(fileURLToPath(import.meta.url));
const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

let db: TestDb;
let store: ConfigStore;
let repo: ToolRequestRepo;
let ideaRepo: ToolIdeaRepo;

beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dir, '..', 'db', 'migrations'), 'up');
});
afterAll(async () => { await store?.close(); await db.close(); });

type Rig = ReturnType<typeof rigUp>;
const kinds: Record<string, ToolKind | undefined> = { web_search: 'read', fetch_page: 'read', clickup_update_task: 'write', clickup_create_task: 'write', kindless_plugin: undefined, create_task: 'write', admin_op_propose: 'write' };

function rigUp(over: { halted?: boolean; failCard?: boolean; registered?: string[]; toolsFor?: string[] } = {}) {
  const st = { halted: over.halted ?? false, failCard: over.failCard ?? false, registered: over.registered ?? Object.keys(kinds) };
  const audits: { actor: string; action: string; tool?: string | null; outcome?: string | null }[] = [];
  const cards: OutboundPayload[] = [];
  const closed: { channelId: string; messageId: string; note: string }[] = [];
  const notices: { dept: string; text: string }[] = [];
  const logs: unknown[] = [];
  let seq = 0;
  const deps: ToolRequestDeps = {
    repo, cfg: store,
    org: { dept: (id: string) => (['software', 'rnd', 'praw'].includes(id) ? ({} as never) : null), toolsFor: () => over.toolsFor ?? ['respond', 'create_task'] },
    grant: { registered: () => st.registered, builtins: () => ['create_task', 'respond', 'tool_request', 'tool_idea'], kindOf: (n) => kinds[n] },
    plugins: () => st.registered.filter((n) => !['create_task', 'respond', 'tool_request', 'tool_idea'].includes(n)),
    halted: () => st.halted, audit: async (e) => void audits.push(e as never), secrets: [], configChannelId: CONFIG_CHANNEL_ID,
    postCard: async (p) => { if (st.failCard) throw new Error('boom'); cards.push(p); return `8000000000000001${String(10 + ++seq).padStart(2, '0')}`; },
    closeCard: async (channelId, messageId, note) => void closed.push({ channelId, messageId, note }),
    notifyHead: async (dept, text) => void notices.push({ dept, text }),
    log: { error: (o) => void logs.push(o) },
  };
  const svc = new ToolRequestService(deps);
  const click = (token: string, action: 'approve' | 'reject', o: Partial<{ userId: string; channelId: string | null; messageId: string | null }> = {}) =>
    svc.decide({ token, action, userId: o.userId ?? ADMIN, channelId: o.channelId === undefined ? CONFIG_CHANNEL_ID : o.channelId, messageId: o.messageId === undefined ? lastMsg(cards, token) : o.messageId });
  return { svc, deps, st, audits, cards, closed, notices, logs, click };
}
const lastMsg = (_c: OutboundPayload[], token: string): string | null => msgOf.get(token) ?? null;
const msgOf = new Map<string, string>();
/** Files a request and returns the row; the card's message id is read back from the row. */
async function file(r: Rig, tool = 'web_search', actor: typeof HEAD | { kind: 'head'; dept: 'rnd' } = HEAD) {
  const res = await r.svc.request(actor, CLEAN, { tool, reason: 'We need it for research tasks.' });
  if (!res.ok) throw new Error(`refused ${res.code}`);
  if (res.id === null) throw new Error('granted for a project without a card');
  const row = (await repo.byId(res.id))!;
  if (row.messageId) msgOf.set(row.token, row.messageId);
  return row;
}
const byDept = () => store.get('tools.byDept');
const count = async (t: string, where = '') => Number((await db.pool.query(`SELECT count(*) AS n FROM ${t} ${where}`)).rows[0].n);

beforeEach(async () => {
  await store?.close();
  for (const t of ['tool_requests', 'tool_ideas', 'audit_log', 'approvals', 'config']) await db.pool.query(`DELETE FROM ${t}`);
  store = await ConfigStore.open(db.pool, new EventBus<AppEvents>());
  await store.set('tools.byDept', {}, 'test'); // the shipped defaults already list web tools for software
  repo = new ToolRequestRepo(db.pool);
  ideaRepo = new ToolIdeaRepo(db.pool);
  msgOf.clear();
});

describe('tool_request: refusals (fixed texts, request order)', () => {
  const ask = (r: Rig, input = { tool: 'web_search', reason: 'need it' }, actor: never = HEAD as never, run: { tainted: boolean; task: { id: string; tainted: boolean } | null } = CLEAN) => r.svc.request(actor, run, input);
  it.each([
    ['not_head: a persona', { kind: 'persona', personaId: 'system-analyst' }],
    ['not_head: praw', { kind: 'head', dept: 'praw' }],
  ])('%s', async (_n, actor) => {
    const r = rigUp();
    const x = await ask(r, undefined, actor as never);
    expect(x).toEqual({ ok: false, code: 'not_head', error: REQUEST_TEXT.not_head });
    expect(await count('tool_requests')).toBe(0);
  });
  it('halted (checked by the tool itself), before the taint check', async () => {
    const r = rigUp({ halted: true });
    expect(await ask(r, undefined, HEAD as never, { tainted: true, task: null })).toMatchObject({ code: 'halted', error: REQUEST_TEXT.halted });
  });
  it('tainted: the run or the task', async () => {
    const r = rigUp();
    expect(await ask(r, undefined, HEAD as never, { tainted: true, task: null })).toMatchObject({ code: 'tainted' });
    expect(await ask(r, undefined, HEAD as never, { tainted: false, task: { id: 'x', tainted: true } })).toMatchObject({ code: 'tainted' });
  });
  it('unknown_tool, then already_allowed (head list and tools.byDept), then not_grantable (core builtin, kindless, admin)', async () => {
    const r = rigUp();
    expect(await ask(r, { tool: 'ghost_tool', reason: 'x' })).toMatchObject({ code: 'unknown_tool', error: REQUEST_TEXT.unknown_tool });
    expect(await ask(r, { tool: 'create_task', reason: 'x' })).toMatchObject({ code: 'already_allowed' }); // in the head's own list
    await store.set('tools.byDept', { software: ['web_search'] }, 'u');
    expect(await ask(r, { tool: 'web_search', reason: 'x' })).toMatchObject({ code: 'already_allowed' });
    const r2 = rigUp({ toolsFor: [] });
    expect(await ask(r2, { tool: 'create_task', reason: 'x' })).toMatchObject({ code: 'not_grantable', error: REQUEST_TEXT.not_grantable }); // core builtin
    expect(await ask(r2, { tool: 'kindless_plugin', reason: 'x' })).toMatchObject({ code: 'not_grantable' }); // C7
    expect(await ask(r2, { tool: 'admin_op_propose', reason: 'x' })).toMatchObject({ code: 'not_grantable' });
  });
  it('screen: a secret-like reason or control characters; nothing stored', async () => {
    const r = rigUp();
    expect(await ask(r, { tool: 'web_search', reason: 'use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' })).toMatchObject({ code: 'screen', error: REQUEST_TEXT.screen });
    expect(await ask(r, { tool: 'web_search', reason: 'a‮b' })).toMatchObject({ code: 'screen' });
    expect(await count('tool_requests')).toBe(0);
  });
  it('open_cap (the 4th), pending_exists, recently_rejected; each writes an audit row with the code only', async () => {
    const r = rigUp();
    for (const t of ['web_search', 'fetch_page', 'clickup_update_task']) await file(r, t);
    expect(await ask(r, { tool: 'clickup_create_task', reason: 'x' })).toMatchObject({ code: 'open_cap', error: REQUEST_TEXT.open_cap });
    expect(await ask(r, { tool: 'web_search', reason: 'x' })).toMatchObject({ code: 'open_cap' }); // cap first
    const rows = (await repo.listPending()).filter((x) => x.tool === 'clickup_update_task');
    await db.pool.query("UPDATE tool_requests SET status = 'rejected', decided_by = $1, decided_at = now(), outcome = 'rejected' WHERE id = $2", [ADMIN, rows[0]!.id]);
    expect(await ask(r, { tool: 'fetch_page', reason: 'x' })).toMatchObject({ code: 'pending_exists', error: REQUEST_TEXT.pending_exists });
    expect(await ask(r, { tool: 'clickup_update_task', reason: 'x' })).toMatchObject({ code: 'recently_rejected' });
    expect(r.audits.filter((a) => a.action === 'tool.request' && a.outcome?.startsWith('refused:')).map((a) => a.outcome)).toEqual(['refused:open_cap', 'refused:open_cap', 'refused:pending_exists', 'refused:recently_rejected']);
  });
  it('an old rejection (over 7 days) no longer blocks', async () => {
    const r = rigUp();
    const row = await file(r);
    await repo.reject(row.token, ADMIN);
    await db.pool.query("UPDATE tool_requests SET decided_at = now() - interval '8 days', created_at = now() - interval '9 days', expires_at = now() - interval '2 days' WHERE id = $1", [row.id]);
    expect((await r.svc.request(HEAD, CLEAN, { tool: 'web_search', reason: 'again' })).ok).toBe(true);
  });
  it('four concurrent requests (different tools) give exactly 3 rows (GW-C23)', async () => {
    const r = rigUp();
    const out = await Promise.all(['web_search', 'fetch_page', 'clickup_update_task', 'clickup_create_task'].map((tool) => r.svc.request(HEAD, CLEAN, { tool, reason: 'need it' })));
    expect(out.filter((o) => o.ok)).toHaveLength(3);
    expect(out.filter((o) => !o.ok).map((o) => (o as { code: string }).code)).toEqual(['open_cap']);
    expect(await count('tool_requests')).toBe(3);
  });
  it('two concurrent requests for the same pair give one row', async () => {
    const r = rigUp();
    const out = await Promise.all([1, 2].map(() => r.svc.request(HEAD, CLEAN, { tool: 'web_search', reason: 'need it' })));
    expect(out.filter((o) => o.ok)).toHaveLength(1);
    expect(await count('tool_requests')).toBe(1);
  });
  it('input schema is strict and bounded', async () => {
    const { ToolRequestInput } = await import('./tool-requests.js');
    expect(ToolRequestInput.safeParse({ tool: 'web_search', reason: 'ok', kind: 'read' }).success).toBe(false);
    expect(ToolRequestInput.safeParse({ tool: 'Web Search', reason: 'ok' }).success).toBe(false);
    expect(ToolRequestInput.safeParse({ tool: 'web_search', reason: 'x'.repeat(301) }).success).toBe(false);
    expect(ToolRequestInput.safeParse({ tool: 'web_search', reason: '  ' }).success).toBe(false);
  });
});

describe('tool_request: card and row', () => {
  it('posts one governance card with the token, never a kind approval; the row stores the card; nothing changed; never judged (approval.ai on)', async () => {
    await store.set('approval.ai.enabled', true, 'u');
    const r = rigUp();
    const row = await file(r);
    expect(r.cards).toHaveLength(1);
    const p = r.cards[0]!;
    expect(p).toMatchObject({ type: 'approval', origin: 'governance', title: 'Tool request', toolRequestId: row.token });
    expect(p.body).toContain('software head asks for the existing tool web_search (kind read) for the whole department. Approve adds it to tools.byDept for software only. Expires <t:');
    expect(p.fields![0]!.name).toBe('Reason (written by the bot)');
    expect(row).toMatchObject({ status: 'pending', channelId: CONFIG_CHANNEL_ID, deptId: 'software', tool: 'web_search' });
    expect(row.messageId).toMatch(/^[0-9]{17,20}$/);
    expect(row.token).toMatch(/^[0-9a-f]{32}$/);
    expect(byDept()).toEqual({});
    expect(await count('approvals')).toBe(0); // GW-C16: no approval row, no judge
    expect(r.audits.some((a) => a.action === 'tool.request' && a.outcome === `#${row.id} web_search`)).toBe(true);
  });
  it('the card reason is escaped and masked; a model cannot hide markup in it', async () => {
    const r = rigUp();
    await r.svc.request(HEAD, CLEAN, { tool: 'web_search', reason: 'see **bold** @everyone [x](http://e.x)' });
    const v = r.cards[0]!.fields![0]!.value;
    expect(v).not.toContain('@everyone');
    expect(v).toContain('\\*\\*bold\\*\\*');
  });
  it('a failed card post keeps the row pending and listed with "no card"; the head text says so; logs carry the error name only', async () => {
    const r = rigUp({ failCard: true });
    const res = await r.svc.request(HEAD, CLEAN, { tool: 'web_search', reason: 'need it' });
    expect(res).toMatchObject({ ok: true });
    expect((res as { text: string }).text).toContain('The card could not be posted; a Bot Admin can see it in /tool requests.');
    const [row] = await r.svc.listPending();
    expect(row).toMatchObject({ status: 'pending', messageId: null });
    expect(JSON.stringify(r.logs)).toBe('[{"errName":"Error"}]');
  });
  it('ok text: nothing has changed yet, do not say you have the tool', async () => {
    const r = rigUp();
    const res = await r.svc.request(HEAD, CLEAN, { tool: 'web_search', reason: 'need it' });
    expect((res as { text: string }).text).toMatch(/^Tool request #\d+ for web_search was sent to the Bot Admins\. NOTHING has changed yet; you will be told in this room\. Do not say you have the tool\.$/);
  });
});

describe('tool_request: the button (decide)', () => {
  it('approve: tools.byDept changes for that department only; row approved/ok; audit; card closed; head told with clean text', async () => {
    await store.set('tools.byDept', { rnd: ['fetch_page'], software: ['clickup_update_task'] }, 'u');
    const r = rigUp();
    const row = await file(r);
    const d = await r.click(row.token, 'approve');
    expect(d).toMatchObject({ ok: true, result: 'approved' });
    expect(byDept()).toEqual({ rnd: ['fetch_page'], software: ['clickup_update_task', 'web_search'] });
    expect(await repo.byId(row.id)).toMatchObject({ status: 'approved', outcome: 'ok', decidedBy: ADMIN });
    expect(r.audits.find((a) => a.action === 'bot.tools.add')).toMatchObject({ actor: `user:${ADMIN}`, tool: 'web_search', outcome: `ok tool_request:${row.id}` });
    expect(r.closed).toEqual([{ channelId: CONFIG_CHANNEL_ID, messageId: row.messageId, note: `Approved by <@${ADMIN}>: software head may use web_search.` }]);
    expect(r.notices).toEqual([{ dept: 'software', text: `Tool request #${row.id} (web_search): approved by a Bot Admin. You can use it from your next run.` }]);
  });
  it('a double click gives one write and one notice; the second is "Already decided."', async () => {
    const r = rigUp();
    const row = await file(r);
    const [a, b] = await Promise.all([r.click(row.token, 'approve'), r.click(row.token, 'approve')]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((x) => !x.ok)).toMatchObject({ code: 'not_pending', text: DECIDE_TEXT.not_pending });
    expect(byDept()).toEqual({ software: ['web_search'] });
    expect(r.notices).toHaveLength(1);
  });
  it('reject: nothing changes; row rejected; card closed; head told; a new request for the pair is refused for 7 days', async () => {
    const r = rigUp();
    const row = await file(r);
    expect(await r.click(row.token, 'reject')).toMatchObject({ ok: true, result: 'rejected' });
    expect(byDept()).toEqual({});
    expect(await repo.byId(row.id)).toMatchObject({ status: 'rejected', outcome: 'rejected' });
    expect(r.closed[0]!.note).toBe(`Rejected by <@${ADMIN}>. Nothing changed.`);
    expect(r.notices[0]!.text).toBe(`Tool request #${row.id} (web_search): rejected by a Bot Admin. Nothing changed.`);
    expect(await r.svc.request(HEAD, CLEAN, { tool: 'web_search', reason: 'again' })).toMatchObject({ code: 'recently_rejected' });
  });
  it('wrong card: another channel, another message, no message, a bad or unknown token; the row stays pending', async () => {
    const r = rigUp();
    const row = await file(r);
    const fails = [
      await r.click(row.token, 'approve', { channelId: '700000000000000001' }),
      await r.click(row.token, 'approve', { messageId: '800000000000000099' }),
      await r.click(row.token, 'approve', { messageId: null }),
      await r.click('zz' + row.token.slice(2), 'approve'),
      await r.click('0'.repeat(32), 'approve'),
      await r.click(row.token.toUpperCase(), 'approve'),
    ];
    for (const f of fails) expect(f).toEqual({ ok: false, code: 'wrong_card', text: DECIDE_TEXT.wrong_card });
    expect((await repo.byId(row.id))!.status).toBe('pending');
    expect(byDept()).toEqual({});
  });
  it('a request whose card was never posted cannot be decided (no stored message id)', async () => {
    const r = rigUp({ failCard: true });
    await r.svc.request(HEAD, CLEAN, { tool: 'web_search', reason: 'need it' });
    const [row] = await r.svc.listPending();
    expect(await r.click(row!.token, 'approve', { messageId: MSG })).toMatchObject({ code: 'wrong_card' });
  });
  it('not_pending after a decision, expired after the deadline (nothing changes either way)', async () => {
    const r = rigUp();
    const row = await file(r);
    await r.click(row.token, 'reject');
    expect(await r.click(row.token, 'approve')).toMatchObject({ code: 'not_pending', text: 'Already decided.' });
    const r2 = rigUp();
    const row2 = await file(r2, 'fetch_page');
    await db.pool.query("UPDATE tool_requests SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE id = $1", [row2.id]);
    expect(await r2.click(row2.token, 'approve')).toMatchObject({ code: 'expired', text: 'This request has expired.' });
    expect(byDept()).toEqual({});
  });
  it('halted: approve is refused and the row stays pending; reject still works', async () => {
    const r = rigUp();
    const row = await file(r);
    r.st.halted = true;
    expect(await r.click(row.token, 'approve')).toEqual({ ok: false, code: 'halted', text: 'The company is halted; approve after /resume.' });
    expect((await repo.byId(row.id))!.status).toBe('pending');
    expect(await r.click(row.token, 'reject')).toMatchObject({ ok: true });
  });
  it('CAS loss: tools.byDept changed meanwhile -> back to pending, nothing written, "changed"; pressing again then works', async () => {
    const r = rigUp();
    const row = await file(r);
    const real = r.deps.cfg.setIf.bind(r.deps.cfg);
    let first = true;
    r.deps.cfg = { get: store.get.bind(store), setIf: async (w: Parameters<typeof real>[0], by: string) => { if (first) { first = false; await store.set('tools.byDept', { software: ['clickup_update_task'] }, 'someone'); } return real(w, by); } } as never;
    const lost = await r.click(row.token, 'approve');
    expect(lost).toEqual({ ok: false, code: 'changed', text: DECIDE_TEXT.changed });
    expect(byDept()).toEqual({ software: ['clickup_update_task'] }); // only the other writer's change
    expect(await repo.byId(row.id)).toMatchObject({ status: 'pending', decidedBy: null, outcome: null });
    expect(r.notices).toHaveLength(0);
    expect(r.audits.some((a) => a.action === 'bot.tools.add')).toBe(false);
    expect(await r.click(row.token, 'approve')).toMatchObject({ ok: true, result: 'approved' });
    expect(byDept()).toEqual({ software: ['clickup_update_task', 'web_search'] });
  });
  it('rule G again at decide: the tool was deregistered or became kindless -> void, no write, head told', async () => {
    const r = rigUp();
    const row = await file(r);
    r.st.registered = r.st.registered.filter((n) => n !== 'web_search');
    expect(await r.click(row.token, 'approve')).toEqual({ ok: false, code: 'void', text: DECIDE_TEXT.void });
    expect(await repo.byId(row.id)).toMatchObject({ status: 'void', outcome: 'not_grantable' });
    expect(byDept()).toEqual({});
    expect(r.notices[0]!.text).toBe(`Tool request #${row.id} (web_search): closed; that tool cannot be granted.`);
  });
  it('already in the list at decide: outcome already, no write', async () => {
    const r = rigUp();
    const row = await file(r);
    await store.set('tools.byDept', { software: ['web_search'] }, 'u');
    expect(await r.click(row.token, 'approve')).toMatchObject({ ok: true, result: 'already' });
    expect(await repo.byId(row.id)).toMatchObject({ status: 'approved', outcome: 'already' });
    expect(r.audits.some((a) => a.action === 'bot.tools.add')).toBe(false);
  });
  it('an exception in the write puts the row back to pending, with the fixed text and an error name only', async () => {
    const r = rigUp();
    const row = await file(r);
    r.deps.cfg = { get: store.get.bind(store), setIf: async () => { throw new Error('db down: secret'); } } as never;
    expect(await r.click(row.token, 'approve')).toEqual({ ok: false, code: 'exception', text: DECIDE_TEXT.exception });
    expect((await repo.byId(row.id))!.status).toBe('pending');
    expect(JSON.stringify(r.logs)).not.toContain('secret');
  });
});

describe('tool_request: expiry sweep and boot recovery', () => {
  it('sweep expires a 7 day old pending request, closes the card, tells the head; leaves a fresh one; a second sweep is a no-op', async () => {
    const r = rigUp();
    const old = await file(r);
    const fresh = await file(r, 'fetch_page');
    await db.pool.query("UPDATE tool_requests SET created_at = now() - interval '7 days 2 hours', expires_at = now() - interval '2 hours' WHERE id = $1", [old.id]);
    expect(await r.svc.sweep()).toBe(1);
    expect(await repo.byId(old.id)).toMatchObject({ status: 'expired' });
    expect((await repo.byId(fresh.id))!.status).toBe('pending');
    expect(r.closed).toEqual([{ channelId: CONFIG_CHANNEL_ID, messageId: old.messageId, note: 'Expired after 7 days without a decision.' }]);
    expect(r.notices).toEqual([{ dept: 'software', text: `Tool request #${old.id} (web_search): expired after 7 days without a decision.` }]);
    expect(await r.svc.sweep()).toBe(0);
    expect(r.notices).toHaveLength(1);
  });
  it('a card close or head notice failure never throws out of the sweep', async () => {
    const r = rigUp();
    const old = await file(r);
    await db.pool.query("UPDATE tool_requests SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE id = $1", [old.id]);
    r.deps.closeCard = async () => { throw new Error('x'); };
    r.deps.notifyHead = async () => { throw new Error('y'); };
    expect(await r.svc.sweep()).toBe(1);
    expect(r.logs.length).toBe(2);
  });
  it('G2-GW-01: settle throws after setIf: the row is not reverted, the reply does not say nothing changed, boot recovery settles it', async () => {
    const r = rigUp();
    const row = await file(r);
    const realSettle = repo.settle.bind(repo);
    let fail = true;
    r.deps.repo = Object.assign(Object.create(repo), { settle: async (...a: Parameters<typeof repo.settle>) => { if (fail) { fail = false; throw new Error('db blip'); } return realSettle(...a); } });
    const res = await r.click(row.token, 'approve');
    expect(res).toMatchObject({ ok: false, code: 'exception' });
    expect((res as { text: string }).text).not.toContain('nothing was changed');
    expect(byDept()).toEqual({ software: ['web_search'] });
    expect(await repo.byId(row.id)).toMatchObject({ status: 'approved', outcome: 'applying' });
    await r.svc.recover();
    expect(await repo.byId(row.id)).toMatchObject({ status: 'approved', outcome: 'ok' });
  });
  it('GW-C20: a crash between the claim and setIf does not strand the request: boot puts it back to pending (unexpired)', async () => {
    const r = rigUp();
    const row = await file(r);
    await repo.claim(row.token, ADMIN); // the process died here
    expect(await repo.byId(row.id)).toMatchObject({ status: 'approved', outcome: 'applying' });
    await r.svc.recover();
    expect(await repo.byId(row.id)).toMatchObject({ status: 'pending', decidedBy: null, outcome: null });
    expect(byDept()).toEqual({});
    expect(await r.click(row.token, 'approve')).toMatchObject({ ok: true }); // and it can still be approved
  });
  it('GW-C20: a crash after setIf (tool listed) settles the claim as ok and tells the head', async () => {
    const r = rigUp();
    const row = await file(r);
    await repo.claim(row.token, ADMIN);
    await store.set('tools.byDept', { software: ['web_search'] }, `user:${ADMIN}`);
    await r.svc.recover();
    expect(await repo.byId(row.id)).toMatchObject({ status: 'approved', outcome: 'ok' });
    expect(r.notices[0]!.text).toContain('approved by a Bot Admin');
  });
  it('GW-C20: an expired claim that was never applied becomes void', async () => {
    const r = rigUp();
    const row = await file(r);
    await repo.claim(row.token, ADMIN);
    await db.pool.query("UPDATE tool_requests SET created_at = now() - interval '8 days', expires_at = now() - interval '1 day' WHERE id = $1", [row.id]);
    await r.svc.recover();
    expect(await repo.byId(row.id)).toMatchObject({ status: 'void', outcome: 'recovered' });
    expect(byDept()).toEqual({});
  });
  it('recover leaves decided rows alone', async () => {
    const r = rigUp();
    const row = await file(r);
    await r.click(row.token, 'approve');
    await r.svc.recover();
    expect(await repo.byId(row.id)).toMatchObject({ status: 'approved', outcome: 'ok' });
    expect(r.notices).toHaveLength(1);
  });
});

describe('tool_request: guard rails (grep)', () => {
  const src = (f: string) => readFileSync(join(dir, f), 'utf8');
  it('never AI-approved: the module reaches neither the AI approver, the skill judge nor the approvals table', () => {
    const code = src('tool-requests.ts') + src('../tools/builtin/grow.ts') + src('../discord/commands/toolreq.ts') + src('../db/repos/grow.ts');
    expect(code).not.toMatch(/ai-approver|AiApprover|skill-judge|SkillJudge|judge-call|JudgeCaller|approvals\.(request|decide)|INSERT INTO approvals|approval\.requested/);
  });
  it('the only config key written is tools.byDept', () => {
    const w = [...src('tool-requests.ts').matchAll(/set(?:If)?\(/g)];
    expect(w.length).toBeGreaterThan(0);
    expect(src('tool-requests.ts')).not.toMatch(/\.set\(/); // no unconditional config write
  });
  it('the tools declare no kind and no approval; no code but /tool and the repo reads tool_ideas (GW-C24)', () => {
    expect(src('../tools/builtin/grow.ts')).not.toMatch(/\bkind:/);
    const out = Array.from(readFileSync(join(dir, '..', 'tools', 'builtin', 'grow.ts'), 'utf8').matchAll(/requiresApproval: \(\) => false/g));
    expect(out).toHaveLength(2);
    for (const f of ['tool-requests.ts', 'retro.ts', 'retro-facts.ts', '../skills/service.ts', '../governance/skill-judge.ts', '../agents/loop/loop.ts', '../discord/commands/tool.ts']) expect(src(f)).not.toMatch(/tool_ideas/);
  });
});

describe('tool_idea', () => {
  const rigIdeas = (over: { halted?: boolean; failNotify?: boolean } = {}) => {
    const audits: { actor: string; action: string; outcome?: string | null }[] = [];
    const notes: { title: string; text: string }[] = [];
    const logs: unknown[] = [];
    const svc = new ToolIdeaService({
      repo: ideaRepo, halted: () => over.halted ?? false, audit: async (e) => void audits.push(e as never), secrets: [], log: { error: (o) => void logs.push(o) },
      notify: async (title, text) => { if (over.failNotify) throw new Error('x'); notes.push({ title, text }); },
    });
    return { svc, audits, notes, logs };
  };
  const input = (name = 'pdf_reader', o: Partial<{ problem: string; example: string }> = {}) => ({ name, problem: o.problem ?? 'We cannot read scanned PDFs at all.', example: o.example ?? 'Read the invoice from the client' });

  it('files a ticket: text, bot-log line, masked row; taint stored (clean run false, tainted run true)', async () => {
    const r = rigIdeas();
    const a = await r.svc.idea(HEAD, CLEAN, input());
    expect(a).toMatchObject({ ok: true });
    expect((a as { text: string }).text).toMatch(/^Tool idea #\d+ \(pdf_reader\) was filed as a ticket\. Nothing is built now\.$/);
    expect(r.notes).toEqual([{ title: 'Tool idea', text: `Tool idea #${(a as { id: number }).id} from software head: pdf_reader` }]);
    const b = await r.svc.idea(HEAD, { tainted: true, task: null }, input('csv_diff'));
    expect(b).toMatchObject({ ok: true });
    const rows = await ideaRepo.listOpen();
    expect(rows.map((x) => [x.name, x.tainted])).toEqual([['pdf_reader', false], ['csv_diff', true]]);
  });
  it('a failed bot-log line keeps the ticket (error name only)', async () => {
    const r = rigIdeas({ failNotify: true });
    expect(await r.svc.idea(HEAD, CLEAN, input())).toMatchObject({ ok: true });
    expect(await count('tool_ideas')).toBe(1);
    expect(JSON.stringify(r.logs)).toBe('[{"errName":"Error"}]');
  });
  it('caps: the 6th open idea refuses; duplicate name refuses; another department is separate; closing frees the name', async () => {
    const r = rigIdeas();
    for (const n of ['aa_1', 'aa_2', 'aa_3', 'aa_4', 'aa_5']) expect(await r.svc.idea(HEAD, CLEAN, input(n))).toMatchObject({ ok: true });
    expect(await r.svc.idea(HEAD, CLEAN, input('aa_6'))).toEqual({ ok: false, code: 'open_cap', error: 'Your department already has 5 open tool ideas.' });
    expect(await r.svc.idea({ kind: 'head', dept: 'rnd' }, CLEAN, input('aa_1'))).toMatchObject({ ok: true });
    const r2 = rigIdeas();
    expect(await r2.svc.idea({ kind: 'head', dept: 'rnd' }, CLEAN, input('aa_1'))).toEqual({ ok: false, code: 'duplicate', error: 'Your department already has an open idea with that name.' });
    const [first] = await ideaRepo.listOpen();
    expect(await r.svc.close(first!.id, ADMIN, null)).toEqual({ ok: true });
    expect(await r.svc.idea(HEAD, CLEAN, input('aa_1'))).toMatchObject({ ok: true });
  });
  it('concurrent filing: 7 at once give 5', async () => {
    const r = rigIdeas();
    const out = await Promise.all(['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'].map((n) => r.svc.idea(HEAD, CLEAN, input(n))));
    expect(out.filter((o) => o.ok)).toHaveLength(5);
    expect(await count('tool_ideas')).toBe(5);
  });
  it('refusals: not_head (praw, persona), halted, secret in problem / example / reason; nothing stored', async () => {
    const r = rigIdeas();
    expect(await r.svc.idea({ kind: 'head', dept: 'praw' }, CLEAN, input())).toMatchObject({ code: 'not_head' });
    expect(await r.svc.idea({ kind: 'persona', personaId: 'x' } as never, CLEAN, input())).toMatchObject({ code: 'not_head' });
    expect(await rigIdeas({ halted: true }).svc.idea(HEAD, CLEAN, input())).toMatchObject({ code: 'halted', error: 'The company is halted; try again after /resume.' });
    const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';
    expect(await r.svc.idea(HEAD, CLEAN, input('pdf_reader', { problem: `Use this key ${key} to call the API` }))).toMatchObject({ code: 'screen' });
    expect(await r.svc.idea(HEAD, CLEAN, input('pdf_reader', { example: key }))).toMatchObject({ code: 'screen' });
    expect(await count('tool_ideas')).toBe(0);
  });
  it('PII is masked in the stored text (an email address)', async () => {
    const r = rigIdeas();
    await r.svc.idea(HEAD, CLEAN, input('mailer', { problem: 'Send the report to somebody@example.com every Monday' }));
    const [row] = await ideaRepo.listOpen();
    expect(row!.problem).not.toContain('somebody@example.com');
  });
  it('schema: bad slug, short or long problem, empty or long example, extra key', () => {
    const ok = { name: 'pdf_reader', problem: 'long enough problem', example: 'e' };
    expect(ToolIdeaInput.safeParse(ok).success).toBe(true);
    for (const bad of [{ ...ok, name: 'Pdf' }, { ...ok, name: '1abc' }, { ...ok, name: 'a' }, { ...ok, name: 'a'.repeat(41) }, { ...ok, problem: 'short' }, { ...ok, problem: 'p'.repeat(501) }, { ...ok, example: ' ' }, { ...ok, example: 'e'.repeat(501) }, { ...ok, extra: 1 }])
      expect(ToolIdeaInput.safeParse(bad).success).toBe(false);
  });
  it('close: fixed replies; a secret-like reason refuses and leaves the idea open; a not-open idea is refused', async () => {
    const r = rigIdeas();
    const a = (await r.svc.idea(HEAD, CLEAN, input())) as { id: number };
    expect(await r.svc.close(a.id, ADMIN, 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789')).toMatchObject({ ok: false });
    expect(await count('tool_ideas', "WHERE status = 'open'")).toBe(1);
    expect(await r.svc.close(a.id, ADMIN, 'duplicate of the pdf tool')).toEqual({ ok: true });
    expect(await r.svc.close(a.id, ADMIN, null)).toEqual({ ok: false, text: 'That idea is not open.' });
    expect((await db.pool.query('SELECT close_reason, closed_by FROM tool_ideas WHERE id = $1', [a.id])).rows[0]).toEqual({ close_reason: 'duplicate of the pdf tool', closed_by: ADMIN });
    expect(r.audits.at(-1)).toMatchObject({ actor: `user:${ADMIN}`, action: 'tool.idea.close' });
    void uuid;
  });
});

import { describe, expect, it } from 'vitest';
import type { OutboundPayload } from '../../agents/loop/payload.js';
import type { ApprovalBatch, AuditEntry, BatchMember } from '../../db/repos/index.js';
import type { BatchDecideResult, TaskGrantResult } from '../../governance/approval/approvals.js';
import { handleInteraction } from './index.js';
import { ADMIN_ROLE, interaction, makeDeps, text } from './test-helpers.js';
import { CONFIG_CHANNEL_ID } from './types.js';

const DIGEST = 'abcdef012345';
const CARD = '1570000000000000002';
const OTHER = '1570000000000000003';
const EXPIRES = new Date('2026-11-10T00:00:00Z');
const mem = (id: number, status: BatchMember['status'] = 'pending'): BatchMember => ({
  id, taskId: 't-1', reason: 'r', estCostUsd: 0, requestedBy: 'head:praw', status, decidedBy: null, createdAt: new Date(), decidedAt: null,
  toolName: 'forum_post', toolInput: { title: `t${id}` }, inputSha256: 'a'.repeat(64), kind: 'tool', live: status === 'pending',
});
const GRANT_ROW = { id: 9, rootId: 'root-1', approvalId: 1, cardMessageId: CARD, expiresAt: EXPIRES, maxCalls: 40, used: 3, usedByTool: { forum_post: 3, '<script>': 9 }, webGrantId: null as number | null };
const OFFER = { maxCalls: 40, hours: 12, web: null };

/** Real-shaped fakes as classes using `this`: the repo of task grants and the card editor. */
class FakeTaskGrants {
  revoked: [number, string, string][] = [];
  unrevoked: typeof GRANT_ROW | null = null;
  constructor(private readonly row: typeof GRANT_ROW = GRANT_ROW) {}
  async get(id: number) { return id === this.row.id ? this.row : null; }
  async revoke(id: number, by: string, why: string) { this.revoked.push([id, by, why]); return this.revoked.length === 1; }
  async unrevokedOfMessage() { return this.unrevoked; }
}
class FakeCard { closedIds: number[] = []; closed(id: number) { this.closedIds.push(id); } }

function setup(o: { batched?: boolean; decideTaskGrant?: (id: number, u: unknown, opts: unknown) => Promise<TaskGrantResult>; decideBatch?: (...a: unknown[]) => Promise<BatchDecideResult>; offer?: (a: unknown) => Promise<unknown>; row?: typeof GRANT_ROW } = {}) {
  const members = [1, 2, 3].map((i) => mem(i));
  const batch: ApprovalBatch = { id: 5, taskId: 't-1', requestedBy: 'head:praw', state: 'posted', itemCount: 3, digest: DIGEST, channelId: CONFIG_CHANNEL_ID, messageId: CARD };
  const closes: unknown[][] = [];
  const updated: { channelId: string; messageId: string; payload: OutboundPayload }[] = [];
  const audits: AuditEntry[] = [];
  const taskCalls: unknown[][] = [];
  const batchCalls: unknown[][] = [];
  const grants = new FakeTaskGrants(o.row);
  const card = new FakeCard();
  const decideTaskGrant = o.decideTaskGrant ?? (async (id: number, u: unknown, opts: unknown) => {
    taskCalls.push([id, u, opts]);
    return { ok: true as const, approval: members.find((m) => m.id === id)!, grant: { id: 9, rootId: 'root-1', expiresAt: EXPIRES, maxCalls: 40, conversation: false, web: null } };
  });
  const decideBatch = o.decideBatch ?? (async (...a: unknown[]) => {
    batchCalls.push(a);
    return { ok: true as const, decided: members, skipped: [], digest: DIGEST, taskId: 't-1', taskGrant: { id: 9, rootId: 'root-1', expiresAt: EXPIRES, maxCalls: 40, conversation: false, web: null } };
  });
  const batches = o.batched === false
    ? { ofApproval: async () => null, get: async () => null, members: async () => members, pendingIds: async () => [1], close: async () => true }
    : { ofApproval: async () => batch, get: async () => batch, members: async () => members, pendingIds: async () => [1, 2, 3], close: async () => true };
  const over = {
    approvals: { decide: async () => ({ ok: false as const, error: 'not_pending' as const }), resumeApproved: async () => 0, decideTaskGrant, decideBatch } as never,
    batches,
    cards: { close: async (...a: unknown[]) => void closes.push(a), update: async (channelId: string, messageId: string, payload: OutboundPayload) => (updated.push({ channelId, messageId, payload }), true) },
    taskGrants: grants as never,
    taskGrantOffer: (o.offer ?? (async () => OFFER)) as never,
    taskCard: card,
    audit: async (e: AuditEntry) => void audits.push(e),
    secrets: [],
  };
  return { members, closes, updated, audits, taskCalls, batchCalls, grants, card, over: over as never };
}
const click = (customId: string, over: { roles?: string[]; messageId?: string | null } = {}) =>
  interaction({ kind: 'button', customId, userId: 'boss', roles: over.roles ?? [ADMIN_ROLE], messageId: over.messageId === undefined ? CARD : over.messageId, messageAuthorId: 'hq' });

describe('TG-C15: router, malformed ids', () => {
  it.each([
    'approval:1:task:x', 'approval:t:9', 'approval:t:x:revoke', 'approval:t:1:revoke:x', `approval:b:1:${DIGEST}:task:x`, 'approval:t:9:revoke\n', 'approval:t::revoke',
    `approval:t:${'1'.repeat(16)}:revoke`, 'approval:t:9:grant', 'approval:t:', `approval:${'1'.repeat(16)}:task`, 'approval:1:task\n', `approval:b:1:${DIGEST.slice(1)}:task`, 'approval:t:-1:revoke',
  ])('%j answers Unknown action and changes nothing', async (id) => {
    const s = setup();
    const t = await makeDeps(s.over);
    const r = await handleInteraction(click(id), t.deps);
    expect(text(r)).toContain('Unknown action.');
    expect(s.taskCalls).toEqual([]);
    expect(s.batchCalls).toEqual([]);
    expect(s.grants.revoked).toEqual([]);
    expect(s.closes).toEqual([]);
    expect(s.updated).toEqual([]);
  });

  it('a non-admin cannot take any task-grant action (guard), nothing is called', async () => {
    const s = setup();
    const t = await makeDeps(s.over);
    for (const id of ['approval:1:task', `approval:b:5:${DIGEST}:task`, 'approval:t:9:revoke']) {
      expect(text(await handleInteraction(click(id, { roles: [] }), t.deps))).toContain('Only Bot Admins');
    }
    expect(s.taskCalls).toEqual([]);
    expect(s.batchCalls).toEqual([]);
    expect(s.grants.revoked).toEqual([]);
  });

  it('without the task-grant deps the buttons answer Unknown action', async () => {
    const s = setup();
    const t = await makeDeps({ ...(s.over as object), taskGrants: undefined } as never);
    for (const id of ['approval:1:task', `approval:b:5:${DIGEST}:task`, 'approval:t:9:revoke']) expect(text(await handleInteraction(click(id), t.deps))).toContain('Unknown action.');
  });
});

describe('TREEGRANT-1: solo and batch clicks', () => {
  it('solo card: decideTaskGrant gets the clicked message and channel, the card closes in place with the task revoke button, the text states scope, caps and the usage line', async () => {
    const s = setup({ batched: false });
    const t = await makeDeps(s.over);
    const r = await handleInteraction(click('approval:1:task'), t.deps);
    expect(s.taskCalls).toHaveLength(1);
    expect(s.taskCalls[0]![0]).toBe(1);
    expect(s.taskCalls[0]![2]).toMatchObject({ messageId: CARD, channelId: expect.any(String) });
    expect(s.closes).toHaveLength(1);
    const [, , note, revoke] = s.closes[0] as [string, string, string, unknown];
    expect(revoke).toEqual({ task: 9 });
    expect(note).toContain('task tree root-1');
    expect(note).toContain('every department and persona in this task tree');
    expect(note).toContain('up to 40 calls');
    expect(note).toContain('Used 0/40');
    expect(note).toContain('Still asks every time');
    expect(s.audits.find((a) => a.action === 'approval.task_grant')).toMatchObject({ outcome: 'ok #1 grant #9' });
    expect(text(r)).toContain('Whole task approved');
  });

  it('the companion web grant shows in the audit and in the card text, with the leak statement', async () => {
    const s = setup({ batched: false, decideTaskGrant: async (id) => ({ ok: true, approval: mem(id), grant: { id: 9, rootId: 'root-1', expiresAt: EXPIRES, maxCalls: 40, conversation: false, web: { id: 4, rootId: 'root-1', expiresAt: EXPIRES, maxFetches: 20, maxHosts: 5, maxUrlChars: 4000 } } }) });
    const t = await makeDeps(s.over);
    await handleInteraction(click('approval:1:task'), t.deps);
    expect((s.closes[0] as unknown[])[2]).toContain('about 4000 characters');
    expect(s.audits.find((a) => a.action === 'approval.task_grant')?.outcome).toBe('ok #1 grant #9 web_grant #4');
  });

  it.each([
    ['not_grantable', 'already has a live approval'], ['root_ended', 'The task has ended.'], ['halted', 'halted'],
  ] as const)('a refused click (%s) answers the fixed text and leaves the card decidable', async (error, expected) => {
    const s = setup({ decideTaskGrant: async () => ({ ok: false, error }) });
    const t = await makeDeps(s.over);
    expect(text(await handleInteraction(click('approval:1:task'), t.deps))).toContain(expected);
    expect(s.closes).toEqual([]);
    expect(s.updated).toEqual([]);
    expect(s.audits).toEqual([]);
  });

  it('halted_after_commit: the approval is audited, the card closes without a revoke button, the reply says it runs after /resume', async () => {
    const s = setup({ batched: false, decideTaskGrant: async () => ({ ok: false, error: 'halted_after_commit', approval: mem(1) }) });
    const t = await makeDeps(s.over);
    const r = await handleInteraction(click('approval:1:task'), t.deps);
    expect(text(r)).toContain('/resume');
    expect(s.closes).toHaveLength(1);
    expect((s.closes[0] as unknown[])[3]).toBeUndefined();
    expect(s.audits.filter((a) => a.action === 'approval.approve')).toEqual([expect.objectContaining({ outcome: 'ok #1 halted_after_commit' })]);
    expect(s.audits.find((a) => a.action === 'approval.task_grant')).toBeUndefined();
  });

  it('a member click on a batch card re-renders the batch card with the task revoke button and the note (never closes it)', async () => {
    const s = setup();
    s.grants.unrevoked = GRANT_ROW;
    const t = await makeDeps(s.over);
    await handleInteraction(click('approval:2:task'), t.deps);
    expect(s.closes).toEqual([]);
    expect(s.updated).toHaveLength(1);
    const b = s.updated[0]!.payload.batchButtons!;
    expect(b.revokeTaskGrantId).toBe(9);
    expect(b.revokeGrantId).toBeUndefined(); // TG-C10: never a web revoke for the companion
    expect(b.grantNote).toContain('Used 3/40 · forum_post×3');
    expect(b.grantNote).not.toContain('<script>'); // TG-C17: only covered tool names
  });

  it('batch :task calls decideBatch with approved + task (never the reject path) and the card ids; refreshes the card and audits', async () => {
    const s = setup();
    const t = await makeDeps(s.over);
    const r = await handleInteraction(click(`approval:b:5:${DIGEST}:task`), t.deps);
    expect(s.batchCalls).toEqual([[5, DIGEST, 'approved', { id: 'boss', isAdmin: true }, { task: true, messageId: CARD, channelId: expect.any(String) }]]);
    expect(s.audits.filter((a) => a.action === 'approval.reject')).toEqual([]);
    expect(s.audits.find((a) => a.action === 'approval.task_grant')).toMatchObject({ outcome: 'ok #1 grant #9' });
    expect(s.updated).toHaveLength(1);
    expect(text(r)).toContain('Whole task approved for task tree root-1');
  });

  it('a refused batch :task leaves the card as it is; halted_after_commit re-renders and says so', async () => {
    const a = setup({ decideBatch: async () => ({ ok: false, error: 'not_grantable' }) });
    expect(text(await handleInteraction(click(`approval:b:5:${DIGEST}:task`), (await makeDeps(a.over)).deps))).toContain("can't be approved from this card");
    expect(a.updated).toEqual([]);
    const b = setup({ decideBatch: async () => ({ ok: false, error: 'halted_after_commit', decided: [mem(1), mem(2)], taskId: 't-1' }) });
    expect(text(await handleInteraction(click(`approval:b:5:${DIGEST}:task`), (await makeDeps(b.over)).deps))).toContain('/resume');
    expect(b.audits.filter((x) => x.action === 'approval.approve').map((x) => x.outcome)).toEqual(['ok #1 halted_after_commit', 'ok #2 halted_after_commit']);
    expect(b.updated).toHaveLength(1);
  });
});

describe('TG-C13/C14: the batch card offer', () => {
  it('a refresh offers the task button only when every member carries an offer (and no grant exists on the message)', async () => {
    const all = setup();
    await handleInteraction(click('approval:2:approve'), (await makeDeps(all.over)).deps);
    expect(all.updated[0]!.payload.batchButtons).toMatchObject({ task: true });
    expect(all.updated[0]!.payload.batchButtons!.grant).toBeUndefined();
    const some = setup({ offer: async (a) => ((a as { id: number }).id === 2 ? null : OFFER) });
    await handleInteraction(click('approval:2:approve'), (await makeDeps(some.over)).deps);
    expect(some.updated[0]!.payload.batchButtons!.task).toBeUndefined();
    const boom = setup({ offer: async () => { throw new Error('db'); } });
    await handleInteraction(click('approval:2:approve'), (await makeDeps(boom.over)).deps);
    expect(boom.updated[0]!.payload.batchButtons!.task).toBeUndefined();
  });
});

describe('TG-C10 / TG-C15: the task revoke button', () => {
  it('on the grant\'s own card it revokes, cancels the pending usage edit, audits and re-renders the batch card', async () => {
    const s = setup();
    const t = await makeDeps(s.over);
    const r = await handleInteraction(click('approval:t:9:revoke'), t.deps);
    expect(s.grants.revoked).toEqual([[9, 'boss', 'admin']]);
    expect(s.card.closedIds).toEqual([9]);
    expect(s.audits.find((a) => a.action === 'task_grant.revoke')).toMatchObject({ outcome: 'admin #9' });
    expect(s.updated).toHaveLength(1);
    expect(s.updated[0]!.payload.batchButtons!.revokeTaskGrantId).toBeUndefined();
    expect(text(r)).toContain('Whole-task approval revoked');
  });

  it('on a solo card it closes in place with the revoked text and the final usage line', async () => {
    const s = setup({ batched: false });
    await handleInteraction(click('approval:t:9:revoke'), (await makeDeps(s.over)).deps);
    expect(s.closes).toHaveLength(1);
    const [, , note, revoke] = s.closes[0] as [string, string, string, unknown];
    expect(note).toContain('revoked');
    expect(note).toContain('Used 3/40');
    expect(revoke).toBeUndefined();
  });

  it('a forged id on another card, an unknown grant and a click without a message change nothing', async () => {
    const s = setup();
    const t = await makeDeps(s.over);
    for (const c of [click('approval:t:9:revoke', { messageId: OTHER }), click('approval:t:77:revoke'), click('approval:t:9:revoke', { messageId: null })]) {
      expect(text(await handleInteraction(c, t.deps))).toContain('does not belong to this card');
    }
    expect(s.grants.revoked).toEqual([]);
    expect(s.card.closedIds).toEqual([]);
    expect(s.updated).toEqual([]);
    expect(s.closes).toEqual([]);
  });

  it('twice answers "Already revoked." and edits nothing the second time', async () => {
    const s = setup();
    const t = await makeDeps(s.over);
    await handleInteraction(click('approval:t:9:revoke'), t.deps);
    expect(text(await handleInteraction(click('approval:t:9:revoke'), t.deps))).toContain('Already revoked.');
    expect(s.updated).toHaveLength(1);
  });

  it('a companion web grant (no card id) is never rendered as a second revoke button, and its own revoke refuses on the task card', async () => {
    const s = setup();
    s.grants.unrevoked = { ...GRANT_ROW, webGrantId: 4 };
    const web = { get: async () => ({ id: 4, rootId: 'root-1', approvalId: 1, cardMessageId: null, maxFetches: 20, maxHosts: 5, maxUrlChars: 4000 }), revoke: async () => true, setCard: async () => undefined, unrevokedOfMessage: async () => null };
    const t = await makeDeps({ ...(s.over as object), webGrants: web } as never);
    await handleInteraction(click('approval:2:approve'), t.deps);
    const b = s.updated[0]!.payload.batchButtons!;
    expect(b.revokeTaskGrantId).toBe(9);
    expect(b.revokeGrantId).toBeUndefined();
    expect(b.grantNote).toContain('about 4000 characters'); // the leak statement is on the card (TG-C11)
    expect(text(await handleInteraction(click('approval:g:4:revoke'), t.deps))).toContain('does not belong to this card');
  });
});

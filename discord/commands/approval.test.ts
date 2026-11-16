import { describe, expect, it } from 'vitest';
import type { OutboundPayload } from '../../agents/loop/payload.js';
import type { ApprovalBatch, AuditEntry, BatchMember } from '../../db/repos/index.js';
import type { BatchDecideResult } from '../../governance/approval/approvals.js';
import { handleInteraction } from './index.js';
import { ADMIN_ROLE, interaction, makeDeps, text } from './test-helpers.js';
import { CONFIG_CHANNEL_ID } from './types.js';

const DIGEST = 'abcdef012345';
const CARD = '1570000000000000002';
const mem = (id: number, status: BatchMember['status'] = 'pending'): BatchMember => ({
  id, taskId: 't-1', reason: 'r', estCostUsd: 0, requestedBy: 'head:praw', status, decidedBy: null, createdAt: new Date(), decidedAt: null,
  toolName: 'fetch_page', toolInput: { url: `https://example.com/${id}` }, inputSha256: 'a'.repeat(64), kind: 'tool', live: status === 'pending',
});

/** A tiny in-memory batch: ids 1..3, decide() flips a row, the card is re-rendered from it. */
function setup(state: ApprovalBatch['state'] = 'posted', ids = [1, 2, 3]) {
  const members = ids.map((i) => mem(i));
  const batch: ApprovalBatch = { id: 5, taskId: 't-1', requestedBy: 'head:praw', state, itemCount: ids.length, digest: DIGEST, channelId: CONFIG_CHANNEL_ID, messageId: CARD };
  const closed: unknown[] = [];
  const updated: { channelId: string; messageId: string; payload: OutboundPayload }[] = [];
  const audits: { action: string; outcome?: string | null; taskId?: string | null; tool?: string | null }[] = [];
  const calls: string[] = [];
  const decideBatchResult: { v: BatchDecideResult | null } = { v: null };
  const decide = async (id: number, decision: string) => {
    calls.push(`decide:${id}:${decision}`);
    const m = members.find((x) => x.id === id);
    if (!m) return { ok: false as const, error: 'not_pending' as const };
    if (decision === 'ask') return { ok: true as const, approval: m };
    if (m.status !== 'pending') return { ok: false as const, error: 'not_pending' as const };
    m.status = decision as 'approved' | 'rejected';
    return { ok: true as const, approval: m };
  };
  const decideBatch = async (batchId: number, digest: string, decision: string): Promise<BatchDecideResult> => {
    calls.push(`decideBatch:${batchId}:${digest}:${decision}`);
    if (decideBatchResult.v) return decideBatchResult.v;
    const pending = members.filter((m) => m.status === 'pending');
    for (const m of pending) m.status = decision as 'approved' | 'rejected';
    return { ok: true, decided: pending, skipped: members.filter((m) => !pending.includes(m)).map((m) => ({ id: m.id, why: 'not_pending' as const })), digest, taskId: 't-1' };
  };
  return {
    members, batch, closed, updated, audits, calls, decideBatchResult,
    over: {
      approvals: { decide, decideBatch, resumeApproved: async () => 0 } as never,
      batches: {
        ofApproval: async (id: number) => (ids.includes(id) ? batch : null),
        get: async (id: number) => (id === batch.id ? batch : null),
        members: async () => members,
        pendingIds: async () => members.filter((m) => m.status === 'pending').map((m) => m.id),
        close: async () => { batch.state = 'closed'; return true; },
      },
      cards: { close: async (c: string, m: string, n: string) => void closed.push([c, m, n]), update: async (channelId: string, messageId: string, payload: OutboundPayload) => (updated.push({ channelId, messageId, payload }), true) },
      audit: async (e: AuditEntry) => void audits.push(e),
      secrets: [],
    },
  };
}
const click = (customId: string, over: { roles?: string[]; messageId?: string | null } = {}) =>
  interaction({ kind: 'button', customId, userId: 'boss', roles: over.roles ?? [ADMIN_ROLE], messageId: over.messageId === undefined ? CARD : over.messageId, messageAuthorId: 'hq' });

describe('B1: a per-item click on a batch card refreshes it instead of closing it', () => {
  it('(a) approve item 1 of 3: items 2 and 3 keep their buttons and Approve all stays (with a lower count)', async () => {
    const s = setup();
    const t = await makeDeps(s.over);
    const r = await handleInteraction(click('approval:1:approve'), t.deps);
    expect(s.closed).toEqual([]);
    expect(s.updated).toHaveLength(1);
    expect(s.updated[0]).toMatchObject({ channelId: CONFIG_CHANNEL_ID, messageId: CARD });
    expect(s.updated[0]!.payload.batchButtons).toEqual({ batchId: 5, digest: DIGEST, grant: true, items: [{ id: 1, pending: false }, { id: 2, pending: true }, { id: 3, pending: true }] });
    expect(s.batch.state).toBe('posted');
    expect(r?.ephemeral).toBe(true);
    expect(text(r)).toContain('The card above shows the decision.');
    expect(s.audits[0]).toMatchObject({ action: 'approval.approve', taskId: 't-1', tool: 'fetch_page', outcome: 'ok #1' });
  });

  it('(b) a double click on item 1 does not close the card', async () => {
    const s = setup();
    const t = await makeDeps(s.over);
    await handleInteraction(click('approval:1:approve'), t.deps);
    const again = await handleInteraction(click('approval:1:approve'), t.deps);
    expect(s.closed).toEqual([]);
    expect(s.updated).toHaveLength(2);
    expect(text(again)).toContain('already decided');
    expect(s.updated[1]!.payload.batchButtons!.items.filter((i) => i.pending).map((i) => i.id)).toEqual([2, 3]);
  });

  it('the last pending item decided closes the card (no components) and the batch', async () => {
    const s = setup();
    const t = await makeDeps(s.over);
    for (const id of [1, 2, 3]) await handleInteraction(click(`approval:${id}:reject`), t.deps);
    expect(s.closed).toEqual([]);
    expect(s.updated.at(-1)!.payload.batchButtons!.items.every((i) => !i.pending)).toBe(true);
    expect(s.batch.state).toBe('closed');
  });

  it('(c) a dissolved solo card closes exactly as today; so does a row that was never batched', async () => {
    const s = setup('dissolved', [7]);
    s.members[0]!.id = 7;
    const t = await makeDeps(s.over);
    await handleInteraction(click('approval:7:approve'), t.deps);
    expect(s.closed).toEqual([[CONFIG_CHANNEL_ID, CARD, 'Approval #7 approved by <@boss>.']]);
    expect(s.updated).toEqual([]);
    const plain = setup('posted', [1]);
    const t2 = await makeDeps({ ...plain.over, batches: { ...plain.over.batches, ofApproval: async () => null } });
    await handleInteraction(click('approval:1:reject'), t2.deps);
    expect(plain.closed).toEqual([[CONFIG_CHANNEL_ID, CARD, 'Approval #1 rejected by <@boss>.']]);
  });

  it('when the batch lookup fails the card is left alone (closing it would remove every other item\'s buttons)', async () => {
    const s = setup();
    const t = await makeDeps({ ...s.over, batches: { ...s.over.batches, ofApproval: async () => { throw new Error('db down'); } } });
    const r = await handleInteraction(click('approval:1:approve'), t.deps);
    expect(s.closed).toEqual([]);
    expect(s.updated).toEqual([]);
    expect(text(r)).toContain('Decided by');
  });

  it('G2AB-01: a card of a batch left sealed (post went out, markPosted failed) is never closed by a per-item click', async () => {
    const s = setup('sealed');
    const t = await makeDeps(s.over);
    const r = await handleInteraction(click('approval:1:approve'), t.deps);
    expect(s.members[0]!.status).toBe('approved');
    expect(s.closed).toEqual([]);
    expect(s.updated).toEqual([]);
    expect(text(r)).toContain('Decided by');
    await handleInteraction(click('approval:1:approve'), t.deps); // a second (stale) click
    expect(s.closed).toEqual([]);
  });

  it('a refresh that fails falls back to the plain reply and never throws', async () => {
    const s = setup();
    const t = await makeDeps({ ...s.over, cards: { close: async () => undefined, update: async () => { throw new Error('discord 500'); } } });
    const r = await handleInteraction(click('approval:2:approve'), t.deps);
    expect(text(r)).toContain('Decided by');
  });
});

describe('G2AB-04: only the batch\'s own card is re-rendered', () => {
  it('a click on another message (forged custom id) edits nothing and gets the plain reply', async () => {
    const s = setup();
    const t = await makeDeps(s.over);
    const r = await handleInteraction(click('approval:1:approve', { messageId: '1570000000000000999' }), t.deps);
    expect(s.updated).toEqual([]);
    expect(s.closed).toEqual([]);
    expect(text(r)).toContain('Decided by');
    const stale = await handleInteraction(click(`approval:b:5:${DIGEST}:approve`, { messageId: '1570000000000000999' }), t.deps);
    expect(s.updated).toEqual([]);
    expect(text(stale)).toContain('Approved');
  });
});

describe('batch buttons', () => {
  const id = (a: string) => `approval:b:5:${DIGEST}:${a}`;

  it('Approve all decides through decideBatch with the clicked digest, refreshes the card and answers with the counts', async () => {
    const s = setup();
    s.members[0]!.status = 'approved';
    const t = await makeDeps(s.over);
    const r = await handleInteraction(click(id('approve')), t.deps);
    expect(s.calls).toEqual([`decideBatch:5:${DIGEST}:approved`]);
    expect(text(r)).toContain('Approved 2 of 3 (1 already decided or expired).');
    expect(s.updated).toHaveLength(1);
    expect(s.audits.map((a) => a.action)).toEqual(['approval.approve', 'approval.approve', 'approval.batch_approve']);
    expect(s.audits[2]).toMatchObject({ taskId: 't-1', outcome: `batch:5 digest:${DIGEST} n=3 decided=2` });
    expect(s.closed).toEqual([]);
    expect(s.batch.state).toBe('closed'); // nothing is pending any more
  });

  it('Deny all says Denied; a second click decides nothing', async () => {
    const s = setup();
    const t = await makeDeps(s.over);
    expect(text(await handleInteraction(click(id('reject')), t.deps))).toContain('Denied 3 of 3.');
    expect(text(await handleInteraction(click(id('reject')), t.deps))).toContain('These approvals were already decided.');
  });

  it('a stale or forged digest is refused with the stale text, the card is refreshed and nothing else changes', async () => {
    const s = setup();
    s.decideBatchResult.v = { ok: false, error: 'stale' };
    const t = await makeDeps(s.over);
    const r = await handleInteraction(click(id('approve')), t.deps);
    expect(text(r)).toContain('This card changed; review it again.');
    expect(s.updated).toHaveLength(1);
    expect(s.audits.map((a) => [a.action, a.outcome])).toEqual([['approval.batch_approve', `batch:5 digest:${DIGEST} stale`]]);
  });

  it('not_found answers Unknown action; a non-admin gets the admin text and no audit row', async () => {
    const s = setup();
    s.decideBatchResult.v = { ok: false, error: 'not_found' };
    const t = await makeDeps(s.over);
    expect(text(await handleInteraction(click(id('approve')), t.deps))).toContain('Unknown action.');
    s.decideBatchResult.v = { ok: false, error: 'not_admin' };
    s.audits.length = 0;
    expect(text(await handleInteraction(click(id('reject')), t.deps))).toContain('Only Bot Admins can do this.');
    expect(s.audits).toEqual([]);
    const nonAdmin = await handleInteraction(click(id('approve'), { roles: ['1'] }), t.deps);
    expect(text(nonAdmin)).toContain('Only Bot Admins can do this.');
  });

  it('B12: Ask changes nothing: no decision call, no card edit, one summary audit row, code-written text listing the pending ids', async () => {
    const s = setup();
    s.members[1]!.status = 'approved';
    const t = await makeDeps(s.over);
    const r = await handleInteraction(click(id('ask')), t.deps);
    expect(s.calls).toEqual([]);
    expect(s.updated).toEqual([]);
    expect(s.closed).toEqual([]);
    expect(s.members.map((m) => m.status)).toEqual(['pending', 'approved', 'pending']);
    expect(s.audits).toEqual([expect.objectContaining({ action: 'approval.batch_ask', taskId: 't-1', outcome: `batch:5 digest:${DIGEST} n=2 decided=0` })]);
    expect(text(r)).toContain('Batch stays pending (#1, #3); ask the requester for details, then decide.');
  });

  it('Ask with a digest that does not match the stored one is stale', async () => {
    const s = setup();
    const t = await makeDeps(s.over);
    const r = await handleInteraction(click(`approval:b:5:${'0'.repeat(12)}:ask`), t.deps);
    expect(text(r)).toContain('This card changed; review it again.');
    expect(s.audits.map((a) => a.outcome)).toEqual([`batch:5 digest:${'0'.repeat(12)} stale`]);
  });

  it('B8: anything that matches neither custom id shape answers "Unknown action." and makes no DB call', async () => {
    const s = setup();
    const t = await makeDeps(s.over);
    for (const bad of [
      `approval:b:${'1'.repeat(16)}:${DIGEST}:approve`, `approval:b:5:${DIGEST.toUpperCase()}:approve`, `approval:b:5:${DIGEST}0:approve`,
      `approval:b:5:${DIGEST.slice(0, 11)}:approve`, `approval:b:5:${DIGEST}:approve:x`, 'approval:b:5:approve', 'approval:b::approve', 'approval:5:approve:x',
      `approval:b:5:${DIGEST}:delete`, 'approval:', 'approval:b:5:abcdef012345:approve\n',
      // Gate 2 (W-C11): the grant and revoke shapes, malformed
      'approval:g::revoke', `approval:g:${'1'.repeat(16)}:revoke`, 'approval:g:9:revoke:x', 'approval:g:9:revoke\n', 'approval:g:a:revoke',
      'approval:g:9:grant', 'approval:g:9', 'approval:1:grant:x', 'approval:1:grant\n', `approval:${'1'.repeat(16)}:grant`, `approval:b:5:${DIGEST}:revoke`,
    ]) {
      const r = await handleInteraction(click(bad), t.deps);
      expect(text(r), bad).toContain('Unknown action.');
    }
    expect(s.calls).toEqual([]);
    expect(s.audits).toEqual([]);
    expect(s.updated).toEqual([]);
  });

  it('without a decideBatch (older wiring) a batch click answers Unknown action and decides nothing', async () => {
    const s = setup();
    const t = await makeDeps({ ...s.over, approvals: { decide: async () => ({ ok: false, error: 'not_pending' }), resumeApproved: async () => 0 } });
    expect(text(await handleInteraction(click(id('approve')), t.deps))).toContain('Unknown action.');
  });
});

// ---- WEBGRANT-1 (W-C11, D5, D6, D10) ----
const GRANT = { id: 9, rootId: 'root-1', expiresAt: new Date('2026-11-08T16:00:00Z'), maxFetches: 20, maxHosts: 5, maxUrlChars: 4000 };
const NOT_CARD = '1570000000000000099';
function grantSetup(over: { decideGrant?: (id: number) => Promise<unknown>; decideBatch?: (...a: unknown[]) => Promise<unknown>; cardMessageId?: string | null; ids?: number[]; batched?: boolean } = {}) {
  const s = setup('posted', over.ids ?? [1, 2, 3]);
  const grantCalls: number[] = [];
  const batchCalls: unknown[][] = [];
  const store = { cards: [] as [number, string][], revoked: [] as [number, string, string][], unrevoked: null as { id: number } | null };
  const grantOpts: unknown[] = [];
  const decideGrant = over.decideGrant ?? (async (id: number, _u?: unknown, o?: unknown) => {
    grantCalls.push(id);
    grantOpts.push(o);
    const m = s.members.find((x) => x.id === id)!;
    m.status = 'approved';
    return { ok: true as const, approval: m, grant: GRANT };
  });
  const decideBatch = over.decideBatch ?? (async (...a: unknown[]) => {
    batchCalls.push(a);
    for (const m of s.members) if (m.status === 'pending') m.status = 'approved';
    return { ok: true as const, decided: s.members, skipped: [], digest: DIGEST, taskId: 't-1', grant: GRANT };
  });
  const webGrants = {
    get: async (id: number) => (id === GRANT.id ? { id, rootId: 'root-1', approvalId: 1, cardMessageId: over.cardMessageId === undefined ? CARD : over.cardMessageId } : null),
    revoke: async (id: number, by: string, why: string) => { store.revoked.push([id, by, why]); return store.revoked.length === 1; },
    setCard: async (id: number, m: string) => void store.cards.push([id, m]),
    unrevokedOfMessage: async () => store.unrevoked,
  };
  const batches = over.batched === false ? { ...(s.over.batches as object), ofApproval: async () => null } : s.over.batches;
  return { s, grantCalls, grantOpts, batchCalls, store, over: { ...s.over, batches, webGrants, approvals: { ...(s.over.approvals as object), decideGrant, decideBatch } } as never };
}

describe('WEBGRANT-1: grant and revoke buttons', () => {
  it('grant on a batch member refreshes the batch card, records its message, never closes it (W-C11a)', async () => {
    const g = grantSetup();
    g.store.unrevoked = { id: 9, rootId: 'root-1', expiresAt: GRANT.expiresAt, maxFetches: 20, maxHosts: 5, maxUrlChars: 4000 } as never; // what the DB returns once the card is recorded
    const t = await makeDeps(g.over);
    const r = await handleInteraction(click('approval:2:grant'), t.deps);
    expect(g.grantCalls).toEqual([2]);
    // W-C9/W-C10: the refreshed batch card itself carries the revoke button and the closing text (message content), not only the admin's private reply
    expect(g.s.updated[0]!.payload.batchButtons).toMatchObject({ revokeGrantId: 9, grantNote: expect.stringContaining('about 4000 characters of what it has read in this task tree') });
    expect(g.s.updated[0]!.payload.batchButtons!.grantNote).toContain('every department working on this task tree');
    expect(g.s.closed).toEqual([]);
    expect(g.s.updated).toHaveLength(1);
    expect(g.grantOpts).toEqual([{ messageId: CARD }]); // G2W-03: the card id travels into the grant transaction, no separate write
    expect(g.store.cards).toEqual([]);
    expect(g.s.audits.find((a) => a.action === 'approval.grant')).toMatchObject({ outcome: 'ok #2 grant #9' });
    expect(text(r)).toContain('task tree root-1');
  });

  it('grant on a solo card closes it in place with the revoke button and the honest closing text (D10, W-C9, W-C10)', async () => {
    const g = grantSetup({ batched: false });
    const closes: unknown[][] = [];
    const t = await makeDeps({ ...(g.over as object), cards: { close: async (...a: unknown[]) => void closes.push(a), update: async () => true } } as never);
    await handleInteraction(click('approval:1:grant'), t.deps);
    expect(closes).toHaveLength(1);
    const [, , note, revokeId] = closes[0] as [string, string, string, number];
    expect(revokeId).toBe(9);
    expect(note).toContain('every department working on this task tree');
    expect(note).toContain('about 4000 characters');
    expect(note).toContain('20 pages on up to 5 sites');
  });

  it('a refused grant (not_grantable, root_ended, halted) answers the fixed text and leaves the card alone', async () => {
    for (const [error, expected] of [
      ['not_grantable', "Web reading can't be allowed for this card; decide it with Approve or Reject."],
      ['root_ended', 'The task has ended.'],
      ['halted', 'halted'],
    ] as const) {
      const g = grantSetup({ decideGrant: async () => ({ ok: false, error }) });
      const t = await makeDeps(g.over);
      const r = await handleInteraction(click('approval:1:grant'), t.deps);
      expect(text(r)).toContain(expected);
      expect(g.s.closed).toEqual([]);
      expect(g.s.updated).toEqual([]);
      expect(g.s.audits).toEqual([]);
    }
  });

  it('G2W-07: halted_after_commit on a solo card says approved, no web reading, runs after /resume, and closes the card in place', async () => {
    const g = grantSetup({ batched: false, decideGrant: async () => ({ ok: false, error: 'halted_after_commit', approval: { id: 1, taskId: 't-1', toolName: 'fetch_page' } }) });
    const closes: unknown[][] = [];
    const t = await makeDeps({ ...(g.over as object), cards: { close: async (...a: unknown[]) => void closes.push(a), update: async () => true } } as never);
    const r = await handleInteraction(click('approval:1:grant'), t.deps);
    const reply = text(r).toLowerCase();
    expect(reply).toContain('approved');
    expect(reply).toContain('web reading was not allowed');
    expect(reply).toContain('/resume');
    expect(closes).toHaveLength(1);
    expect(g.s.audits.filter((a) => a.action === 'approval.approve')).toEqual([expect.objectContaining({ taskId: 't-1', tool: 'fetch_page', outcome: 'ok #1 halted_after_commit' })]);
    expect(g.s.audits.find((a) => a.action === 'approval.grant')).toBeUndefined();
    const [, , note, revokeId] = closes[0] as [string, string, string, number | undefined];
    expect(note.toLowerCase()).toContain('/resume');
    expect(revokeId).toBeUndefined();
  });

  it('G2W-07: halted_after_commit on a batch grant re-renders the batch card and says the same', async () => {
    const g = grantSetup({ decideBatch: async () => ({ ok: false, error: 'halted_after_commit', decided: [{ id: 1, taskId: 't-1', toolName: 'fetch_page' }, { id: 2, taskId: 't-1', toolName: 'fetch_page' }], taskId: 't-1' }) });
    const t = await makeDeps(g.over);
    const r = await handleInteraction(click(`approval:b:5:${DIGEST}:grant`), t.deps);
    expect(text(r).toLowerCase()).toContain('web reading was not allowed');
    expect(g.s.audits.filter((a) => a.action === 'approval.approve').map((a) => a.outcome)).toEqual(['ok #1 halted_after_commit', 'ok #2 halted_after_commit']);
    expect(g.s.updated).toHaveLength(1);
    expect(g.s.closed).toEqual([]);
  });

  it('G2W-07: halted_after_commit on a member click re-renders the batch card, never closes it', async () => {
    const g = grantSetup({ decideGrant: async () => ({ ok: false, error: 'halted_after_commit', approval: { id: 1, taskId: 't-1', toolName: 'fetch_page' } }) });
    const t = await makeDeps(g.over);
    const r = await handleInteraction(click('approval:2:grant'), t.deps);
    expect(text(r).toLowerCase()).toContain('/resume');
    expect(g.s.updated).toHaveLength(1);
    expect(g.s.closed).toEqual([]);
  });

  it('batch grant calls decideBatch with approved + grant, never the reject path (trap: grant is not Deny all)', async () => {
    const g = grantSetup();
    const t = await makeDeps(g.over);
    const r = await handleInteraction(click(`approval:b:5:${DIGEST}:grant`), t.deps);
    expect(g.batchCalls).toEqual([[5, DIGEST, 'approved', { id: 'boss', isAdmin: true }, { grant: true, messageId: CARD }]]);
    expect(g.s.audits.filter((a) => a.action === 'approval.reject')).toEqual([]);
    expect(g.s.audits.find((a) => a.action === 'approval.grant')).toMatchObject({ outcome: 'ok #1 grant #9' });
    expect(g.store.cards).toEqual([]); // recorded inside decideBatch, not afterwards
    expect(text(r)).toContain('Web reading allowed for task tree root-1');
  });

  it('a refused batch grant (not_grantable) leaves the card as it is and does not refresh it', async () => {
    const g = grantSetup({ decideBatch: async () => ({ ok: false, error: 'not_grantable' }) });
    const t = await makeDeps(g.over);
    const r = await handleInteraction(click(`approval:b:5:${DIGEST}:grant`), t.deps);
    expect(text(r)).toContain("Web reading can't be allowed for this card");
    expect(g.s.updated).toEqual([]);
    expect(g.s.closed).toEqual([]);
  });

  it('revoke on the grant\'s own card revokes, audits and re-renders the batch card without the revoke button', async () => {
    const g = grantSetup();
    const t = await makeDeps(g.over);
    const r = await handleInteraction(click('approval:g:9:revoke'), t.deps);
    expect(g.s.updated[0]!.payload.batchButtons!.grantNote).toBeUndefined(); // nothing unrevoked on the message any more
    expect(g.store.revoked).toEqual([[9, 'boss', 'admin']]);
    expect(g.s.audits.find((a) => a.action === 'web_grant.revoke')).toMatchObject({ outcome: 'admin #9' });
    expect(g.s.updated).toHaveLength(1);
    expect(text(r)).toContain('Web reading revoked');
  });

  it('forged revoke on another card does not edit it and does not revoke (W-C11b)', async () => {
    const g = grantSetup();
    const t = await makeDeps(g.over);
    const r = await handleInteraction(click('approval:g:9:revoke', { messageId: NOT_CARD }), t.deps);
    expect(text(r)).toContain('does not belong to this card');
    expect(text(r)).toContain('/halt'); // G2W-03: the reply names the stop that always works
    expect(g.store.revoked).toEqual([]);
    expect(g.s.updated).toEqual([]);
    expect(g.s.closed).toEqual([]);
    const unknown = await handleInteraction(click('approval:g:77:revoke'), t.deps);
    expect(text(unknown)).toContain('does not belong to this card');
    const noMsg = await handleInteraction(click('approval:g:9:revoke', { messageId: null }), t.deps);
    expect(text(noMsg)).toContain('does not belong to this card');
    expect(g.s.closed).toEqual([]);
  });

  it('revoke twice answers "Already revoked."', async () => {
    const g = grantSetup();
    const t = await makeDeps(g.over);
    await handleInteraction(click('approval:g:9:revoke'), t.deps);
    expect(text(await handleInteraction(click('approval:g:9:revoke'), t.deps))).toContain('Already revoked.');
  });

  it('a non-admin cannot grant or revoke (guard)', async () => {
    const g = grantSetup();
    const t = await makeDeps(g.over);
    for (const id of ['approval:1:grant', `approval:b:5:${DIGEST}:grant`, 'approval:g:9:revoke']) {
      expect(text(await handleInteraction(click(id, { roles: [] }), t.deps))).toContain('Only Bot Admins');
    }
    expect(g.grantCalls).toEqual([]);
    expect(g.batchCalls).toEqual([]);
    expect(g.store.revoked).toEqual([]);
  });

  it('without the web grant wiring, grant and revoke answer Unknown action', async () => {
    const s = setup();
    const t = await makeDeps(s.over);
    for (const id of ['approval:1:grant', `approval:b:5:${DIGEST}:grant`, 'approval:g:9:revoke']) expect(text(await handleInteraction(click(id), t.deps)), id).toContain('Unknown action.');
  });
});

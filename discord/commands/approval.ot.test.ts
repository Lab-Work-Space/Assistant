import { describe, expect, it } from 'vitest';
import type { OtRequest } from '../../db/repos/ot-requests.js';
import type { OtDecided } from '../../governance/spend/ot.js';
import { handleInteraction } from './index.js';
import { ADMIN_ROLE, interaction, makeDeps, text } from './test-helpers.js';
import { CONFIG_CHANNEL_ID, type CommandDeps } from './types.js';

const DIGEST = 'abcdef012345';
const CARD = '1570000000000000002';
const row = (over: Partial<OtRequest> = {}): OtRequest => ({
  id: 4, rootId: 'root-1', localDay: '2026-11-07', seq: 1, requestedBy: '123456789012345678', digest: DIGEST, status: 'approved', cardChannelId: CONFIG_CHANNEL_ID, cardMessageId: CARD,
  createdAt: new Date(), expiresAt: new Date(Date.now() + 3600_000), decidedBy: 'boss', decidedAt: new Date(), grantExpiresAt: new Date(Date.now() + 3600_000),
  maxRuns: 30, runsUsed: 0, maxUsd: 2, usdBase: 0, revokedAt: null, revokedBy: null, revokeReason: null, ...over,
});

type Call = { kind: string; arg: Record<string, unknown> };
function fakeOt(answer: OtDecided = { ok: true, row: row() }) {
  const calls: Call[] = [];
  const ot: NonNullable<CommandDeps['ot']> = {
    decide: async (c) => (calls.push({ kind: `decide:${c.action}`, arg: c }), answer),
    decideDay: async (c, openDay) => {
      calls.push({ kind: 'day', arg: c });
      const o = await openDay('2026-11-07', c.userId);
      calls.push({ kind: 'openDay', arg: o });
      return answer;
    },
    revoke: async (c) => (calls.push({ kind: 'revoke', arg: c }), answer),
    revokeAll: async () => 0,
  };
  return { ot, calls, answer };
}
const click = (customId: string, over: { roles?: string[]; messageId?: string | null; channelId?: string | null } = {}) =>
  interaction({ kind: 'button', customId, userId: 'boss', roles: over.roles ?? [ADMIN_ROLE], messageId: over.messageId === undefined ? CARD : over.messageId, channelId: over.channelId === undefined ? CONFIG_CHANNEL_ID : over.channelId, messageAuthorId: 'hq' });
const id = (a: string) => `approval:ot:4:${DIGEST}:${a}`;

describe('OT-1 OT-C16: the approval:ot: buttons', () => {
  it('approve, deny, day and revoke each reach the service with the clicked message, the digest and the user (never the other ids)', async () => {
    const f = fakeOt();
    const t = await makeDeps({ ot: f.ot });
    for (const a of ['approve', 'deny', 'revoke']) await handleInteraction(click(id(a)), t.deps);
    expect(f.calls.map((c) => c.kind)).toEqual(['decide:approve', 'decide:deny', 'revoke']);
    expect(f.calls[0]!.arg).toEqual({ id: 4, digest: DIGEST, userId: 'boss', channelId: CONFIG_CHANNEL_ID, messageId: CARD, action: 'approve' });
  });

  it('the replies are private (deferred ephemeral) and name the grant on approve', async () => {
    const f = fakeOt();
    const t = await makeDeps({ ot: f.ot });
    const i = click(id('approve'));
    const r = await handleInteraction(i, t.deps);
    expect(i.deferred).toEqual({ ephemeral: true });
    expect(text(r)).toMatch(/OT approved for this task tree: up to 30 runs and \$2\.00/);
  });

  it('OT-C17: the whole-day reply says every held work opens, not only this tree; it opens the day with the same plan as /holiday workday', async () => {
    const f = fakeOt();
    const t = await makeDeps({ ot: f.ot });
    const r = await handleInteraction(click(id('day')), t.deps);
    expect(text(r)).toMatch(/ALL held work/);
    expect(f.calls.find((c) => c.kind === 'openDay')!.arg).toEqual({ ok: true });
    expect(t.deps.cfg.get('schedule.workDays')).toContain('2026-11-07');
    expect((t.audits as { action: string; tool?: string }[]).some((a) => a.action === 'holiday.workday' && a.tool === '2026-11-07')).toBe(true);
  });

  it('whole day on a day that is already a workday counts as done (the plan error is a success), other plan errors are refused with the claim handed back', async () => {
    const f = fakeOt();
    const t = await makeDeps({ ot: f.ot });
    await t.deps.cfg.set('schedule.workDays', ['2026-11-07'], 'x');
    await handleInteraction(click(id('day')), t.deps);
    expect(f.calls.find((c) => c.kind === 'openDay')!.arg).toMatchObject({ ok: false, already: true });
    const g = fakeOt({ ok: false, error: 'day_failed', text: 'boom' });
    const u = await makeDeps({ ot: g.ot });
    expect(text(await handleInteraction(click(id('day')), u.deps))).toContain('The workday could not be opened: boom');
  });

  it('each error has its fixed text', async () => {
    const want: Record<string, string> = {
      not_pending: 'Already decided.', expired: 'The day this request was for has ended.', halted: 'The company is halted; approve after /resume.',
      halted_after_commit: 'Approved, but a halt landed; OT was revoked.', root_ended: 'The task tree has ended.', moot: 'Today is already a workday.',
      disabled: 'OT requests are switched off.', wrong_card: 'That button does not belong to this card.', not_found: 'That button does not belong to this card.',
    };
    for (const [error, msg] of Object.entries(want)) {
      const t = await makeDeps({ ot: fakeOt({ ok: false, error: error as never }).ot });
      expect(text(await handleInteraction(click(id('approve')), t.deps)), error).toContain(msg);
    }
  });

  it('a null message id (or channel id) is refused before any service call', async () => {
    const f = fakeOt();
    const t = await makeDeps({ ot: f.ot });
    expect(text(await handleInteraction(click(id('approve'), { messageId: null }), t.deps))).toContain('does not belong to this card');
    expect(f.calls).toHaveLength(0);
  });

  it('malformed approval:ot: shapes never reach the service nor fall through to the other approval handlers', async () => {
    const f = fakeOt();
    const t = await makeDeps({ ot: f.ot });
    for (const bad of ['approval:ot:', 'approval:ot:4', `approval:ot:4:${DIGEST}`, `approval:ot:4:${DIGEST}:reject`, `approval:ot:4:${DIGEST.toUpperCase()}:approve`, `approval:ot:x:${DIGEST}:approve`, `approval:ot:4:${DIGEST}:approve:more`]) {
      expect(text(await handleInteraction(click(bad), t.deps)), bad).toContain('Unknown action.');
    }
    expect(f.calls).toHaveLength(0);
  });

  it('an OT id clicked in a category approvals room is passed with that room as the clicked channel, so the stored card never matches (wrong_card)', async () => {
    const room = '1570000000000000777';
    const f = fakeOt({ ok: false, error: 'wrong_card' });
    const t = await makeDeps({ ot: f.ot });
    await t.deps.cfg.set('approvals.channelByCategory', { '1570000000000000555': room }, 'x');
    const r = await handleInteraction(click(id('approve'), { channelId: room }), t.deps);
    expect(f.calls[0]!.arg).toMatchObject({ channelId: room });
    expect(text(r)).toContain('does not belong to this card');
  });

  it('a non-Bot-Admin is refused by the guard before any handler, in #setting and in an approvals room', async () => {
    const f = fakeOt();
    const t = await makeDeps({ ot: f.ot });
    expect(text(await handleInteraction(click(id('approve'), { roles: [] }), t.deps))).toContain('Only Bot Admins');
    expect(f.calls).toHaveLength(0);
    const room = '1570000000000000777';
    await t.deps.cfg.set('approvals.channelByCategory', { '1570000000000000555': room }, 'x');
    expect(text(await handleInteraction(click(id('approve'), { roles: [], channelId: room }), t.deps))).toContain('Only Bot Admins');
    expect(f.calls).toHaveLength(0);
  });

  it('an OT button elsewhere (not #setting, not an approvals room) is refused', async () => {
    const f = fakeOt();
    const t = await makeDeps({ ot: f.ot });
    expect(text(await handleInteraction(click(id('approve'), { channelId: '1570000000000000888' }), t.deps))).toContain('#⚙️-setting');
    expect(f.calls).toHaveLength(0);
  });

  it('without the service wired the button answers Unknown action', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(click(id('approve')), t.deps))).toContain('Unknown action.');
  });

  it('a service fault answers a fixed text and changes nothing', async () => {
    const t = await makeDeps({ ot: { ...fakeOt().ot, decide: async () => { throw new Error('secret db text'); } } });
    const r = await handleInteraction(click(id('approve')), t.deps);
    expect(text(r)).toContain('nothing was changed');
    expect(text(r)).not.toContain('secret db text');
  });
});

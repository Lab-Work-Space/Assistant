import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CARD_KIND_MIN_TIER, MIN_TIER, TIER_LIMITS, cardKindMinTier, kindsFor, normalizeChannelName, opMinTier, opsTierProblem, rankOf, tierOf, timeoutMaxMinutes } from './tiers.js';
import { ServerOp } from './server/server-ops.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROLES = { botAdminRoleId: 'A', managerId: 'M', moderatorId: 'D' };

describe('T2: one op-to-tier table, shared and pure', () => {
  it('every ServerOp kind has exactly one entry, and the table has no stray entries', () => {
    const kinds = ServerOp.options.map((o) => o.shape.kind.value as string).sort();
    expect(Object.keys(MIN_TIER).sort()).toEqual(kinds);
  });
  it('every card kind has an entry; config, admin_op, perm, knowledge and deploy are Bot Admin only', () => {
    expect(Object.keys(CARD_KIND_MIN_TIER).sort()).toEqual(['admin_op', 'code', 'config', 'deploy', 'knowledge', 'perm', 'server', 'skill']);
    for (const k of ['config', 'admin_op', 'perm', 'knowledge', 'deploy', 'code', 'skill']) expect(cardKindMinTier(k)).toBe('bot_admin');
    expect(cardKindMinTier('server')).toBe('per_op');
    expect(cardKindMinTier('something_new')).toBe('bot_admin');
  });
  it('an unknown op kind is Bot Admin only', () => {
    expect(opMinTier('frobnicate')).toBe('bot_admin');
    expect(opsTierProblem('manager', [{ kind: 'frobnicate' }])).toContain('bot admin');
    expect(opsTierProblem('bot_admin', [{ kind: 'frobnicate' }])).toBeNull();
  });
  it('the spec table: ban, unban, channel.delete, AutoMod, guild, welcome are Bot Admin; kick, channels, invites, events, nick are Manager; the moderation set is Moderator', () => {
    for (const k of ['member.ban', 'member.unban', 'channel.delete', 'thread.delete', 'guild.edit', 'welcome.resume', 'automod.create', 'automod.edit', 'automod.enable', 'automod.disable', 'automod.delete']) expect(MIN_TIER[k as keyof typeof MIN_TIER], k).toBe('bot_admin');
    for (const k of ['member.kick', 'member.nick', 'invite.create', 'invite.revoke', 'channel.edit', 'channel.move', 'channel.make', 'channel.archive', 'event.create', 'event.edit', 'event.cancel', 'thread.unlock']) expect(MIN_TIER[k as keyof typeof MIN_TIER], k).toBe('manager');
    for (const k of ['msg.delete', 'msg.bulk', 'msg.pin', 'msg.unpin', 'member.timeout', 'member.untimeout', 'thread.archive', 'thread.lock']) expect(MIN_TIER[k as keyof typeof MIN_TIER], k).toBe('moderator');
    expect(kindsFor('moderator')).toHaveLength(8);
    expect(kindsFor('manager')).toHaveLength(8 + 12);
    expect(kindsFor('bot_admin')).toHaveLength(Object.keys(MIN_TIER).length);
  });
  it('limits: bulk 50, timeout 1 day / 28 days, 5 member ops per card, no NSFW flag for a tier', () => {
    expect(TIER_LIMITS.moderator.bulkMax).toBe(50);
    expect(timeoutMaxMinutes('moderator')).toBe(1440);
    expect(timeoutMaxMinutes('manager')).toBe(40_320);
    expect(opsTierProblem('moderator', [{ kind: 'msg.bulk', count: 51 }])).toContain('50');
    expect(opsTierProblem('moderator', [{ kind: 'msg.bulk', count: 50 }])).toBeNull();
    expect(opsTierProblem('moderator', [{ kind: 'member.timeout', minutes: 1441 }])).toContain('1440');
    expect(opsTierProblem('manager', [{ kind: 'member.timeout', minutes: 40_321 }])).toContain('40320');
    expect(opsTierProblem('manager', [{ kind: 'channel.edit', nsfw: true }])).toContain('NSFW');
    expect(opsTierProblem('manager', Array.from({ length: 6 }, () => ({ kind: 'member.nick' })))).toContain('5');
    expect(opsTierProblem('moderator', [{ kind: 'msg.bulk' }])).not.toBeNull(); // a missing number is not a pass
  });
});

describe('tierOf', () => {
  it('is the highest tier held; none without a configured role; a switched-off tier gives nothing', () => {
    expect(tierOf(['M', 'D'], ROLES)).toBe('manager');
    expect(tierOf(['D'], ROLES)).toBe('moderator');
    expect(tierOf(['D', 'A'], ROLES)).toBe('bot_admin');
    expect(tierOf(['x'], ROLES)).toBeNull();
    expect(tierOf(['M'], { ...ROLES, managerId: null })).toBeNull();
    expect(tierOf(['A'], { ...ROLES, botAdminRoleId: '' })).toBeNull();
    expect(rankOf('moderator')).toBeLessThan(rankOf('manager'));
    expect(rankOf('manager')).toBeLessThan(rankOf('bot_admin'));
    expect(rankOf(null)).toBe(0);
  });
  it('normalizes channel names so emoji, case and spacing cannot dodge a reserved name', () => {
    expect(normalizeChannelName('🛡️-Mod Room')).toBe('modroom');
    expect(normalizeChannelName('mod_room')).toBe('modroom');
  });
});

describe('T23: the executor apply path checks the tiers before any write (static)', () => {
  const src = readFileSync(join(ROOT, 'executor/service.ts'), 'utf8');
  const apply = src.slice(src.indexOf('private async doApply('), src.indexOf('private async runServer('));
  it('doApply fetches proposer and decider live before it can reach perm.apply, the rate gate or runServer', () => {
    const at = (s: string) => apply.indexOf(s);
    expect(at('this.authority(card.proposerId')).toBeGreaterThan(0);
    expect(at('this.authority(card.decidedBy')).toBeGreaterThan(0);
    for (const write of ['this.perm.apply(', 'this.runServer(', 'this.d.rate.check(', 'checkServerOps(']) expect(at('this.authority(card.proposerId'), write).toBeLessThan(at(write));
    expect(at('this.authority(card.decidedBy')).toBeLessThan(at('this.runServer('));
  });
  it('the stored tier is never read as authority: the only read of snapshot.tier is the mismatch comparison', () => {
    expect(src.match(/snapshot as \{ tier\?/g)).toHaveLength(1);
    expect(apply).toContain('proposedAs !== tier');
  });
  it('the main process never computes a tier for the executor: the IPC propose request carries no tier', () => {
    expect(readFileSync(join(ROOT, 'executor/ipc.ts'), 'utf8')).not.toMatch(/op: z\.literal\('propose'\)[^\n]*tier/);
    expect(readFileSync(join(ROOT, 'admin/executor-port.ts'), 'utf8')).not.toMatch(/op: 'propose'[^\n]*tier/);
  });
});

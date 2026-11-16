import { describe, expect, it, vi } from 'vitest';
import type { ReleaseView } from '../../db/repos/releases.js';
import { DECIDE_TEXT, ReleaseService, type ReleaseDeps } from '../../releases/service.js';
import { handleInteraction } from './index.js';
import { ADMIN_ROLE, cmd, interaction, makeDeps, text } from './test-helpers.js';
import { CONFIG_CHANNEL_ID } from './types.js';

const TOKEN = 'ab'.repeat(16);
const CARD_MSG = '800000000000000011';
const GUILD = '1565649426943442944';
const SRC = '700000000000000001';
const THREAD = '700000000000000002';
const REL_MSG = '800000000000000099';
const row = (over: Partial<ReleaseView> = {}): ReleaseView => ({
  id: 7, deptId: 'software', requester: 'head:software', taskId: 't', rootId: 'r', projectId: null, target: 'handoff', title: 'Title', summary: 'Summary', slug: 'proj-a', sha256: 'c'.repeat(64),
  bytes: 10, files: 2, skipped: 0, evidence: { runs: [], writesAfterLastRun: null }, tainted: false, catalogDigest: 'd'.repeat(64), sourceChannelId: SRC, sourceThreadId: null, status: 'pending',
  channelId: CONFIG_CHANNEL_ID, messageId: CARD_MSG, createdAt: new Date('2026-11-12T00:00:00Z'), expiresAt: new Date('2026-11-19T00:00:00Z'), decidedBy: null, decidedAt: null, reason: null,
  releasedMessageId: null, releasedAt: null, outcome: null, live: true, forgeId: null, pluginSlug: null, pluginManifestSha256: null, ...over,
});
const okDecide = (action: 'approve' | 'reject') => ({ ok: true as const, row: row(), result: action === 'approve' ? ('released' as const) : ('rejected' as const) });
const mk = async (over: Partial<Parameters<typeof makeDeps>[0]> & { svc?: Record<string, unknown> } = {}) => {
  const { svc, ...rest } = over;
  const releases = {
    decide: vi.fn(async (c: { action: 'approve' | 'reject' }) => okDecide(c.action)),
    reject: vi.fn(async () => okDecide('reject')),
    list: vi.fn(async () => [row()]),
    show: vi.fn(async (id: number) => (id === 7 ? row() : null)),
    ...svc,
  };
  const t = await makeDeps({ releases: releases as never, ...rest });
  return { t, releases };
};
const click = (action: 'approve' | 'reject', o: Parameters<typeof interaction>[0] = {}) => interaction({ kind: 'button', customId: `relcard:${TOKEN}:${action}`, messageId: CARD_MSG, ...o });

describe('R5 relcard: buttons reach the service only through route(), after the #setting and live Bot Admin checks (RL-C11)', () => {
  it('a click in #setting by a Bot Admin passes the token, action, user, channel and the clicked message id to decide, and answers privately', async () => {
    const { t, releases } = await mk();
    const i = click('approve');
    const r = await handleInteraction(i, t.deps);
    expect(releases.decide).toHaveBeenCalledWith({ token: TOKEN, action: 'approve', userId: 'u1', channelId: CONFIG_CHANNEL_ID, messageId: CARD_MSG });
    expect(i.deferred).toEqual({ ephemeral: true });
    expect(text(r)).toContain('Released #7: posted in the task thread.');
    const j = click('reject');
    expect(text(await handleInteraction(j, t.deps))).toContain('Rejected. Nothing was released.');
    expect(releases.decide).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'reject' }));
  });
  it('R7: approving an install_plugin row says the build is queued and nothing is installed (never "posted in the task thread")', async () => {
    const { t } = await mk({ svc: { decide: async () => ({ ok: true, row: row({ target: 'install_plugin', forgeId: 3, pluginSlug: 'hello', pluginManifestSha256: 'm'.repeat(64) }), result: 'released' }) } });
    const r = text(await handleInteraction(click('approve'), t.deps));
    expect(r).toContain('build is queued');
    expect(r).toContain('/mcp approve');
    expect(r).not.toContain('Released #');
  });
  it('R7: /release show names the plugin slug and the forge for an install_plugin row', async () => {
    const { t } = await mk({ svc: { show: async () => row({ target: 'install_plugin', forgeId: 3, pluginSlug: 'hello', pluginManifestSha256: 'm'.repeat(64) }) } });
    const r = text(await handleInteraction(cmd('release', 'show', { numbers: { id: 7 } }), t.deps));
    expect(r).toContain('Target: install_plugin');
    expect(r).toContain('Plugin hello (forge #3)');
  });
  it('a refusal text from the service is shown as is', async () => {
    const { t } = await mk({ svc: { decide: async () => ({ ok: false, code: 'not_pending', text: DECIDE_TEXT.not_pending }) } });
    expect(text(await handleInteraction(click('approve'), t.deps))).toContain('Already decided.');
  });
  it('outside #setting, without the role, in a category approvals room, from another guild: refused, and decide is never called', async () => {
    const { t, releases } = await mk();
    expect(text(await handleInteraction(click('approve', { channelId: '123456789012345678' }), t.deps))).toContain('#⚙️-setting');
    expect(text(await handleInteraction(click('approve', { roles: [] }), t.deps))).toContain('Only Bot Admins');
    await t.deps.cfg.set('approvals.channelByCategory', { '123456789012345670': '123456789012345679' } as never, 'x');
    expect(text(await handleInteraction(click('approve', { channelId: '123456789012345679' }), t.deps))).toContain('#⚙️-setting');
    expect(await handleInteraction(click('approve', { guildId: '999' }), t.deps)).toBeNull();
    expect(text(await handleInteraction(click('approve', { channelId: '123456789012345679', roles: [ADMIN_ROLE] }), t.deps))).toContain('#⚙️-setting');
    expect(releases.decide).not.toHaveBeenCalled();
  });
  it('a malformed relcard id is unknown and never reaches the service', async () => {
    const { t, releases } = await mk();
    for (const id of [`relcard:${TOKEN}:approve:x`, `relcard:${TOKEN.toUpperCase()}:approve`, `relcard:${TOKEN}:delete`, 'relcard:short:approve']) {
      expect(text(await handleInteraction(interaction({ kind: 'button', customId: id }), t.deps)), id).toContain('Unknown action.');
    }
    expect(releases.decide).not.toHaveBeenCalled();
  });
  it('without a service it says so', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(click('approve'), t.deps))).toContain('Releases are not available.');
  });
  it('the stored-message check holds through the route: a click on any other message is wrong_card and nothing is claimed', async () => {
    const claim = vi.fn();
    const repo = { byToken: async () => row(), claim } as unknown as ReleaseDeps['repo'];
    const svc = new ReleaseService({ repo, halted: () => false, enabled: () => true, configChannelId: CONFIG_CHANNEL_ID, log: { error() {} } } as unknown as ReleaseDeps);
    const t = await makeDeps({ releases: svc });
    expect(text(await handleInteraction(click('approve', { messageId: '800000000000000012' }), t.deps))).toContain('does not belong to this card');
    expect(text(await handleInteraction(click('approve', { messageId: null }), t.deps))).toContain('does not belong to this card');
    expect(claim).not.toHaveBeenCalled();
  });
});

describe('R5 /release list, show, reject (RL-C10)', () => {
  const PROBE = '@everyone <@123456789012345678> [click](https://evil.example) `code` **bold**';
  it('list shows number, slug, status, escaped title; ephemeral; empty and missing service', async () => {
    const { t } = await mk({ svc: { list: async () => [row({ title: PROBE, slug: 'proj-a', status: 'pending' }), row({ id: 8, status: 'released' })] } });
    const r = await handleInteraction(cmd('release', 'list'), t.deps);
    const s = text(r);
    expect(s).toContain('#7 proj-a (pending)');
    expect(s).toContain('#8 proj-a (released)');
    expect(s).not.toContain('@everyone');
    expect(s).not.toContain('[click](');
    expect(s).not.toMatch(/(^|[^\\])<@1234/);
    expect(r?.ephemeral).toBe(true);
    const e = await mk({ svc: { list: async () => [] } });
    expect(text(await handleInteraction(cmd('release', 'list'), e.t.deps))).toContain('No releases yet.');
    const none = await makeDeps();
    expect(text(await handleInteraction(cmd('release', 'list'), none.deps))).toContain('Releases are not available.');
  });
  it('show: the bot text is escaped and labelled, the summary stays inside one embed, and an unknown number is refused', async () => {
    const long = '[a](http://x)'.repeat(46); // escaping nearly doubles it
    const { t } = await mk({ svc: { show: async () => row({ title: PROBE, summary: `${PROBE} ${long}`.slice(0, 600) }) } });
    const r = await handleInteraction(cmd('release', 'show', { numbers: { id: 7 } }), t.deps);
    const s = text(r);
    expect(s).toContain('Summary (written by the bot)');
    expect(s).not.toContain('@everyone');
    expect(s).not.toContain('[click](');
    expect(s).not.toMatch(/(^|[^\\])<@1234/);
    expect(r?.embeds).toHaveLength(1);
    for (const f of (r!.embeds![0] as { fields?: { value: string }[] }).fields ?? []) expect(f.value.length).toBeLessThanOrEqual(1024);
    expect((r!.embeds![0] as { description: string }).description.length).toBeLessThanOrEqual(4096);
    const n = await mk();
    expect(text(await handleInteraction(cmd('release', 'show', { numbers: { id: 99 } }), n.t.deps))).toContain('No release with that number.');
  });
  it('show: a planted secret in the stored text is masked', async () => {
    const SECRET = 'sk-planted-secret-value-0123456789';
    const { t } = await mk({ svc: { show: async () => row({ summary: `x ${SECRET} y` }) }, secrets: [SECRET] });
    expect(text(await handleInteraction(cmd('release', 'show', { numbers: { id: 7 } }), t.deps))).not.toContain(SECRET);
  });
  it('show: a released row links its message in the thread (or the channel); evidence and status are shown; no link before release', async () => {
    const a = await mk({ svc: { show: async () => row({ status: 'released', releasedMessageId: REL_MSG, sourceThreadId: THREAD, releasedAt: new Date('2026-11-12T01:00:00Z') }) } });
    expect(text(await handleInteraction(cmd('release', 'show', { numbers: { id: 7 } }), a.t.deps))).toContain(`https://discord.com/channels/${GUILD}/${THREAD}/${REL_MSG}`);
    const b = await mk({ svc: { show: async () => row({ status: 'released', releasedMessageId: REL_MSG, sourceThreadId: null }) } });
    expect(text(await handleInteraction(cmd('release', 'show', { numbers: { id: 7 } }), b.t.deps))).toContain(`https://discord.com/channels/${GUILD}/${SRC}/${REL_MSG}`);
    const c = await mk();
    expect(text(await handleInteraction(cmd('release', 'show', { numbers: { id: 7 } }), c.t.deps))).not.toContain('discord.com/channels');
  });
  it('reject passes id, the Bot Admin and the reason to the service; a refusal text is shown; the command is Bot Admin and #setting only', async () => {
    const { t, releases } = await mk();
    const r = await handleInteraction(cmd('release', 'reject', { numbers: { id: 7 }, strings: { reason: 'not ready' } }), t.deps);
    expect(releases.reject).toHaveBeenCalledWith({ id: 7, userId: 'u1', reason: 'not ready' });
    expect(text(r)).toContain('Rejected. Nothing was released.');
    const bad = await mk({ svc: { reject: async () => ({ ok: false, code: 'screen', text: DECIDE_TEXT.screen }) } });
    expect(text(await handleInteraction(cmd('release', 'reject', { numbers: { id: 7 }, strings: { reason: 'x' } }), bad.t.deps))).toContain('The reason was refused');
    const none = await handleInteraction(cmd('release', 'reject', { numbers: { id: 7 }, strings: { reason: 'x' }, roles: [] }), t.deps);
    expect(text(none)).toContain('Only Bot Admins');
    const wrong = await handleInteraction(cmd('release', 'reject', { numbers: { id: 7 }, strings: { reason: 'x' }, channelId: '999' }), t.deps);
    expect(text(wrong)).toContain('#⚙️-setting');
    expect(releases.reject).toHaveBeenCalledTimes(1);
    const missing = await handleInteraction(cmd('release', 'reject', { strings: { reason: 'x' } }), t.deps);
    expect(text(missing)).toContain('Give a release number');
    expect(releases.reject).toHaveBeenCalledTimes(1);
  });
});

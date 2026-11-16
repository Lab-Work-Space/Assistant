import { describe, expect, it, vi } from 'vitest';
import { PrawRateLimit } from '../../agents/call/rate.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { chatRig, TEXT, until, VC } from '../../voice/chat/test-helpers.js';
import { ADMIN_ROLE, GUILD, cmd, interaction } from '../commands/test-helpers.js';
import { handlePrawInteraction, prawCommandDeps, PRAW_COMMANDS } from './index.js';

const DENIED_TEXT = '1565715069969502310';
function mk(withVoice = true) {
  const t = chatRig();
  const cfg = new FakeConfig();
  const audits: Record<string, unknown>[] = [];
  const deps = prawCommandDeps({
    guildId: GUILD, adminRoleId: ADMIN_ROLE, org: { dept: () => null }, cfg, rate: new PrawRateLimit(cfg, () => 0), ask: vi.fn() as never,
    audit: async (e) => void audits.push(e as never), log: { error: () => undefined }, reminders: {} as never, schedules: {} as never, clock: () => 0,
    ...(withVoice ? { voiceChat: t.chat } : {}),
  });
  return { t, deps, audits };
}
const voiceCmd = (sub: string, o: Parameters<typeof cmd>[2] = {}) => cmd('voice', sub, { channelId: TEXT, roles: [], ...o });
const answer = (i: { followUps: { content?: string }[]; edits: { content?: string }[]; replies: { content?: string }[] }) => i.followUps[0] ?? i.edits[0] ?? i.replies[0];

describe('/voice', () => {
  it('registers /voice join and /voice leave', () => {
    const v = PRAW_COMMANDS.find((c) => c.name === 'voice') as unknown as { options: { name: string }[] };
    expect(v.options.map((o) => o.name)).toEqual(['join', 'leave']);
  });

  it('join needs the user in a voice channel; leave works from anywhere', async () => {
    const m = mk();
    m.t.where.set('u1', null);
    const away = voiceCmd('join');
    await handlePrawInteraction(away, m.deps);
    expect(answer(away)).toMatchObject({ ephemeral: true });
    expect(answer(away)?.content).toMatch(/join a voice channel/i);

    m.t.where.set('u1', VC);
    const ok = voiceCmd('join');
    expect((await handlePrawInteraction(ok, m.deps))?.ephemeral).toBe(false);
    expect(m.t.voice.current()?.channelId).toBe(VC);
    // u2 is in no voice channel and in another text channel: /voice leave still works
    const leave = voiceCmd('leave', { userId: 'u2', channelId: '1565999999999999777' });
    const r = await handlePrawInteraction(leave, m.deps);
    expect(r?.content).toMatch(/left/i);
    await until(() => m.t.voice.current() === null);
    expect(m.audits.map((a) => `${a.action}:${a.outcome}`)).toEqual(['voice.join:refused', 'voice.join:ok', 'voice.leave:ok']);
  });

  it('the opt-in button: scoped to the session, ephemeral answer, bots and denied channels dropped', async () => {
    const m = mk();
    const r = await handlePrawInteraction(voiceCmd('join'), m.deps);
    const id = (r as { components?: { components: { custom_id: string }[] }[] }).components![0]!.components[0]!.custom_id;
    m.t.where.set('u2', VC);
    const click = interaction({ kind: 'button', customId: id, channelId: TEXT, userId: 'u2', roles: [] });
    const a = await handlePrawInteraction(click, m.deps);
    expect(a?.ephemeral).toBe(true);
    expect(a?.content).toMatch(/opted in|ฟัง/i);
    const bot = interaction({ kind: 'button', customId: id, channelId: TEXT, userId: 'bot-9', userIsBot: true, roles: [] });
    expect(await handlePrawInteraction(bot, m.deps)).toBeNull();
    const denied = interaction({ kind: 'button', customId: id, channelId: DENIED_TEXT, userId: 'u4', roles: [] });
    expect((await handlePrawInteraction(denied, m.deps))?.content).toMatch(/not available in this channel/);
    const stale = interaction({ kind: 'button', customId: 'voice:optin:00000000-0000-0000-0000-000000000000', channelId: TEXT, userId: 'u5', roles: [] });
    expect((await handlePrawInteraction(stale, m.deps))?.content).toMatch(/ended|no longer/i);
    const other = interaction({ kind: 'button', customId: 'approval:x:approve', channelId: TEXT, userId: 'u5', roles: [] });
    expect(await handlePrawInteraction(other, m.deps)).toBeNull(); // config buttons are never reachable from Praw's path
    await m.t.chat.leave();
  });

  it('voice disabled → not available', async () => {
    const m = mk(false);
    const i = voiceCmd('join');
    await handlePrawInteraction(i, m.deps);
    expect(answer(i)?.content).toMatch(/not available/i);
  });
});

import { describe, expect, it } from 'vitest';
import { toGeminiSchema } from '../../../providers/gemini/convert.js';
import { musicRig, VC, waitFor } from '../../../voice/music/test-helpers.js';
import { webRig } from '../web/test-helpers.js';
import type { PluginDeps } from '../deps.js';
import { musicGroup } from './index.js';

const HANG = { extraEnv: { FAKE_YTDLP_HANG: '/dev/null' } };
function setup(o: Parameters<typeof musicRig>[0] = {}, origin: 'chat' | 'voice' | 'delegated' = 'chat', userId: string | null = 'u1') {
  const rig = musicRig({ track: HANG, ...o });
  const g = musicGroup({ music: rig.player } as unknown as PluginDeps);
  if ('disabled' in g) throw new Error('disabled');
  return { ...rig, g, ctx: () => webRig(g.tools, { direct: true, origin, source: { channelId: 'c1', threadId: null, messageId: null, userId, attachments: [] } }) };
}

describe('music tools', () => {
  it('five tools; write kinds go through approvalFor; schemas convert for Gemini', () => {
    const t = setup();
    expect(t.g.tools.map((x) => [x.name, x.kind])).toEqual([['music_play', 'write'], ['music_queue', 'read'], ['music_skip', 'write'], ['music_stop', 'write'], ['music_volume', 'write']]);
    for (const x of t.g.tools) expect(() => toGeminiSchema(x.inputSchema)).not.toThrow();
    const vol = t.g.tools.find((x) => x.name === 'music_volume')!;
    expect(vol.inputSchema.safeParse({ percent: 150 }).success).toBe(true);
    expect(vol.inputSchema.safeParse({ percent: 151 }).success).toBe(false);
    expect(vol.inputSchema.safeParse({ percent: -1 }).success).toBe(false);
  });

  it('music_play › user must be in a voice channel; not connected → joins it (needs Connect)', async () => {
    const away = setup({ channelOf: async () => null });
    const a = await away.ctx();
    const r1 = await a.reg.run('music_play', { query: 'song' }, a.c);
    expect(r1).toMatchObject({ isError: true, content: expect.stringMatching(/voice channel/i) });
    expect(away.voice.current()).toBeNull();

    const noPerm = setup({ check: async () => 'Praw cannot join <#1565999999999999555>: missing Connect. Grant them on this voice channel or its category (never guild-wide).' });
    const b = await noPerm.ctx();
    const r2 = await b.reg.run('music_play', { query: 'song' }, b.c);
    expect(r2).toMatchObject({ isError: true, content: expect.stringMatching(/missing Connect/) });
    expect(noPerm.voice.current()).toBeNull();
    expect(noPerm.queue.list().current).toBeNull();

    const ok = setup();
    const c = await ok.ctx();
    const r3 = await c.reg.run('music_play', { query: 'song' }, c.c);
    expect(r3.isError).toBeFalsy();
    expect(ok.voice.current()?.channelId).toBe(VC);
    expect(ok.session().calls[0]).toBe(`join:1565649426943442944/${VC}`);
    await waitFor(() => ok.session().played.length === 1);
    expect(c.approvals.request).not.toHaveBeenCalled(); // direct, untainted chat: no approval
    await ok.player.stop();
  });

  it('music_play from voice or delegated work asks approval first; a refused URL never starts anything', async () => {
    const t = setup({}, 'voice');
    const { reg, c, approvals } = await t.ctx();
    const voiceCtx = { ...c, direct: false };
    await reg.run('music_play', { query: 'song' }, voiceCtx);
    expect(approvals.request).toHaveBeenCalledTimes(1);
    expect(t.voice.current()).toBeNull();

    const u = setup();
    const d = await u.ctx();
    const r = await d.reg.run('music_play', { query: 'http://10.0.0.1/a.m3u8' }, d.c);
    expect(r).toMatchObject({ isError: true, content: expect.stringMatching(/not allowed/) });
    expect(u.sessions).toHaveLength(0);
  });

  it('approved voice run plays (runApproved, the approvedToolContext shape); delegated runs are refused before any approval card', async () => {
    const t = setup({}, 'voice');
    const { reg, c, approvals } = await t.ctx();
    // approvedToolContext: origin from the task row, source.userId from task.source_user_id, direct false
    const r = await reg.runApproved('music_play', { query: 'song' }, { ...c, direct: false });
    expect(r.isError).toBeFalsy();
    await waitFor(() => t.session()?.played.length === 1);
    await t.player.stop();

    const d = setup({}, 'delegated');
    const x = await d.ctx();
    const refused = await x.reg.run('music_play', { query: 'song' }, { ...x.c, direct: false });
    expect(refused).toMatchObject({ isError: true, content: expect.stringMatching(/conversation with a person/) });
    expect(x.approvals.request).not.toHaveBeenCalled();
    expect(approvals.request).not.toHaveBeenCalled();
    expect(d.sessions).toHaveLength(0);
  });

  it('I1: a tainted run whose requester is not in voice, a non-allowlisted URL, or Praw in another channel: refused with zero approval rows', async () => {
    const away = setup({ channelOf: async () => null });
    const a = await away.ctx();
    a.c.run.markTainted();
    const r1 = await a.reg.run('music_play', { query: 'song' }, { ...a.c, tainted: () => true });
    expect(r1).toMatchObject({ isError: true, content: expect.stringMatching(/voice channel/i) });
    const bad = setup();
    const b = await bad.ctx();
    const r2 = await b.reg.run('music_play', { query: 'http://10.0.0.1/a.m3u8' }, { ...b.c, tainted: () => true });
    expect(r2).toMatchObject({ isError: true, content: expect.stringMatching(/not allowed/) });
    const other = setup({ channelOf: async () => '1565999999999999777' });
    await other.voice.join('1565999999999999555', '1565649426943442944');
    const o = await other.ctx();
    const r3 = await o.reg.run('music_play', { query: 'song' }, { ...o.c, direct: false });
    expect(r3).toMatchObject({ isError: true, content: expect.stringMatching(/playing in <#1565999999999999555>/) });
    for (const x of [a, b, o]) expect(x.approvals.request).not.toHaveBeenCalled();
    expect(away.sessions).toHaveLength(0);
    // a request that could play still asks (tainted), and the approved run re-checks it
    const ok = setup();
    const k = await ok.ctx();
    await k.reg.run('music_play', { query: 'song' }, { ...k.c, tainted: () => true });
    expect(k.approvals.request).toHaveBeenCalledTimes(1);
  });

  it('music_queue output is untrusted (other members\' request text)', () => {
    const q = setup().g.tools.find((x) => x.name === 'music_queue')!;
    expect(q).toMatchObject({ untrustedOutput: true, untrustedSource: 'music' });
  });

  it('queue, skip, volume and stop answer from the player; no requesting user refuses play', async () => {
    const t = setup();
    const { reg, c } = await t.ctx();
    await reg.run('music_play', { query: 'one' }, c);
    await reg.run('music_play', { query: 'two' }, c);
    expect((await reg.run('music_skip', {}, c)).content).toMatch(/next track/);
    expect(t.queue.list().current?.query).toBe('two');
    expect((await reg.run('music_volume', { percent: 30 }, c)).content).toMatch(/30%/);
    await reg.run('music_play', { query: 'three' }, c);
    expect((await reg.run('music_queue', {}, c)).content).toMatch(/two[\s\S]*three/);
    // the queue listing tainted the run: the next write asks first instead of acting on other members' text
    expect((await reg.run('music_stop', {}, c)).content).toMatch(/approval/);
    expect(t.queue.list().current?.query).toBe('two');
    expect((await t.player.stop()).text).toMatch(/Stopped/);
    const n = setup({}, 'chat', null);
    const x = await n.ctx();
    expect((await x.reg.run('music_play', { query: 'one' }, x.c)).isError).toBe(true);
  });

  it('disabled when the media check turned music off', () => {
    const t = setup();
    expect(musicGroup({ music: t.player, mediaDisabled: [{ id: 'music', why: 'yt-dlp sha256 mismatch' }] } as unknown as PluginDeps)).toEqual({ id: 'music', disabled: 'yt-dlp sha256 mismatch' });
    expect(musicGroup({} as PluginDeps)).toEqual({ id: 'music', disabled: expect.any(String) });
  });
});

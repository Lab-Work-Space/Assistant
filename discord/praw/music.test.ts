import { describe, expect, it, vi } from 'vitest';
import { PrawRateLimit } from '../../agents/call/rate.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { musicRig, waitFor } from '../../voice/music/test-helpers.js';
import { ADMIN_ROLE, GUILD, cmd, text } from '../commands/test-helpers.js';
import { handlePrawInteraction, prawCommandDeps, PRAW_COMMANDS } from './index.js';

const NOW = Date.parse('2026-11-01T10:00:00Z');
const DENIED = '1565715069969502310';
function mk(limit = 20, withMusic = true) {
  const cfg = new FakeConfig({ 'limits.prawPerUser10Min': limit });
  const rig = musicRig({ track: { extraEnv: { FAKE_YTDLP_HANG: '/dev/null' } } });
  const audits: unknown[] = [];
  const deps = prawCommandDeps({
    guildId: GUILD, adminRoleId: ADMIN_ROLE, org: { dept: () => null }, cfg, rate: new PrawRateLimit(cfg, () => NOW),
    ask: vi.fn() as never, audit: async (e) => void audits.push(e), log: { error: () => undefined }, reminders: {} as never, schedules: {} as never, clock: () => NOW,
    ...(withMusic ? { music: rig.player } : {}),
  });
  return { deps, rig, audits };
}
const slash = (name: string, o: Parameters<typeof cmd>[2] = {}) => cmd(name, null, { channelId: '555', roles: [], ...o });

describe('slash', () => {
  it('registers /play /skip /queue /stop /volume with bounded options', () => {
    const names = PRAW_COMMANDS.map((c) => c.name);
    for (const n of ['play', 'skip', 'queue', 'stop', 'volume']) expect(names).toContain(n);
    const play = PRAW_COMMANDS.find((c) => c.name === 'play') as unknown as { options: { name: string; required: boolean; max_length: number }[] };
    expect(play.options[0]).toMatchObject({ name: 'query', required: true, max_length: 300 });
    const vol = PRAW_COMMANDS.find((c) => c.name === 'volume') as unknown as { options: { name: string; min_value: number; max_value: number }[] };
    expect(vol.options[0]).toMatchObject({ name: 'percent', min_value: 0, max_value: 150 });
  });

  it('slash › music commands rate limited and denied in denied channels', async () => {
    const t = mk(3);
    const play = slash('play', { strings: { query: 'song' } });
    const r1 = await handlePrawInteraction(play, t.deps);
    expect(r1?.ephemeral).toBe(false);
    expect(text(r1)).toMatch(/Playing/);
    await waitFor(() => t.rig.session()?.played.length === 1);
    const q = slash('queue');
    const r2 = await handlePrawInteraction(q, t.deps);
    expect(q.deferred).toEqual({ ephemeral: true }); // P15: the queue lists stored items
    expect(text(r2)).toContain('song');
    expect(text(await handlePrawInteraction(slash('volume', { numbers: { percent: 50 } }), t.deps))).toMatch(/50%/);
    const limited = slash('skip');
    const r4 = await handlePrawInteraction(limited, t.deps); // 4th slot: refused before anything runs
    expect(r4?.ephemeral).toBe(true);
    expect(limited.deferred).toBeNull();
    expect(text(r4)).toMatch(/at most 3/);
    expect(t.rig.queue.list().current?.query).toBe('song');

    for (const over of [{ channelId: DENIED }, { channelId: 'thread-1', parentChannelId: DENIED }]) {
      const fresh = mk();
      const i = slash('play', { strings: { query: 'song' }, ...over });
      const r = await handlePrawInteraction(i, fresh.deps);
      expect(r?.ephemeral).toBe(true);
      expect(text(r)).toMatch(/not available in this channel/);
      expect(i.deferred).toBeNull();
      expect(fresh.rig.sessions).toHaveLength(0);
    }
    await t.rig.player.stop();
  });

  it('M2/M6: a refusal after the public defer goes to the invoker alone; public replies escape the query markdown', async () => {
    const t = mk();
    const ok = slash('play', { strings: { query: '**bold** [x](https://evil.example) _u_' } });
    const r = await handlePrawInteraction(ok, t.deps);
    expect(ok.deferred).toEqual({ ephemeral: false });
    expect(r?.ephemeral).toBe(false);
    expect(ok.edits[0]!.content).toContain('\\*\\*bold\\*\\*');
    expect(ok.edits[0]!.content).not.toMatch(/(?<!\\)\*\*bold/);
    const bad = slash('play', { strings: { query: 'http://10.0.0.1/a.m3u8' } });
    const r2 = await handlePrawInteraction(bad, t.deps);
    expect(r2?.ephemeral).toBe(true);
    expect(bad.deferred).toEqual({ ephemeral: false });
    expect(bad.edits).toEqual([]);
    expect(bad.deletedReply).toBe(true);
    expect(bad.followUps).toEqual([expect.objectContaining({ ephemeral: true, content: expect.stringMatching(/not allowed/) })]);
    await t.rig.player.stop();
  });

  it('/stop and /skip act on the player and are audited; empty query and no music refused', async () => {
    const t = mk();
    await handlePrawInteraction(slash('play', { strings: { query: 'a' } }), t.deps);
    await handlePrawInteraction(slash('play', { strings: { query: 'b' } }), t.deps);
    expect(text(await handlePrawInteraction(slash('skip'), t.deps))).toMatch(/Skipped; the next track/);
    expect(t.rig.queue.list().current?.query).toBe('b');
    expect(text(await handlePrawInteraction(slash('stop'), t.deps))).toMatch(/Stopped/);
    expect(t.audits).toContainEqual(expect.objectContaining({ action: 'music.stop', actor: 'user:u1' }));
    expect(t.audits).toContainEqual(expect.objectContaining({ action: 'music.play', actor: 'user:u1' }));
    const empty = slash('play', { strings: { query: '  ' } });
    expect((await handlePrawInteraction(empty, t.deps))?.ephemeral).toBe(true);
    expect(empty.deferred).toBeNull();
    const off = mk(20, false);
    expect(text(await handlePrawInteraction(slash('play', { strings: { query: 'a' } }), off.deps))).toMatch(/not available/i);
  });
});

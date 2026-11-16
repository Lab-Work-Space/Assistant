import { describe, expect, it } from 'vitest';
import { SEED_DEPARTMENTS } from '../../company/seed.js';
import { handleInteraction } from './index.js';
import { cmd, makeDeps } from './test-helpers.js';

const ch = { channel: { id: '777', parentId: null } };
const mapWork = (dept: string) => cmd('channel', 'map', { strings: { dept }, bools: { work: true }, channels: ch });
const unmap = () => cmd('channel', 'unmap', { channels: ch });
const praw = { id: 'praw', name: 'praw', categoryNamePattern: '', workChannelId: null, color: 1, model: null, provider: null, enabled: true };

describe('channel work flag (R1)', () => {
  it('work:true on praw (null work channel) sets dept.work_channel_id and is_work', async () => {
    const t = await makeDeps();
    t.mem.depts.set('praw', praw);
    await t.org.reload();
    await handleInteraction(mapWork('praw'), t.deps);
    expect(t.mem.depts.get('praw')!.workChannelId).toBe('777');
    expect(t.mem.channels.get('777')).toMatchObject({ deptId: 'praw', isWork: true });
    expect(t.org.dept('praw')!.workChannelId).toBe('777');
  });
  it('work:true on software leaves its seeded work channel untouched', async () => {
    const t = await makeDeps();
    const seeded = SEED_DEPARTMENTS.find((d) => d.id === 'software')!.workChannelId;
    await handleInteraction(mapWork('software'), t.deps);
    expect(t.mem.depts.get('software')!.workChannelId).toBe(seeded);
    expect(t.mem.channels.get('777')).toMatchObject({ isWork: true });
  });
  it("unmapping praw's work channel clears it; unmapping a seeded dept's channel never nulls it", async () => {
    const t = await makeDeps();
    t.mem.depts.set('praw', praw);
    await t.org.reload();
    await handleInteraction(mapWork('praw'), t.deps);
    await handleInteraction(unmap(), t.deps);
    expect(t.mem.depts.get('praw')!.workChannelId).toBeNull();

    // A seeded dept whose seeded channel is the one being unmapped keeps it.
    const seededCh = SEED_DEPARTMENTS.find((d) => d.id === 'software')!.workChannelId!;
    t.mem.channels.set(seededCh, { channelId: seededCh, deptId: 'software', isWork: true });
    await handleInteraction(cmd('channel', 'unmap', { channels: { channel: { id: seededCh, parentId: null } } }), t.deps);
    expect(t.mem.depts.get('software')!.workChannelId).toBe(seededCh);
  });
  it('re-mapping praw work channel to another dept releases it from praw', async () => {
    const t = await makeDeps();
    t.mem.depts.set('praw', praw);
    await t.org.reload();
    await handleInteraction(mapWork('praw'), t.deps);
    await handleInteraction(cmd('channel', 'map', { strings: { dept: 'rnd' }, channels: ch }), t.deps);
    expect(t.mem.depts.get('praw')!.workChannelId).toBeNull();
  });
});

describe('channel map protected channels', () => {
  it.each([['bot log', '1566454343820124352'], ['ai-warroom', '1566366032094961705'], ['task log', '1565671253803794494']])('%s cannot be mapped, nor can a thread under it', async (_n, id) => {
    const t = await makeDeps();
    for (const channel of [{ id, parentId: null }, { id: 'thr-1', parentId: id }]) {
      await handleInteraction(cmd('channel', 'map', { strings: { dept: 'rnd' }, channels: { channel } }), t.deps);
      expect(t.mem.channels.has(channel.id)).toBe(false);
    }
  });
});

describe('channel map forums (Teamwork D)', () => {
  const forum = { id: '888', parentId: 'cat-1', type: 15 };
  const GOALS_FORUM = '1565652418383847514';
  const GOALS_TEXT = '1565651009076985956';
  it('a forum can be mapped to a department and unmapped again', async () => {
    const t = await makeDeps();
    await handleInteraction(cmd('channel', 'map', { strings: { dept: 'software' }, channels: { channel: forum } }), t.deps);
    expect(t.mem.channels.get('888')).toMatchObject({ deptId: 'software', isWork: false });
    expect(t.org.deptOfChannel('888')).toBe('software');
    await handleInteraction(cmd('channel', 'unmap', { channels: { channel: forum } }), t.deps);
    expect(t.mem.channels.has('888')).toBe(false);
  });
  it('the /channel map and unmap options accept a forum channel type (and other commands keep text only)', async () => {
    const { COMMANDS } = await import('./definitions.js');
    const channel = COMMANDS.find((c) => (c as { name: string }).name === 'channel') as unknown as { options: { name: string; options: { name: string; channel_types?: number[] }[] }[] };
    for (const sub of channel.options) expect(sub.options.find((o) => o.name === 'channel')!.channel_types).toEqual([0, 5, 15]);
    const ocr = COMMANDS.find((c) => (c as { name: string }).name === 'autoocr') as unknown as { options: { options: { name: string; channel_types?: number[] }[] }[] };
    expect(ocr.options[0]!.options.find((o) => o.name === 'channel')!.channel_types).toEqual([0, 5]);
  });
  it('a forum cannot be the work channel', async () => {
    const t = await makeDeps();
    await handleInteraction(cmd('channel', 'map', { strings: { dept: 'software' }, bools: { work: true }, channels: { channel: forum } }), t.deps);
    expect(t.mem.channels.has('888')).toBe(false);
  });
  it.each([['goals forum', GOALS_FORUM], ['goals text channel', GOALS_TEXT]])('TW10: the %s cannot be mapped (it routes to the CEO already), nor a post under it', async (_n, id) => {
    const t = await makeDeps();
    for (const channel of [{ id, parentId: null, type: 15 }, { id: 'post-1', parentId: id }]) {
      await handleInteraction(cmd('channel', 'map', { strings: { dept: 'software' }, channels: { channel } }), t.deps);
      expect(t.mem.channels.has(channel.id)).toBe(false);
    }
  });
});

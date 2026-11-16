import { describe, expect, it } from 'vitest';
import type { OutboxRow } from '../db/repos/exec.js';
import { buildMessage } from '../discord/embeds/index.js';
import { OutboxPump } from './outbox.js';

const BOT_LOG = '1566454343820124352';
const row = (id: number, kind: OutboxRow['kind'], payload: Record<string, unknown>, ageMs = 0): OutboxRow => ({ id, kind, payload, createdAt: new Date(1_000_000 - ageMs) });

function rig(rows: OutboxRow[], cfg: { enabled?: boolean; message?: string; channelId?: string | null } = {}, failPost = false) {
  const posts: { actor: unknown; target: unknown; payload: Record<string, unknown> }[] = [];
  const done: number[] = [];
  const pump = new OutboxPump({
    exec: { pending: async () => rows.filter((r) => !done.includes(r.id)), markDone: async (id) => (done.includes(id) ? false : (done.push(id), true)) },
    port: { post: async (actor, target, payload) => { if (failPost) throw new Error('down'); posts.push({ actor, target, payload: payload as never }); return 'm1'; } },
    cfg: { get: ((k: string) => ({ 'welcome.enabled': cfg.enabled ?? true, 'welcome.message': cfg.message ?? 'Welcome {user}!', 'welcome.channelId': cfg.channelId === undefined ? '700000000000000050' : cfg.channelId })[k]) as never },
    botLogChannelId: BOT_LOG, log: { error() {} }, now: () => 1_000_000,
  });
  return { pump, posts, done };
}
const USER = '800000000000000001';

describe('OutboxPump (the executor has no Send Messages)', () => {
  it('alerts and summaries are posted by hq to #bot-log; the welcome is posted by Praw in the configured channel with exactly the new member pinged', async () => {
    const x = rig([row(1, 'alert', { title: 'Welcome paused', text: 'raid' }), row(2, 'summary', { text: 'member.ban by <@1>' }), row(3, 'welcome.post', { userId: USER })]);
    expect(await x.pump.tick()).toBe(3);
    expect(x.posts[0]).toMatchObject({ actor: { kind: 'head', dept: 'hq' }, target: { channelId: BOT_LOG }, payload: { type: 'alert', origin: 'governance', title: 'Welcome paused' } });
    expect(x.posts[1]).toMatchObject({ actor: { dept: 'hq' }, payload: { type: 'report' } });
    expect(x.posts[2]).toMatchObject({ actor: { kind: 'head', dept: 'praw' }, target: { channelId: '700000000000000050' }, payload: { body: `Welcome <@${USER}>!`, mentionUsers: [USER] } });
    expect(x.done).toEqual([1, 2, 3]);
  });
  it('the welcome message renders with allowedMentions users: [member] and nothing else', () => {
    const m = buildMessage({ type: 'chat', origin: 'governance', body: `Welcome <@${USER}>!`, mentionUsers: [USER] }, { dept: 'praw', deptColor: 0 } as never);
    expect(m[0]!.allowedMentions).toEqual({ parse: [], users: [USER] });
    expect(m[0]!.content).toBe(`<@${USER}>`);
    const forged = buildMessage({ type: 'chat', origin: 'model', body: 'x', mentionUsers: [USER] }, { dept: 'praw', deptColor: 0 } as never);
    expect(forged[0]!.allowedMentions).toEqual({ parse: [] }); // a model payload can never ping
    const bad = buildMessage({ type: 'chat', origin: 'governance', body: 'x', mentionUsers: ['@everyone', 'abc'] }, { dept: 'praw', deptColor: 0 } as never);
    expect(bad[0]!.allowedMentions).toEqual({ parse: [] });
  });
  it('a welcome is re-validated when posted: disabled, no channel, an unsafe template or a forged user id post nothing (and the row is closed)', async () => {
    for (const [cfg, payload] of [
      [{ enabled: false }, { userId: USER }], [{ channelId: null }, { userId: USER }], [{ message: 'hi @everyone {user}' }, { userId: USER }], [{ message: 'see https://x.example {user}' }, { userId: USER }], [{}, { userId: '@everyone' }],
    ] as const) {
      const x = rig([row(1, 'welcome.post', payload)], cfg);
      expect(await x.pump.tick(), JSON.stringify([cfg, payload])).toBe(0);
      expect(x.posts).toEqual([]);
      expect(x.done).toEqual([1]);
    }
  });
  it('a failed post is retried on the next pass and not marked done; a row older than an hour is dropped', async () => {
    const bad = rig([row(1, 'alert', { text: 'x' })], {}, true);
    expect(await bad.pump.tick()).toBe(0);
    expect(bad.done).toEqual([]);
    const old = rig([row(1, 'welcome.post', { userId: USER }, 2 * 3600_000)]);
    expect(await old.pump.tick()).toBe(0);
    expect(old.posts).toEqual([]);
    expect(old.done).toEqual([1]);
  });
  it('two overlapping ticks never post a row twice', async () => {
    const x = rig([row(1, 'alert', { text: 'x' })]);
    await Promise.all([x.pump.tick(), x.pump.tick()]);
    expect(x.posts).toHaveLength(1);
  });
});

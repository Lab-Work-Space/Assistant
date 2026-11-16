import { describe, expect, it } from 'vitest';
import type { OutboxRow } from '../db/repos/exec.js';
import { ToolRegistry } from '../tools/registry.js';
import { ADMIN_TOOL_NAMES } from './names.js';
import type { AdminConsole } from './console.js';
import { OutboxPump } from './outbox.js';
import { adminTools, type DeployToolDeps } from './tools.js';

const CHAN = '1565667791938387969';
const CARD = 'e'.repeat(32);
function rig(deploy?: DeployToolDeps, tier?: string) {
  const proposed: unknown[] = [];
  const stored: string[] = [];
  const c = { proposeDeploy: async (_w: unknown, raw: unknown) => (proposed.push(raw), { ok: true, text: 'card posted' }) } as unknown as AdminConsole;
  const r = new ToolRegistry({ halt: { isHalted: () => false } });
  for (const t of adminTools({ console: c, ...(deploy ? { deploy } : {}) })) r.register(t);
  const ctx = { actor: { kind: 'head', dept: 'praw' }, task: null, source: { userId: '900000000000000001', ...(tier ? { tier, channelId: 'room' } : {}) }, tainted: () => false, run: { tainted: () => false, markTainted() {}, knownUrls: new Set() }, org: { toolsFor: () => [...ADMIN_TOOL_NAMES] }, audit: async () => undefined, tasks: {} } as never;
  return { r, ctx, proposed, stored };
}

describe('deploy tools', () => {
  it('are part of the admin allowlist', () => expect(ADMIN_TOOL_NAMES).toEqual(expect.arrayContaining(['deploy_propose', 'deploy_read', 'site_publish_static'])));

  it('deploy_propose validates the request in code and never takes a sha from the model', async () => {
    const x = rig();
    expect((await x.r.run('deploy_propose', { requestJson: '{"op":"add","repo":"blog","category":"apps"}' }, x.ctx)).isError).toBeUndefined();
    expect(x.proposed).toEqual([{ op: 'add', repo: 'blog', category: 'apps' }]);
    for (const bad of ['{nope', '{"op":"add","repo":"blog","category":"apps","sha":"' + 'a'.repeat(40) + '"}', '{"op":"add","repo":"o/blog","category":"apps"}', '{"op":"add","repo":"x","category":"main"}', '{"op":"rm","app":"main/x"}']) {
      expect((await x.r.run('deploy_propose', { requestJson: bad }, x.ctx)).isError, bad).toBe(true);
    }
    expect(x.proposed).toHaveLength(1);
  });

  it('deploy_read is for Bot Admin runs only and needs the executor', async () => {
    const calls: unknown[] = [];
    const x = rig({ read: async (u, req) => (calls.push([u, req]), { ok: true, text: 'rows' }) });
    expect((await x.r.run('deploy_read', { kind: 'status' }, x.ctx)).content).toContain('rows');
    expect(calls).toEqual([['900000000000000001', { kind: 'status' }]]);
    const t = rig({ read: async () => ({ ok: true, text: 'rows' }) }, 'moderator');
    expect((await t.r.run('deploy_read', { kind: 'status' }, t.ctx)).isError).toBe(true);
    expect((await rig().r.run('deploy_read', { kind: 'status' }, rig().ctx)).isError).toBe(true);
  });

  it('site_publish_static packs, stores the archive for the executor and then proposes by digest only', async () => {
    const stored: [string, number, string][] = [];
    const x = rig({ read: async () => ({ ok: true, text: '' }), site: { pack: async (dir) => (dir === 'site' ? { ok: true, tar: Buffer.from('T'.repeat(2048)), sha256: 'b'.repeat(64), size: 2048, files: 3 } : { ok: false, error: 'no index' }), store: async (s, t, u) => void stored.push([s, t.length, u]) } });
    const ok = await x.r.run('site_publish_static', { dir: 'site', name: 'landing', category: 'apps' }, x.ctx);
    expect(ok.isError).toBeUndefined();
    expect(stored).toEqual([['b'.repeat(64), 2048, '900000000000000001']]);
    expect(x.proposed).toEqual([{ op: 'publish_static', name: 'landing', category: 'apps', sha256: 'b'.repeat(64), size: 2048 }]);
    const bad = await x.r.run('site_publish_static', { dir: 'other', name: 'landing', category: 'apps' }, x.ctx);
    expect(bad.isError).toBe(true);
    const badName = await x.r.run('site_publish_static', { dir: 'site', name: 'a--b', category: 'apps' }, x.ctx);
    expect(badName.isError).toBe(true);
    expect(x.proposed).toHaveLength(1);
    expect(stored).toHaveLength(1); // nothing is stored for a request that fails validation
  });
});

const row = (kind: OutboxRow['kind'], payload: Record<string, unknown>): OutboxRow => ({ id: 1, kind, payload, createdAt: new Date(1_000_000) });
function outbox(rows: OutboxRow[]) {
  const posts: { actor: unknown; target: unknown; payload: Record<string, unknown> }[] = [];
  const done: number[] = [];
  const pump = new OutboxPump({
    exec: { pending: async () => rows.filter((r) => !done.includes(r.id)), markDone: async (id) => (done.push(id), true) },
    port: { post: async (actor, target, payload) => { posts.push({ actor, target, payload: payload as never }); return 'm'; } },
    cfg: { get: (() => null) as never }, botLogChannelId: '1566454343820124352', log: { error() {} }, now: () => 1_000_000,
  });
  return { pump, posts, done };
}

describe('OutboxPump deploy.result (V21, V23)', () => {
  it('posts redacted, defanged text into #setting only', async () => {
    const x = outbox([row('deploy.result', { cardId: CARD, channelId: CHAN, text: 'Deploy FAILED: @everyone ghp_abcdefghijklmnopqrstuvwxyz0123456789' })]);
    expect(await x.pump.tick()).toBe(1);
    expect(x.posts[0]).toMatchObject({ actor: { dept: 'hq' }, target: { channelId: CHAN }, payload: { type: 'report', title: 'VPS deploy' } });
    const body = x.posts[0]!.payload.body as string;
    expect(body).not.toContain('ghp_abc');
    expect(body).not.toContain('@everyone');
  });
  it('a forged row for another channel or a bad card id posts nothing', async () => {
    const x = outbox([row('deploy.result', { cardId: CARD, channelId: '1566454343820124352', text: 'x' })]);
    expect(await x.pump.tick()).toBe(0);
    const y = outbox([row('deploy.result', { cardId: 'nope', channelId: CHAN, text: 'x' })]);
    expect(await y.pump.tick()).toBe(0);
    expect(x.posts.concat(y.posts)).toEqual([]);
  });
});

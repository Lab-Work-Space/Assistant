import { describe, expect, it, vi } from 'vitest';
import { CapError } from '../../../db/repos/praw.js';
import { FakeConfig } from '../../../governance/test-helpers.js';
import { toGeminiSchema } from '../../../providers/gemini/convert.js';
import type { PluginDeps } from '../deps.js';
import { webRig } from '../web/test-helpers.js';
import { watchGroup } from './index.js';
import { watchNet } from './test-helpers.js';

function setup(origin: 'chat' | 'schedule' | 'watch' | 'delegated' = 'chat', userId: string | null = 'u1') {
  const added: { w: Record<string, unknown>; caps: unknown }[] = [];
  let n = 0;
  const watches = {
    add: vi.fn(async (w: Record<string, unknown>, caps: unknown) => {
      if (added.filter((a) => a.w.userId === w.userId).length >= 5) throw new CapError('user', 5);
      added.push({ w, caps });
      return { id: ++n, ...w };
    }),
    list: vi.fn(async (u: string) => (u === 'u1' ? [{ id: 1, kind: 'url', target: 'https://example.com/a', intervalMinutes: 30 }] : [])),
    remove: vi.fn(async (id: number, u: string) => u === 'u1' && id === 1),
  };
  const net = watchNet();
  const deps = { env: { guildId: 'g1' }, cfg: new FakeConfig(), log: { warn: vi.fn() }, clock: () => 0, watches, net } as unknown as PluginDeps;
  const g = watchGroup(deps);
  if ('disabled' in g) throw new Error('disabled');
  return { g, watches, added, net, rig: (over = {}) => webRig(g.tools, { direct: true, origin, source: { channelId: 'c1', threadId: null, messageId: null, userId, attachments: [] }, ...over }) };
}

describe('watch tools', () => {
  it('declares kinds, none taint, and converts for Gemini', () => {
    const t = setup();
    expect(Object.fromEntries(t.g.tools.map((x) => [x.name, x.kind]))).toEqual({ watch_add: 'write', watch_list: 'read', watch_remove: 'write' });
    expect(t.g.tools.some((x) => x.untrustedOutput)).toBe(false); // they return no snapshot or page text
    for (const x of t.g.tools) expect(() => toGeminiSchema(x.inputSchema as never)).not.toThrow();
  });

  it('tool › interval 14 refused; user, channel and caps come from the trigger', async () => {
    const t = setup('chat', 'real');
    const { reg, c } = await t.rig();
    expect((await reg.run('watch_add', { kind: 'url', target: 'https://example.com/a', intervalMinutes: 14 }, c)).isError).toBe(true);
    expect(t.watches.add).not.toHaveBeenCalled();
    const ok = await reg.run('watch_add', { kind: 'url', target: 'https://example.com/a#frag', intervalMinutes: 15, userId: 'attacker' }, c);
    expect(ok.isError).toBeFalsy();
    expect(t.added[0]!.w).toMatchObject({ guildId: 'g1', channelId: 'c1', userId: 'real', kind: 'url', target: 'https://example.com/a', intervalMinutes: 15 });
    expect(t.added[0]!.caps).toEqual({ perUser: 5, total: 50 });
  });

  it('poller › private URL watch refused at add (SSRF reuse)', async () => {
    const t = setup();
    const { reg, c } = await t.rig();
    for (const target of ['http://127.0.0.1/', 'http://169.254.169.254/x', 'https://evil.example/', 'http://[::1]/', 'file:///etc/passwd', 'https://user:pw@example.com/']) {
      const r = await reg.run('watch_add', { kind: 'url', target, intervalMinutes: 30 }, c);
      expect(r.isError, target).toBe(true);
    }
    expect(t.watches.add).not.toHaveBeenCalled();
    expect(t.net.transport.requests).toHaveLength(0); // checked, never fetched
  });

  it('watch › 6th watch refused', async () => {
    const t = setup();
    const { reg, c } = await t.rig();
    for (let i = 0; i < 5; i++) expect((await reg.run('watch_add', { kind: 'topic', target: `topic ${i}`, intervalMinutes: 60 }, c)).isError).toBeFalsy();
    const r = await reg.run('watch_add', { kind: 'topic', target: 'sixth', intervalMinutes: 60 }, c);
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/limit/);
  });

  it("watch › another user's watch cannot be listed or removed", async () => {
    const other = setup('chat', 'u2');
    const o = await other.rig();
    expect((await o.reg.run('watch_list', {}, o.c)).content).toMatch(/No watches/);
    expect((await o.reg.run('watch_remove', { id: 1 }, o.c)).isError).toBe(true);
    expect(other.watches.list).toHaveBeenCalledWith('u2');
    expect(other.watches.remove).toHaveBeenCalledWith(1, 'u2');
    const mine = setup('chat', 'u1');
    const m = await mine.rig();
    expect((await m.reg.run('watch_list', {}, m.c)).content).toContain('https://example.com/a');
    expect((await m.reg.run('watch_remove', { id: 1 }, m.c)).isError).toBeFalsy();
  });

  it('watches are only managed from a human conversation', async () => {
    for (const origin of ['schedule', 'watch', 'delegated'] as const) {
      const t = setup(origin);
      const { reg, c } = await t.rig();
      expect((await reg.run('watch_add', { kind: 'topic', target: 'x', intervalMinutes: 60 }, c)).isError, origin).toBe(true);
    }
    const t = setup('chat', null);
    const { reg, c } = await t.rig();
    expect((await reg.run('watch_list', {}, c)).isError).toBe(true);
  });

  it('R17: after untrusted content, a url the run has not seen (and any topic) needs approval', async () => {
    const t = setup();
    const { reg, c, approvals } = await t.rig();
    const input = { kind: 'url', target: 'https://example.com/leak?d=secret', intervalMinutes: 30 };
    expect(t.g.tools[0]!.requiresApproval(input as never, c)).toBe(false); // clean run
    c.run.markTainted();
    expect(t.g.tools[0]!.requiresApproval(input as never, c)).toMatchObject({ reason: expect.stringContaining('watch_add') });
    expect(t.g.tools[0]!.requiresApproval({ kind: 'topic', target: 'secret', intervalMinutes: 30 } as never, c)).toMatchObject({ reason: expect.any(String) });
    c.run.knownUrls.add('https://example.com/leak?d=secret');
    expect(t.g.tools[0]!.requiresApproval(input as never, c)).toBe(false);
    void reg; void approvals;
  });
});

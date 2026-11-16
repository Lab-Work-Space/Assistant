import { describe, expect, it, vi } from 'vitest';
import { PrawRateLimit } from '../../agents/call/rate.js';
import { VisionCap } from '../../agents/loop/vision.js';
import type { AgentOutcome } from '../../agents/loop/loop.js';
import type { IncomingMessage } from '../../company/types.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { ADMIN_ROLE, GUILD, cmd, text } from '../commands/test-helpers.js';
import { handlePrawInteraction, prawCommandDeps, PRAW_COMMANDS } from './index.js';

const URL_OK = 'https://cdn.discordapp.com/attachments/1/2/receipt.png?ex=1&hm=2';
const att = (over: Partial<{ url: string; name: string; size: number; contentType: string | null }> = {}) => ({ url: URL_OK, name: 'receipt.png', size: 120_000, contentType: 'image/png', ...over });
const chat = (body: string): AgentOutcome => ({ payload: { type: 'chat', body }, costUsd: 0, turns: 1 });

function mk(o: { limit?: number; daily?: number } = {}) {
  const cfg = new FakeConfig({ 'limits.prawPerUser10Min': o.limit ?? 20, 'limits.visionPerUserDay': o.daily ?? 30 });
  const now = Date.UTC(2026, 10, 1, 12);
  const rate = new PrawRateLimit(cfg, () => now);
  const vision = new VisionCap(cfg, () => now);
  const asks: { msg: IncomingMessage; o: unknown }[] = [];
  const ask = vi.fn(async (msg: IncomingMessage, opts?: unknown) => { asks.push({ msg, o: opts }); return chat('Total 155.15 THB'); });
  const deps = prawCommandDeps({
    guildId: GUILD, adminRoleId: ADMIN_ROLE, org: { dept: () => null }, cfg, rate, vision, ask: ask as never,
    audit: async () => undefined, log: { error: () => undefined }, reminders: {} as never, schedules: {} as never, clock: () => now,
  });
  return { deps, rate, vision, asks, ask };
}
const run = (name: 'ocr' | 'receipt', attachments: Record<string, ReturnType<typeof att>> | undefined, extra: Parameters<typeof cmd>[2] = {}) =>
  cmd(name, null, { channelId: '555', roles: [], ...(attachments ? { attachments } : {}), ...extra });

describe('/ocr', () => {
  it('/ocr › file option runs ocr_image through ask() and the loop', async () => {
    const t = mk();
    const i = run('ocr', { file: att() }, { id: 'o1', userId: 'u9', strings: { language: 'th' } });
    const r = await handlePrawInteraction(i, t.deps);
    expect(t.ask).toHaveBeenCalledTimes(1);
    const { msg, o } = t.asks[0]!;
    expect(msg).toMatchObject({ id: 'interaction:o1', channelId: '555', mentionedHeads: ['praw'], author: { id: 'u9', kind: 'human' }, attachments: [{ url: URL_OK, name: 'receipt.png', size: 120_000 }] });
    expect(msg.content).toContain('ocr_image');
    expect(msg.content).toContain('th');
    expect(msg.content).not.toContain(URL_OK); // the model never sees or passes a url (PF20)
    expect(o).toMatchObject({ deliver: false, preCharged: true });
    expect(i.deferred).toEqual({ ephemeral: false });
    expect(text(i.edits[0]!)).toContain('155.15');
    expect(r).toBe(i.edits[0]);
  });

  it('/receipt › returns table + CSV: the synthetic message tells Praw to call extract_receipt for attachment 0', async () => {
    const t = mk();
    const i = run('receipt', { file: att({ name: 'bill.pdf', contentType: 'application/pdf' }) }, { id: 'r1' });
    await handlePrawInteraction(i, t.deps);
    const { msg } = t.asks[0]!;
    expect(msg.content).toContain('extract_receipt');
    expect(msg.attachments).toEqual([{ url: URL_OK, name: 'bill.pdf', size: 120_000, contentType: 'application/pdf' }]);
    expect(text(i.edits[0]!)).toContain('155.15');
  });

  it('caps › 11 MB or text/html file refused with ephemeral notice, nothing charged, no model call', async () => {
    const t = mk({ limit: 1 });
    const big = run('ocr', { file: att({ size: 11 * 1024 * 1024 }) });
    const html = run('receipt', { file: att({ name: 'page.html', contentType: 'text/html; charset=utf-8' }) });
    const noext = run('ocr', { file: att({ name: 'evil', contentType: null }) });
    for (const i of [big, html, noext]) {
      const r = await handlePrawInteraction(i, t.deps);
      expect(r?.ephemeral).toBe(true);
      expect(i.deferred).toBeNull();
    }
    expect(t.ask).not.toHaveBeenCalled();
    expect(t.rate.take('u1').ok).toBe(true); // the refusals took no Praw slot
  });

  it('accepts a missing declared type when the suffix is an image/pdf one (magic bytes decide later)', async () => {
    const t = mk();
    await handlePrawInteraction(run('ocr', { file: att({ contentType: null }) }), t.deps);
    expect(t.ask).toHaveBeenCalledTimes(1);
  });

  it('a missing file option is refused', async () => {
    const t = mk();
    const r = await handlePrawInteraction(run('ocr', undefined), t.deps);
    expect(r?.ephemeral).toBe(true);
    expect(t.ask).not.toHaveBeenCalled();
  });

  it('caps.test › /ocr over limits.visionPerUserDay refused (P15): ephemeral, no model call, no Praw slot', async () => {
    const t = mk({ daily: 2 });
    t.vision.take('u1');
    t.vision.take('u1');
    const i = run('ocr', { file: att() });
    const r = await handlePrawInteraction(i, t.deps);
    expect(r?.ephemeral).toBe(true);
    expect(text(r)).toMatch(/limit/i);
    expect(t.ask).not.toHaveBeenCalled();
    expect(i.deferred).toBeNull();
    const other = await handlePrawInteraction(run('receipt', { file: att() }, { userId: 'u2' }), t.deps);
    expect(other?.ephemeral).toBe(false);
  });

  it('the commands are registered on Praw with a required attachment option', () => {
    for (const n of ['ocr', 'receipt']) {
      const c = PRAW_COMMANDS.find((x) => x.name === n) as { options?: { name: string; type: number; required?: boolean }[] };
      expect(c.options?.find((o) => o.name === 'file')).toMatchObject({ type: 11, required: true });
    }
  });
});

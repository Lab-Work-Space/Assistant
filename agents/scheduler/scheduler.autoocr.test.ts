import { BOT_LOG_CHANNEL_ID } from '../../company/channels.js';
import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from '../../company/types.js';
import type { Task } from '../../db/repos/tasks.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { FakeDiscordPort } from '../../tests/fakes/discordPort.js';
import type { AgentDeps, AgentOutcome, AgentTrigger } from '../loop/loop.js';
import { Scheduler } from './scheduler.js';
import { MemTasks, humanMsg, newBus, noApprovedTools, quiet, seededOrg } from '../test-helpers.js';
import { VisionCap } from '../loop/vision.js';

const PRAW_CH = '1569111111111111111';
const OTHER_CH = '1565682159375749161'; // software's work channel
const CDN = 'https://cdn.discordapp.com/attachments/1/2/receipt.png?ex=1';
const chat = (body: string): AgentOutcome => ({ payload: { type: 'chat', body }, costUsd: 0, turns: 1 });
const IMG = { name: 'receipt.png', url: CDN, size: 5000 };

async function mk(o: { auto?: string | null; mapped?: boolean; daily?: number } = {}) {
  const cfg = new FakeConfig({ 'ocr.autoChannelId': 'auto' in o ? (o.auto ?? null) : PRAW_CH, 'limits.visionPerUserDay': o.daily ?? 30, 'limits.prawPerUser10Min': 3 });
  const tasks = new MemTasks() as MemTasks & { findByThread(id: string): Promise<Task | null> };
  tasks.findByThread = async () => null;
  const port = new FakeDiscordPort();
  const now = () => Date.UTC(2026, 10, 1, 12);
  const vision = new VisionCap(cfg, now);
  const runs: AgentTrigger[] = [];
  const run = vi.fn(async (t: AgentTrigger) => { runs.push(t); return chat('ok'); });
  const org = await seededOrg({ editDept: (d) => (d.id === 'praw' && o.mapped !== false ? { ...d, workChannelId: PRAW_CH } : d) });
  const s = new Scheduler({
    agent: {} as AgentDeps, approvedTools: noApprovedTools, run, port, org, tasks, limits: new Limits(cfg, tasks), halt: { isHalted: () => false },
    cfg, bus: newBus(), log: quiet, now, vision,
  });
  s.attach();
  return { s, port, runs, run, vision, cfg };
}
const img = (over: Partial<IncomingMessage> = {}) => humanMsg('', { channelId: PRAW_CH, attachments: [IMG], ...over });

describe('auto-ocr', () => {
  it('auto-ocr › image in the configured, praw-mapped channel triggers OCR (origin chat, to Praw, instruction in code)', async () => {
    const t = await mk();
    await t.s.onMessage(img());
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(1);
    const trig = t.runs[0]!;
    expect(trig.route.actor).toEqual({ kind: 'head', dept: 'praw' });
    expect(trig.msg).toMatchObject({ origin: 'chat', attachments: [IMG] });
    expect(trig.msg!.content).toContain('ocr_image');
    expect(t.port.posts.filter((p) => p.payload.type === 'alert')).toEqual([]);
    expect(t.port.posts).toHaveLength(1); // Praw's answer, delivered in the channel
  });

  it('auto-ocr › elsewhere not: other channel, no image, a text file, a bot author, a Praw-less setting', async () => {
    const t = await mk();
    await t.s.onMessage(humanMsg('hi', { channelId: OTHER_CH, attachments: [IMG], mentionedHeads: ['software'] }));
    await t.s.onMessage(humanMsg('hello', { channelId: PRAW_CH }));
    await t.s.onMessage(img({ attachments: [{ name: 'notes.txt', url: CDN, size: 5 }] }));
    await t.s.onMessage(img({ author: { id: 'b', name: 'bot', kind: 'foreign_bot' } }));
    await t.s.idle();
    expect(t.runs.filter((r) => r.msg?.content.includes('ocr_image'))).toEqual([]);
    const off = await mk({ auto: null });
    await off.s.onMessage(img());
    await off.s.idle();
    expect(off.runs.filter((r) => r.msg?.content.includes('ocr_image'))).toEqual([]); // a plain post there is still just a Praw chat message
  });

  it('auto-ocr › unmapped configured channel does nothing and alerts once', async () => {
    const t = await mk({ mapped: false });
    await t.s.onMessage(img());
    await t.s.onMessage(img({ author: { id: '77', name: 'o', kind: 'human' } }));
    await t.s.idle();
    expect(t.run).not.toHaveBeenCalled();
    const alerts = t.port.posts.filter((p) => p.payload.type === 'alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.target).toEqual({ channelId: BOT_LOG_CHANNEL_ID });
    expect(JSON.stringify(alerts[0]!.payload)).toContain(PRAW_CH);
  });

  it('caps › auto-OCR channel images count against the Praw per-user counter (P15, P19)', async () => {
    const t = await mk();
    for (let i = 0; i < 4; i++) await t.s.onMessage(img());
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(3); // limits.prawPerUser10Min = 3
    expect(t.port.posts.filter((p) => p.payload.title === 'Slow down')).toHaveLength(1);
  });

  it('caps › over limits.visionPerUserDay: a notice, no run, no Praw slot used', async () => {
    const t = await mk({ daily: 1 });
    t.vision.take('42');
    await t.s.onMessage(img());
    await t.s.idle();
    expect(t.run).not.toHaveBeenCalled();
    expect(t.port.posts).toHaveLength(1);
    expect(JSON.stringify(t.port.posts[0]!.payload)).toMatch(/limit/i);
    t.vision.take('other');
    await t.cfg.set('limits.visionPerUserDay', 5, 't');
    for (let i = 0; i < 3; i++) await t.s.onMessage(img());
    await t.s.idle();
    expect(t.run).toHaveBeenCalledTimes(3); // the refused image took no Praw slot
  });
});

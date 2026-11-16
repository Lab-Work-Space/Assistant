import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCalendar } from '../company/calendar.js';
import { Org, seed } from '../company/index.js';
import type { ActorRef } from '../company/types.js';
import { BotMessageRepo, ChannelMapRepo, DepartmentRepo, PersonaRepo, TaskRepo } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { Limits } from '../governance/limits.js';
import { FakeConfig } from '../governance/test-helpers.js';
import { FakeDiscordPort } from '../tests/fakes/discordPort.js';
import type { AgentDeps } from './loop/loop.js';
import type { OutboundPayload } from './loop/payload.js';
import { Scheduler } from './scheduler/scheduler.js';
import { newBus, noApprovedTools, prompts } from './test-helpers.js';

// GROW-1 Scheduler.notifyHead (Gate 1 GW-C22): code text in a head's work room, plain chat, recorded with clean provenance.
class Port extends FakeDiscordPort {
  override snowflakes = true;
  fail = false;
  override async post(actor: ActorRef, target: { channelId: string; threadId?: string }, payload: OutboundPayload, opts?: Parameters<FakeDiscordPort['post']>[3]): Promise<string> {
    if (this.fail) throw new Error('discord down');
    const id = await super.post(actor, target, payload, opts);
    opts?.onSent?.([id]);
    return id;
  }
}

let db: TestDb;
let org: Org;
beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'), 'up');
  const repos = { departments: new DepartmentRepo(db.pool), personas: new PersonaRepo(db.pool), channelMap: new ChannelMapRepo(db.pool) };
  await seed(repos, prompts);
  org = await Org.load(repos, prompts);
});
afterAll(async () => db.close());

function mk() {
  const cfg = new FakeConfig({ 'schedule.offDays': [], 'schedule.timezone': 'Asia/Bangkok' } as never);
  const port = new Port();
  const tasks = new TaskRepo(db.pool, []);
  const limits = new Limits(cfg, tasks);
  const log = { error: vi.fn(), warn: vi.fn() };
  const s = new Scheduler({
    agent: { limits } as unknown as AgentDeps, approvedTools: noApprovedTools, run: async () => ({ payload: { type: 'chat', body: 'x' }, costUsd: 0, turns: 1, tainted: false }), port, org, tasks, limits,
    halt: { isHalted: () => false }, cfg, bus: newBus(), log, incidents: { report: vi.fn(() => '') }, calendar: createCalendar(cfg), secrets: [], provenance: new BotMessageRepo(db.pool),
  } as never);
  return { s, port };
}

describe('Scheduler.notifyHead', () => {
  it('posts plain chat with noHandles as the head in its work room and records clean provenance (tainted false, no user)', async () => {
    const t = mk();
    await t.s.notifyHead('software', 'Tool request #1 (web_search): approved by a Bot Admin. You can use it from your next run.');
    expect(t.port.posts).toHaveLength(1);
    const p = t.port.posts[0]!;
    expect(p.actor).toEqual({ kind: 'head', dept: 'software' });
    expect(p.target.channelId).toBe(org.dept('software')!.workChannelId);
    expect(p.payload).toEqual({ type: 'chat', body: 'Tool request #1 (web_search): approved by a Bot Admin. You can use it from your next run.', noHandles: true });
    const rows = (await db.pool.query('SELECT message_id, tainted, trigger_user_id FROM bot_messages')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tainted: false, trigger_user_id: null });
  });
  it('throws (so the caller can log it) when the department has no work room or the post fails', async () => {
    const t = mk();
    await expect(t.s.notifyHead('nowhere', 'x')).rejects.toThrow();
    t.port.fail = true;
    await expect(t.s.notifyHead('software', 'x')).rejects.toThrow();
  });
});

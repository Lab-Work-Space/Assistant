import { describe, expect, it } from 'vitest';
import { AI_WARROOM_CHANNEL_ID as WR } from '../../company/channels.js';
import type { ActorRef } from '../../company/types.js';
import type { ConfigKey, ConfigValue } from '../../config/schema.js';
import { Limits } from '../../governance/limits.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { SAY_MAX_CHARS } from '../../tools/builtin/warroomSay.js';
import { FakeDiscordPort } from '../../tests/fakes/discordPort.js';
import { createConversation } from '../conversation.js';
import type { AgentDeps } from '../loop/loop.js';
import { WarroomGuard } from '../team/warroom.js';
import { MemTasks, newBus, noApprovedTools, quiet, seededOrg } from '../test-helpers.js';
import { Scheduler } from './scheduler.js';

const CTO = { kind: 'head', dept: 'software' } as ActorRef;
const MIN = 60_000;
type Cfg = Partial<{ [K in ConfigKey]: ConfigValue<K> }>;
type Say = Parameters<NonNullable<AgentDeps['warroomSay']>['say']>[0];

async function mk(cfgOver: Cfg = {}, o: { audit?: (a: unknown) => Promise<void>; log?: { error(x: unknown, m?: string): void } } = {}) {
  const cfg = new FakeConfig({ 'warroom.stallTurns': 1, 'warroom.turnsPerThreadPerHour': 1000, 'warroom.turnsPerHour': 1000, ...cfgOver });
  const tasks = new MemTasks();
  const port = new FakeDiscordPort();
  port.snowflakes = true;
  const bus = newBus();
  const audits: { actor: string; action: string; outcome: string }[] = [];
  const clock = { t: Date.parse('2026-11-09T05:00:00Z') };
  const agent = {} as AgentDeps;
  const s = new Scheduler({
    agent, run: async () => ({ payload: { type: 'chat', body: 'ok' }, costUsd: 0, turns: 1 }), port, org: await seededOrg(), tasks, limits: new Limits(cfg, tasks), halt: { isHalted: () => false },
    cfg, bus, log: o.log ?? quiet, conversation: createConversation({ tasks, port, limits: new Limits(cfg, tasks), bus }), approvedTools: noApprovedTools, now: () => clock.t,
    calendar: { isOffDay: () => ({ off: false }) }, admin: { audit: o.audit ?? (async (a) => void audits.push(a as never)) },
  });
  s.attach();
  const guard = (s as unknown as { guard: WarroomGuard }).guard;
  const stall = async () => {
    await guard.ensure(WR);
    guard.start(WR, 'a');
    guard.start(WR, 'a'); // stallTurns 1: the 2nd start stalls
    expect(guard.isStalled(WR)).toBe(true);
  };
  const say = (o: Partial<Say> = {}) => (s as unknown as { warroomSay(r: Say): Promise<{ ok: boolean; reason?: string }> }).warroomSay({ actor: CTO, text: '@CFO hi', task: null, tainted: false, personStarted: true, personAdmin: false, personUser: '1565682159375749161', ...o });
  const wrPosts = () => port.posts.filter((p) => p.target.channelId === WR).length;
  return { s, cfg, guard, stall, say, port, audits, clock, wrPosts, sayAt: (s as unknown as { sayAt: Map<string, number[]> }).sayAt };
}
const STALLED = /stalled until a person writes/;

describe('HEAL-1 H3a: a person-started say lifts a stalled warroom', () => {
  it('an untainted person-started say lifts, posts, audits person_run, and the room stalls again after stallTurns turns', async () => {
    const r = await mk();
    await r.stall();
    expect(await r.say()).toMatchObject({ ok: true });
    expect(r.wrPosts()).toBe(1);
    expect(r.audits).toEqual([{ actor: 'system', action: 'warroom.stall.lift', outcome: 'person_run head:software user:1565682159375749161' }]);
    expect(r.guard.isStalled(WR)).toBe(false);
    r.guard.taskWrite(WR); // resetUsed true after a lift: no extra reset
    expect(r.guard.start(WR, 'a').kind).toBe('ok');
    expect(r.guard.start(WR, 'a').kind).toBe('stalled');
  });
  it('tainted, bot-started and heal-off says do not lift and say nothing new', async () => {
    const r = await mk();
    await r.stall();
    expect(await r.say({ tainted: true })).toMatchObject({ ok: false, reason: expect.stringMatching(STALLED) });
    expect(await r.say({ personStarted: false })).toMatchObject({ ok: false, reason: expect.stringMatching(STALLED) });
    expect(await r.say({ personStarted: undefined })).toMatchObject({ ok: false });
    r.cfg.values.set('heal.enabled', false);
    expect(await r.say()).toMatchObject({ ok: false, reason: expect.stringMatching(STALLED) });
    r.cfg.throwOn.add('heal.enabled');
    expect(await r.say()).toMatchObject({ ok: false, reason: expect.stringMatching(STALLED) });
    expect(r.wrPosts()).toBe(0);
    expect(r.audits).toEqual([]);
    expect(r.guard.isStalled(WR)).toBe(true);
  });
  it('a say refused by the hourly, private-room or length check does not lift', async () => {
    const hourly = await mk();
    await hourly.stall();
    hourly.sayAt.set('software', Array.from({ length: 50 }, () => hourly.clock.t));
    expect(await hourly.say()).toMatchObject({ ok: false, reason: expect.stringMatching(/per hour/) });
    expect(hourly.guard.isStalled(WR)).toBe(true);

    const priv = await mk();
    await priv.stall();
    priv.port.privateChannel.set(WR, false);
    expect(await priv.say()).toMatchObject({ ok: false, reason: expect.stringMatching(/not a private channel/) });
    expect(priv.guard.isStalled(WR)).toBe(true);

    const long = await mk();
    await long.stall();
    expect(await long.say({ text: 'x'.repeat(SAY_MAX_CHARS + 50) })).toMatchObject({ ok: false });
    expect(long.guard.isStalled(WR)).toBe(true);
    expect(long.audits).toEqual([]);
  });
  it('refused says do not move the quiet clock; a posted say does', async () => {
    const r = await mk();
    await r.stall(); // stamped at the 2nd start
    r.clock.t += 40 * MIN;
    r.port.privateChannel.set(WR, false);
    await r.say({ personStarted: false });
    await r.say();
    r.clock.t += 20 * MIN;
    expect(r.guard.isStalled(WR)).toBe(false); // quiet 60 min from the last ok start; refusals did not move it
    expect(r.audits.map((a) => a.outcome)).toEqual(['quiet']);
    const p = await mk();
    await p.stall();
    p.clock.t += 40 * MIN;
    await p.say(); // lifts and posts: stamps the clock
    expect(p.wrPosts()).toBe(1);
  });
  it('non-admin person lifts stop at personLiftsPerDay; a Bot Admin still lifts afterwards and is not counted', async () => {
    const r = await mk({ 'warroom.personLiftsPerDay': 2 });
    for (let i = 0; i < 2; i++) {
      await r.stall();
      expect(await r.say()).toMatchObject({ ok: true });
      r.guard.humanMessage(WR);
    }
    await r.stall();
    expect(await r.say()).toMatchObject({ ok: false, reason: expect.stringMatching(STALLED) });
    expect(await r.say({ personAdmin: true })).toMatchObject({ ok: true });
    r.guard.humanMessage(WR);
    await r.stall();
    expect(await r.say({ personAdmin: true })).toMatchObject({ ok: true });
    r.guard.humanMessage(WR);
    await r.stall();
    expect(await r.say()).toMatchObject({ ok: false });
    // the next day in schedule.timezone the count is back
    r.clock.t += 24 * 60 * MIN;
    expect(await r.say()).toMatchObject({ ok: true });
  });
  it('quiet lifts stop at quietLiftsPerDay', async () => {
    const r = await mk({ 'warroom.quietLiftsPerDay': 1 });
    await r.stall();
    r.clock.t += 60 * MIN;
    expect(r.guard.isStalled(WR)).toBe(false);
    r.guard.humanMessage(WR);
    await r.stall();
    r.clock.t += 60 * MIN;
    expect(r.guard.isStalled(WR)).toBe(true);
  });
  it('the day rolls over at midnight in schedule.timezone, not UTC', async () => {
    const r = await mk({ 'warroom.personLiftsPerDay': 1, 'schedule.timezone': 'Asia/Bangkok' });
    r.clock.t = Date.parse('2026-11-09T16:30:00Z'); // 23:30 on the 9th in Bangkok
    await r.stall();
    expect(await r.say()).toMatchObject({ ok: true });
    r.guard.humanMessage(WR);
    await r.stall();
    expect(await r.say()).toMatchObject({ ok: false });
    r.clock.t = Date.parse('2026-11-09T17:10:00Z'); // 00:10 on the 10th in Bangkok, still the 9th in UTC
    expect(await r.say()).toMatchObject({ ok: true });
  });
  it('G2-02: a failing lift audit logs the error name only and the say still posts', async () => {
    const errors: unknown[] = [];
    const r = await mk({}, { audit: async () => { throw new TypeError('db detail user:1565682159375749161'); }, log: { ...quiet, error: (x: unknown) => void errors.push(x) } });
    await r.stall();
    expect((await r.say()).ok).toBe(true);
    await new Promise((res) => setTimeout(res, 0));
    expect(errors).toEqual([{ errName: 'TypeError' }]);
  });
  it('without a stall nothing changes: no lift, no audit, and the say posts', async () => {
    const r = await mk();
    await r.guard.ensure(WR);
    expect(await r.say({ personStarted: false })).toMatchObject({ ok: true });
    expect(r.audits).toEqual([]);
  });
});

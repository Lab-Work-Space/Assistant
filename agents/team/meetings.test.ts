import { describe, expect, it } from 'vitest';
import type { DeptId } from '../../core/index.js';
import { ConfigSchema } from '../../config/schema.js';
import { CONFIG_DEFAULTS } from '../../config/defaults.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import type { RootTaskGate } from '../../tools/types.js';
import { MAX_CLOSE_TASKS, Meetings, type MeetingHost } from './meetings.js';

const HQ = { kind: 'head', dept: 'hq' } as const;
const MON_0905 = Date.UTC(2026, 10, 2, 2, 5); // Monday 09:05 in Asia/Bangkok
const WED_1405 = Date.UTC(2026, 10, 4, 7, 5);
const SAT_0905 = Date.UTC(2026, 10, 7, 2, 5);
const ALL: DeptId[] = ['hq', 'software', 'rnd', 'it', 'marketing', 'sales', 'hr', 'finance', 'ops', 'praw'];

function rig(o: { now?: number; off?: boolean; work?: { blocked: string[]; overdue: string[] }; online?: (d: DeptId) => boolean; roots?: RootTaskGate; cfg?: object } = {}) {
  const jobs: Promise<void>[] = [];
  const turns: { dept: DeptId; thread: string; text: string; content: string; gate: RootTaskGate }[] = [];
  const posts: { thread: string; title?: string; body: string }[] = [];
  const claimed = new Set<string>();
  const opened: boolean[] = [];
  const state = { off: o.off ?? false, now: o.now ?? MON_0905, halted: false };
  let m!: Meetings;
  const host: MeetingHost = {
    canRun: () => !state.halted, offDay: () => state.off, online: o.online ?? (() => true),
    openThread: async (name) => { threads.push(name); return `thread-${threads.length}`; },
    post: async (thread, p) => { posts.push({ thread, ...(p.title ? { title: p.title } : {}), body: p.body }); return 'id'; },
    turn: async (dept, thread, t, x) => { opened.push(m.isOpen(thread)); turns.push({ dept, thread, text: t.instruction, content: t.content, gate: x.taskGate }); },
    openWork: async () => o.work ?? { blocked: [], overdue: [] },
    spawn: (_w, fn) => void jobs.push(fn()),
  };
  const threads: string[] = [];
  m = new Meetings({
    cfg: new FakeConfig(o.cfg as never), now: () => state.now, claim: async (k) => (claimed.has(k) ? false : (claimed.add(k), true)),
    heads: () => ALL, ...(o.roots ? { roots: o.roots } : {}), log: { error: () => undefined },
  });
  m.bind(host);
  return { m, turns, posts, threads, state, opened, claimed, done: async () => { await Promise.all(jobs); } };
}

describe('TW13 meetings', () => {
  it('runs 2 rounds in a fixed order and closes with the CEO; routing is off until the close; cost is invitees x 2 + 1', async () => {
    const r = rig();
    expect(await r.m.start({ topic: 'Launch', agenda: ['a', 'b'], invitees: ['rnd', 'software', 'it'], actor: HQ })).toMatchObject({ ok: true });
    await r.done();
    expect(r.threads[0]).toBe('Meeting: Launch (2026-11-02)');
    expect(r.turns.map((t) => t.dept)).toEqual(['rnd', 'software', 'it', 'rnd', 'software', 'it', 'hq']);
    expect(r.turns).toHaveLength(3 * 2 + 1);
    expect(r.turns[0]!.text).toContain('round 1 of 2');
    expect(r.turns[3]!.text).toContain('round 2 of 2');
    expect(r.opened.every(Boolean)).toBe(true); // isOpen during every turn
    expect(r.m.isOpen('thread-1')).toBe(false); // and off after the close
    expect(r.turns.at(-1)!.gate).toBeDefined();
    // the agenda travels as the (untrusted) message; the code-written instruction carries no model text
    expect(r.turns[0]!.content).toBe('Meeting topic: Launch\nAgenda:\n- a\n- b');
    expect(r.turns.every((t) => !t.text.includes('Launch') && !t.text.includes('- a'))).toBe(true);
    expect(r.posts[0]).toMatchObject({ title: 'Agenda: Launch', body: '- a\n- b' });
  });

  it('invitees: de-duplicated, never the CEO or an unknown id, offline heads dropped, at most 9', async () => {
    const r = rig({ online: (d) => d !== 'ops' });
    await r.m.start({ topic: 't', agenda: ['x'], invitees: ['rnd', 'rnd', 'hq', 'ops', 'nobody' as never, ...ALL], actor: HQ });
    await r.done();
    const first = r.turns.filter((t) => t.text.includes('round 1 of 2')).map((t) => t.dept);
    expect(new Set(first).size).toBe(first.length);
    expect(first).not.toContain('hq');
    expect(first).not.toContain('ops');
    expect(first.length).toBeLessThanOrEqual(9);
    expect(r.turns.length).toBe(first.length * 2 + 1);
  });

  it('refuses: not the CEO, from inside a meeting thread, while another is open, over the daily cap, on an off day', async () => {
    const r = rig();
    const req = { topic: 't', agenda: ['x'], invitees: ['rnd' as DeptId], actor: HQ };
    expect(await r.m.start({ ...req, actor: { kind: 'head', dept: 'software' } })).toMatchObject({ ok: false });
    expect(await r.m.start(req)).toMatchObject({ ok: true });
    expect(await r.m.start(req)).toMatchObject({ ok: false, reason: 'another meeting is open' });
    await r.done();
    expect(r.m.refusal({ threadId: 'thread-1' })).toBe('a meeting cannot be started from inside a meeting thread');
    expect(await r.m.start(req)).toMatchObject({ ok: true });
    await r.done();
    expect(await r.m.start(req)).toMatchObject({ ok: false, reason: expect.stringContaining('daily limit of 2') });
    const off = rig({ off: true });
    expect(await off.m.start(req)).toMatchObject({ ok: false, reason: expect.stringContaining('off day') });
  });

  it('the close may create at most 10 tasks, each also counted against the daily root-task cap', async () => {
    let taken = 0;
    const roots: RootTaskGate = { acquire: async () => (taken < 100 ? (taken++, () => undefined) : null) };
    const r = rig({ roots });
    await r.m.start({ topic: 't', agenda: ['x'], invitees: ['rnd'], actor: HQ });
    await r.done();
    const gate = r.turns.at(-1)!.gate!;
    const got = await Promise.all(Array.from({ length: 15 }, () => gate.acquire()));
    expect(got.filter(Boolean)).toHaveLength(MAX_CLOSE_TASKS);
    expect(taken).toBe(MAX_CLOSE_TASKS);
    const capped = rig({ roots: { acquire: async () => null } });
    await capped.m.start({ topic: 't', agenda: ['x'], invitees: ['rnd'], actor: HQ });
    await capped.done();
    expect(await capped.turns.at(-1)!.gate!.acquire()).toBeNull();
  });

  it('TW6: only the CEO\'s close can create tasks; every invitee round turn gets a gate that refuses', async () => {
    const roots: RootTaskGate = { acquire: async () => () => undefined };
    const r = rig({ roots });
    await r.m.start({ topic: 't', agenda: ['x'], invitees: ['rnd', 'it'], actor: HQ });
    await r.done();
    for (const t of r.turns.slice(0, -1)) expect(await t.gate.acquire(), t.dept).toBeNull();
    expect(await r.turns.at(-1)!.gate.acquire()).not.toBeNull();
  });

  it('the ad-hoc daily cap is stored: a restart (a new instance on the same claims) does not reset it', async () => {
    const r = rig();
    const req = { topic: 't', agenda: ['x'], invitees: ['rnd' as DeptId], actor: HQ };
    await r.m.start(req);
    await r.done();
    await r.m.start(req);
    await r.done();
    const again = new Meetings({ cfg: new FakeConfig(), now: () => r.state.now, claim: async (k) => (r.claimed.has(k) ? false : (r.claimed.add(k), true)), heads: () => ALL, log: { error: () => undefined } });
    again.bind({ canRun: () => true, offDay: () => false, online: () => true, openThread: async () => 'x', post: async () => null, turn: async () => undefined, openWork: async () => ({ blocked: [], overdue: [] }), spawn: () => undefined });
    expect(await again.start(req)).toMatchObject({ ok: false, reason: expect.stringContaining('daily limit') });
  });

  it('the agenda and thread name are cleaned and capped', async () => {
    const r = rig();
    await r.m.start({ topic: `x${'y'.repeat(300)}\nline`, agenda: Array.from({ length: 9 }, (_, i) => `p${i}${'z'.repeat(400)}`), invitees: ['rnd'], actor: HQ });
    await r.done();
    expect(r.threads[0]!.length).toBeLessThanOrEqual(100);
    expect(r.posts[0]!.body.split('\n')).toHaveLength(5);
    expect(r.posts[0]!.body.split('\n').every((l) => l.length <= 202)).toBe(true);
  });

  it('a halt stops the meeting between turns', async () => {
    const r = rig();
    await r.m.start({ topic: 't', agenda: ['x'], invitees: ['rnd', 'it'], actor: HQ });
    r.state.halted = true;
    await r.done();
    expect(r.turns).toHaveLength(0);
    expect(r.m.isOpen('thread-1')).toBe(false);
  });
});

describe('TW13 the weekly schedule (started by code)', () => {
  it('Monday 09:00 starts the planning meeting once, even across ticks (claimed)', async () => {
    const r = rig();
    await r.m.tick();
    await r.m.tick();
    await r.done();
    expect(r.threads).toEqual(['Meeting: Weekly planning (2026-11-02)']);
    expect(r.turns.at(-1)!.dept).toBe('hq');
  });

  it('nothing before the time, nothing after the catch-up window', async () => {
    const early = rig({ now: Date.UTC(2026, 10, 2, 1, 55) });
    await early.m.tick();
    const late = rig({ now: Date.UTC(2026, 10, 2, 5, 0) });
    await late.m.tick();
    await Promise.all([early.done(), late.done()]);
    expect(early.threads.length + late.threads.length).toBe(0);
  });

  it('skips off days and a halted company', async () => {
    const off = rig({ now: SAT_0905, off: true, cfg: { 'meetings.weekly': [{ day: 6, time: '09:00', kind: 'planning', topic: 'Sat' }] } });
    await off.m.tick();
    const halted = rig();
    halted.state.halted = true;
    await halted.m.tick();
    await Promise.all([off.done(), halted.done()]);
    expect(off.threads.length + halted.threads.length).toBe(0);
    halted.state.halted = false;
    await halted.m.tick(); // not claimed while halted: it still starts inside the window
    await halted.done();
    expect(halted.threads).toHaveLength(1);
  });

  it('Wednesday 14:00 progress meets only when something is blocked or overdue, with ids in the agenda and no titles', async () => {
    const quiet = rig({ now: WED_1405 });
    await quiet.m.tick();
    const busy = rig({ now: WED_1405, work: { blocked: ['b1234567890'], overdue: ['o1234567890', 'o2'] } });
    await busy.m.tick();
    await Promise.all([quiet.done(), busy.done()]);
    expect(quiet.threads).toHaveLength(0);
    expect(busy.threads).toEqual(['Meeting: Progress check (2026-11-04)']);
    expect(busy.posts[0]!.body).toContain('Blocked tasks (1): b1234567');
    expect(busy.posts[0]!.body).toContain('Overdue tasks (2)');
  });

  it('Friday 16:00 starts the review', async () => {
    const r = rig({ now: Date.UTC(2026, 10, 6, 9, 10) });
    await r.m.tick();
    await r.done();
    expect(r.threads).toEqual(['Meeting: Weekly review (2026-11-06)']);
  });

  it('an open meeting delays the next one (retried inside the window), it does not overlap', async () => {
    const r = rig();
    await r.m.start({ topic: 't', agenda: ['x'], invitees: ['rnd'], actor: HQ });
    await r.m.tick();
    expect([...r.claimed].filter((k) => k.includes('planning'))).toHaveLength(0);
    await r.done();
    await r.m.tick();
    await r.done();
    expect(r.threads).toHaveLength(2);
  });
});

describe('meetings.weekly schema (TW13)', () => {
  const s = ConfigSchema['meetings.weekly'];
  it('default is valid: Monday 09:00 planning, Wednesday 14:00 progress, Friday 16:00 review', () => {
    expect(s.safeParse(CONFIG_DEFAULTS['meetings.weekly']).success).toBe(true);
    expect(CONFIG_DEFAULTS['meetings.weekly'].map((e) => `${e.day} ${e.time} ${e.kind}`)).toEqual(['1 09:00 planning', '3 14:00 progress', '5 16:00 review']);
  });
  it('rejects a bad day, time, kind, topic, extra key, duplicates and more than 3 entries', () => {
    const ok = { day: 1, time: '09:00', kind: 'planning', topic: 'x' };
    for (const bad of [{ ...ok, day: 7 }, { ...ok, day: -1 }, { ...ok, time: '9:00' }, { ...ok, time: '24:00' }, { ...ok, time: '09:60' }, { ...ok, kind: 'x' }, { ...ok, topic: '' }, { ...ok, topic: 'a'.repeat(101) }, { ...ok, topic: 'a\nb' }, { ...ok, extra: 1 }])
      expect(s.safeParse([bad]).success, JSON.stringify(bad)).toBe(false);
    expect(s.safeParse([ok, ok]).success).toBe(false);
    expect(s.safeParse([ok, { ...ok, day: 2 }, { ...ok, day: 3 }, { ...ok, day: 4 }]).success).toBe(false);
    expect(s.safeParse([]).success).toBe(true);
  });
  it('warroom defaults: 50% of the local pool and of the company budget', () => {
    expect(CONFIG_DEFAULTS['warroom.localCallsPerDay']).toBe(CONFIG_DEFAULTS['limits.localCallsPerDay'] / 2);
    expect(CONFIG_DEFAULTS['warroom.dailyUsd']).toBe(CONFIG_DEFAULTS['budget.companyDailyUsd'] / 2);
    expect(CONFIG_DEFAULTS['warroom.rootTasksPerDay']).toBe(10);
  });
});

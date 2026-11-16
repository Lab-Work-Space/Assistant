import { describe, expect, it } from 'vitest';
import { AI_WARROOM_CHANNEL_ID as WR } from '../../company/channels.js';
import { FakeConfig } from '../../governance/test-helpers.js';
import { liftsCap } from '../../governance/budget.js';
import { WarroomGuard, type GuardRow, type GuardStore, type LiftOpts } from './warroom.js';

const MIN = 60_000;
const LIM = { turnsPerThreadPerHour: 1000, turnsPerHour: 1000, stallTurns: 2, heldMax: 10 };
const DEPT = '1566454343820124399';
const THREAD = '1566454343820124400';

class Store implements GuardStore {
  rows = new Map<string, GuardRow>();
  async get(k: string) { return this.rows.get(k) ?? null; }
  async put(k: string, r: GuardRow) { this.rows.set(k, { ...r }); }
  async prune() {}
}

function mk(o: { on?: boolean; quietCap?: number; personCap?: number; store?: Store; start?: number; clock?: { t: number } } = {}) {
  const clock = o.clock ?? { t: o.start ?? Date.parse('2026-11-09T05:00:00Z') };
  const cfg = { on: o.on ?? true, quietCap: o.quietCap ?? 3, personCap: o.personCap ?? 4, offsetH: 0 };
  const lifts: { reason: string; detail?: string }[] = [];
  const opts: LiftOpts = {
    quietMs: () => (cfg.on ? 60 * MIN : null), quietCap: () => (cfg.on ? cfg.quietCap : null), personCap: () => (cfg.on ? cfg.personCap : null),
    day: (ms) => new Date(ms + cfg.offsetH * 3_600_000).toISOString().slice(0, 10),
    onLift: (e) => void lifts.push(e),
  };
  const g = new WarroomGuard(() => LIM, () => clock.t, o.store, undefined, opts);
  return { g, clock, cfg, lifts };
}
/** Takes the key to stalled with stallTurns ok starts and one refused start. */
async function stall(g: WarroomGuard, key = WR) {
  await g.ensure(key);
  expect(g.start(key, 'a').kind).toBe('ok');
  expect(g.start(key, 'b').kind).toBe('ok');
  expect(g.start(key, 'a').kind).toBe('stalled');
}

describe('HL-C1/C4 H3b quiet lift', () => {
  it('59 min: no lift, 60 min: lift (isStalled and start both trigger it)', async () => {
    const { g, clock, lifts } = mk();
    await stall(g);
    clock.t += 59 * MIN;
    expect(g.isStalled(WR)).toBe(true);
    expect(g.start(WR, 'a').kind).toBe('stalled');
    clock.t += MIN;
    expect(g.isStalled(WR)).toBe(false);
    expect(lifts).toEqual([{ reason: 'quiet' }]);
    const m = mk();
    await stall(m.g);
    m.clock.t += 60 * MIN;
    expect(m.g.start(WR, 'a').kind).toBe('ok'); // start() lifts too
  });
  it('a refused start or a read does not move the quiet clock', async () => {
    const { g, clock } = mk();
    await stall(g); // clock stamped by the 2nd ok start
    clock.t += 40 * MIN;
    expect(g.start(WR, 'a').kind).toBe('stalled'); // refused: no stamp
    g.isStalled(WR);
    clock.t += 20 * MIN;
    expect(g.isStalled(WR)).toBe(false); // 60 min since the last ok start
  });
  it('noteBotPost moves the clock', async () => {
    const { g, clock } = mk();
    await stall(g);
    clock.t += 40 * MIN;
    g.noteBotPost(WR);
    clock.t += 59 * MIN;
    expect(g.isStalled(WR)).toBe(true);
    clock.t += MIN;
    expect(g.isStalled(WR)).toBe(false);
  });
  it('does nothing when heal is off, when paused, or when the cap is 0', async () => {
    const off = mk({ on: false });
    await stall(off.g);
    off.clock.t += 120 * MIN;
    expect(off.g.isStalled(WR)).toBe(true);
    const p = mk();
    await stall(p.g);
    p.g.pauseToday();
    p.clock.t += 120 * MIN;
    expect(p.g.isStalled(WR)).toBe(true);
    const z = mk({ quietCap: 0 });
    await stall(z.g);
    z.clock.t += 120 * MIN;
    expect(z.g.isStalled(WR)).toBe(true);
  });
  it('heal switched off later stops the lift', async () => {
    const { g, clock, cfg } = mk();
    await stall(g);
    clock.t += 120 * MIN;
    cfg.on = false;
    expect(g.isStalled(WR)).toBe(true);
  });
  it('only the warroom key lifts: a department-room key and a thread key stay stalled after 61 min', async () => {
    const { g, clock } = mk();
    await stall(g);
    await stall(g, DEPT);
    await stall(g, THREAD);
    clock.t += 61 * MIN;
    expect(g.isStalled(DEPT)).toBe(true);
    expect(g.isStalled(THREAD)).toBe(true);
    expect(g.lift(DEPT, 'quiet')).toBe(false);
    expect(g.canLift(DEPT, true)).toBe(false);
    expect(g.isStalled(WR)).toBe(false);
  });
  it('a NULL stored clock uses the load time', async () => {
    const store = new Store();
    store.rows.set(WR, { count: 2, stalled: true, ceoTurn: false, resetUsed: false, lastBotTurnAt: null });
    const { g, clock } = mk({ store });
    await g.ensure(WR);
    clock.t += 59 * MIN;
    expect(g.isStalled(WR)).toBe(true);
    clock.t += MIN;
    expect(g.isStalled(WR)).toBe(false);
  });
});

describe('G2-02 lift() callback failure', () => {
  it('a throwing onLift still lifts and logs the error name only', async () => {
    const errors: unknown[] = [];
    const opts: LiftOpts = {
      quietMs: () => 60 * MIN, quietCap: () => 3, personCap: () => 4, day: (ms) => new Date(ms).toISOString().slice(0, 10),
      onLift: () => { throw new TypeError('detail user:1566454343820124399'); },
    };
    const clock = { t: Date.parse('2026-11-09T05:00:00Z') };
    const g = new WarroomGuard(() => LIM, () => clock.t, undefined, { error: (o) => void errors.push(o) }, opts);
    await stall(g);
    expect(g.lift(WR, 'person_run', { admin: true })).toBe(true);
    expect(errors).toEqual([{ errName: 'TypeError' }]);
  });
});

describe('HL-C3 lift()', () => {
  it('re-stalls after exactly stallTurns starts (resetUsed stays true, taskWrite does not reset)', async () => {
    const { g, clock } = mk();
    await stall(g);
    clock.t += 60 * MIN;
    expect(g.isStalled(WR)).toBe(false);
    g.taskWrite(WR); // resetUsed is true: no reset
    expect(g.start(WR, 'a').kind).toBe('ok');
    g.taskWrite(WR);
    expect(g.start(WR, 'b').kind).toBe('ok');
    expect(g.start(WR, 'a')).toEqual({ kind: 'stalled', ceoTurn: true });
  });
  it('a person message gives the task-write reset back', async () => {
    const { g, clock } = mk();
    await stall(g);
    clock.t += 60 * MIN;
    g.isStalled(WR);
    g.start(WR, 'a');
    g.humanMessage(WR);
    g.start(WR, 'a');
    g.taskWrite(WR);
    expect(g.start(WR, 'a').kind).toBe('ok');
    expect(g.start(WR, 'a').kind).toBe('ok');
  });
});

describe('HL-C2 caps', () => {
  it('the 4th quiet lift in a day does nothing; the next day it works again', async () => {
    const { g, clock, lifts } = mk();
    for (let i = 0; i < 3; i++) {
      await stall(g);
      clock.t += 60 * MIN;
      expect(g.isStalled(WR)).toBe(false);
      g.start(WR, 'a'); // keeps `ensure` state realistic; the room is moving again
      g.humanMessage(WR);
    }
    expect(lifts).toHaveLength(3);
    await stall(g);
    clock.t += 60 * MIN;
    expect(g.isStalled(WR)).toBe(true);
    clock.t += 24 * 60 * MIN;
    expect(g.isStalled(WR)).toBe(false);
    expect(lifts).toHaveLength(4);
  });
  it('the 5th non-admin person lift is refused; an admin still lifts; admin lifts are not counted', async () => {
    const { g, lifts } = mk();
    for (let i = 0; i < 4; i++) {
      await stall(g);
      expect(g.canLift(WR, false)).toBe(true);
      expect(g.lift(WR, 'person_run', { detail: 'head:x user:1' })).toBe(true);
      g.humanMessage(WR);
    }
    await stall(g);
    expect(g.canLift(WR, false)).toBe(false);
    expect(g.lift(WR, 'person_run')).toBe(false);
    expect(g.canLift(WR, true)).toBe(true);
    for (let i = 0; i < 6; i++) {
      expect(g.lift(WR, 'person_run', { admin: true })).toBe(true);
      g.humanMessage(WR);
      await stall(g);
    }
    expect(lifts.filter((l) => l.reason === 'person_run')).toHaveLength(10);
    expect(g.canLift(WR, false)).toBe(false); // admin lifts counted for nothing, the 4 non-admin ones still hold
  });
  it('person cap 0, heal off, or a key that is not stalled: no lift', async () => {
    const z = mk({ personCap: 0 });
    await stall(z.g);
    expect(z.g.canLift(WR, true)).toBe(false);
    const off = mk({ on: false });
    await stall(off.g);
    expect(off.g.canLift(WR, true)).toBe(false);
    const ok = mk();
    await ok.g.ensure(WR);
    expect(ok.g.canLift(WR, true)).toBe(false);
  });
  it('person-lift counts roll over on the next day in the configured zone', async () => {
    const { g, clock, cfg } = mk({ start: Date.parse('2026-11-09T16:00:00Z') });
    cfg.offsetH = 7; // 16:00Z is 23:00 local on the 9th
    for (let i = 0; i < 4; i++) {
      await stall(g);
      g.lift(WR, 'person_run');
      g.humanMessage(WR);
    }
    await stall(g);
    expect(g.canLift(WR, false)).toBe(false);
    clock.t += 61 * MIN; // 00:01 local on the 10th (the UTC day is still the 9th)
    expect(g.canLift(WR, false)).toBe(true);
  });
  it('limits.localUnlimited does not lift either cap', () => {
    const cfg = new FakeConfig({ 'limits.localUnlimited': true });
    expect(liftsCap('warroom.quietLiftsPerDay', cfg, 'local')).toBe(false);
    expect(liftsCap('warroom.personLiftsPerDay', cfg, 'local')).toBe(false);
  });
  it('prune keeps the warroom state with 500+ other keys in memory', async () => {
    const { g, clock } = mk();
    await stall(g);
    for (let i = 0; i < 520; i++) {
      await g.ensure(`15000000000000${String(i).padStart(5, '0')}`);
      clock.t += 1000;
    }
    clock.t += 7 * 3_600_000;
    for (let i = 0; i < 5; i++) await g.ensure(`16000000000000${String(i).padStart(5, '0')}`);
    expect(g.lift(WR, 'person_run')).toBe(true); // still there and still stalled
  });
});

describe('HL-C2/HL-C18 persistence', () => {
  it('state survives a restart: stall, clock and counts are loaded by ensure()', async () => {
    const store = new Store();
    const a = mk({ store, personCap: 1 });
    await stall(a.g);
    a.g.lift(WR, 'person_run');
    a.g.humanMessage(WR);
    await stall(a.g);
    await a.g.flush(WR);
    expect(store.rows.get(WR)).toMatchObject({ stalled: true, personLifts: 1, quietLifts: 0, liftDay: '2026-11-09' });
    expect(store.rows.get(WR)!.lastBotTurnAt).toBeGreaterThan(0);
    const b = mk({ store, personCap: 1, clock: a.clock });
    await b.g.ensure(WR);
    expect(b.g.isStalled(WR)).toBe(true);
    expect(b.g.canLift(WR, false)).toBe(false); // the count held
    expect(b.g.canLift(WR, true)).toBe(true);
    a.clock.t += 60 * MIN; // the stored clock, not the load time
    expect(b.g.isStalled(WR)).toBe(false);
  });
});

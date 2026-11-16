import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActorRef } from '../company/types.js';
import { FakeConfig } from '../governance/test-helpers.js';
import { FallbackGate, markFromError, markFromRefusal } from './fallback-gate.js';
import { ProviderError } from './types.js';

const hq: ActorRef = { kind: 'head', dept: 'hq' };
const sw: ActorRef = { kind: 'head', dept: 'software' };
const T0 = Date.UTC(2026, 10, 16, 12, 0, 0);

function rig(over: { held?: number | null } = {}) {
  let now = T0;
  let held: number | null = over.held === undefined ? T0 + 3_600_000 : over.held;
  const events: { kind: string; first: boolean }[] = [];
  const cfg = new FakeConfig();
  cfg.values.set('provider.fallback.enabled', true);
  const gate = new FallbackGate({ heldUntil: () => held, now: () => now, onMark: (e, first) => events.push({ kind: e.kind, first }) });
  return { gate, events, advance: (ms: number) => { now += ms; }, setHeld: (h: number | null) => { held = h; } };
}

describe('R8 FallbackGate', () => {
  it('starts clear and delegates the hold', () => {
    const { gate } = rig();
    expect(gate.heldUntil()).toBe(T0 + 3_600_000);
    expect(gate.usable(hq, 'hq')).toBe(true);
  });

  it('apiOff (401/402/403) blocks everyone until the hold episode ends; the alert is first once per episode', () => {
    const { gate, events } = rig();
    gate.mark({ kind: 'api_off', status: 401 });
    gate.mark({ kind: 'api_off', status: 403 });
    expect(gate.usable(hq, 'hq')).toBe(false);
    expect(gate.usable(sw, 'software')).toBe(false);
    expect(events).toEqual([{ kind: 'api_off', first: true }, { kind: 'api_off', first: false }]);
    gate.clear();
    expect(gate.usable(hq, 'hq')).toBe(true);
    gate.mark({ kind: 'api_off', status: 402 });
    expect(events.at(-1)).toEqual({ kind: 'api_off', first: true });
  });

  it('apiBusy cools for 5 minutes; the alert is once per episode', () => {
    const { gate, events, advance } = rig();
    gate.mark({ kind: 'api_busy', status: 429 });
    expect(gate.usable(hq, 'hq')).toBe(false);
    advance(4 * 60_000);
    expect(gate.usable(hq, 'hq')).toBe(false);
    advance(61_000);
    expect(gate.usable(hq, 'hq')).toBe(true);
    gate.mark({ kind: 'api_busy', status: 529 });
    expect(events.map((e) => e.first)).toEqual([true, false]);
  });

  it('a repeated 429 after the cool-down keeps cooling (no block)', () => {
    const { gate, advance } = rig();
    gate.mark({ kind: 'api_busy', status: 429 });
    advance(5 * 60_000 + 1);
    gate.mark({ kind: 'api_busy', status: 429 });
    expect(gate.usable(hq, 'hq')).toBe(false);
    advance(5 * 60_000 + 1);
    expect(gate.usable(hq, 'hq')).toBe(true);
  });

  it('a company refusal holds everyone until the next UTC day', () => {
    const { gate, advance } = rig();
    gate.mark({ kind: 'budget', scope: 'company', actor: hq, dept: 'hq' });
    expect(gate.usable(sw, 'software')).toBe(false);
    advance(11 * 3_600_000 + 59 * 60_000); // 23:59 UTC
    expect(gate.usable(sw, 'software')).toBe(false);
    advance(2 * 60_000); // next UTC day
    expect(gate.usable(sw, 'software')).toBe(true);
  });

  it('a bot refusal holds that actor only; a dept refusal that department only', () => {
    const { gate } = rig();
    gate.mark({ kind: 'budget', scope: 'bot', actor: hq, dept: 'hq' });
    expect(gate.usable(hq, 'hq')).toBe(false);
    expect(gate.usable(sw, 'software')).toBe(true);
    gate.mark({ kind: 'budget', scope: 'dept', actor: sw, dept: 'software' });
    expect(gate.usable(sw, 'software')).toBe(false);
    expect(gate.usable({ kind: 'persona', personaId: 'p1' }, 'software')).toBe(false); // the whole department
    expect(gate.usable({ kind: 'persona', personaId: 'p1' }, 'sales')).toBe(true);
  });

  it('a 400 is a per-task mark: only that task is held, nobody else, never apiOff (PV-C06)', () => {
    const { gate, events } = rig();
    gate.mark({ kind: 'task_400', taskId: 't1' });
    expect(gate.usable(hq, 'hq', 't1')).toBe(false);
    expect(gate.usable(hq, 'hq', 't2')).toBe(true);
    expect(gate.usable(hq, 'hq')).toBe(true);
    expect(gate.usable(sw, 'software', 't3')).toBe(true);
    expect(events).toEqual([{ kind: 'task_400', first: true }]);
    gate.mark({ kind: 'task_400', taskId: 't2' });
    expect(events.at(-1)).toEqual({ kind: 'task_400', first: false }); // A3 once per episode
    gate.clear();
    expect(gate.usable(hq, 'hq', 't1')).toBe(true);
  });

  // Gate 2 G2-PV-02 (rule 10): anyone who can talk to a bot can cause a 400; that must not use up the A3 alert that tells the owner the backup is off for everyone.
  it('a per-task 400 does not swallow the later apiOff alert (separate once-per-episode claims)', () => {
    const { gate, events } = rig();
    gate.mark({ kind: 'task_400', taskId: 't1' });
    gate.mark({ kind: 'api_off', status: 401 });
    expect(events).toEqual([{ kind: 'task_400', first: true }, { kind: 'api_off', first: true }]);
    gate.mark({ kind: 'api_off', status: 403 });
    gate.mark({ kind: 'task_400', taskId: 't2' });
    expect(events.slice(2)).toEqual([{ kind: 'api_off', first: false }, { kind: 'task_400', first: false }]);
  });

  it('claimReoffer: once per task per episode (PV-C03)', () => {
    const { gate } = rig();
    expect(gate.claimReoffer('t1')).toBe(true);
    expect(gate.claimReoffer('t1')).toBe(false);
    expect(gate.claimReoffer('t2')).toBe(true);
    gate.clear();
    expect(gate.claimReoffer('t1')).toBe(true);
  });

  it('a throwing alert hook never breaks a mark', () => {
    const gate = new FallbackGate({ heldUntil: () => null, now: () => T0, onMark: () => { throw new Error('boom'); } });
    expect(() => gate.mark({ kind: 'api_off', status: 401 })).not.toThrow();
    expect(gate.usable(hq, 'hq')).toBe(false);
  });

  it('episodeUsed is set by noteUsed and read by the end alert', () => {
    const { gate } = rig();
    expect(gate.episodeUsed()).toBe(false);
    gate.noteUsed();
    expect(gate.episodeUsed()).toBe(true);
    gate.clear();
    expect(gate.episodeUsed()).toBe(false);
  });
});

describe('R8 markFromError (numeric status only)', () => {
  const e = (status?: number) => new ProviderError('vendor words', { retryable: false, ...(status !== undefined ? { status } : {}) });
  it('maps the status table', () => {
    for (const s of [401, 402, 403]) expect(markFromError(e(s))).toEqual({ kind: 'api_off', status: s });
    for (const s of [408, 409, 429, 500, 502, 503, 529]) expect(markFromError(e(s))).toEqual({ kind: 'api_busy', status: s });
    expect(markFromError(e(400))).toEqual({ kind: 'task_400' });
  });
  it('anything else, a missing status or a non-error gives null', () => {
    for (const s of [404, 413, 422, undefined]) expect(markFromError(e(s))).toBeNull();
    expect(markFromError(new Error('HTTP 401 in text'))).toBeNull();
    expect(markFromError({ status: '401' })).toBeNull();
    expect(markFromError(null)).toBeNull();
  });
});

describe('R8 markFromRefusal', () => {
  it('company, bot and dept hold the work; task, project, price and the rest keep their own flows', () => {
    for (const scope of ['company', 'bot', 'dept']) expect(markFromRefusal(scope, hq, 'hq')).toEqual({ kind: 'budget', scope, actor: hq, dept: 'hq' });
    for (const scope of ['task', 'project', 'price', 'local', 'local_task', 'warroom', 'warroom_bot', 'x']) expect(markFromRefusal(scope, hq, 'hq')).toBeNull();
  });
});

describe('R8 FallbackGate expiry re-offer', () => {
  afterEach(() => vi.useRealTimers());
  const mkTimed = () => {
    vi.useFakeTimers({ now: T0 });
    const expired: number[] = [];
    const gate = new FallbackGate({ heldUntil: () => T0 + 7 * 86_400_000, now: () => Date.now(), onExpire: () => { expired.push(Date.now()); } });
    return { gate, expired };
  };

  it('a cool-down mark calls onExpire once, just after it ends, so the requeued work is offered again (A4 says five minutes)', async () => {
    const { gate, expired } = mkTimed();
    gate.mark({ kind: 'api_busy', status: 429 });
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(expired).toHaveLength(0);
    expect(gate.usable(hq, 'hq')).toBe(false);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(expired).toHaveLength(1);
    expect(gate.usable(hq, 'hq')).toBe(true);
    await vi.advanceTimersByTimeAsync(86_400_000);
    expect(expired).toHaveLength(1);
  });

  it('a repeated 429 moves the expiry; only the last cool-down fires', async () => {
    const { gate, expired } = mkTimed();
    gate.mark({ kind: 'api_busy', status: 429 });
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    gate.mark({ kind: 'api_busy', status: 429 });
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(expired).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(expired).toHaveLength(1);
  });

  it('a company, bot or dept mark calls onExpire after the next UTC midnight (once for several marks)', async () => {
    const { gate, expired } = mkTimed(); // 12:00 UTC
    gate.mark({ kind: 'budget', scope: 'company', actor: hq, dept: 'hq' });
    gate.mark({ kind: 'budget', scope: 'bot', actor: sw, dept: 'software' });
    await vi.advanceTimersByTimeAsync(11 * 3_600_000 + 59 * 60_000);
    expect(expired).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(expired).toHaveLength(1);
    expect(gate.usable(hq, 'hq')).toBe(true);
  });

  it('api_off and a per-task 400 last for the episode: no timer, no onExpire', async () => {
    const { gate, expired } = mkTimed();
    gate.mark({ kind: 'api_off', status: 401 });
    gate.mark({ kind: 'task_400', taskId: 't1' });
    await vi.advanceTimersByTimeAsync(3 * 86_400_000);
    expect(expired).toHaveLength(0);
  });

  it('clear() cancels every pending expiry; a throwing onExpire never breaks anything', async () => {
    const { gate, expired } = mkTimed();
    gate.mark({ kind: 'api_busy', status: 500 });
    gate.mark({ kind: 'budget', scope: 'dept', actor: sw, dept: 'software' });
    gate.clear();
    await vi.advanceTimersByTimeAsync(2 * 86_400_000);
    expect(expired).toHaveLength(0);
    const bad = new FallbackGate({ heldUntil: () => null, now: () => Date.now(), onExpire: () => { throw new Error('boom'); } });
    bad.mark({ kind: 'api_busy', status: 429 });
    await expect(vi.advanceTimersByTimeAsync(10 * 60_000)).resolves.not.toThrow();
  });
});

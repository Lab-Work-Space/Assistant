import { describe, expect, it } from 'vitest';
import { EventBus, type AppEvents } from '../core/events.js';
import type { Task } from '../db/repos/tasks.js';
import { Halt } from './halt.js';
import { FakeConfig } from './test-helpers.js';

function fakeTasks(ids: string[]) {
  const updates: { id: string; status: string; expected?: string; reason?: string }[] = [];
  return {
    updates,
    listByStatus: async (s: string) => (s === 'doing' ? ids.map((id) => ({ id }) as Task) : []),
    update: async (id: string, p: { status?: string; blockedReason?: string }, expected?: string) => {
      updates.push({ id, status: p.status!, expected, ...(p.blockedReason ? { reason: p.blockedReason } : {}) });
      return { id, status: p.status } as Task;
    },
  };
}

describe('Halt', () => {
  it('abortInFlight aborts tracked work without halting or persisting anything', async () => {
    const cfg = new FakeConfig();
    const tasks = fakeTasks(['a']);
    const h = new Halt(cfg, tasks as never, new EventBus<AppEvents>());
    const a = new AbortController();
    h.track(a);
    expect(h.abortInFlight()).toBe(1);
    expect(a.signal.aborted).toBe(true);
    expect(h.isHalted()).toBe(false);
    expect(cfg.values.has('halted')).toBe(false);
    expect(tasks.updates).toEqual([]);
  });

  it('halt aborts tracked controllers', async () => {
    const cfg = new FakeConfig();
    const tasks = fakeTasks(['a', 'b']);
    const h = new Halt(cfg, tasks as never, new EventBus<AppEvents>());
    const a = new AbortController();
    const b = new AbortController();
    const c = new AbortController();
    h.track(a);
    h.track(b);
    h.track(c)(); // untracked again
    expect(await h.halt('admin')).toBe(2);
    expect([a.signal.aborted, b.signal.aborted, c.signal.aborted]).toEqual([true, true, false]);
    expect(h.isHalted()).toBe(true);
    expect(tasks.updates).toEqual([
      { id: 'a', status: 'blocked', expected: 'doing', reason: 'halt' },
      { id: 'b', status: 'blocked', expected: 'doing', reason: 'halt' },
    ]);
  });

  it('isHalted true on second instance after config change', async () => {
    const cfg = new FakeConfig(); // shared "database"
    const bus = new EventBus<AppEvents>();
    const one = new Halt(cfg, fakeTasks([]) as never, bus);
    const two = new Halt(cfg, fakeTasks([]) as never, bus);
    expect(two.isHalted()).toBe(false);
    await one.halt('admin');
    expect(two.isHalted()).toBe(true);
    await one.resume('admin');
    expect(two.isHalted()).toBe(false);
  });

  it('config read error treated as halted', () => {
    const cfg = new FakeConfig();
    cfg.throwOn.add('halted');
    expect(new Halt(cfg, fakeTasks([]) as never, new EventBus<AppEvents>()).isHalted()).toBe(true);
  });

  it('non-boolean halted value treated as halted', () => {
    const cfg = new FakeConfig({ halted: 'no' as never });
    expect(new Halt(cfg, fakeTasks([]) as never, new EventBus<AppEvents>()).isHalted()).toBe(true);
  });

  it('emits halt.changed and still aborts when persisting fails', async () => {
    const cfg = new FakeConfig();
    cfg.set = async () => { throw new Error('db down'); };
    const bus = new EventBus<AppEvents>();
    const seen: unknown[] = [];
    bus.on('halt.changed', (p) => { seen.push(p); });
    const h = new Halt(cfg, fakeTasks([]) as never, bus);
    const ac = new AbortController();
    h.track(ac);
    await expect(h.halt('admin')).rejects.toThrow('db down');
    expect(ac.signal.aborted).toBe(true);
    expect(seen).toEqual([{ halted: true, by: 'admin' }]);
  });

  it('latches locally: halted during a slow persist and after a failed one', async () => {
    const cfg = new FakeConfig();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    cfg.set = async () => { await gate; throw new Error('db down'); };
    const h = new Halt(cfg, fakeTasks([]) as never, new EventBus<AppEvents>());
    const p = h.halt('admin').catch(() => undefined);
    expect(h.isHalted()).toBe(true); // during the persist
    release();
    await p;
    expect(h.isHalted()).toBe(true); // persist failed, still latched
  });

  it('resume clears the latch', async () => {
    const cfg = new FakeConfig();
    const h = new Halt(cfg, fakeTasks([]) as never, new EventBus<AppEvents>());
    await h.halt('a');
    await h.resume('a');
    expect(h.isHalted()).toBe(false);
  });

  it('a controller tracked while halted is aborted at once', async () => {
    const h = new Halt(new FakeConfig(), fakeTasks([]) as never, new EventBus<AppEvents>());
    await h.halt('admin');
    const ac = new AbortController();
    h.track(ac);
    expect(ac.signal.aborted).toBe(true);
  });

  it('a halt set elsewhere aborts tracked controllers and blocks doing tasks once', async () => {
    const cfg = new FakeConfig();
    const tasks = fakeTasks(['a']);
    const h = new Halt(cfg, tasks as never, new EventBus<AppEvents>());
    const ac = new AbortController();
    h.track(ac);
    await cfg.set('halted', true, 'other-instance');
    await new Promise((r) => setTimeout(r, 10));
    expect(ac.signal.aborted).toBe(true);
    expect(tasks.updates).toHaveLength(1);
  });

  it('halt blocks doing tasks with reason halt and mirrors each as task.changed (R35, final #4)', async () => {
    const tasks = fakeTasks(['a', 'b']);
    const bus = new EventBus<AppEvents>();
    const changed: unknown[] = [];
    bus.on('task.changed', (e) => void changed.push({ id: e.task.id, from: e.from, to: e.to }));
    await new Halt(new FakeConfig(), tasks as never, bus).halt('admin');
    expect(tasks.updates).toEqual([
      { id: 'a', status: 'blocked', expected: 'doing', reason: 'halt' },
      { id: 'b', status: 'blocked', expected: 'doing', reason: 'halt' },
    ]);
    expect(changed).toEqual([{ id: 'a', from: 'doing', to: 'blocked' }, { id: 'b', from: 'doing', to: 'blocked' }]);
  });
});

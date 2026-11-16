import { describe, expect, it } from 'vitest';
import { Limits } from './limits.js';
import { FakeConfig } from './test-helpers.js';

const tick = () => new Promise((r) => setTimeout(r, 10));

describe('Limits', () => {
  it('turn 20 rejected at default', () => {
    const l = new Limits(new FakeConfig());
    expect(l.checkTurn({ turnsUsed: 19 })).toBe(true);
    expect(l.checkTurn({ turnsUsed: 20 })).toBe(false);
  });

  it('depth 4 rejected', () => {
    const l = new Limits(new FakeConfig());
    expect(l.checkDepth(2)).toBe(true); // child depth 3
    expect(l.checkDepth(3)).toBe(false); // child depth 4
  });

  it('concurrency 4 blocks the 5th acquire until release', async () => {
    const l = new Limits(new FakeConfig());
    const rel = await Promise.all([l.acquire(), l.acquire(), l.acquire(), l.acquire()]);
    let fifth = false;
    const p = l.acquire().then((r) => { fifth = true; return r; });
    await tick();
    expect(fifth).toBe(false);
    rel[0]!();
    const r5 = await p;
    expect(fifth).toBe(true);
    r5();
  });

  it('release is idempotent', async () => {
    const l = new Limits(new FakeConfig({ 'limits.concurrency': 1 }));
    const r = await l.acquire();
    r();
    r();
    const a = await l.acquire();
    let second = false;
    void l.acquire().then(() => { second = true; });
    await tick();
    expect(second).toBe(false);
    a();
  });

  it('resizes on config change', async () => {
    const cfg = new FakeConfig({ 'limits.concurrency': 1 });
    const l = new Limits(cfg);
    await l.acquire();
    let second = false;
    void l.acquire().then(() => { second = true; });
    await tick();
    expect(second).toBe(false);
    await cfg.set('limits.concurrency', 2, 'admin');
    await tick();
    expect(second).toBe(true);
  });

  it('6th OPEN child under one parent is refused (childrenPerTask 5); finished children do not count (2026-11-08)', async () => {
    let n = 5;
    const l = new Limits(new FakeConfig(), { countOpenChildren: async () => n, countChildren: async () => 99, countOpen: async () => 0 });
    expect(await l.checkChildren('p')).toBe(false);
    n = 4;
    expect(await l.checkChildren('p')).toBe(true);
  });

  it('openTasks cap 20 refuses the 21st', async () => {
    let n = 20;
    const l = new Limits(new FakeConfig(), { countOpenChildren: async () => 0, countChildren: async () => 0, countOpen: async () => n });
    expect(await l.checkOpenTasks()).toBe(false);
    n = 19;
    expect(await l.checkOpenTasks()).toBe(true);
  });

  it('count lookups that throw fail closed', async () => {
    const boom = async () => { throw new Error('db'); };
    const l = new Limits(new FakeConfig(), { countOpenChildren: boom, countChildren: boom, countOpen: boom });
    expect(await l.checkChildren('p')).toBe(false);
    expect(await l.checkOpenTasks()).toBe(false);
  });
});

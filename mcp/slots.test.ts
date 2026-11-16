import { describe, expect, it } from 'vitest';
import { McpError } from './errors.js';
import { Slots } from './slots.js';

const code = async (p: Promise<unknown>): Promise<string | undefined> => { try { await p; } catch (e) { return e instanceof McpError ? e.code : 'other'; } return undefined; };
const tick = () => new Promise((r) => setTimeout(r, 10));

describe('MCP-AC13 / MC-C13: slots (global 2, per server 1, wait 15 s, at most 8 waiters)', () => {
  it('a third concurrent call waits and is served when a slot frees; the per-server limit holds', async () => {
    const s = new Slots({ waitMs: 1000 });
    const a = await s.acquire('aa');
    const b = await s.acquire('bb');
    let got = '';
    const c = s.acquire('cc').then((x) => { got = 'c'; return x; });
    await tick();
    expect(got).toBe('');
    a.release();
    const cc = await c;
    expect(got).toBe('c');
    const d = s.acquire('bb').then((x) => { got = 'd'; return x; });
    await tick();
    expect(got).toBe('c'); // bb already holds its one slot
    b.release();
    (await d).release();
    cc.release();
  });
  it('the same server never holds two slots even when the global limit is free', async () => {
    const s = new Slots({ waitMs: 1000 });
    const a = await s.acquire('aa');
    let second = false;
    const p = s.acquire('aa').then((x) => { second = true; return x; });
    await tick();
    expect(second).toBe(false);
    a.release();
    (await p).release();
  });
  it('waits at most waitMs and then E_BUSY with the waiter removed; release is idempotent', async () => {
    const s = new Slots({ waitMs: 40 });
    const a = await s.acquire('aa');
    const t0 = Date.now();
    expect(await code(s.acquire('aa'))).toBe('E_BUSY');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(30);
    a.release();
    a.release();
    const b = await s.acquire('aa');
    const c = await s.acquire('bb');
    b.release();
    c.release();
    expect(s.state()).toEqual({ running: 0, waiting: 0 });
  });
  it('at most 8 waiters: the ninth waiting call is E_BUSY at once', async () => {
    const s = new Slots({ waitMs: 1000 });
    const a = await s.acquire('aa');
    const waiters = Array.from({ length: 8 }, () => s.acquire('aa'));
    const t0 = Date.now();
    expect(await code(s.acquire('aa'))).toBe('E_BUSY');
    expect(Date.now() - t0).toBeLessThan(200);
    expect(s.state().waiting).toBe(8);
    a.release();
    for (const w of waiters) (await w).release();
    expect(s.state()).toEqual({ running: 0, waiting: 0 });
  });
});

describe('G2-MCP-06: a free server does not wait behind another server\'s blocked waiter', () => {
  it('with bb running and a second bb call queued, aa takes the free slot at once; the queued bb call is still served when bb frees', async () => {
    const s = new Slots({ waitMs: 1000 });
    const b1 = await s.acquire('bb');
    let b2got = false;
    const b2 = s.acquire('bb').then((x) => { b2got = true; return x; });
    await tick();
    expect(s.state()).toEqual({ running: 1, waiting: 1 });
    const t0 = Date.now();
    const a = await s.acquire('aa');
    expect(Date.now() - t0).toBeLessThan(5);
    expect(b2got).toBe(false);
    b1.release();
    const b2s = await b2;
    expect(b2got).toBe(true);
    a.release();
    b2s.release();
    expect(s.state()).toEqual({ running: 0, waiting: 0 });
  });
  it('the global limit still queues: with two running, a third server waits', async () => {
    const s = new Slots({ waitMs: 1000 });
    const a = await s.acquire('aa');
    const b = await s.acquire('bb');
    let got = false;
    const c = s.acquire('cc').then((x) => { got = true; return x; });
    await tick();
    expect(got).toBe(false);
    a.release();
    (await c).release();
    b.release();
  });
});

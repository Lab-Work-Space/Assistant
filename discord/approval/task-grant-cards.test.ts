import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskGrant } from '../../db/repos/task-grants.js';
import { TaskGrantCards } from './task-grant-cards.js';

const row = (over: Partial<TaskGrant> = {}): TaskGrant => ({
  id: 9, rootId: 'root-1', approvalId: 1, grantedBy: '123456789012345678', requestedBy: 'head:praw', maxCalls: 40, used: 3, usedByTool: { forum_post: 3 }, webGrantId: null,
  cardMessageId: '223456789012345678', cardChannelId: '323456789012345678', createdAt: new Date(), expiresAt: new Date(Date.now() + 3600_000), revokedAt: null, revokeReason: null, ...over,
});

/** Fakes as classes using `this`. */
class FakeRepo { current: TaskGrant | null = row(); reads = 0; async editable(id: number) { this.reads++; return this.current && this.current.id === id ? this.current : null; } }
class FakePorts {
  notes: [string, string, string][] = []; closes: [string, string, string][] = []; fail = false; gate: Promise<void> | null = null;
  async note(c: string, m: string, t: string) { if (this.gate) await this.gate; if (this.fail) throw new Error('discord down'); this.notes.push([c, m, t]); }
  async close(c: string, m: string, t: string) { this.closes.push([c, m, t]); }
}
const logs: unknown[] = [];
const mk = (repo: FakeRepo, ports: FakePorts, batch = false) => new TaskGrantCards({
  repo, ports, text: async (g) => `live used ${g.used}`, endedText: (g, r) => `ended ${r} ${g.used}`, isBatchCard: async () => batch, log: { error: (o) => void logs.push(o) },
});

beforeEach(() => { vi.useFakeTimers(); logs.length = 0; });
afterEach(() => { vi.useRealTimers(); });

describe('TG-C17: the debounced usage line', () => {
  it('a burst of calls gives ONE edit per 15 s window, on the stored card ids, with the row re-read', async () => {
    const repo = new FakeRepo(); const ports = new FakePorts(); const c = mk(repo, ports);
    for (let i = 0; i < 7; i++) c.touch(9);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(ports.notes).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(ports.notes).toEqual([['323456789012345678', '223456789012345678', 'live used 3']]);
    expect(repo.reads).toBe(1);
    c.touch(9);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(ports.notes).toHaveLength(2); // the next window
  });

  it('a close (revoke, root end, halt) cancels the pending edit: nothing repaints a closed card', async () => {
    const repo = new FakeRepo(); const ports = new FakePorts(); const c = mk(repo, ports);
    c.touch(9);
    await vi.advanceTimersByTimeAsync(5_000);
    c.closed(9);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ports.notes).toEqual([]);
    c.touch(9); // a late spend after the close never schedules anything either
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ports.notes).toEqual([]);
  });

  it('an edit skipped when the row is no longer editable (revoked, expired, root ended)', async () => {
    const repo = new FakeRepo(); const ports = new FakePorts(); const c = mk(repo, ports);
    repo.current = null;
    c.touch(9);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(ports.notes).toEqual([]);
  });

  it('a close landing while the edit is in flight wins: the edit finishes first, then the card is closed', async () => {
    const repo = new FakeRepo(); const ports = new FakePorts(); const c = mk(repo, ports);
    let release!: () => void;
    ports.gate = new Promise<void>((r) => { release = r; });
    c.touch(9);
    await vi.advanceTimersByTimeAsync(16_000); // edit started, stuck on the port
    const closing = c.revoked([row({ revokedAt: new Date(), revokeReason: 'halt' })], 'halt');
    await Promise.resolve();
    expect(ports.closes).toEqual([]); // the close waits for the in-flight edit
    release();
    await closing;
    expect(ports.closes).toEqual([['323456789012345678', '223456789012345678', 'ended halt 3']]);
  });

  it('a Discord failure is logged and never thrown', async () => {
    const repo = new FakeRepo(); const ports = new FakePorts(); ports.fail = true; const c = mk(repo, ports);
    c.touch(9);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(logs).toHaveLength(1);
  });
});

describe('closing the card of a revoked grant', () => {
  it('a solo card loses its buttons; a batch card keeps them (content only)', async () => {
    const solo = new FakePorts(); await mk(new FakeRepo(), solo, false).revoked([row()], 'root_ended');
    expect(solo.closes).toHaveLength(1);
    expect(solo.notes).toEqual([]);
    const batch = new FakePorts(); await mk(new FakeRepo(), batch, true).revoked([row()], 'disabled');
    expect(batch.notes).toHaveLength(1);
    expect(batch.closes).toEqual([]);
  });

  it('an admin revoke is closed by the Revoke click itself (no second writer) but still cancels the usage edit', async () => {
    const ports = new FakePorts(); const c = mk(new FakeRepo(), ports);
    c.touch(9);
    await c.revoked([row()], 'admin');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ports.closes).toEqual([]);
    expect(ports.notes).toEqual([]);
  });

  it('a grant without stored card ids is skipped; a port failure is logged', async () => {
    const ports = new FakePorts();
    await mk(new FakeRepo(), ports).revoked([row({ cardMessageId: null, cardChannelId: null })], 'halt');
    expect(ports.closes).toEqual([]);
    const failing = { note: async () => { throw new Error('x'); }, close: async () => { throw new Error('x'); } };
    const c = new TaskGrantCards({ repo: new FakeRepo(), ports: failing, text: async () => '', endedText: () => 'e', isBatchCard: async () => false, log: { error: (o) => void logs.push(o) } });
    await c.revoked([row()], 'halt');
    expect(logs).toHaveLength(1);
  });
});

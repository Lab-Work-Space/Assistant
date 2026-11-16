import { vi } from 'vitest';
import type { AuditEntry } from '../../../governance/index.js';
import { FakeDiscordPort } from '../../../tests/fakes/discordPort.js';
import { ClickUpError, type CuComment, type CuTask } from './client.js';
import type { ClickUpSeenRepo } from '../../../db/repos/praw.js';
import { ClickUpPoller } from './poller.js';

/** In-memory stand-in for ClickUpSeenRepo (the DB-backed behaviour is in poller.int.test.ts). */
export function memSeen() {
  const rows = new Set<string>();
  let base: Date | null = null;
  const k = (t: string, kind: string, f: string) => `${t}|${kind}|${f}`;
  return {
    rows,
    async claim(t: string, kind: string, f: string, at = new Date()) {
      if (kind === 'baseline') base = at;
      const key = k(t, kind, f);
      if (rows.has(key)) return false;
      rows.add(key);
      return true;
    },
    async claimMany(r: { taskId: string; kind: string; fingerprint: string }[]) { for (const x of r) rows.add(k(x.taskId, x.kind, x.fingerprint)); },
    async release(t: string, kind: string, f: string) { rows.delete(k(t, kind, f)); },
    async baselineAt() { return base; },
    async prune() { return 0; },
    ticks: null as number | null,
    async lastTick() { return this.ticks; },
    async saveTick(ms: number) { this.ticks = ms; },
  };
}

export const NOW = Date.parse('2026-11-01T10:00:00Z');
export const task = (over: Partial<CuTask> = {}): CuTask => ({ id: 't1', name: 'Write spec', status: { status: 'to do' }, assignees: [], date_updated: String(NOW), ...over });

export function rig(o: { tasks?: CuTask[]; comments?: Record<string, CuComment[]>; channel?: string | null; me?: number | null; failComments?: string[] } = {}) {
  let now = NOW;
  const state = { tasks: o.tasks ?? [], comments: o.comments ?? {}, fail: false };
  const client = {
    listOpenTasks: vi.fn(async () => { if (state.fail) throw new ClickUpError('ClickUp request failed (HTTP 500)', 500); return { tasks: state.tasks, truncated: false }; }),
    listComments: vi.fn(async (id: string) => { if (o.failComments?.includes(id)) throw new ClickUpError('ClickUp request failed (HTTP 500)', 500); return state.comments[id] ?? []; }),
    currentUserId: vi.fn(async () => o.me ?? null),
  };
  const port = new FakeDiscordPort();
  const audits: AuditEntry[] = [];
  const log = { warn: vi.fn(), error: vi.fn() };
  const seen = memSeen();
  const mk = (s: Pick<ClickUpSeenRepo, 'claim' | 'claimMany' | 'release' | 'baselineAt' | 'prune' | 'lastTick' | 'saveTick'> = seen as never) => new ClickUpPoller({
    client, seen: s, port, channel: async () => (o.channel === undefined ? '1569000000000000001' : o.channel), intervalSec: () => 120,
    canRun: () => true, clock: () => now, log, audit: async (e) => void audits.push(e),
  });
  return { state, client, port, audits, log, seen, mk, advance: (ms: number) => void (now += ms), now: () => now };
}


import type { ActorRef } from '../../../company/types.js';
import type { ClickUpSeenRepo, SeenKind } from '../../../db/repos/praw.js';
import type { DiscordPort } from '../../../discord/port.js';
import type { AuditFn } from '../../../governance/audit.js';
import { CLICKUP_ID } from '../../../services/ids.js';
import { clip, escapeText } from '../watch/diff.js';
import type { ClickUpClient, CuTask } from './client.js';

/** R1 order: clickup.notifyChannelId, then Praw's work channel (/channel map ... work:true), then a channel_map row of praw with isWork; else null. */
export function resolveNotifyChannel(configured: string | null, workChannelId: string | null | undefined, map: { deptId: string; channelId: string; isWork: boolean }[]): string | null {
  return configured ?? workChannelId ?? map.find((m) => m.deptId === 'praw' && m.isWork)?.channelId ?? null;
}

const MAX_COMMENT_FAILS = 3;
const PRAW: ActorRef = { kind: 'head', dept: 'praw' };
/** Config min is 30 (clickup.pollIntervalSec); enforced again here so a bad injected value cannot hammer ClickUp. */
export const MIN_INTERVAL_SEC = 30;
/** Notices per tick; the rest stay unclaimed and are announced on the next tick. */
const MAX_POSTS = 10;
/** Tasks whose comments are read per tick (one request each); the rest wait for the next tick. */
export const MAX_COMMENT_TASKS = 20;
const MAX_BACKOFF_MS = 30 * 60_000;
const SLACK_MS = 60_000;
const DAY = 86_400_000;
const RETAIN_MS = 30 * DAY;
/** Comments older than this are never announced, so pruning comment rows cannot make an old comment look new. */
const COMMENT_MAX_AGE_MS = 25 * DAY;
const PRUNE_EVERY_MS = DAY;

export interface ClickUpPollerDeps {
  client: Pick<ClickUpClient, 'listOpenTasks' | 'listComments'> & Partial<Pick<ClickUpClient, 'currentUserId' | 'teamTasks' | 'listCommentsFor'>>;
  /**
   * CLICKUP-ALL-1 (workspace mode): the lists to watch (clickup.pollListIds), read every tick; an empty list polls nothing. Absent = list mode (today's behaviour).
   * Each watched list has its own silent baseline row ('*','baseline',<listId>); the legacy row with fingerprint '1' belongs to list mode.
   */
  watched?: () => readonly string[];
  seen: Pick<ClickUpSeenRepo, 'claim' | 'claimMany' | 'release' | 'baselineAt' | 'prune' | 'lastTick' | 'saveTick'>;
  port: Pick<DiscordPort, 'post'>;
  /** See resolveNotifyChannel; read every tick so a later /channel map takes effect. Null posts nothing (one alert). */
  channel: () => Promise<string | null>;
  /** clickup.pollIntervalSec, read before every wait. */
  intervalSec: () => number;
  /** False while halted, paused (D9) or stopping. */
  canRun: () => boolean;
  clock: () => number;
  log: { warn(o: unknown, m?: string): void; error(o: unknown, m?: string): void };
  audit?: AuditFn;
  enabled?: () => boolean;
}

type Notice = { kind: SeenKind; taskId: string; fp: string; body: string };
const one = (s: string, n: number): string => escapeText(clip(s.replace(/\s+/g, ' ').trim(), n));
const link = (id: string): string => (CLICKUP_ID.test(id) ? `\n<https://app.clickup.com/t/${id}>` : '');
const who = (t: CuTask): string[] => (t.assignees ?? []).map((u) => one(u.username ?? String(u.id), 40));

/**
 * Polls the configured ClickUp list and announces new tasks, status changes, assignments and comments as Praw (spec §14.10). There is
 * no model in this path (PF15): notices are built by code from untrusted ClickUp text, escaped and capped, with no pings and no tool run.
 * Each fact is claimed in clickup_seen before it is posted (insert-or-skip), so ticks, restarts and overlapping pollers announce it once; a
 * claim whose post failed is released. The first run takes a silent baseline. A failed poll backs off (interval x 2^fails, at most 30 min)
 * with one audited alert per streak.
 */
export class ClickUpPoller {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = true;
  private fails = 0;
  private backoffUntil = 0;
  private alerted = new Set<string>();
  private since: number | null = null;
  private lastPrune = 0;
  private readonly commentFails = new Map<string, number>();

  constructor(private readonly d: ClickUpPollerDeps) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.tick().finally(() => this.schedule());
  }

  private schedule(): void {
    if (this.stopped) return;
    const sec = Math.max(MIN_INTERVAL_SEC, this.d.intervalSec());
    this.timer = setTimeout(() => void this.tick().finally(() => this.schedule()), sec * 1000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** One pass; a tick that overlaps a running one waits for it instead of starting a second. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    const run = this.pass().catch((err: unknown) => {
      this.d.log.error({ err: err instanceof Error ? err.name : 'error' }, 'clickup poll failed');
    }).finally(() => { if (this.running === run) this.running = null; });
    this.running = run;
    return run;
  }

  private async alertOnce(key: string, outcome: string): Promise<void> {
    if (this.alerted.has(key)) return;
    this.alerted.add(key);
    this.d.log.warn({ alert: key }, outcome);
    await this.d.audit?.({ actor: 'system:clickup', action: key, tool: 'clickup_poll', outcome });
  }

  private async pass(): Promise<void> {
    if (!this.d.canRun() || (this.d.enabled && !this.d.enabled())) return;
    const t0 = this.d.clock();
    if (t0 < this.backoffUntil) return;
    const channel = await this.d.channel();
    if (!channel) return void (await this.alertOnce('clickup.poll.no_channel', 'no notify channel configured and no mapped home channel for praw'));
    this.alerted.delete('clickup.poll.no_channel');
    const ws = this.d.watched !== undefined;
    let ids = ws ? [...new Set(this.d.watched!())] : [];
    if (ws && ids.length === 0) return;
    let list;
    try {
      list = ws ? await this.d.client.teamTasks!(ids) : await this.d.client.listOpenTasks({ includeDone: false });
    } catch (err) {
      return void (await this.fail(err));
    }
    if (this.fails > 0) { this.fails = 0; this.alerted.delete('clickup.poll.fail'); }
    // CLICKUP-MULTI-1: a watched list that is out of scope now is dropped BEFORE the baseline logic (else it would be baselined empty and flood notices once it returns)
    const skipped: string[] = (ws ? (list as { skipped?: string[] }).skipped : undefined) ?? [];
    if (skipped.length) {
      ids = ids.filter((id) => !skipped.includes(id));
      await this.alertOnce('clickup.poll.watch_out_of_scope', `${skipped.length} watched list(s) are no longer in the ClickUp scope`); // a count only
      if (ids.length === 0) return;
    } else this.alerted.delete('clickup.poll.watch_out_of_scope');
    const bases = new Map<string, number>();
    let base: Date | null;
    if (!ws) {
      base = await this.d.seen.baselineAt();
      if (!base) return void (await this.baseline(list.tasks, t0));
    } else {
      // a list watched for the first time is baselined silently, alone; the other lists carry on
      const fresh: string[] = [];
      for (const id of ids) {
        const b = await this.d.seen.baselineAt(id);
        if (b) bases.set(id, b.getTime());
        else fresh.push(id);
      }
      if (fresh.length) {
        await this.baselineLists(list.tasks.filter((t) => fresh.includes(t.list?.id ?? '')), fresh, t0);
        for (const id of fresh) bases.set(id, t0);
        list = { ...list, tasks: list.tasks.filter((t) => !fresh.includes(t.list?.id ?? '')) };
      }
      base = new Date(Math.min(...bases.values()));
    }

    let posts = 0;
    const post = async (n: Notice): Promise<boolean> => {
      if (posts >= MAX_POSTS) {
        await this.d.seen.release(n.taskId, n.kind, n.fp); // over budget: unannounced, picked up next tick
        return false;
      }
      posts++;
      try {
        await this.d.port.post(PRAW, { channelId: channel }, { type: 'chat', body: n.body });
        return true;
      } catch (err) {
        await this.d.seen.release(n.taskId, n.kind, n.fp);
        this.d.log.warn({ err: err instanceof Error ? err.name : 'error' }, 'clickup notice could not be posted');
        posts = MAX_POSTS; // stop this tick; the unposted facts are retried on the next one
        return false;
      }
    };
    for (const t of list.tasks) if (!(await this.announceTask(t, post))) break;
    const full = posts < MAX_POSTS;
    if (full) await this.comments(list.tasks, base.getTime(), t0, post, bases);
    if (!list.truncated && t0 - this.lastPrune >= PRUNE_EVERY_MS) {
      this.lastPrune = t0;
      await this.d.seen.prune(new Date(t0 - RETAIN_MS), list.tasks.map((t) => t.id)).catch(() => undefined);
    }
  }

  /** Workspace mode: the silent baseline of newly watched lists (their tasks are recorded, nothing is posted; comments are cut off by the list's baseline time). */
  private async baselineLists(tasks: CuTask[], listIds: string[], at: number): Promise<void> {
    const rows = tasks.flatMap((t) => [
      { taskId: t.id, kind: 'created' as const, fingerprint: '1' },
      { taskId: t.id, kind: 'status_changed' as const, fingerprint: statusFp(t) },
      ...(t.assignees ?? []).map((u) => ({ taskId: t.id, kind: 'assigned' as const, fingerprint: String(u.id) })),
    ]);
    await this.d.seen.claimMany(rows, new Date(at));
    for (const id of listIds) await this.d.seen.claim('*', 'baseline', id, new Date(at)); // last, so an interrupted baseline is redone
    if (this.since === null && (await this.d.seen.lastTick()) === null) {
      this.since = at - SLACK_MS;
      await this.d.seen.saveTick(this.since);
    }
    await this.d.audit?.({ actor: 'system:clickup', action: 'clickup.poll.baseline', tool: 'clickup_poll', outcome: `${tasks.length} tasks recorded silently in ${listIds.length} new list(s)` });
  }

  /** Silent first run: everything that exists now is marked seen, nothing is posted. Comments are cut off by the baseline time instead. */
  private async baseline(tasks: CuTask[], at: number): Promise<void> {
    const rows = tasks.flatMap((t) => [
      { taskId: t.id, kind: 'created' as const, fingerprint: '1' },
      { taskId: t.id, kind: 'status_changed' as const, fingerprint: statusFp(t) },
      ...(t.assignees ?? []).map((u) => ({ taskId: t.id, kind: 'assigned' as const, fingerprint: String(u.id) })),
    ]);
    await this.d.seen.claimMany(rows, new Date(at));
    await this.d.seen.claim('*', 'baseline', '1', new Date(at)); // last, so an interrupted baseline is redone
    this.since = at - SLACK_MS;
    await this.d.seen.saveTick(this.since);
    await this.d.audit?.({ actor: 'system:clickup', action: 'clickup.poll.baseline', tool: 'clickup_poll', outcome: `${tasks.length} tasks recorded silently` });
  }

  /**
   * Known limit (M4): the status fingerprint is the status name and the assignee fingerprint the user id, and a fact is announced once ever.
   * So A->B->A on a status, or unassign then reassign of the same person, is silent. Facts of live tasks are never pruned.
   * Returns false once the per-tick post budget is spent.
   */
  private async announceTask(t: CuTask, post: (n: Notice) => Promise<boolean>): Promise<boolean> {
    const name = one(t.name, 120);
    const status = statusFp(t);
    const asg = who(t);
    if (await this.d.seen.claim(t.id, 'created', '1')) {
      await this.d.seen.claimMany([{ taskId: t.id, kind: 'status_changed', fingerprint: status }, ...(t.assignees ?? []).map((u) => ({ taskId: t.id, kind: 'assigned' as const, fingerprint: String(u.id) }))], new Date(this.d.clock()));
      return post({ kind: 'created', taskId: t.id, fp: '1', body: `ClickUp: new task **${name}** (status ${one(status, 40)}${asg.length ? `, assigned to ${asg.join(', ')}` : ''})${link(t.id)}` });
    }
    if (await this.d.seen.claim(t.id, 'status_changed', status) && !(await post({ kind: 'status_changed', taskId: t.id, fp: status, body: `ClickUp: **${name}** moved to status ${one(status, 40)}${link(t.id)}` }))) return false;
    for (const u of t.assignees ?? []) {
      const fp = String(u.id);
      if (await this.d.seen.claim(t.id, 'assigned', fp) && !(await post({ kind: 'assigned', taskId: t.id, fp, body: `ClickUp: **${name}** assigned to ${one(u.username ?? fp, 40)}${link(t.id)}` }))) return false;
    }
    return true;
  }

  /** Reads comments of at most MAX_COMMENT_TASKS recently updated tasks per tick; the rest are picked up next tick. */
  private async comments(tasks: CuTask[], baseMs: number, t0: number, post: (n: Notice) => Promise<boolean>, bases: ReadonlyMap<string, number> = new Map()): Promise<void> {
    this.since ??= (await this.d.seen.lastTick()) ?? baseMs - SLACK_MS; // persisted: a restart resumes from the last completed window
    const since = this.since;
    const me = (await this.d.client.currentUserId?.().catch(() => null)) ?? null;
    const cutoffOf = (t: CuTask): number => Math.max(bases.get(t.list?.id ?? '') ?? baseMs, t0 - COMMENT_MAX_AGE_MS);
    const upd = (t: CuTask): number => Number(t.date_updated ?? 0) || 0;
    const due = tasks.filter((t) => upd(t) >= since).sort((a, b) => upd(a) - upd(b));
    const batch = due.slice(0, MAX_COMMENT_TASKS);
    let next: number = t0 - SLACK_MS;
    if (due.length > batch.length) {
      next = upd(due[batch.length]!) - 1;
      this.d.log.warn({ inspected: batch.length, deferred: due.length - batch.length }, 'clickup comment check capped');
      await this.d.audit?.({ actor: 'system:clickup', action: 'clickup.poll.capped', tool: 'clickup_poll', outcome: `inspected ${batch.length} of ${due.length} updated tasks` });
    }
    for (const t of batch) {
      let found;
      try {
        found = this.d.client.listCommentsFor ? await this.d.client.listCommentsFor(t) : await this.d.client.listComments(t.id);
      } catch {
        // retry this window next tick, but a task that keeps failing is skipped after MAX_COMMENT_FAILS so it cannot pin the window
        const n = (this.commentFails.get(t.id) ?? 0) + 1;
        if (n >= MAX_COMMENT_FAILS) {
          this.commentFails.delete(t.id);
          this.d.log.warn({ task: t.id }, 'clickup comments skipped after repeated failures');
        } else {
          this.commentFails.set(t.id, n);
          next = Math.min(next, since);
        }
        continue;
      }
      this.commentFails.delete(t.id);
      for (const c of found) {
        const at = Number(c.date ?? 0);
        if (!c.id || !Number.isFinite(at) || at < cutoffOf(t) || (me !== null && c.user?.id === me)) continue; // own comments (Praw's clickup_add_comment) are not echoed
        const body = `ClickUp: new comment on **${one(t.name, 120)}**${c.user?.username ? ` by ${one(c.user.username, 40)}` : ''}\n> ${one(c.comment_text ?? '', 300)}${link(t.id)}`;
        if (await this.d.seen.claim(t.id, 'comment', c.id) && !(await post({ kind: 'comment', taskId: t.id, fp: c.id, body }))) return; // budget spent: since stays
      }
    }
    this.since = next;
    await this.d.seen.saveTick(next).catch(() => undefined);
  }

  private async fail(err: unknown): Promise<void> {
    this.fails++;
    const base = Math.max(MIN_INTERVAL_SEC, this.d.intervalSec()) * 1000;
    this.backoffUntil = this.d.clock() + Math.min(base * 2 ** this.fails, MAX_BACKOFF_MS);
    // ClickUpError text is fixed (status code only); anything else is reduced to its class name.
    const reason = err instanceof Error && err.name === 'ClickUpError' ? err.message : 'ClickUp poll failed';
    await this.alertOnce('clickup.poll.fail', reason);
  }
}

function statusFp(t: CuTask): string {
  return (t.status?.status ?? 'unknown').toLowerCase();
}

import { isDenied } from '../../../company/denylist.js';
import type { ActorRef } from '../../../company/types.js';
import { goalTask } from '../../../agents/scheduler/notices.js';
import { nextRun, type JobRepo, type ScheduledJob } from '../../../db/repos/jobs.js';
import type { NewTask, Task } from '../../../db/repos/tasks.js';
import type { DiscordPort } from '../../../discord/port.js';
import type { AuditFn } from '../../../governance/audit.js';

const PRAW: ActorRef = { kind: 'head', dept: 'praw' };
const BATCH = 25;
/** Occurrences stepped over when a skipped one is seen late (bounds the walk for a short interval job after a long outage). */
const MAX_STEPS = 10_000;

export interface JobRunnerDeps {
  repo: Pick<JobRepo, 'claimDue' | 'get' | 'reschedule'>;
  port: Pick<DiscordPort, 'canMemberView'>;
  /** Scheduler.submitTask: creates the root task and starts its run; null when nothing can start now (halted, paused, task cap). */
  submit: (t: NewTask) => Promise<Task | null>;
  /** How many jobs may start now (Scheduler.jobCapacity: free Praw slots, 0 at the open-task cap). Default: unbounded up to the batch. */
  capacity?: () => Promise<number>;
  /** False while halted, paused (D9) or stopping: nothing is claimed, so every due job stays due. */
  canRun: () => boolean;
  /** Epoch ms; injectable so tests drive a fake clock. */
  clock: () => number;
  intervalMs?: number;
  log: { warn(o: unknown, m?: string): void; error(o: unknown, m?: string): void };
  audit?: AuditFn;
  /** Whether Praw is enabled; a disabled Praw fires nothing. */
  enabled?: () => boolean;
  /** Whether the instant falls on an off day (company/calendar.ts); default never. */
  offDay?: (at: number) => boolean;
}

/**
 * Polls for due scheduled jobs. The claim is atomic in the repo (R11/PF12: next_run_at advances in the same statement), so
 * overlapping ticks or runners start each fire once. Every fire becomes a root task owned by Praw with requester Praw
 * (never the creator, PF5) and origin schedule|import (R3), so its tools need approval and its prompt is untrusted data (D7).
 * Before each fire: the channel must not be denied (D8), Praw must be enabled, the job must still exist and be active, and the
 * creator must still be a member who can see the channel; otherwise one audit row records the skip. If the task cannot be
 * started (halt arrived between the check and the claim, or the open-task cap), the claim is undone and the job stays due.
 */
export class JobRunner {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  /** Jobs whose start already failed once (retried once) and jobs already warned about. */
  private readonly retried = new Set<number>();
  private readonly warned = new Set<number>();

  constructor(private readonly d: JobRunnerDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.d.intervalMs ?? 15_000);
    this.timer.unref();
    void this.tick(); // boot catch-up: jobs that came due while the bot was down fire now (once each)
  }

  /** Clears the timer and resolves once an in-flight pass has finished (shutdown awaits it before closing the pool). */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
  }

  /** One pass; a tick that overlaps a running one waits for it instead of starting a second. */
  tick(): Promise<void> {
    if (this.running) return this.running;
    const run = this.pass().finally(() => { if (this.running === run) this.running = null; });
    this.running = run;
    return run;
  }

  private async pass(): Promise<void> {
    // Bookkeeping for removed or finished jobs is bounded: past the cap it is simply forgotten (worst case: one extra warning/retry).
    if (this.warned.size > 200) this.warned.clear();
    if (this.retried.size > 200) this.retried.clear();
    if (!this.d.canRun()) return; // D9: halted or paused: claim nothing
    try {
      // Only as many as can start: the rest stay due for a later tick (a burst must not fill the global run pool).
      const n = Math.min(BATCH, (await this.d.capacity?.()) ?? BATCH);
      if (n <= 0) return;
      for (const j of await this.d.repo.claimDue(new Date(this.d.clock()), n)) await this.fire(j);
    } catch (err) {
      this.d.log.error({ err: err instanceof Error ? err.message : 'error' }, 'schedule tick failed');
    }
  }

  private async skip(j: ScheduledJob, reason: string): Promise<void> {
    await this.d.audit?.({ actor: 'system:schedule', action: 'schedule.skip', tool: String(j.id), outcome: reason });
  }

  /**
   * An occurrence on an off day is skipped, not caught up (one audit row). The claim already moved the job past now; when the
   * skip is seen late (the bot was down), the job is put back on the first later occurrence that is on a workday and already
   * due, so that one still fires on the next tick like any missed occurrence. A one-off is simply gone.
   */
  private async skipOffDay(j: ScheduledJob): Promise<void> {
    await this.skip(j, 'off day');
    if (j.kind === 'once') return;
    const now = this.d.clock();
    let at: Date | null = j.nextRunAt;
    for (let n = 0; at && n < MAX_STEPS; n++) {
      at = nextRun(j, at);
      if (!at || at.getTime() > now) return; // nothing missed: the claim's own advance stands
      if (!this.d.offDay!(at.getTime())) return void (await this.d.repo.reschedule(j.id, at));
    }
  }

  private async fire(j: ScheduledJob): Promise<void> {
    try {
      const cur = await this.d.repo.get(j.id);
      if (!cur || (j.kind !== 'once' && !cur.active)) return void (await this.skip(j, 'removed'));
      if (this.d.offDay?.(j.nextRunAt.getTime())) return void (await this.skipOffDay(j));
      if (isDenied(j.channelId, null)) return void (await this.skip(j, 'channel is denied'));
      if (this.d.enabled && !this.d.enabled()) return void (await this.skip(j, 'praw disabled'));
      if (!(await this.d.port.canMemberView(j.userId, j.channelId))) return void (await this.skip(j, 'creator is not a member who can see the channel'));
      const goal = goalTask(j.prompt);
      const task = await this.d.submit({
        title: `Scheduled: ${goal.title}`.slice(0, 200), description: goal.description, deptId: 'praw', owner: PRAW, requester: PRAW, origin: j.origin,
        channelId: j.channelId, sourceUserId: j.userId, status: 'todo', depth: 0,
      });
      if (!task) {
        // Nothing could start (halt, pause or the task cap): put the job back as it was so the next tick retries it.
        await this.d.repo.reschedule(j.id, j.nextRunAt);
        if (!this.warned.has(j.id)) this.d.log.warn({ job: j.id }, 'scheduled job could not start; kept due');
        this.warned.add(j.id);
        return;
      }
      this.warned.delete(j.id);
      this.retried.delete(j.id);
    } catch (err) {
      this.d.log.warn({ job: j.id, err: err instanceof Error ? err.message : 'error' }, 'scheduled job failed to start');
      // A one-off was deactivated by the claim: put it back once so the fire is not lost; a second failure is final.
      const retry = j.kind === 'once' && !this.retried.has(j.id);
      if (retry) {
        this.retried.add(j.id);
        await this.d.repo.reschedule(j.id, j.nextRunAt).catch(() => undefined);
      } else this.retried.delete(j.id);
      await this.d.audit?.({ actor: 'system:schedule', action: 'schedule.fail', tool: String(j.id), outcome: retry ? 'start failed; will retry once' : 'start failed' });
    }
  }
}

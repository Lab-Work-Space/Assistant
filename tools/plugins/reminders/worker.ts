import type { OutboundPayload } from '../../../agents/loop/payload.js';
import { isDenied } from '../../../company/denylist.js';
import type { ActorRef } from '../../../company/types.js';
import type { ClaimedReminder, Reminder, ReminderRepo } from '../../../db/repos/reminders.js';
import type { DiscordPort, DmResult } from '../../../discord/port.js';
import type { AuditFn } from '../../../governance/audit.js';

const PRAW: ActorRef = { kind: 'head', dept: 'praw' };
const BATCH = 25;
/** An unposted one-off claim older than this is retried once. */
export const STALE_MS = 5 * 60_000;

export interface ReminderWorkerDeps {
  repo: Pick<ReminderRepo, 'claimDue' | 'claimAdvanceDue' | 'reclaimStale' | 'markFired' | 'get'>;
  port: Pick<DiscordPort, 'post' | 'dm' | 'canMemberView'>;
  /** Epoch ms; injectable so tests drive a fake clock. */
  clock: () => number;
  intervalMs?: number;
  log: { warn(o: unknown, m?: string): void; error(o: unknown, m?: string): void };
  audit?: AuditFn;
  /** Whether Praw is enabled; a disabled Praw fires nothing (the claim stays for the retry). */
  enabled?: () => boolean;
  /** D9 (controller ruling I5): false while halted or paused; the worker then claims nothing, and due reminders fire after /resume. */
  canRun?: () => boolean;
  /** Base delay (ms) between markFired attempts after a successful post; default 50. */
  markRetryMs?: number;
}

/**
 * Polls for due reminders. Claiming is atomic in the repo (R11), so overlapping ticks or workers deliver each reminder once.
 * Before every delivery: the channel is re-checked against the denylist (D8), the creator must still be able to see it
 * (a guild member), and the reminder must not be cancelled; otherwise one audit row records the skip (a one-off is then marked
 * fired, so it is not retried). Posts ping only the creator (R12).
 *
 * R11 amendment: delivery is at-least-once for a one-off. A claim whose post never happened (crash, Discord error) is retried
 * once after 5 minutes. If the post succeeds and markFired then throws, markFired is retried in-process (3 attempts) and the
 * row is remembered in `posted`, so reclaimStale never re-sends it from this process. Only a process crash between the post
 * and markFired can deliver a one-off twice (at most twice).
 */
export class ReminderWorker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  /** One-offs whose post succeeded but whose markFired kept failing; never re-sent by this process. */
  private readonly posted = new Set<number>();

  constructor(private readonly d: ReminderWorkerDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.d.intervalMs ?? 15_000);
    this.timer.unref();
    void this.tick(); // boot catch-up: missed reminders fire now
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
    if (this.d.canRun && !this.d.canRun()) return; // D9: halted or paused: claim nothing
    const at = new Date(this.d.clock());
    try {
      for (const r of await this.d.repo.reclaimStale(at, STALE_MS, BATCH)) {
        if (this.posted.has(r.id)) await this.markDone(r.id); // already delivered here; only the bookkeeping is missing
        else await this.fire(r, false);
      }
      for (const r of await this.d.repo.claimDue(at, BATCH)) await this.fire(r, false);
      for (const r of await this.d.repo.claimAdvanceDue(at, BATCH)) await this.fire(r, true);
    } catch (err) {
      this.d.log.error({ err: err instanceof Error ? err.message : 'error' }, 'reminder tick failed');
    }
  }

  /** markFired with a short backoff; true once it stuck. */
  private async markDone(id: number): Promise<boolean> {
    const base = this.d.markRetryMs ?? 50;
    for (let n = 1; n <= 3; n++) {
      try {
        await this.d.repo.markFired(id);
        this.posted.delete(id);
        return true;
      } catch (err) {
        this.d.log.warn({ reminder: id, attempt: n, err: err instanceof Error ? err.message : 'error' }, 'markFired failed after a successful post');
        if (n < 3) await new Promise((r) => setTimeout(r, base * n));
      }
    }
    this.posted.add(id);
    return false;
  }

  private async skip(r: Reminder, reason: string, advance: boolean): Promise<void> {
    if (!advance && r.everyMinutes === null) await this.d.repo.markFired(r.id).catch(() => undefined); // never retried
    await this.d.audit?.({ actor: 'system:reminders', action: 'reminder.skip', tool: String(r.id), outcome: reason });
  }

  private async fire(r: ClaimedReminder | Reminder, advance: boolean): Promise<void> {
    try {
      const cur = await this.d.repo.get(r.id);
      if (!cur || cur.cancelled) return void (await this.skip(r, 'cancelled', advance));
      if (isDenied(r.channelId, null)) return void (await this.skip(r, 'channel is denied', advance));
      if (this.d.enabled && !this.d.enabled()) return void (await this.skip(r, 'praw disabled', advance));
      if (!(await this.d.port.canMemberView(r.userId, r.channelId))) return void (await this.skip(r, 'creator is not a member who can see the channel', advance));
      const left = Math.max(1, Math.round((r.remindAt.getTime() - this.d.clock()) / 60_000));
      const body = advance ? `Coming up in ${left} minutes: ${r.text}` : `Reminder: ${r.text}`;
      let dm: DmResult = 'failed';
      if (r.notifyVia === 'dm') dm = await this.d.port.dm(PRAW, r.userId, { type: 'chat', body }).catch((): DmResult => 'failed');
      if (dm === 'failed') {
        const note = r.notifyVia === 'dm' ? '\n(DM closed, sent here instead)' : '';
        await this.d.port.post(PRAW, { channelId: r.channelId }, { type: 'chat', body: body + note }, { mentionUserIds: [r.userId] });
      }
      if (!advance && r.everyMinutes === null) await this.markDone(r.id); // never throws
    } catch (err) {
      // The post did not happen. A one-off stays claimed and unfired: reclaimStale retries it once. Recurring rows already moved on.
      this.d.log.warn({ reminder: r.id, err: err instanceof Error ? err.message : 'error' }, 'reminder delivery failed');
      await this.d.audit?.({ actor: 'system:reminders', action: 'reminder.fail', tool: String(r.id), outcome: 'delivery failed' });
    }
  }
}

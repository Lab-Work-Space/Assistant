import type { ConfigStore } from '../config/store.js';
import type { DeptIncidentRepo, SweepStep } from '../db/repos/dept-incidents.js';

/** R7: `forge` (S9, failed plugin builds by closed code) runs before the retention statements. */
export const SWEEP_STEPS: readonly SweepStep[] = ['tasks', 'heal', 'tools', 'forge', 'retention', 'cap'];

export interface IncidentSweepDeps {
  cfg: Pick<ConfigStore, 'get'>;
  repo: Pick<DeptIncidentRepo, 'step'>;
  /** Not halted (Scheduler.canRun). The sweep runs on off days: it only counts what already happened. */
  canRun: () => boolean;
  log: { error(o: unknown, m?: string): void };
}

/**
 * LEARN-1 (D2): the code timer that turns blocked and cancelled tasks, heal decisions and tool-error clusters into `dept_incidents` rows (S1 to S5, each its own statement,
 * idempotent by `ON CONFLICT (dept_id, ikey)`). No model call. Never throws; a failed statement logs `errName` only and the next one still runs; the next tick retries.
 */
export class IncidentSweep {
  private busy = false;

  constructor(private readonly d: IncidentSweepDeps) {}

  /** Returns the steps that ran without error; [] when gated off or already busy. A read error of the switch counts as off. */
  async tick(): Promise<SweepStep[]> {
    if (this.busy) return [];
    this.busy = true;
    const ok: SweepStep[] = [];
    try {
      let tz: string;
      try {
        if (this.d.cfg.get('grow.incidents.enabled') !== true || !this.d.canRun()) return [];
        tz = this.d.cfg.get('schedule.timezone');
      } catch {
        return [];
      }
      for (const step of SWEEP_STEPS) {
        try {
          await this.d.repo.step(step, tz);
          ok.push(step);
        } catch (err) {
          this.d.log.error({ errName: err instanceof Error ? err.name : 'error' }, 'incident sweep step failed');
        }
      }
      return ok;
    } catch (err) {
      this.d.log.error({ errName: err instanceof Error ? err.name : 'error' }, 'incident sweep failed');
      return ok;
    } finally {
      this.busy = false;
    }
  }
}

import { describe, expect, it, vi } from 'vitest';
import { IncidentSweep, SWEEP_STEPS } from './incident-sweep.js';

const mk = (over: { enabled?: unknown; canRun?: boolean; fail?: string; throwCfg?: boolean } = {}) => {
  const steps: string[] = [];
  const log = { error: vi.fn() };
  const sweep = new IncidentSweep({
    cfg: { get: ((k: string) => { if (over.throwCfg) throw new Error('read'); return k === 'grow.incidents.enabled' ? (over.enabled ?? true) : 'Asia/Bangkok'; }) as never },
    repo: { step: async (s) => { steps.push(s); if (s === over.fail) throw Object.assign(new Error('secret text sk-123'), { name: 'PgError' }); } },
    canRun: () => over.canRun ?? true, log,
  });
  return { sweep, steps, log };
};

describe('LEARN-1 IncidentSweep', () => {
  it('runs S1..S5 and the R7 forge statement S9 in order (forge before retention), each as its own statement', async () => {
    const { sweep, steps } = mk();
    expect(await sweep.tick()).toEqual([...SWEEP_STEPS]);
    expect(steps).toEqual(['tasks', 'heal', 'tools', 'forge', 'retention', 'cap']);
  });
  it('gated by the switch (anything but true, or a read error, is off) and by canRun', async () => {
    for (const o of [{ enabled: false }, { enabled: 'true' }, { canRun: false }, { throwCfg: true }]) {
      const { sweep, steps } = mk(o);
      expect(await sweep.tick()).toEqual([]);
      expect(steps).toEqual([]);
    }
  });
  it('a failing statement logs errName only and the next one still runs', async () => {
    const { sweep, steps, log } = mk({ fail: 'heal' });
    expect(await sweep.tick()).toEqual(['tasks', 'tools', 'forge', 'retention', 'cap']);
    expect(steps).toHaveLength(6);
    expect(JSON.stringify(log.error.mock.calls)).toContain('PgError');
    expect(JSON.stringify(log.error.mock.calls)).not.toContain('sk-123');
  });
  it('overlapping ticks are blocked by the busy flag', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const sweep = new IncidentSweep({ cfg: { get: ((k: string) => (k === 'grow.incidents.enabled' ? true : 'UTC')) as never }, repo: { step: () => gate }, canRun: () => true, log: { error: vi.fn() } });
    const first = sweep.tick();
    expect(await sweep.tick()).toEqual([]);
    release();
    expect((await first).length).toBe(6);
  });
});

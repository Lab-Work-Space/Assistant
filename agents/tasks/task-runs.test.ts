import { describe, expect, it } from 'vitest';
import { TaskRuns } from './task-runs.js';

describe('TaskRuns (TA-C9, TA-C10)', () => {
  it('abort marks every id cancelled, tracked or not, and aborts the controllers of those that run', () => {
    const r = new TaskRuns();
    const a = new AbortController();
    const b = new AbortController();
    const other = new AbortController();
    r.track('t1', a);
    r.track('t1', b); // owner and mention runs can overlap on one task
    r.track('t3', other);
    expect(r.active('t1')).toBe(true);
    expect(r.abort(['t1', 't2'])).toBe(2);
    expect(a.signal.aborted && b.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
    expect(r.cancelled('t1')).toBe(true);
    expect(r.cancelled('t2')).toBe(true); // between model calls nothing is tracked: the mark still stops the run
    expect(r.cancelled('t3')).toBe(false);
  });

  it('untrack removes only its own controller and the task is inactive once all are gone', () => {
    const r = new TaskRuns();
    const a = new AbortController();
    const b = new AbortController();
    const ua = r.track('t', a);
    const ub = r.track('t', b);
    ua();
    expect(r.active('t')).toBe(true);
    ub();
    expect(r.active('t')).toBe(false);
    ub(); // idempotent
    expect(r.abort(['t'])).toBe(0);
  });

  it('the cancelled set is bounded', () => {
    const r = new TaskRuns(5);
    for (let i = 0; i < 20; i++) r.abort([`t${i}`]);
    expect(r.cancelled('t19')).toBe(true);
    expect(r.cancelled('t0')).toBe(false);
  });
});

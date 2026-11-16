import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { releaseRoot, startReleaseWatch } from './release-watch.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
let dir = '';
afterEach(() => { vi.useRealTimers(); if (dir) rmSync(dir, { recursive: true, force: true }); });

function layout() {
  dir = mkdtempSync(join(tmpdir(), 'rw-'));
  for (const h of [A, B]) { mkdirSync(join(dir, 'releases', h), { recursive: true }); writeFileSync(join(dir, 'releases', h, 'release.json'), '{}'); }
  return join(dir, 'releases', A);
}

describe('release watch', () => {
  it('is inactive outside a release directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'rw-'));
    expect(releaseRoot(dir)).toBeNull();
    expect(startReleaseWatch({ onChange: () => undefined, cwd: dir })).toBeNull();
  });
  it('asks for a stop when current moves to another release, not before, and ignores unreadable links', () => {
    vi.useFakeTimers();
    const cwd = layout();
    expect(releaseRoot(cwd)).toBe(dir);
    let target = join(dir, 'releases', A);
    let broken = false;
    const onChange = vi.fn();
    startReleaseWatch({ onChange, cwd, everyMs: 1000, read: () => { if (broken) throw new Error('x'); return target; } });
    vi.advanceTimersByTime(3000);
    expect(onChange).not.toHaveBeenCalled();
    broken = true;
    vi.advanceTimersByTime(2000);
    expect(onChange).not.toHaveBeenCalled();
    broken = false;
    target = join(dir, 'releases', B);
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
  it('works with a real link', () => {
    const cwd = layout();
    symlinkSync(join(dir, 'releases', A), join(dir, 'current'));
    const onChange = vi.fn();
    const w = startReleaseWatch({ onChange, cwd, everyMs: 20 })!;
    w.stop();
    expect(onChange).not.toHaveBeenCalled();
  });
});

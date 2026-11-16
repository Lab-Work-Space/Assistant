import { readFileSync, readlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Restart on release switch (Gate 1 self-code OD-2a, X18). The application runs from `<root>/current`, a link only the executor switches. The
 * executor cannot signal a process of another user, so the application watches the link itself: when `current` no longer points at the release
 * it started from, it asks for a graceful stop and the service manager (KeepAlive) starts it again from the new target. The watcher reads two
 * paths and does nothing else; it is inactive outside a release directory.
 */
export function releaseRoot(cwd: string = process.cwd()): string | null {
  const parent = dirname(cwd);
  if (basename(parent) !== 'releases') return null;
  try {
    readFileSync(join(cwd, 'release.json'));
  } catch {
    return null;
  }
  return dirname(parent);
}

export function startReleaseWatch(o: { onChange: () => void; cwd?: string; everyMs?: number; read?: (p: string) => string }): { stop(): void } | null {
  const cwd = o.cwd ?? process.cwd();
  const root = releaseRoot(cwd);
  if (!root) return null;
  const read = o.read ?? ((p: string) => readlinkSync(p));
  const mine = basename(cwd);
  const t = setInterval(() => {
    let now: string;
    try { now = basename(read(join(root, 'current'))); } catch { return; } // an unreadable link is not a reason to stop
    if (now !== mine && /^[0-9a-f]{40}$/.test(now)) { clearInterval(t); o.onChange(); }
  }, o.everyMs ?? 5000);
  t.unref();
  return { stop: () => clearInterval(t) };
}

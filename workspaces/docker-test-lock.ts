import { mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Real-Docker ws int tests share ONE daemon, one label (ws=1) and global killAll/ps checks, so two files running in parallel see each other's
 * containers. This cross-process mutex (an atomic mkdir; a lock older than 15 min is stale) serialises them. Test helper only.
 */
const LOCK = join(tmpdir(), 'assistant-ws-docker-int.lock');
export async function acquireDockerTestLock(): Promise<void> {
  for (;;) {
    try {
      mkdirSync(LOCK);
      return;
    } catch {
      try {
        if (Date.now() - statSync(LOCK).mtimeMs > 15 * 60_000) rmSync(LOCK, { recursive: true, force: true });
      } catch { /* released meanwhile */ }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
export function releaseDockerTestLock(): void {
  rmSync(LOCK, { recursive: true, force: true });
}

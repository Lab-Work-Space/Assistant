import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The commit this build was made from (Gate 1 self-code X18). A release directory made by the executor holds `release.json`
 * ({head, tree, builtAt}); the application reads it once from its working directory and reports `head` on /healthz. A run from a plain
 * checkout has no such file and reports nothing.
 */
let cached: string | null | undefined;
export function buildSha(dir: string = process.cwd()): string | null {
  if (cached !== undefined && dir === process.cwd()) return cached;
  let v: string | null = null;
  try {
    const j = JSON.parse(readFileSync(join(dir, 'release.json'), 'utf8')) as { head?: unknown };
    v = typeof j.head === 'string' && /^[0-9a-f]{40}$/.test(j.head) ? j.head : null;
  } catch {
    v = null;
  }
  if (dir === process.cwd()) cached = v;
  return v;
}

// R4 (spec 5.2, Gate 1 PM-C11): the one explicit writer for the committed golden files. Test-only (tsconfig.build.json excludes tests/; it lives here, not under tools/, because it reads process.env).
// Nothing writes a golden unless GOLDEN_UPDATE=1; the writer is refused under CI, DEVJOB or a sandbox env, and a run that wrote always fails so the diff is reviewed by hand.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

type Env = Readonly<Record<string, string | undefined>>;

/** Keys sorted at every level, 2-space indent, trailing newline (the committed format). */
export function canonicalGolden(v: unknown): string {
  const sort = (x: unknown): unknown => (Array.isArray(x) ? x.map(sort) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, y]) => [k, sort(y)])) : x);
  return JSON.stringify(sort(v), null, 2) + '\n';
}

/** True when the update writer may run. Throws when GOLDEN_UPDATE is set in a place where writing is refused. */
export function updateRequested(env: Env = process.env): boolean {
  if (!env['GOLDEN_UPDATE']) return false;
  const blocked = ['CI', 'DEVJOB', 'DEVJOB_SANDBOX'].filter((k) => env[k]);
  if (blocked.length) throw new Error(`GOLDEN_UPDATE is refused when ${blocked.join(' or ')} is set`);
  return true;
}

/**
 * The committed text of a golden file. With GOLDEN_UPDATE=1 the observed text is written first and the call then throws, so the run fails ("golden updated; review the diff").
 * A missing file is an error (never created silently).
 */
export function readGolden(file: URL, observed: string, env: Env = process.env): string {
  if (updateRequested(env)) {
    writeFileSync(file, observed);
    throw new Error('golden updated; review the diff');
  }
  if (!existsSync(file)) throw new Error(`golden file missing: ${file.pathname} (generate it once with GOLDEN_UPDATE=1 and review it)`);
  return readFileSync(file, 'utf8');
}

import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Gate 1 P8: names that must never reach a child process, whoever asks. */
const FORBIDDEN = /^(BOT_TOKEN_|GEMINI_API_KEY$|ANTHROPIC_API_KEY$|CLICKUP_API_TOKEN$|JIRA_API_TOKEN$|GITHUB_APP_PRIVATE_KEY$|GOOGLE_SHEETS_WEBAPP_SECRET$|DATABASE_URL$|CONFIG_MASTER_KEY$|NODE_OPTIONS$)/;

export type ChildEnv = { env: Record<string, string>; cleanup(): void };

/**
 * Environment for a child process (git, document converters, anything a tool spawns): PATH, LANG and TMPDIR from this
 * process, HOME pointing at a private per-call directory (mode 0700, so no planted dotfile or leftover state from another
 * child), plus the documented per-tool keys in `extra`. Never `process.env` (P8). Call `cleanup()` once the child has exited.
 * The claude CLI keeps its own exact allowlist (providers/claude-code-local, L2).
 */
export function childEnv(extra: Record<string, string> = {}): ChildEnv {
  for (const k of Object.keys(extra))
    if (FORBIDDEN.test(k)) throw new Error(`childEnv: ${k.replace(/[^A-Z0-9_]/gi, '')} may not be passed to a child process`);
  const home = mkdtempSync(join(tmpdir(), 'lw-child-'));
  chmodSync(home, 0o700);
  const env: Record<string, string> = { HOME: home };
  for (const k of ['PATH', 'LANG', 'TMPDIR'] as const) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  Object.assign(env, extra);
  env.HOME = home; // extra can never move HOME
  return { env, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** Runs `fn` with a fresh child env and always removes the private HOME afterwards. */
export async function withChildEnv<T>(extra: Record<string, string>, fn: (env: Record<string, string>) => Promise<T>): Promise<T> {
  const c = childEnv(extra);
  try {
    return await fn(c.env);
  } finally {
    c.cleanup();
  }
}

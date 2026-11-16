import { randomBytes } from 'node:crypto';
import { closeSync, openSync, writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { applyExecutorRole, EXECUTOR_ROLE } from '../db/executor-role.js';
import { createPool } from '../db/pool.js';

/**
 * Owner-run (OD-1): creates or re-keys the PostgreSQL role the LW Admin executor connects as and applies its least-privilege grants.
 *   node --env-file="$HOME/.config/assistant/env.local" dist/scripts/executor-role.js --out FILE
 * DATABASE_URL (the owner's own role) comes from the env file and must be loopback. A fresh random password is written ONLY to FILE
 * (mode 0600, created exclusively) as the executor's DATABASE_URL line; the installer (sudo scripts/executor-service.sh install) moves it into
 * the executor's env file and deletes FILE. Nothing secret is printed.
 */
export function executorUrl(ownerUrl: string, role: string, password: string): string {
  const u = new URL(ownerUrl);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) throw new Error('DATABASE_URL must point at loopback');
  u.username = role;
  u.password = password;
  u.search = '';
  return u.toString();
}

async function main(): Promise<void> {
  const i = process.argv.indexOf('--out');
  const out = i > 0 ? process.argv[i + 1] : undefined;
  const url = process.env.DATABASE_URL;
  if (!out || !out.startsWith('/') || !url) throw new Error('usage: node --env-file=<env.local> dist/scripts/executor-role.js --out <absolute file>');
  const password = randomBytes(32).toString('hex');
  const next = executorUrl(url, EXECUTOR_ROLE, password);
  const pool = createPool(url, 1);
  try {
    // the schema comes from the owner's connection (search_path); the default is public
    await applyExecutorRole(pool, { password });
  } finally {
    await pool.end();
  }
  const fd = openSync(out, 'wx', 0o600);
  try { writeSync(fd, `DATABASE_URL=${next}\n`); } finally { closeSync(fd); }
  console.log(`role ${EXECUTOR_ROLE} is ready; its DATABASE_URL line is in ${out} (0600). Next: sudo bash scripts/executor-service.sh install`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`executor-role failed: ${err instanceof Error ? err.message.replace(/postgres(ql)?:\/\/\S+/g, '[url]') : 'error'}`);
    process.exit(1);
  });
}

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPool, type Pool } from './pool.js';

/** Applies pending (up) or reverts all applied (down, newest first) migrations; each file in one transaction. */
export async function migrate(pool: Pool, dir: string, direction: 'up' | 'down'): Promise<string[]> {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const suffix = `.${direction}.sql`;
  const files = (await readdir(dir)).filter((f) => f.endsWith(suffix)).sort();
  if (direction === 'down') files.reverse();
  const applied = new Set(
    (await pool.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  const done: string[] = [];
  for (const file of files) {
    const name = file.slice(0, -suffix.length);
    if (applied.has(name) !== (direction === 'up' ? false : true)) continue;
    const sql = await readFile(join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      if (direction === 'up') await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [name]);
      else await client.query('DELETE FROM schema_migrations WHERE name = $1', [name]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    done.push(name);
  }
  return done;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = createPool(url, 1);
  try {
    const names = await migrate(pool, join(dirname(fileURLToPath(import.meta.url)), 'migrations'), 'up');
    console.log(`applied: ${names.join(', ') || '(none)'}`);
  } finally {
    await pool.end();
  }
}

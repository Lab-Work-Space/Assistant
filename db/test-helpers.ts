import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { Pool } from './pool.js';

export const TEST_URL = process.env.TEST_DATABASE_URL!;

export interface TestDb {
  pool: Pool;
  /** Also the pool's application_name. */
  schema: string;
  close(): Promise<void>;
}

/** A private schema per test file (search_path pinned), so int files stay independent even when run in parallel. */
export async function freshDb(): Promise<TestDb> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: TEST_URL, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  // application_name = schema: lets a test tell its own backends from those of test files running in parallel.
  const pool = new pg.Pool({ connectionString: TEST_URL, max: 4, options: `-c search_path=${schema}`, application_name: schema });
  return {
    pool,
    schema,
    async close() {
      await pool.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}

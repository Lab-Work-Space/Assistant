import { pathToFileURL } from 'node:url';
import { decryptSecret, encryptSecret } from '../config/secrets.js';
import { createPool } from '../db/pool.js';
import type { ProviderKey } from '../db/repos/ledger.js';

/** Gate 1 D22: re-encrypts every provider_keys row from OLD_CONFIG_MASTER_KEY to NEW_CONFIG_MASTER_KEY (AAD = provider id). */

export function reencryptRow(row: ProviderKey, oldKey: Buffer, newKey: Buffer): ProviderKey {
  const plain = decryptSecret(row, oldKey, row.provider);
  return { provider: row.provider, ...encryptSecret(plain, newKey, row.provider) };
}

interface TxClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

/** All-or-nothing: every row is re-encrypted in memory before the first UPDATE, and the whole thing is one transaction. */
export async function rotateMasterKey(
  pool: { connect(): Promise<TxClient> },
  oldKey: Buffer,
  newKey: Buffer,
): Promise<{ rotated: number }> {
  if (oldKey.length !== 32 || newKey.length !== 32) throw new Error('both master keys must be 32 bytes');
  if (oldKey.equals(newKey)) throw new Error('new master key must differ from the old one');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const rows = (await client.query('SELECT provider, ciphertext, iv, tag FROM provider_keys ORDER BY provider FOR UPDATE')).rows as ProviderKey[];
    const next = rows.map((r) => {
      try {
        return reencryptRow(r, oldKey, newKey);
      } catch {
        throw new Error(`provider_keys row "${r.provider}" does not decrypt with the old master key`);
      }
    });
    for (const n of next) {
      await client.query('UPDATE provider_keys SET ciphertext = $1, iv = $2, tag = $3 WHERE provider = $4', [n.ciphertext, n.iv, n.tag, n.provider]);
    }
    await client.query('COMMIT');
    return { rotated: next.length };
  } catch (err) {
    // A failed ROLLBACK (e.g. the connection is gone) must not replace the error that caused it.
    try { await client.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    client.release();
  }
}

function keyFromEnv(name: string): Buffer {
  const v = process.env[name];
  if (!v || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) throw new Error(`${name} must be base64`);
  return Buffer.from(v, 'base64');
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = createPool(url, 1);
  try {
    const { rotated } = await rotateMasterKey(pool, keyFromEnv('OLD_CONFIG_MASTER_KEY'), keyFromEnv('NEW_CONFIG_MASTER_KEY'));
    console.log(`re-encrypted ${rotated} provider key(s)`);
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`rotate-master-key failed: ${err instanceof Error ? err.message : 'unknown error'}`); // never prints key material
    process.exit(1);
  });
}

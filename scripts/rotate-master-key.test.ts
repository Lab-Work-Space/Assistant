import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../config/secrets.js';
import type { ProviderKey } from '../db/repos/ledger.js';
import { reencryptRow, rotateMasterKey } from './rotate-master-key.js';

const oldKey = randomBytes(32);
const newKey = randomBytes(32);
const row = (provider: string, plain: string, key = oldKey): ProviderKey => ({ provider, ...encryptSecret(plain, key, provider) });

class FakeClient {
  queries: string[] = [];
  written = new Map<string, ProviderKey>();
  constructor(private readonly rows: ProviderKey[]) {}
  async query(sql: string, params?: unknown[]) {
    this.queries.push(sql.trim().split(/\s+/)[0]!);
    if (sql.startsWith('SELECT')) return { rows: this.rows };
    if (sql.startsWith('UPDATE')) {
      const [ciphertext, iv, tag, provider] = params as [Buffer, Buffer, Buffer, string];
      this.written.set(provider, { provider, ciphertext, iv, tag });
    }
    return { rows: [] };
  }
  release() { this.queries.push('RELEASE'); }
}
const poolOf = (c: FakeClient) => ({ connect: async () => c });

describe('rotate-master-key', () => {
  it('reencryptRow decrypts with the old key and the same provider id as AAD', () => {
    const out = reencryptRow(row('openai', 'sk-one'), oldKey, newKey);
    expect(decryptSecret(out, newKey, 'openai')).toBe('sk-one');
    expect(() => decryptSecret(out, oldKey, 'openai')).toThrow();
    expect(() => decryptSecret(out, newKey, 'other')).toThrow();
  });

  it('rotates every row in one transaction', async () => {
    const c = new FakeClient([row('openai', 'sk-one'), row('gemini', 'g-two')]);
    const r = await rotateMasterKey(poolOf(c), oldKey, newKey);
    expect(r.rotated).toBe(2);
    expect(decryptSecret(c.written.get('gemini')!, newKey, 'gemini')).toBe('g-two');
    expect(c.queries).toEqual(['BEGIN', 'SELECT', 'UPDATE', 'UPDATE', 'COMMIT', 'RELEASE']);
  });

  it('a row that does not decrypt with the old key rolls back and writes nothing', async () => {
    const c = new FakeClient([row('openai', 'sk-one'), row('bad', 'x', randomBytes(32))]);
    await expect(rotateMasterKey(poolOf(c), oldKey, newKey)).rejects.toThrow(/bad/);
    expect(c.written.size).toBe(0);
    expect(c.queries).toEqual(['BEGIN', 'SELECT', 'ROLLBACK', 'RELEASE']);
  });

  it('rejects identical keys and wrong-length keys', async () => {
    const c = new FakeClient([]);
    await expect(rotateMasterKey(poolOf(c), oldKey, oldKey)).rejects.toThrow(/differ/);
    await expect(rotateMasterKey(poolOf(c), randomBytes(16), newKey)).rejects.toThrow(/32/);
    expect(c.queries).toEqual([]);
  });

  it('a failing ROLLBACK does not hide the original error (final #10)', async () => {
    class DeadClient extends FakeClient {
      override async query(sql: string, params?: unknown[]) {
        if (sql.startsWith('UPDATE')) throw new Error('connection lost during update');
        if (sql.startsWith('ROLLBACK')) throw new Error('rollback failed');
        return super.query(sql, params);
      }
    }
    const c = new DeadClient([row('openai', 'sk-one')]);
    await expect(rotateMasterKey(poolOf(c), oldKey, newKey)).rejects.toThrow('connection lost during update');
    expect(c.queries.at(-1)).toBe('RELEASE');
  });
});

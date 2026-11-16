import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SHORT_SECRET_CHARS, secretsOf, shortSecretCount } from './app.js';
import type { Env } from './core/index.js';

const dir = mkdtempSync(join(tmpdir(), 'secrets-of-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const PEM = (generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string);
const bodyLines = PEM.split('\n').filter((l) => l && !l.startsWith('-----'));
const base = (over: Partial<Env> = {}): Env => ({
  databaseUrl: 'postgres://app:p%40ss%2Fw0rd@db:5432/x', configMasterKey: Buffer.alloc(32, 7), guildId: 'g', botAdminRoleId: 'r', healthPort: 1, healthHost: '127.0.0.1', logLevel: 'silent', botTokens: { hq: 'tok-hq' }, ...over,
}) as Env;

describe('short literal secrets', () => {
  it('are counted for the one startup warning but never dropped from the mask list', () => {
    const s = secretsOf(base({ botTokens: { hq: 'tok' } as Env['botTokens'] }));
    expect(s).toContain('tok');
    expect(SHORT_SECRET_CHARS).toBe(8);
    expect(shortSecretCount(s)).toBe(1);
    expect(shortSecretCount(secretsOf(base()))).toBe(1); // 'tok-hq' (6)
    expect(shortSecretCount(['12345678'])).toBe(0);
  });
});

describe('secretsOf (P24)', () => {
  it('has the master key (base64 and hex), the whole DATABASE_URL and its password raw and decoded', () => {
    const s = secretsOf(base());
    expect(s).toEqual(expect.arrayContaining([Buffer.alloc(32, 7).toString('base64'), Buffer.alloc(32, 7).toString('hex'), 'postgres://app:p%40ss%2Fw0rd@db:5432/x', 'p%40ss%2Fw0rd', 'p@ss/w0rd', 'tok-hq']));
    expect(s.every((x) => x.length > 0)).toBe(true);
  });

  it('a PEM loaded from GITHUB_APP_PRIVATE_KEY_PATH is masked: the file text, the one-line form and each body line', () => {
    const f = join(dir, 'app.pem');
    writeFileSync(f, PEM);
    chmodSync(f, 0o600);
    const s = secretsOf(base({ github: { appId: '1', installationId: '2', privateKeyPath: f } }));
    expect(s).toContain(PEM);
    for (const l of bodyLines) expect(s, l).toContain(l);
    expect(s).toContain(PEM.replace(/\s*\n\s*/g, ' ').trim());
  });

  it('an inline PEM gets the same body-line literals; an unreadable key path adds nothing and does not throw', () => {
    const s = secretsOf(base({ github: { appId: '1', installationId: '2', privateKey: PEM } }));
    for (const l of bodyLines) expect(s).toContain(l);
    expect(() => secretsOf(base({ github: { appId: '1', installationId: '2', privateKeyPath: join(dir, 'missing.pem') } }))).not.toThrow();
  });
});

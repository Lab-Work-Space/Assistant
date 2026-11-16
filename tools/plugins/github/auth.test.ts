import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createHttpClient } from '../../../services/http.js';
import { fakeFetch } from '../../../tests/fakes/http.js';
import { loadPrivateKey } from './auth.js';
import { githubFromEnv } from './client.js';
import { APP_ID, INSTALLATION_ID, PEM, T0, rig } from './test-helpers.js';

const R = { issues: 'read', metadata: 'read' } as const;

describe('auth', () => {
  it('JWT claims iss/iat/exp and RS256 verify with the fake public key', async () => {
    const { auth, mints } = rig();
    const tok = await auth.tokenFor({ repoId: 'widgets', permissions: R });
    expect(tok).toMatch(/^ghs_/); // the fake answers 201 only when the RS256 signature and the claims verify
    expect(mints).toHaveLength(1);
    expect(mints[0]!.claims).toEqual({ iss: APP_ID, iat: T0 / 1000 - 60, exp: T0 / 1000 + 9 * 60 });
  });

  it('a JWT signed by another key is rejected by the fake', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const { createGithubAuth } = await import('./auth.js');
    const r = rig();
    const bad = createGithubAuth({ appId: APP_ID, installationId: INSTALLATION_ID, privateKey: other, http: createHttpClient({ fetch: r.f }), clock: () => T0 });
    await expect(bad.tokenFor({ repoId: 'widgets', permissions: R })).rejects.toThrow(/HTTP 401/);
  });

  it('token request is scoped to one repo with minimum permissions', async () => {
    const { auth, mints } = rig();
    await auth.tokenFor({ repoId: 'widgets', permissions: R });
    await auth.tokenFor({ repoId: 777, permissions: { metadata: 'read' } });
    await auth.tokenFor({ permissions: { metadata: 'read' } });
    expect(mints.map((m) => m.body)).toEqual([
      { repositories: ['widgets'], permissions: R },
      { repository_ids: [777], permissions: { metadata: 'read' } },
      { permissions: { metadata: 'read' } }, // repo-less reads (PF18): metadata only, no way to restrict repositories
    ]);
  });

  it('refuses an empty permission set or a bad repo name before any request', async () => {
    const { auth, f } = rig();
    await expect(auth.tokenFor({ repoId: 'widgets', permissions: {} })).rejects.toThrow('GitHub: invalid token scope');
    await expect(auth.tokenFor({ repoId: 'a/../b', permissions: R })).rejects.toThrow('GitHub: invalid token scope');
    await expect(auth.tokenFor({ repoId: 0, permissions: R })).rejects.toThrow('GitHub: invalid token scope');
    expect(f.requests).toHaveLength(0);
  });

  it('identical scope reuses a token until 5 min before expiry', async () => {
    const { auth, mints, t } = rig();
    const a = await auth.tokenFor({ repoId: 'widgets', permissions: R });
    t.now = T0 + 54 * 60_000;
    expect(await auth.tokenFor({ repoId: 'widgets', permissions: { metadata: 'read', issues: 'read' } })).toBe(a); // key order does not matter
    expect(mints).toHaveLength(1);
    expect(await auth.tokenFor({ repoId: 'other', permissions: R })).not.toBe(a); // another scope never shares
    t.now = T0 + 56 * 60_000;
    expect(await auth.tokenFor({ repoId: 'widgets', permissions: R })).not.toBe(a);
    expect(mints).toHaveLength(3);
  });

  it('one installation, selected by code from the allowlisted repo, never from tool input', async () => {
    const { auth, client, f } = rig();
    await auth.tokenFor({ repoId: 'widgets', permissions: R, installation_id: '1', installationId: '1' } as never);
    await client.getRepositoryInfo('acme', 'widgets');
    const posts = f.requests.filter((q) => q.method === 'POST');
    expect(posts.length).toBeGreaterThan(0);
    for (const q of posts) expect(q.url).toBe(`https://api.github.com/app/installations/${INSTALLATION_ID}/access_tokens`);
  });

  it('a full cache drops expired entries first and keeps live ones', async () => {
    const { auth, mints, t } = rig();
    const live = await auth.tokenFor({ repoId: 'keep', permissions: R });
    t.now = T0 + 30 * 60_000;
    for (let i = 0; i < 49; i++) await auth.tokenFor({ repoId: `r${i}`, permissions: R }); // 50 entries now
    t.now = T0 + 56 * 60_000; // the first is expired, the 49 minted at +30 min are not
    await auth.tokenFor({ repoId: 'new', permissions: R });
    const n = mints.length;
    expect(await auth.tokenFor({ repoId: 'r3', permissions: R })).toMatch(/^ghs_/);
    expect(mints.length).toBe(n); // still cached: the whole cache was not cleared
    expect(live).toMatch(/^ghs_/);
  });

  describe('PEM file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghpem-'));
    const file = (name: string, mode: number, text = PEM) => { const p = join(dir, name); writeFileSync(p, text); chmodSync(p, mode); return p; };
    const uid = process.getuid!();

    it('mode 0600 owned by the app uid loads', () => {
      const r = loadPrivateKey({ path: file('ok.pem', 0o600), uid });
      expect(r).toEqual({ ok: true, key: PEM });
    });

    it('PEM file with mode 0644 or symlink → group disabled with reason, key content never in message', () => {
      const wide = file('wide.pem', 0o644);
      const link = join(dir, 'link.pem');
      symlinkSync(file('real.pem', 0o600), link);
      for (const path of [wide, link, file('g.pem', 0o640), file('x.pem', 0o601)]) {
        const r = loadPrivateKey({ path, uid });
        expect(r.ok, path).toBe(false);
        const msg = (r as { reason: string }).reason;
        expect(msg).toMatch(/GITHUB_APP_PRIVATE_KEY_PATH/);
        expect(msg).not.toContain('PRIVATE KEY');
        expect(msg).not.toContain(PEM.split('\n')[1]!);
        const g = githubFromEnv({ appId: APP_ID, installationId: INSTALLATION_ID, privateKeyPath: path }, { http: createHttpClient({ fetch: fakeFetch({}) }), clock: () => T0, uid });
        expect('disabled' in g && g.disabled).toBe(msg);
      }
    });

    it('PEM owned by another uid refused', () => {
      const r = loadPrivateKey({ path: file('uid.pem', 0o600), uid: uid + 1 });
      expect(r).toEqual({ ok: false, reason: expect.stringMatching(/owned by the user running the assistant/) });
    });

    it('unreadable, missing or non-PEM content is refused without echoing it', () => {
      expect(loadPrivateKey({ path: join(dir, 'missing.pem'), uid }).ok).toBe(false);
      const r = loadPrivateKey({ path: file('junk.pem', 0o600, 'super-secret-not-a-pem'), uid });
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain('super-secret');
      const e = loadPrivateKey({ pem: 'also-secret-junk' });
      expect(e.ok).toBe(false);
      expect(JSON.stringify(e)).not.toContain('also-secret');
      expect(loadPrivateKey({ pem: PEM.replace(/\n/g, '\\n') }).ok).toBe(true); // one-line env form
    });
  });
});

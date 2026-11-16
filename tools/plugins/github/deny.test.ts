import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDenylist, parseRepoLine, readAppConfRepos, SNAPSHOT_PATH } from '../../../scripts/gen-deploy-denylist.js';
import { GithubError } from './auth.js';
import { createDeniedIdCache, isDeniedRepo, normalizeRepoSpec, repoWriteAllowed } from './deny.js';

const ALLOW = [{ id: 777, fullName: 'acme/widgets' }, { id: 1, fullName: 'Lab-Work-Space/Assistant' }, { id: 2, fullName: 'Lab-Work-Space/Labworkspace_backend' }];
const snapshot = () => readFileSync(SNAPSHOT_PATH, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

describe('deny', () => {
  it('deny › case variants, trailing slash/.git, renamed-redirect (fake returns full_name Assistant) refused', () => {
    for (const n of ['Lab-Work-Space/Assistant', 'lab-work-space/assistant', 'LAB-WORK-SPACE/ASSISTANT', 'Lab-Work-Space/Assistant/', 'Lab-Work-Space/Assistant.git', 'Lab-Work-Space/Assistant.GIT/', ' Lab-Work-Space/Assistant ', 'https://github.com/Lab-Work-Space/Assistant.git', 'git@github.com:Lab-Work-Space/Assistant.git',
      'Lab-Work-Space/Labworkspace_backend', 'lab-work-space/labworkspace_frontend', 'Lab-Work-Space/labworkspace-infra', 'Lab-Work-Space/Discord_bot', 'lab-work-space/discord_bot.git'])
      expect(isDeniedRepo({ fullName: n, id: 999 }), n).toBe(true);
    // a renamed repo: the API answers the old name with the canonical full_name, and that is what is checked
    expect(isDeniedRepo({ fullName: 'Assistant', id: 4242 })).toBe(true);
    expect(isDeniedRepo({ fullName: 'acme/Assistant', id: 4242 })).toBe(true); // bare names are denied under any owner
    expect(isDeniedRepo({ fullName: 'someone/discord_bot', id: 4243 })).toBe(true);
    expect(isDeniedRepo({ fullName: 'acme/widgets', id: 777 })).toBe(false);
    expect(normalizeRepoSpec('https://github.com/Acme/Widgets.git/')).toBe('acme/widgets');
  });

  it('deny › Lab-Work-Space/my-deploy-tools and acme/infra refused by regex', () => {
    for (const n of ['Lab-Work-Space/my-deploy-tools', 'acme/infra', 'acme/INFRA-live', 'acme/app-secrets', 'infra-team/web', 'acme/Deployer'])
      expect(isDeniedRepo({ fullName: n, id: 5 }), n).toBe(true);
    for (const n of ['acme/widgets', 'acme/inf-ra', 'acme/secret']) expect(isDeniedRepo({ fullName: n, id: 5 }), n).toBe(false);
  });

  it('deny › a malformed or empty full_name is denied (fail closed)', () => {
    for (const n of ['', '/', 'a/b/c', 'acme/', '../x']) expect(isDeniedRepo({ fullName: n, id: 5 }), JSON.stringify(n)).toBe(true);
  });

  it('deny › every REPO= line in infra/vps/files/lw-git/apps/*/app.conf is denied', () => {
    // PF19: the real infra dir when LW_INFRA_DIR is set, else the committed snapshot (refreshed by scripts/gen-deploy-denylist.ts)
    const dir = process.env['LW_INFRA_DIR'];
    const repos = dir ? readAppConfRepos(dir) : snapshot();
    expect(repos.length).toBeGreaterThanOrEqual(3);
    for (const r of repos) {
      expect(isDeniedRepo({ fullName: r, id: 1 }), r).toBe(true);
      expect(isDeniedRepo({ fullName: r.toUpperCase(), id: 1 }), r).toBe(true);
    }
    expect(snapshot()).toEqual(expect.arrayContaining(['Lab-Work-Space/Assistant', 'Lab-Work-Space/Labworkspace_backend', 'Lab-Work-Space/Labworkspace_frontend']));
    // the committed deploy-repos.json is exactly what the generator builds from the snapshot
    const json = JSON.parse(readFileSync(new URL('./deploy-repos.json', import.meta.url), 'utf8'));
    expect(json).toEqual(buildDenylist(snapshot(), json.ids));
  });

  it('deny › app.conf parsing: ssh, https, quotes, comments; a missing infra dir fails with a clear message', () => {
    expect(parseRepoLine('git@github.com:Lab-Work-Space/Assistant.git')).toBe('Lab-Work-Space/Assistant');
    expect(parseRepoLine('"https://github.com/Acme/Web-App.git"')).toBe('Acme/Web-App');
    expect(parseRepoLine("'ssh://git@github.com/acme/x'")).toBe('acme/x');
    expect(() => parseRepoLine('not a repo')).toThrow(/REPO=/);
    const root = mkdtempSync(join(tmpdir(), 'lwinfra-'));
    const apps = join(root, 'vps', 'files', 'lw-git', 'apps');
    mkdirSync(join(apps, 'one'), { recursive: true });
    mkdirSync(join(apps, 'two'), { recursive: true });
    mkdirSync(join(apps, 'empty'), { recursive: true });
    writeFileSync(join(apps, 'one', 'app.conf'), '# app\nNAME=one\nREPO=git@github.com:Acme/One.git # deploy source\nBRANCH=main\n');
    writeFileSync(join(apps, 'two', 'app.conf'), 'REPO="https://github.com/acme/two"\n#REPO=git@github.com:acme/commented.git\n');
    expect(readAppConfRepos(root)).toEqual(['Acme/One', 'acme/two']);
    expect(() => readAppConfRepos(join(root, 'nope'))).toThrow(/LW_INFRA_DIR.*vps\/files\/lw-git\/apps/);
  });

  it('repoWriteAllowed: not denied AND on the allowlist by id (the stored name does not matter)', () => {
    expect(repoWriteAllowed({ fullName: 'acme/widgets', id: 777 }, ALLOW)).toEqual({ ok: true });
    expect(repoWriteAllowed({ fullName: 'acme/renamed-widgets', id: 777 }, ALLOW)).toEqual({ ok: true });
    expect(repoWriteAllowed({ fullName: 'acme/widgets', id: 778 }, ALLOW)).toMatchObject({ ok: false, why: expect.stringMatching(/not on github\.repoAllowlist/) });
    expect(repoWriteAllowed({ fullName: 'Lab-Work-Space/Assistant', id: 1 }, ALLOW)).toMatchObject({ ok: false, why: expect.stringMatching(/never allowed/) });
    expect(repoWriteAllowed({ fullName: 'Lab-Work-Space/Labworkspace_backend', id: 2 }, ALLOW)).toMatchObject({ ok: false, why: expect.stringMatching(/never allowed/) });
  });

  it('deny › denied names resolve to ids once (cached 6 h); 404/422 skipped; other failures throw; ids deny any name', async () => {
    const t = { now: 0 };
    const calls: string[] = [];
    const ids: Record<string, number | number[]> = { 'Lab-Work-Space/Assistant': 11, 'Lab-Work-Space/Labworkspace_backend': 21, 'Lab-Work-Space/Discord_bot': 404, 'Lab-Work-Space/Labworkspace_frontend': 422 };
    let fail = false;
    const cache = createDeniedIdCache({
      account: async () => 'Lab-Work-Space', clock: () => t.now,
      resolve: async (o, r) => {
        calls.push(`${o}/${r}`);
        if (fail) throw new GithubError('boom', 500);
        const v = Object.entries(ids).find(([k]) => k.toLowerCase() === `${o}/${r}`.toLowerCase())?.[1];
        if (v === undefined || v === 404 || v === 422) throw new GithubError('not there', (v as number | undefined) ?? 404);
        return { id: v as number };
      },
    });
    const got = await cache.ids();
    expect([...got].sort()).toEqual([11, 21]);
    const n = calls.length;
    expect(n).toBeGreaterThanOrEqual(5);
    await cache.ids();
    expect(calls.length).toBe(n); // cached
    expect(isDeniedRepo({ fullName: 'Lab-Work-Space/harmless', id: 21 }, got)).toBe(true);
    expect(repoWriteAllowed({ fullName: 'Lab-Work-Space/harmless', id: 21 }, [{ id: 21, fullName: 'x/y' }], got)).toMatchObject({ ok: false, why: expect.stringMatching(/never allowed/) });
    t.now = 7 * 3_600_000;
    fail = true;
    await expect(cache.ids()).rejects.toThrow(/could not be resolved to repository ids/);
  });
});


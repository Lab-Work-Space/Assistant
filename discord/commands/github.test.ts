import { describe, expect, it } from 'vitest';
import { LWS, lwsRepo, rig } from '../../tools/plugins/github/test-helpers.js';
import { COMMANDS, handleInteraction } from './index.js';
import { cmd, makeDeps, text } from './test-helpers.js';

const allowCmd = (action: string, repo: string, extra = {}) => cmd('github', 'allow', { strings: { action, repo }, ...extra });

async function setup() {
  const gh = rig({ account: LWS, repos: [lwsRepo('tools', 31, { aliases: ['old-tools'] }), lwsRepo('Assistant', 11, { aliases: ['helper-bot'] }), lwsRepo('Labworkspace_backend', 21)] });
  const t = await makeDeps({ github: gh.client });
  return { ...t, gh };
}

describe('/github allow', () => {
  it('/github allow › admin only, resolves the repo id through the API, cannot add a denied repo', async () => {
    const t = await setup();
    // not an admin / wrong channel: refused, nothing stored, no API call
    expect(text(await handleInteraction(allowCmd('add', 'Lab-Work-Space/tools', { roles: [] }), t.deps))).toContain('Only Bot Admins');
    expect(text(await handleInteraction(allowCmd('add', 'Lab-Work-Space/tools', { channelId: '5' }), t.deps))).toContain('#⚙️-setting');
    expect(t.gh.f.requests).toEqual([]);
    expect(t.sets).toHaveLength(0);
    // add through an old name: the stored entry is the canonical name and the API's id
    const ok = await handleInteraction(allowCmd('add', 'Lab-Work-Space/old-tools.git/'), t.deps);
    expect(text(ok)).toContain('Lab-Work-Space/tools');
    expect(t.deps.cfg.get('github.repoAllowlist')).toEqual([{ id: 31, fullName: 'Lab-Work-Space/tools' }]);
    expect(t.sets.at(-1)).toMatchObject({ key: 'github.repoAllowlist', by: 'user:u1' });
    expect(t.audits.at(-1)).toMatchObject({ action: 'github.allow.add', tool: 'Lab-Work-Space/tools#31', outcome: 'ok' });
    expect(t.gh.f.requests.some((q) => q.url.endsWith('/repos/Lab-Work-Space/old-tools'))).toBe(true);
    // adding again is a no-op (deduped by id)
    await handleInteraction(allowCmd('add', 'Lab-Work-Space/tools'), t.deps);
    expect(t.deps.cfg.get('github.repoAllowlist')).toHaveLength(1);
    // denied: by name, by regex, and through a rename that lands on a deploy source
    for (const r of ['Lab-Work-Space/Assistant', 'Lab-Work-Space/Labworkspace_backend', 'Lab-Work-Space/helper-bot', 'Lab-Work-Space/my-deploy-tools', 'Lab-Work-Space/labworkspace-infra']) {
      const d = await handleInteraction(allowCmd('add', r), t.deps);
      expect(d?.ephemeral, r).toBe(true);
      expect(text(d), r).toMatch(/never allowed/);
    }
    expect(t.deps.cfg.get('github.repoAllowlist')).toEqual([{ id: 31, fullName: 'Lab-Work-Space/tools' }]);
    expect(t.audits.filter((a) => (a as { outcome: string }).outcome === 'refused').length).toBe(5);
  });

  it('/github allow › unknown repo, other owner and bad input refused; remove works without the API', async () => {
    const t = await setup();
    for (const r of ['Lab-Work-Space/nope', 'acme/x', 'not a repo', 'a/b/c', '../x/y']) {
      const d = await handleInteraction(allowCmd('add', r), t.deps);
      expect(d?.ephemeral, r).toBe(true);
    }
    expect(t.sets).toHaveLength(0);
    await handleInteraction(allowCmd('add', 'Lab-Work-Space/tools'), t.deps);
    const before = t.gh.f.requests.length;
    const { github: _api, ...noApi } = t.deps; // without the API, removal by the stored name still works
    const gone = await handleInteraction(allowCmd('remove', 'LAB-WORK-SPACE/Tools/'), noApi);
    expect(text(gone)).toContain('Lab-Work-Space/tools');
    expect(t.deps.cfg.get('github.repoAllowlist')).toEqual([]);
    expect(t.gh.f.requests.length).toBe(before);
    expect(t.audits.at(-1)).toMatchObject({ action: 'github.allow.remove', tool: 'Lab-Work-Space/tools#31', outcome: 'ok' });
    expect((await handleInteraction(allowCmd('remove', 'Lab-Work-Space/tools'), t.deps))?.ephemeral).toBe(true);
    expect((await handleInteraction(allowCmd('list', 'Lab-Work-Space/tools'), t.deps))?.ephemeral).toBe(true);
  });

  it('/github allow › remove finds a renamed repo by the id the API resolves, or by owner/repo#id', async () => {
    const t = await setup();
    await t.deps.cfg.set('github.repoAllowlist', [{ id: 31, fullName: 'Lab-Work-Space/old-tools' }, { id: 99, fullName: 'Lab-Work-Space/deleted' }], 'seed');
    const r = await handleInteraction(allowCmd('remove', 'Lab-Work-Space/tools'), t.deps); // stored under the old name; the API says id 31
    expect(text(r)).toContain('Lab-Work-Space/old-tools');
    expect(t.deps.cfg.get('github.repoAllowlist')).toEqual([{ id: 99, fullName: 'Lab-Work-Space/deleted' }]);
    expect(t.audits.at(-1)).toMatchObject({ action: 'github.allow.remove', tool: 'Lab-Work-Space/old-tools#31', outcome: 'ok' });
    const before = t.gh.f.requests.length;
    await handleInteraction(allowCmd('remove', 'Lab-Work-Space/whatever#99'), t.deps); // by id, no API
    expect(t.deps.cfg.get('github.repoAllowlist')).toEqual([]);
    expect(t.gh.f.requests.length).toBe(before);
    expect(t.audits.at(-1)).toMatchObject({ action: 'github.allow.remove', tool: 'Lab-Work-Space/deleted#99', outcome: 'ok' });
  });

  it('/github allow › failed resolve audited; ambiguous name refused; full list refused; renamed denied id refused', async () => {
    const t = await setup();
    await handleInteraction(allowCmd('add', 'Lab-Work-Space/nope'), t.deps);
    expect(t.audits.at(-1)).toMatchObject({ action: 'github.allow.add', tool: 'lab-work-space/nope', outcome: 'failed' });
    await t.deps.cfg.set('github.repoAllowlist', [{ id: 5, fullName: 'Lab-Work-Space/gone' }, { id: 6, fullName: 'Lab-Work-Space/gone' }], 'seed');
    const amb = await handleInteraction(allowCmd('remove', 'Lab-Work-Space/gone'), t.deps); // the API does not know it: name matches two
    expect(text(amb)).toMatch(/Several entries.*#5.*#6/);
    expect(t.deps.cfg.get('github.repoAllowlist')).toHaveLength(2);
    await handleInteraction(allowCmd('remove', 'Lab-Work-Space/gone#6'), t.deps);
    expect(t.deps.cfg.get('github.repoAllowlist')).toEqual([{ id: 5, fullName: 'Lab-Work-Space/gone' }]);
    await t.deps.cfg.set('github.repoAllowlist', Array.from({ length: 200 }, (_, n) => ({ id: 1000 + n, fullName: `Lab-Work-Space/r${n}` })), 'seed');
    expect(text(await handleInteraction(allowCmd('add', 'Lab-Work-Space/tools'), t.deps))).toMatch(/allowlist is full \(200/);
    // Assistant renamed to helper: the denied name still resolves to id 11, so helper cannot be added
    const r = rig({ account: LWS, repos: [lwsRepo('helper', 11, { aliases: ['Assistant'] })] });
    const u = await makeDeps({ github: r.client });
    expect(text(await handleInteraction(allowCmd('add', 'Lab-Work-Space/helper'), u.deps))).toMatch(/never allowed/);
    expect(u.deps.cfg.get('github.repoAllowlist')).toEqual([]);
  });

  it('/github allow › refused when GitHub is not configured; command is registered', async () => {
    const t = await makeDeps();
    const r = await handleInteraction(allowCmd('add', 'Lab-Work-Space/tools'), t.deps);
    expect(text(r)).toMatch(/GitHub is not configured/);
    const gh = COMMANDS.find((c) => c.name === 'github')!;
    expect(gh.options!.map((o) => o.name)).toEqual(['allow']);
  });
});

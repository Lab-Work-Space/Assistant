import { describe, expect, it } from 'vitest';
import { handleInteraction } from './index.js';
import { cmd, makeDeps, text } from './test-helpers.js';

const allow = (action: string, host: string, extra = {}) => cmd('media', 'allowlist', { strings: { action, host }, ...extra });

describe('/media allowlist', () => {
  it('admin only, in #setting; add goes through ConfigStore.set and is audited', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(allow('add', 'music.example.com', { roles: [] }), t.deps))).toContain('Only Bot Admins');
    expect(t.sets).toHaveLength(0);
    expect(text(await handleInteraction(allow('add', ' Music.Example.com '), t.deps))).toContain('music.example.com');
    expect(t.deps.cfg.get('media.ytHostAllowlist')).toContain('music.example.com');
    expect(t.sets.at(-1)).toMatchObject({ key: 'media.ytHostAllowlist', by: 'user:u1' });
    expect(t.audits.at(-1)).toMatchObject({ action: 'media.allowlist', tool: 'add:music.example.com', outcome: 'ok' });
  });

  it('remove works, a missing host and an invalid host (IP, path, port) are refused, the last entry cannot be removed', async () => {
    const t = await makeDeps();
    const before = t.deps.cfg.get('media.ytHostAllowlist');
    expect(text(await handleInteraction(allow('remove', 'youtu.be'), t.deps))).toContain('→');
    expect(t.deps.cfg.get('media.ytHostAllowlist')).not.toContain('youtu.be');
    expect(text(await handleInteraction(allow('remove', 'youtu.be'), t.deps))).toContain('not on the list');
    for (const bad of ['10.0.0.1', '127.0.0.1', 'host:8080', 'a.com/path', 'localhost', 'UPPER_case.com']) {
      expect(text(await handleInteraction(allow('add', bad), t.deps)), bad).toMatch(/Refused|Use action/);
    }
    expect(t.deps.cfg.get('media.ytHostAllowlist')).toHaveLength(before.length - 1);
    for (const h of t.deps.cfg.get('media.ytHostAllowlist').slice(0, -1)) await handleInteraction(allow('remove', h), t.deps);
    expect(text(await handleInteraction(allow('remove', t.deps.cfg.get('media.ytHostAllowlist')[0]!), t.deps))).toMatch(/Refused/);
    expect(t.deps.cfg.get('media.ytHostAllowlist')).toHaveLength(1);
  });
});

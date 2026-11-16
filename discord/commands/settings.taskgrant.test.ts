import { describe, expect, it } from 'vitest';
import { handleInteraction } from './index.js';
import { cmd, makeDeps, text } from './test-helpers.js';

const set = (key: string, value: string) => cmd('settings', 'set', { strings: { key, value } });

describe('TREEGRANT-1: /settings and the taskGrant.* keys', () => {
  it('a cap cannot be set with /settings: refused with the database wording, nothing written', async () => {
    const t = await makeDeps();
    for (const k of ['taskGrant.maxCalls', 'taskGrant.hours', 'taskGrant.conversationHours', 'taskGrant.allowTainted']) {
      expect(text(await handleInteraction(set(k, '50'), t.deps)), k).toContain('the owner sets the task grant caps in the database');
    }
    expect(t.sets).toHaveLength(0);
    expect(t.deps.cfg.get('taskGrant.maxCalls')).toBe(40);
  });

  it('taskGrant.enabled false is accepted, stored and audited; it also revokes every live grant (reason disabled)', async () => {
    const revoked: { reason: string; by: string }[] = [];
    const t = await makeDeps({ taskGrants: { revokeAll: async (reason: string, by?: string) => (revoked.push({ reason, by: by ?? '' }), []), get: async () => null, revoke: async () => false, unrevokedOfMessage: async () => null } as never });
    const r = await handleInteraction(set('taskGrant.enabled', 'false'), t.deps);
    expect(text(r)).toContain('taskGrant.enabled');
    expect(t.deps.cfg.get('taskGrant.enabled')).toBe(false);
    expect(t.sets.at(-1)).toMatchObject({ key: 'taskGrant.enabled', value: false, by: 'user:u1' });
    expect(t.audits.at(-1)).toMatchObject({ actor: 'user:u1', action: 'config.set', tool: 'taskGrant.enabled', outcome: 'ok' });
    expect(revoked).toEqual([{ reason: 'disabled', by: 'u1' }]);
  });

  it('turning it back on does not revoke; a non-boolean value and a no-op are refused', async () => {
    const revoked: string[] = [];
    const t = await makeDeps({ taskGrants: { revokeAll: async (r: string) => (revoked.push(r), []), get: async () => null, revoke: async () => false, unrevokedOfMessage: async () => null } as never });
    await handleInteraction(set('taskGrant.enabled', 'false'), t.deps);
    expect(text(await handleInteraction(set('taskGrant.enabled', 'maybe'), t.deps))).toContain('true or false');
    await handleInteraction(set('taskGrant.enabled', 'true'), t.deps);
    expect(t.deps.cfg.get('taskGrant.enabled')).toBe(true);
    expect(text(await handleInteraction(set('taskGrant.enabled', 'true'), t.deps))).toContain('No change');
    expect(revoked).toEqual(['disabled']);
  });

  it('a non-Bot-Admin cannot flip it', async () => {
    const t = await makeDeps();
    const i = cmd('settings', 'set', { strings: { key: 'taskGrant.enabled', value: 'false' }, roles: [] });
    expect(text(await handleInteraction(i, t.deps))).toContain('Only Bot Admins');
    expect(t.deps.cfg.get('taskGrant.enabled')).toBe(true);
  });
});

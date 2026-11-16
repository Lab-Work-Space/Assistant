import { describe, expect, it } from 'vitest';
import { handleInteraction } from './index.js';
import { cmd, makeDeps, text } from './test-helpers.js';

const set = (key: string, value: string) => cmd('settings', 'set', { strings: { key, value } });

describe('OT-1 OT-C1: /settings and the ot.* keys', () => {
  it('a cap cannot be set with /settings: refused with the database wording, nothing written', async () => {
    const t = await makeDeps();
    for (const k of ['ot.maxUsd', 'ot.maxRuns', 'ot.hours', 'ot.requestsPerRootPerDay', 'ot.requestsPerDay', 'ot.requestsPerPersonPerDay']) {
      expect(text(await handleInteraction(set(k, '50'), t.deps)), k).toContain('the owner sets the OT caps in the database');
    }
    expect(t.sets).toHaveLength(0);
    expect(t.deps.cfg.get('ot.maxUsd')).toBe(2);
  });

  it('ot.enabled false is accepted, stored and audited; it also revokes every live grant (reason admin)', async () => {
    const revoked: { reason: string; by: string }[] = [];
    const t = await makeDeps({ ot: { revokeAll: async (reason, by) => (revoked.push({ reason, by: by ?? '' }), 0), decide: async () => ({ ok: false, error: 'not_found' }), decideDay: async () => ({ ok: false, error: 'not_found' }), revoke: async () => ({ ok: false, error: 'not_found' }) } });
    const r = await handleInteraction(set('ot.enabled', 'false'), t.deps);
    expect(text(r)).toContain('ot.enabled');
    expect(t.deps.cfg.get('ot.enabled')).toBe(false);
    expect(t.sets.at(-1)).toMatchObject({ key: 'ot.enabled', value: false, by: 'user:u1' });
    expect(t.audits.at(-1)).toMatchObject({ actor: 'user:u1', action: 'config.set', tool: 'ot.enabled', outcome: 'ok' });
    expect(revoked).toEqual([{ reason: 'admin', by: 'u1' }]);
  });

  it('turning it back on is accepted and does not revoke; a non-boolean value and a no-op are refused', async () => {
    const revoked: string[] = [];
    const t = await makeDeps({ ot: { revokeAll: async (r) => (revoked.push(r), 0), decide: async () => ({ ok: false, error: 'not_found' }), decideDay: async () => ({ ok: false, error: 'not_found' }), revoke: async () => ({ ok: false, error: 'not_found' }) } });
    await handleInteraction(set('ot.enabled', 'false'), t.deps);
    expect(text(await handleInteraction(set('ot.enabled', 'maybe'), t.deps))).toContain('true or false');
    await handleInteraction(set('ot.enabled', 'true'), t.deps);
    expect(t.deps.cfg.get('ot.enabled')).toBe(true);
    expect(text(await handleInteraction(set('ot.enabled', 'true'), t.deps))).toContain('No change');
    expect(revoked).toEqual(['admin']);
  });

  it('a non-Bot-Admin cannot flip it', async () => {
    const t = await makeDeps();
    const i = cmd('settings', 'set', { strings: { key: 'ot.enabled', value: 'false' }, roles: [] });
    expect(text(await handleInteraction(i, t.deps))).toContain('Only Bot Admins');
    expect(t.deps.cfg.get('ot.enabled')).toBe(true);
  });
});

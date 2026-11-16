import { describe, expect, it } from 'vitest';
import { handleInteraction } from './index.js';
import { cmd, makeDeps, text } from './test-helpers.js';

const set = (v: string, roles?: string[]) => cmd('settings', 'set', { strings: { key: 'autopilot.enabled', value: v }, ...(roles ? { roles } : {}) });

describe('AUTO-1: /settings autopilot.enabled', () => {
  it('toggles, audits, is Bot Admin only; junk and no-op refused; the approval cap stays psql-only', async () => {
    const t = await makeDeps();
    expect(t.deps.cfg.get('autopilot.enabled')).toBe(true);
    expect(text(await handleInteraction(set('false', []), t.deps))).toContain('Only Bot Admins');
    expect(t.deps.cfg.get('autopilot.enabled')).toBe(true);
    await handleInteraction(set('off'), t.deps);
    expect(t.deps.cfg.get('autopilot.enabled')).toBe(false);
    expect(t.audits.at(-1)).toMatchObject({ action: 'config.set', tool: 'autopilot.enabled', outcome: 'ok' });
    expect(text(await handleInteraction(set('maybe'), t.deps))).toContain('true or false');
    expect(text(await handleInteraction(set('off'), t.deps))).toContain('No change');
    await handleInteraction(set('on'), t.deps);
    expect(t.deps.cfg.get('autopilot.enabled')).toBe(true);
    const r = text(await handleInteraction(cmd('settings', 'set', { strings: { key: 'autopilot.maxApprovalsPerProject', value: '9' } }), t.deps));
    expect(r).toContain('not set with /settings');
    expect(t.deps.cfg.get('autopilot.maxApprovalsPerProject')).toBe(500);
  });
  it('turning it on posts the risk notice', async () => {
    const notes: string[] = [];
    const t = await makeDeps({ settings: { notice: async (x) => void notes.push(x), channels: async () => [] } });
    await handleInteraction(set('off'), t.deps);
    await handleInteraction(set('on'), t.deps);
    expect(notes.join(' ')).toContain('autopilot.enabled');
  });
});

describe('AUTO-2 AC-C4: /settings autopilot.scope', () => {
  const scope = (v: string, roles?: string[]) => cmd('settings', 'set', { strings: { key: 'autopilot.scope', value: v }, ...(roles ? { roles } : {}) });
  it('a non-admin is refused; company sets the value and posts the risk notice; project does not; junk says "Give project or company."; a no-op is refused', async () => {
    const notes: string[] = [];
    const t = await makeDeps({ settings: { notice: async (x) => void notes.push(x), channels: async () => [] } });
    expect(t.deps.cfg.get('autopilot.scope')).toBe('project');
    expect(text(await handleInteraction(scope('company', []), t.deps))).toContain('Only Bot Admins');
    expect(t.deps.cfg.get('autopilot.scope')).toBe('project');
    expect(text(await handleInteraction(scope('everything'), t.deps))).toContain('Give project or company.');
    expect(text(await handleInteraction(scope('project'), t.deps))).toContain('No change');
    expect(notes).toEqual([]);
    await handleInteraction(scope('Company'), t.deps);
    expect(t.deps.cfg.get('autopilot.scope')).toBe('company');
    expect(t.audits.at(-1)).toMatchObject({ action: 'config.set', tool: 'autopilot.scope', outcome: 'ok' });
    expect(notes.join(' ')).toContain('autopilot.scope');
    notes.length = 0;
    await handleInteraction(scope('project'), t.deps);
    expect(t.deps.cfg.get('autopilot.scope')).toBe('project');
    expect(notes).toEqual([]); // going back to project is not a risk
  });
  it('the caps keep no /settings path', async () => {
    const t = await makeDeps();
    for (const key of ['autopilot.company.maxApprovalsPerDay', 'autopilot.company.maxApprovalsPerTree', 'autopilot.company.maxApprovalsPerPersonDay']) {
      expect(text(await handleInteraction(cmd('settings', 'set', { strings: { key, value: '5' } }), t.deps))).toContain('not set with /settings');
    }
  });
});

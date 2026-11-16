import { describe, expect, it } from 'vitest';
import { ADMIN_CONFIG_KEYS, ADMIN_READ_KEYS, HANDLER_KEYS, isAdminConfigKey } from '../../admin/keys.js';
import { AdminOp } from '../../admin/ops.js';
import { FOUNDER_ROLE_ID } from '../../company/denylist.js';
import { handleInteraction } from './index.js';
import { ADMIN_ROLE, cmd, makeDeps, text } from './test-helpers.js';
import { taxIdOf } from '../../tools/plugins/docs/test-helpers.js';

const TAX = taxIdOf('010553600000');
const PROFILE = { name: 'บริษัท ทดสอบ จำกัด', address: '1 Test Road, Bangkok', taxId: TAX, branch: '00000' };
const set = (value: string, roles: string[]) => cmd('settings', 'set', { strings: { key: 'company.profile', value }, roles });

describe('RF20 company.profile is owner-only', () => {
  it('RF20: it is a HANDLER key, so config_propose (ADMIN_CONFIG_KEYS) can never write it; it is readable for the admin to see', () => {
    expect(HANDLER_KEYS).toContain('company.profile');
    expect(ADMIN_CONFIG_KEYS).not.toContain('company.profile');
    expect(isAdminConfigKey('company.profile')).toBe(false);
    expect(ADMIN_READ_KEYS).toContain('company.profile');
  });

  it('RF20: no admin_op_propose op can produce the change (the model-facing op schema has no company-profile or generic-config op)', () => {
    const ops = AdminOp.options.map((o) => (o.shape as { op: { value: string } }).op.value);
    expect(ops.filter((o) => /company|profile|config/i.test(o))).toEqual([]);
    for (const op of ops) {
      const r = AdminOp.safeParse({ op, key: 'company.profile', value: PROFILE, profile: PROFILE });
      expect(r.success, op).toBe(false);
    }
  });

  it('RF20 / OD-2: only a member who holds the Founder role right now sets it, with /settings; a Bot Admin without Founder is refused, nothing is written, and it is audited', async () => {
    const t = await makeDeps();
    const r = await handleInteraction(set(JSON.stringify(PROFILE), [ADMIN_ROLE]), t.deps);
    expect(text(r)).toContain('Only the Founder');
    expect(t.sets.filter((s) => s.key === 'company.profile')).toHaveLength(0);
    expect(t.audits.at(-1)).toMatchObject({ tool: 'company.profile', outcome: expect.stringMatching(/refused/) });
    // the Founder role without Bot Admin is refused by the /settings gate (both are required)
    const noAdmin = await handleInteraction(set(JSON.stringify(PROFILE), [FOUNDER_ROLE_ID]), t.deps);
    expect(text(noAdmin)).toContain('Only Bot Admins');
    expect(t.sets.filter((s) => s.key === 'company.profile')).toHaveLength(0);
  });

  it('RF20: a Founder who is also a Bot Admin sets a valid profile; it is validated (13-digit tax ID with the Thai checksum) and audited', async () => {
    const t = await makeDeps();
    const ok = await handleInteraction(set(JSON.stringify(PROFILE), [ADMIN_ROLE, FOUNDER_ROLE_ID]), t.deps);
    expect(text(ok)).not.toMatch(/Invalid|Only the Founder/);
    expect(t.deps.cfg.get('company.profile')).toEqual(PROFILE);
    expect(t.audits.at(-1)).toMatchObject({ tool: 'company.profile', outcome: 'ok' });
    const bad = await handleInteraction(set(JSON.stringify({ ...PROFILE, taxId: `${TAX.slice(0, 12)}${(Number(TAX[12]) + 1) % 10}` }), [ADMIN_ROLE, FOUNDER_ROLE_ID]), t.deps);
    expect(text(bad)).toMatch(/check digit/);
    for (const v of ['{"name":"x"}', 'not json', JSON.stringify({ ...PROFILE, extra: 1 }), JSON.stringify({ ...PROFILE, taxId: '123' }), JSON.stringify({ ...PROFILE, name: 'a\u0000b' })]) {
      const r = await handleInteraction(set(v, [ADMIN_ROLE, FOUNDER_ROLE_ID]), t.deps);
      expect(text(r), v).toMatch(/Invalid|Give the profile as JSON/);
    }
    expect(t.deps.cfg.get('company.profile')).toEqual(PROFILE);
    const cleared = await handleInteraction(set('none', [ADMIN_ROLE, FOUNDER_ROLE_ID]), t.deps);
    expect(text(cleared)).not.toMatch(/Invalid/);
    expect(t.deps.cfg.get('company.profile')).toBeNull();
  });

  it('RF20: it defaults to unset (null)', async () => {
    const t = await makeDeps();
    expect(t.deps.cfg.get('company.profile')).toBeNull();
  });

  it('D-02: a successful set posts the risk notice to #bot-log (key and user only, never the profile); a refused set posts nothing', async () => {
    const notes: string[] = [];
    const t = await makeDeps({ settings: { notice: async (m: string) => { notes.push(m); }, channels: async () => [] } } as never);
    await handleInteraction(set(JSON.stringify(PROFILE), [ADMIN_ROLE]), t.deps);
    expect(notes).toEqual([]);
    await handleInteraction(set(JSON.stringify(PROFILE), [ADMIN_ROLE, FOUNDER_ROLE_ID]), t.deps);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/^⚠ company\.profile was changed by <@u1>/);
    expect(notes[0]).not.toContain(TAX);
  });
});

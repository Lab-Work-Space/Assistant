import { describe, expect, it } from 'vitest';
import { ADMIN_READ_KEYS, isAdminConfigKey } from '../../admin/keys.js';
import { COMMANDS, handleInteraction } from './index.js';
import { cmd, makeDeps, text } from './test-helpers.js';

const settings = (sub: string, strings: Record<string, string> = {}, extra = {}) => cmd('settings', sub, { strings, ...extra });
const proposed = () => {
  const calls: { kind: string; raw: unknown }[] = [];
  return {
    calls,
    admin: {
      click: async () => ({ content: '', ephemeral: true, allowedMentions: { parse: [] as [] } }),
      proposeConfig: async (_p: unknown, raw: unknown) => { calls.push({ kind: 'config', raw }); return { ok: true as const, text: 'Card #abc waiting for Confirm' }; },
      proposeOp: async (_p: unknown, raw: unknown) => { calls.push({ kind: 'op', raw }); return { ok: true as const, text: 'Card #def waiting for Confirm' }; },
    },
  };
};

describe('/settings (spec §4, WS9)', () => {
  it('is registered with list, get and set; slash only, no model path', () => {
    const def = COMMANDS.find((c) => c.name === 'settings')!;
    expect(def.options!.map((o) => o.name)).toEqual(['list', 'get', 'set']);
  });

  it('WS9: a non-Bot-Admin is refused (guard and handler), nothing is read or written', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(settings('set', { key: 'limits.depth', value: '5' }, { roles: [] }), t.deps))).toContain('Only Bot Admins');
    expect(text(await handleInteraction(settings('list', {}, { channelId: '1565000000000000999' }), t.deps))).toContain('#⚙️-setting');
    const { settingsCmd } = await import('./settings.js');
    const r = await settingsCmd(settings('set', { key: 'limits.depth', value: '5' }, { roles: [] }), t.deps);
    expect(JSON.stringify(r)).toContain('Only Bot Admins');
    expect(t.sets).toHaveLength(0);
  });

  it('WS9: list and get read only ADMIN_READ_KEYS; no provider keys, no halted; replies are private', async () => {
    const t = await makeDeps();
    const i = settings('list');
    const r = await handleInteraction(i, t.deps);
    expect(i.deferred).toEqual({ ephemeral: true });
    const out = text(r);
    expect(out).toContain('limits.depth = ');
    expect(out).not.toMatch(/provider_keys|halted|api[_-]?key|token/i);
    const pre = text(await handleInteraction(settings('list', { prefix: 'warroom.' }), t.deps));
    expect(pre).toContain('warroom.stallTurns = ');
    expect(pre).not.toContain('limits.depth');
    expect(text(await handleInteraction(settings('list', { prefix: 'a b' }), t.deps))).toContain('letters, digits and dots');
    expect(text(await handleInteraction(settings('get', { key: 'limits.depth' }), t.deps))).toContain('limits.depth');
    expect(text(await handleInteraction(settings('get', { key: 'halted' }), t.deps))).toContain('/halt');
    expect(text(await handleInteraction(settings('get', { key: 'provider_keys' }), t.deps))).toContain('Unknown key');
    expect(ADMIN_READ_KEYS).not.toContain('halted');
  });

  it('WS9: set halted is refused and audited', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(settings('set', { key: 'halted', value: 'false' }), t.deps))).toContain('/halt');
    expect(t.sets).toHaveLength(0);
    expect(t.audits.at(-1)).toMatchObject({ action: 'settings.set', tool: 'halted' });
  });

  it('a non-sensitive key is set directly: validated, versioned by the store, audited', async () => {
    const t = await makeDeps();
    const r = await handleInteraction(settings('set', { key: 'limits.depth', value: '7' }), t.deps);
    expect(text(r)).toContain('limits.depth');
    expect(t.deps.cfg.get('limits.depth')).toBe(7);
    expect(t.sets.at(-1)).toMatchObject({ key: 'limits.depth', value: 7, by: 'user:u1' });
    expect(t.audits.at(-1)).toMatchObject({ actor: 'user:u1', action: 'config.set', tool: 'limits.depth', outcome: 'ok' });
    expect(text(await handleInteraction(settings('set', { key: 'limits.depth', value: 'abc' }), t.deps))).toContain('Invalid value');
    expect(text(await handleInteraction(settings('set', { key: 'limits.depth', value: '0' }), t.deps))).toContain('Invalid value');
    expect(text(await handleInteraction(settings('set', { key: 'no.such.key', value: '1' }), t.deps))).toContain('Unknown key');
    expect(text(await handleInteraction(settings('set', { key: 'limits.depth', value: '7' }), t.deps))).toContain('No change');
    expect(text(await handleInteraction(settings('set', { key: 'limits.depth', value: '9'.repeat(5000) }), t.deps))).toContain('too long');
    expect(t.sets).toHaveLength(1);
  });

  it('a configRisk change is applied and posts a risk notice; a lowering does not', async () => {
    const notices: string[] = [];
    const t = await makeDeps({ settings: { notice: async (x) => void notices.push(x), channels: async () => [] } });
    await handleInteraction(settings('set', { key: 'budget.taskUsd', value: '99' }), t.deps);
    expect(t.deps.cfg.get('budget.taskUsd')).toBe(99);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('budget.taskUsd');
    await handleInteraction(settings('set', { key: 'budget.taskUsd', value: '1' }), t.deps);
    expect(notices).toHaveLength(1);
  });

  it.each([
    ['net.extraPorts', '[8080]'],
    ['approvals.channelByCategory', '{"1570000000000000100":"1570000000000000200"}'],
    ['roles.managerId', '"1570000000000000300"'],
    ['pricing', '{"m":{"inPerMTok":1,"outPerMTok":1}}'],
    ['warroom.stallTurns', '50'], // G2WS-02 (WS3): a raise from the default 20
  ])('WS9: %s makes a card and writes nothing', async (key, value) => {
    const p = proposed();
    const t = await makeDeps({ admin: p.admin });
    const r = await handleInteraction(settings('set', { key, value }), t.deps);
    expect(text(r)).toContain('Card #abc');
    expect(p.calls).toEqual([{ kind: 'config', raw: { changes: [{ key, value: JSON.parse(value) }] } }]);
    expect(t.sets).toHaveLength(0);
  });

  it('WS9: limits.localUnlimited false->true is a card; true->false is direct', async () => {
    const p = proposed();
    const t = await makeDeps({ admin: p.admin });
    await t.deps.cfg.set('limits.localUnlimited', false, 'seed');
    t.sets.length = 0;
    await handleInteraction(settings('set', { key: 'limits.localUnlimited', value: 'true' }), t.deps);
    expect(p.calls).toHaveLength(1);
    expect(t.deps.cfg.get('limits.localUnlimited')).toBe(false);
    await t.deps.cfg.set('limits.localUnlimited', true, 'seed');
    await handleInteraction(settings('set', { key: 'limits.localUnlimited', value: 'false' }), t.deps);
    expect(t.deps.cfg.get('limits.localUnlimited')).toBe(false);
    expect(p.calls).toHaveLength(1);
  });

  it('TEAMTALK kill switch: teamtalk.enabled is a plain boolean a Bot Admin sets directly, off or on, live', async () => {
    const t = await makeDeps();
    expect(t.deps.cfg.get('teamtalk.enabled')).toBe(true);
    await handleInteraction(settings('set', { key: 'teamtalk.enabled', value: 'false' }), t.deps);
    expect(t.deps.cfg.get('teamtalk.enabled')).toBe(false);
    await handleInteraction(settings('set', { key: 'teamtalk.enabled', value: 'true' }), t.deps);
    expect(t.deps.cfg.get('teamtalk.enabled')).toBe(true);
    expect(text(await handleInteraction(settings('set', { key: 'teamtalk.enabled', value: 'false' }, { roles: [] }), t.deps))).toContain('Only Bot Admins');
    expect(text(await handleInteraction(settings('set', { key: 'teamtalk.enabled', value: 'maybe' }), t.deps))).toContain('Invalid value');
  });

  it('a card key without a console is refused, never written directly', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(settings('set', { key: 'net.extraPorts', value: '[8080]' }), t.deps))).toContain('not available');
    expect(t.deps.cfg.get('net.extraPorts')).toEqual([]);
  });

  it('WS9: provider.default goes through its plan function behind a card (admin op), not a raw write', async () => {
    const p = proposed();
    const t = await makeDeps({ admin: p.admin });
    await handleInteraction(settings('set', { key: 'provider.default', value: 'claude some-model' }), t.deps);
    expect(p.calls).toEqual([{ kind: 'op', raw: { op: 'provider_default', provider: 'claude', model: 'some-model' } }]);
    expect(t.sets).toHaveLength(0);
  });

  it('WS9: ocr.autoChannelId set to a DENIED channel is refused through the handler', async () => {
    const { DENIED_CHANNEL_IDS } = await import('../../company/denylist.js');
    const denied = DENIED_CHANNEL_IDS[0]!;
    const t = await makeDeps({ settings: { notice: async () => undefined, channels: async () => [{ id: denied, name: 'x', parentId: null, type: 0 }] } });
    expect(text(await handleInteraction(settings('set', { key: 'ocr.autoChannelId', value: `<#${denied}>` }), t.deps))).toContain('off limits');
    expect(t.sets).toHaveLength(0);
    // an unknown channel is refused as well; a visible allowed one is stored through the plan
    const ok = '1570000000000000777';
    const t2 = await makeDeps({ settings: { notice: async () => undefined, channels: async () => [{ id: ok, name: 'ok', parentId: null, type: 0 }] } });
    expect(text(await handleInteraction(settings('set', { key: 'ocr.autoChannelId', value: '1570000000000000888' }), t2.deps))).toContain('channel');
    await handleInteraction(settings('set', { key: 'ocr.autoChannelId', value: ok }), t2.deps);
    expect(t2.deps.cfg.get('ocr.autoChannelId')).toBe(ok);
  });

  it('other handler keys use their plan (schedule.offDays) or are refused with a pointer (welcome, holidays)', async () => {
    const t = await makeDeps();
    await handleInteraction(settings('set', { key: 'schedule.offDays', value: 'sat,sun' }), t.deps);
    expect(t.deps.cfg.get('schedule.offDays')).toEqual([0, 6]);
    expect(text(await handleInteraction(settings('set', { key: 'schedule.holidays', value: '[]' }), t.deps))).toContain('/holiday');
    expect(text(await handleInteraction(settings('set', { key: 'welcome.enabled', value: 'true' }), t.deps))).toContain('own administration path');
    expect(text(await handleInteraction(settings('set', { key: 'devjob.enabled', value: 'true' }), t.deps))).toContain('own administration path');
    expect(t.sets.filter((s) => s.key.startsWith('welcome') || s.key.startsWith('devjob'))).toHaveLength(0);
    // WEBGRANT-1 (W-C7): the web grant keys have no /settings path (owner-only, like devjob.*); the kill switch and the caps change in the database
    for (const key of ['web.taskGrant.enabled', 'web.taskGrant.maxFetches', 'web.taskGrant.maxHosts', 'web.taskGrant.maxUrlChars', 'web.taskGrant.hours']) {
      expect(text(await handleInteraction(settings('set', { key, value: key.endsWith('enabled') ? 'false' : '1' }), t.deps)), key).toContain('own administration path');
    }
    expect(t.sets.filter((s) => s.key.startsWith('web.taskGrant'))).toHaveLength(0);
    expect(['web.taskGrant.enabled', 'web.taskGrant.maxFetches'].some(isAdminConfigKey)).toBe(false); // and no model-reachable config_propose path
  });

  it('SPEND-1 S1/S19: every spend.* key is a handler key with no model-reachable path (isAdminConfigKey false), and /settings reaches each through its plan', async () => {
    const { ConfigSchema } = await import('../../config/schema.js');
    const keys = Object.keys(ConfigSchema).filter((k) => k.startsWith('spend.'));
    expect(keys).toHaveLength(9);
    expect(keys.some(isAdminConfigKey)).toBe(false);
    const t = await makeDeps();
    for (const [key, value] of [['spend.warnPct', '85'], ['spend.anomalyMultiplier', '4'], ['spend.anomalyMinUsd', '1'], ['spend.alertsEnabled', 'false'], ['spend.weeklySummary', 'false'], ['spend.weeklySummaryTime', '10:00'], ['spend.overrideStepPct', '30'], ['spend.retentionDays', '200'], ['spend.deptMonthlyUsd', 'hq 5']] as const) {
      expect(text(await handleInteraction(settings('set', { key, value }), t.deps)), key).not.toMatch(/own administration path|Unknown key/);
      expect(t.sets.some((s) => s.key === key), key).toBe(true);
    }
    for (const bad of ['NaN', 'Infinity', '1e308', '-1']) expect(text(await handleInteraction(settings('set', { key: 'spend.warnPct', value: bad }), t.deps))).toContain('Invalid value');
  });

  it('replies never echo a secret-shaped value', async () => {
    const t = await makeDeps();
    const r = await handleInteraction(settings('set', { key: 'voice.ttsVoice', value: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' }), t.deps);
    expect(text(r)).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  describe('WS10/WS11 rhythm.dailyGoalChannelId and dashboard.channelId go through their plan function', () => {
    const ok = '1570000000000000321';
    const chans = (extra: { id: string; parentId: string | null; type: number }[] = []) => ({ notice: async () => undefined, channels: async () => [{ id: ok, name: 'daily', parentId: null, type: 0 }, ...extra.map((e) => ({ ...e, name: 'x' }))] });

    it('are handler keys (never a raw config_propose write) and default to off', async () => {
      const { ADMIN_CONFIG_KEYS, HANDLER_KEYS } = await import('../../admin/keys.js');
      for (const k of ['rhythm.dailyGoalChannelId', 'dashboard.channelId'] as const) {
        expect(HANDLER_KEYS).toContain(k);
        expect(ADMIN_CONFIG_KEYS).not.toContain(k);
      }
      const t = await makeDeps();
      expect(t.deps.cfg.get('rhythm.dailyGoalChannelId')).toBeNull();
      expect(t.deps.cfg.get('dashboard.channelId')).toBeNull();
      expect(t.deps.cfg.get('rhythm.dailyGoalTime')).toBe('09:00');
      expect(t.deps.cfg.get('rhythm.eveningReportTime')).toBe('20:00');
    });

    it('G2WS-01: a text channel inside a category (parentId = the category id) is accepted; one in the DENIED IT category is not', async () => {
      const { DENIED_CATEGORY_IDS } = await import('../../company/denylist.js');
      const inCat = '1570000000000000322';
      const inIt = '1570000000000000323';
      const t = await makeDeps({ settings: chans([{ id: inCat, parentId: '1570000000000000100', type: 0 }, { id: inIt, parentId: DENIED_CATEGORY_IDS[0]!, type: 0 }]) });
      await handleInteraction(settings('set', { key: 'dashboard.channelId', value: `<#${inIt}>` }), t.deps);
      expect(t.deps.cfg.get('dashboard.channelId')).toBeNull();
      await handleInteraction(settings('set', { key: 'dashboard.channelId', value: `<#${inCat}>` }), t.deps);
      expect(t.deps.cfg.get('dashboard.channelId')).toBe(inCat);
    });

    it('a visible text channel is stored; none switches it off', async () => {
      const t = await makeDeps({ settings: chans() });
      await handleInteraction(settings('set', { key: 'rhythm.dailyGoalChannelId', value: `<#${ok}>` }), t.deps);
      expect(t.deps.cfg.get('rhythm.dailyGoalChannelId')).toBe(ok);
      await handleInteraction(settings('set', { key: 'rhythm.dailyGoalChannelId', value: 'none' }), t.deps);
      expect(t.deps.cfg.get('rhythm.dailyGoalChannelId')).toBeNull();
    });

    it('refuses denied, system, goals, warroom, thread, forum, voice, approvals-room and unknown channels, and the channel of the other feature', async () => {
      const { DENIED_CHANNEL_IDS } = await import('../../company/denylist.js');
      const { BOT_LOG_CHANNEL_ID, AI_WARROOM_CHANNEL_ID, GOAL_TEXT_CHANNEL_ID } = await import('../../company/channels.js');
      const room = '1570000000000000777';
      const bad = [
        { id: DENIED_CHANNEL_IDS[0]!, parentId: null, type: 0 }, { id: BOT_LOG_CHANNEL_ID, parentId: null, type: 0 }, { id: GOAL_TEXT_CHANNEL_ID, parentId: null, type: 0 },
        { id: AI_WARROOM_CHANNEL_ID, parentId: null, type: 0 }, { id: '1570000000000000901', parentId: ok, type: 11 }, { id: '1570000000000000902', parentId: null, type: 15 },
        { id: '1570000000000000903', parentId: null, type: 2 }, { id: room, parentId: null, type: 0 },
      ];
      const t = await makeDeps({ settings: chans(bad) });
      await t.deps.cfg.set('approvals.channelByCategory', { '1570000000000000100': room }, 'test');
      for (const c of bad) {
        await handleInteraction(settings('set', { key: 'dashboard.channelId', value: c.id }), t.deps);
        expect(t.deps.cfg.get('dashboard.channelId')).toBeNull();
      }
      await handleInteraction(settings('set', { key: 'dashboard.channelId', value: '1570000000000000999' }), t.deps); // unknown to the bot
      expect(t.deps.cfg.get('dashboard.channelId')).toBeNull();
      await handleInteraction(settings('set', { key: 'rhythm.dailyGoalChannelId', value: ok }), t.deps);
      await handleInteraction(settings('set', { key: 'dashboard.channelId', value: ok }), t.deps); // one purpose per channel
      expect(t.deps.cfg.get('dashboard.channelId')).toBeNull();
    });

    it('the times are validated and set directly', async () => {
      const t = await makeDeps();
      await handleInteraction(settings('set', { key: 'rhythm.dailyGoalTime', value: '25:00' }), t.deps);
      expect(t.deps.cfg.get('rhythm.dailyGoalTime')).toBe('09:00');
      await handleInteraction(settings('set', { key: 'rhythm.dailyGoalTime', value: '08:30' }), t.deps);
      expect(t.deps.cfg.get('rhythm.dailyGoalTime')).toBe('08:30');
    });
  });
});

describe('CLICKUP-ALL-1 C11: clickup.writesPerDay and clickup.pollListIds in /settings', () => {
  it('raising writesPerDay is flagged as a risk (notice posted); lowering and 0 are not; bad values are refused', async () => {
    const notices: string[] = [];
    const t = await makeDeps({ settings: { notice: async (x) => void notices.push(x), channels: async () => [] } });
    expect(text(await handleInteraction(settings('set', { key: 'clickup.writesPerDay', value: '80' }), t.deps))).not.toContain('Unknown');
    expect(t.deps.cfg.get('clickup.writesPerDay')).toBe(80);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('clickup.writesPerDay');
    await handleInteraction(settings('set', { key: 'clickup.writesPerDay', value: '10' }), t.deps);
    await handleInteraction(settings('set', { key: 'clickup.writesPerDay', value: '0' }), t.deps);
    expect(t.deps.cfg.get('clickup.writesPerDay')).toBe(0);
    expect(notices).toHaveLength(1);
    for (const bad of ['501', '-1', '1.5', 'many', '']) expect(text(await handleInteraction(settings('set', { key: 'clickup.writesPerDay', value: bad }), t.deps)), bad).toContain('whole number from 0 to 500');
    expect(t.deps.cfg.get('clickup.writesPerDay')).toBe(0);
  });

  it('pollListIds is not set with /settings: it points to /clickup watch and writes nothing', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(settings('set', { key: 'clickup.pollListIds', value: '["7001"]' }), t.deps))).toContain('/clickup watch');
    expect(t.deps.cfg.get('clickup.pollListIds')).toEqual([]);
  });

  it('the settings command goes through the Bot Admin guard for the new keys too', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(settings('set', { key: 'clickup.writesPerDay', value: '100' }, { roles: [] }), t.deps))).toContain('Only Bot Admins');
    expect(t.deps.cfg.get('clickup.writesPerDay')).toBe(50);
  });
});

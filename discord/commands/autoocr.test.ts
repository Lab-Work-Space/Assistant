import { describe, expect, it } from 'vitest';
import { handleInteraction } from './index.js';
import { cmd, makeDeps, text } from './test-helpers.js';

const CH = '1565999999999999002';
const set = (extra = {}) => cmd('autoocr', 'channel', { channels: { channel: { id: CH, parentId: null } }, ...extra });

describe('/autoocr channel', () => {
  it('admin only, in #setting; stores a validated id through ConfigStore and audits', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(set({ roles: [] }), t.deps))).toContain('Only Bot Admins');
    expect(t.sets).toHaveLength(0);
    expect(text(await handleInteraction(set(), t.deps))).toContain(CH);
    expect(t.deps.cfg.get('ocr.autoChannelId')).toBe(CH);
    expect(t.sets.at(-1)).toMatchObject({ key: 'ocr.autoChannelId', value: CH, by: 'user:u1' });
    expect(t.audits.at(-1)).toMatchObject({ action: 'autoocr.channel', tool: CH, outcome: 'ok' });
  });

  it('no channel clears it; a denied channel is refused', async () => {
    const t = await makeDeps();
    await handleInteraction(set(), t.deps);
    await handleInteraction(cmd('autoocr', 'channel', {}), t.deps);
    expect(t.deps.cfg.get('ocr.autoChannelId')).toBeNull();
    const denied = await handleInteraction(set({ channels: { channel: { id: '1565715069969502310', parentId: null } } }), t.deps);
    expect(text(denied)).toContain('off limits');
  });
});

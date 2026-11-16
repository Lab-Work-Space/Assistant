import { describe, expect, it, vi } from 'vitest';
import { handleInteraction } from './index.js';
import { cmd, makeDeps, text } from './test-helpers.js';

const pause = (action: string, o: { roles?: string[]; channelId?: string; guildId?: string } = {}) => cmd('approval', 'ai', { strings: { action }, ...o });

function repo(o: { paused?: boolean; readFails?: boolean; writeFails?: boolean } = {}) {
  const state = { paused: o.paused ?? false };
  const writes: { user: string; on: boolean }[] = [];
  return {
    state, writes,
    pausedToday: vi.fn(async () => { if (o.readFails) throw new Error('db'); return state.paused; }),
    setPause: vi.fn(async (user: string, on: boolean) => { if (o.writeFails) throw new TypeError('db'); writes.push({ user, on }); state.paused = on; }),
  };
}

describe('AI-APPROVE-1: /approval ai', () => {
  it('pause, same state, resume, resume again', async () => {
    const r = repo();
    const t = await makeDeps({ aiApprover: r });
    expect(text(await handleInteraction(pause('pause'), t.deps))).toContain('AI approvals are paused until midnight (Asia/Bangkok).');
    expect(text(await handleInteraction(pause('pause'), t.deps))).toContain('No change.');
    expect(text(await handleInteraction(pause('resume'), t.deps))).toContain('AI approvals are on again.');
    expect(text(await handleInteraction(pause('resume'), t.deps))).toContain('No change.');
    expect(r.writes).toEqual([{ user: 'u1', on: true }, { user: 'u1', on: false }]);
  });
  it('a write error says nothing changed and logs errName only', async () => {
    const t = await makeDeps({ aiApprover: repo({ writeFails: true }) });
    expect(text(await handleInteraction(pause('pause'), t.deps))).toContain('Nothing changed: the pause could not be saved.');
    expect(t.logLines.join('')).toContain('TypeError');
  });
  it('a read error says nothing changed', async () => {
    const t = await makeDeps({ aiApprover: repo({ readFails: true }) });
    expect(text(await handleInteraction(pause('resume'), t.deps))).toContain('Nothing changed');
  });
  it('a non-admin, the wrong channel and another guild are refused or dropped; nothing is written', async () => {
    const r = repo();
    const t = await makeDeps({ aiApprover: r });
    expect(text(await handleInteraction(pause('pause', { roles: [] }), t.deps))).toContain('Only Bot Admins');
    expect(text(await handleInteraction(pause('pause', { channelId: '1' }), t.deps))).toContain('#⚙️-setting');
    expect(await handleInteraction(pause('pause', { guildId: '9' }), t.deps)).toBeNull();
    expect(r.writes).toHaveLength(0);
  });
  it('an unknown action is refused', async () => {
    const r = repo();
    const t = await makeDeps({ aiApprover: r });
    expect(text(await handleInteraction(pause('stop'), t.deps))).toContain('Unknown action.');
    expect(r.writes).toHaveLength(0);
  });
});

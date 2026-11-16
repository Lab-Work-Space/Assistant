import { describe, expect, it } from 'vitest';
import { handleInteraction } from './index.js';
import { cmd, makeDeps, text } from './test-helpers.js';

const set = (key: string, value: string, roles?: string[]) => cmd('settings', 'set', { strings: { key, value }, ...(roles ? { roles } : {}) });

describe('R6 MCP-1: /settings and the mcp keys (spec 5.9)', () => {
  it('mcp.enabled has a /settings path: on is stored, audited and posts the risk notice; junk and a no-op are refused', async () => {
    const t = await makeDeps();
    const notices: string[] = [];
    t.deps.settings = { notice: async (s: string) => void notices.push(s), channels: async () => [] };
    expect(t.deps.cfg.get('mcp.enabled')).toBe(false);
    expect(text(await handleInteraction(set('mcp.enabled', 'maybe'), t.deps))).toContain('true or false');
    expect(text(await handleInteraction(set('mcp.enabled', 'false'), t.deps))).toContain('No change');
    await handleInteraction(set('mcp.enabled', 'true'), t.deps);
    expect(t.deps.cfg.get('mcp.enabled')).toBe(true);
    expect(t.sets.at(-1)).toMatchObject({ key: 'mcp.enabled', value: true, by: 'user:u1' });
    expect(t.audits.at(-1)).toMatchObject({ actor: 'user:u1', action: 'config.set', tool: 'mcp.enabled', outcome: 'ok' });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('mcp.enabled');
    await handleInteraction(set('mcp.enabled', 'off'), t.deps);
    expect(t.deps.cfg.get('mcp.enabled')).toBe(false);
    expect(notices).toHaveLength(1); // turning it off is not a risk
  });
  it('the caps are the owner\'s, in the database: not set with /settings, nothing written', async () => {
    const t = await makeDeps();
    for (const k of ['mcp.maxCallsPerTree', 'mcp.maxCallsPerDay']) {
      expect(text(await handleInteraction(set(k, '10'), t.deps)), k).toContain('the owner sets the MCP caps in the database');
    }
    expect(t.sets).toHaveLength(0);
  });
  it('a non-Bot-Admin cannot flip it', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(set('mcp.enabled', 'true', []), t.deps))).toContain('Only Bot Admins');
    expect(t.deps.cfg.get('mcp.enabled')).toBe(false);
  });
});

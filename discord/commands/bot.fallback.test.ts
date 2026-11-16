import { describe, expect, it } from 'vitest';
import { PRAW_DEFAULT_MODEL } from '../../company/seed.js';
import { handleInteraction } from './index.js';
import { isError, planBotModel, planProviderDefault } from './plans.js';
import { cmd, makeDeps, text } from './test-helpers.js';

const registered = (...ids: string[]) => ({ has: (id: string) => ids.includes(id) });

// R8 PV-F01 (caller decision, folded into R8): "only praw on Gemini", and the metered claude target needs the LW Admin confirm card.
describe('R8 PV-F01: planBotModel', () => {
  it('refuses gemini for every department except praw (slash path and plan)', async () => {
    const t = await makeDeps({ providers: registered('claude', 'gemini', 'claude-code-local') });
    const r = await handleInteraction(cmd('bot', 'model', { strings: { dept: 'software', provider: 'gemini', model: PRAW_DEFAULT_MODEL } }), t.deps);
    expect(r?.ephemeral).toBe(true);
    expect(text(r)).toContain('Gemini');
    expect(t.org.dept('software')!.provider).toBeNull();
    const p = await planBotModel('hq', 'gemini', PRAW_DEFAULT_MODEL, t.deps);
    expect(isError(p)).toBe(true);
  });

  it('praw may use gemini, and that plan is not a risk', async () => {
    const t = await makeDeps({ providers: registered('claude', 'gemini', 'claude-code-local') });
    t.mem.depts.set('praw', { id: 'praw', name: 'praw', categoryNamePattern: '', workChannelId: null, color: 0xf48fb1, provider: null, model: null, enabled: true } as never);
    await t.org.reload();
    const p = await planBotModel('praw', 'gemini', PRAW_DEFAULT_MODEL, t.deps);
    expect(isError(p)).toBe(false);
    if (!isError(p)) expect(p.risk).toBe(false);
  });

  it('a target provider of claude (metered) is a risk, so the confirm card applies; local is not', async () => {
    const t = await makeDeps({ providers: registered('claude', 'gemini', 'claude-code-local') });
    const claude = await planBotModel('software', 'claude', 'claude-haiku-5-5', t.deps);
    const local = await planBotModel('software', 'claude-code-local', 'local/claude-haiku-5-5', t.deps);
    expect(isError(claude) ? 'error' : claude.risk).toBe(true);
    expect(isError(local) ? 'error' : local.risk).toBe(false);
  });
});

// Gate 2 G2-PV-03 (global rule 8, the sibling of PV-F01): provider.default serves every department without its own row, never praw alone,
// so a Gemini default would move every non-praw department to Gemini. Refused on every path (slash card and admin op share this plan).
describe('R8 G2-PV-03: planProviderDefault', () => {
  it('refuses gemini as the company default; claude and local stay allowed', async () => {
    const t = await makeDeps({ providers: registered('claude', 'gemini', 'claude-code-local') });
    const g = planProviderDefault('gemini', PRAW_DEFAULT_MODEL, t.deps);
    expect(isError(g)).toBe(true);
    if (isError(g)) expect(g.error).toContain('Gemini');
    expect(isError(planProviderDefault('claude', 'claude-sonnet-5-5', t.deps))).toBe(false);
    expect(isError(planProviderDefault('claude-code-local', 'local/claude-sonnet-5-5', t.deps))).toBe(false);
  });
});

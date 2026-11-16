import { describe, expect, it } from 'vitest';
import { resolveActor } from '../../agents/context.js';
import { PRAW_DEFAULT_MODEL } from '../../company/seed.js';
import type { PromptDoc } from '../../prompts/index.js';
import { FakeProvider, ProviderRegistry } from '../../providers/index.js';
import { handleInteraction } from './index.js';
import { cmd, makeDeps, text } from './test-helpers.js';

const registered = (...ids: string[]) => ({ has: (id: string) => ids.includes(id) });
const praw = (provider: string | null, model: string | null) => ({
  id: 'praw', name: 'praw', categoryNamePattern: '', workChannelId: null, color: 0xf48fb1, provider, model, enabled: true,
});
const prawPrompt = new Map<string, PromptDoc>([
  ['heads/praw', { ref: 'heads/praw', meta: { name: 'praw', role: 'head', dept: 'praw', tools: ['respond'], traits: ['x'], fragments: [], model: `gemini/${PRAW_DEFAULT_MODEL}` }, body: 'praw' }],
]);

describe('bot model selection for praw', () => {
  it('/bot model praw claude claude-sonnet-5-5 changes the model Praw actually runs on (resolve end-to-end)', async () => {
    const t = await makeDeps({ providers: registered('claude', 'gemini') });
    t.mem.depts.set('praw', praw('gemini', PRAW_DEFAULT_MODEL));
    await t.org.reload();
    const registry = new ProviderRegistry();
    registry.register(new FakeProvider([], 'claude'));
    registry.register(new FakeProvider([], 'gemini'));
    const run = async () => {
      const a = await resolveActor({ kind: 'head', dept: 'praw' }, t.org, prawPrompt, { getActive: async () => null });
      if (typeof a === 'string') throw new Error(a);
      const r = registry.resolve(a.sel, t.deps.cfg);
      return { provider: r.provider.id, model: r.model };
    };
    expect(await run()).toEqual({ provider: 'gemini', model: PRAW_DEFAULT_MODEL });
    const r = await handleInteraction(cmd('bot', 'model', { strings: { dept: 'praw', provider: 'claude', model: 'claude-sonnet-5-5' } }), t.deps);
    expect(text(r)).toContain('claude/claude-sonnet-5-5');
    expect(await run()).toEqual({ provider: 'claude', model: 'claude-sonnet-5-5' });
  });

  it('/bot model praw gemini <PRAW_DEFAULT_MODEL> accepted; unpriced model refused', async () => {
    const t = await makeDeps({ providers: registered('claude', 'gemini') });
    t.mem.depts.set('praw', praw(null, null));
    await t.org.reload();
    const bad = await handleInteraction(cmd('bot', 'model', { strings: { dept: 'praw', provider: 'gemini', model: 'gemini-mystery' } }), t.deps);
    expect(bad?.ephemeral).toBe(true);
    expect(t.org.dept('praw')!.model).toBeNull();
    const ok = await handleInteraction(cmd('bot', 'model', { strings: { dept: 'praw', provider: 'gemini', model: PRAW_DEFAULT_MODEL } }), t.deps);
    expect(text(ok)).toContain(`gemini/${PRAW_DEFAULT_MODEL}`);
    expect(t.org.dept('praw')).toMatchObject({ provider: 'gemini', model: PRAW_DEFAULT_MODEL });
  });
});

describe('bot tools', () => {
  const call = (o: Record<string, string>, extra = {}) => cmd('bot', 'tools', { strings: o, ...extra });
  it('add/remove persists, audit row written', async () => {
    const t = await makeDeps();
    const r = await handleInteraction(call({ dept: 'software', action: 'add', tool: 'web_search' }), t.deps);
    expect(text(r)).toContain('web_search');
    expect(t.deps.cfg.get('tools.byDept').software).toContain('web_search');
    expect(t.sets.at(-1)).toMatchObject({ key: 'tools.byDept', by: 'user:u1' });
    expect(t.audits.at(-1)).toMatchObject({ action: 'bot.tools.add', tool: 'web_search', outcome: 'ok' });
    await handleInteraction(call({ dept: 'software', action: 'remove', tool: 'web_search' }), t.deps);
    expect(t.deps.cfg.get('tools.byDept').software).not.toContain('web_search');
    expect(t.audits.at(-1)).toMatchObject({ action: 'bot.tools.remove' });
  });
  it('non-admin and wrong channel refused', async () => {
    const t = await makeDeps();
    const base = { dept: 'software', action: 'add', tool: 'web_search' };
    const a = await handleInteraction(call(base, { roles: [] }), t.deps);
    expect(text(a)).toContain('Only Bot Admins');
    const b = await handleInteraction(call(base, { channelId: '5' }), t.deps);
    expect(text(b)).toContain('#⚙️-setting');
    expect(t.sets).toHaveLength(0);
  });
  it('unknown tool, unknown dept and removing an absent tool are refused', async () => {
    const t = await makeDeps();
    for (const o of [
      { dept: 'software', action: 'add', tool: 'not_a_tool' },
      { dept: 'software', action: 'add', tool: 'respond' },
      { dept: 'nowhere', action: 'add', tool: 'web_search' },
      { dept: 'software', action: 'remove', tool: 'fetch_page_x' },
    ]) {
      const r = await handleInteraction(call(o), t.deps);
      expect(r?.ephemeral, JSON.stringify(o)).toBe(true);
    }
    expect(t.sets).toHaveLength(0);
  });
});

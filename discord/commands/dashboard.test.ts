import { describe, expect, it } from 'vitest';
import { handleInteraction } from './index.js';
import { ADMIN_ROLE, interaction, makeDeps } from './test-helpers.js';

describe('/dashboard (S41)', () => {
  it('answers an admin in #setting with an ephemeral, embed-suppressed, angle-bracketed link; the defer is ephemeral too', async () => {
    const t = await makeDeps();
    t.deps.dashboard = { link: async (u) => ({ ok: true, url: `http://127.0.0.1:8787/login?t=tok-${u}` }) };
    const i = interaction({ commandName: 'dashboard', userId: 'u9' });
    const r = await handleInteraction(i, t.deps);
    expect(i.deferred).toEqual({ ephemeral: true });
    expect(r).toMatchObject({ ephemeral: true, suppressEmbeds: true });
    expect(r?.content).toContain('<http://127.0.0.1:8787/login?t=tok-u9>');
  });

  it('refuses a non-admin and another channel before the link is issued', async () => {
    const t = await makeDeps();
    let issued = 0;
    t.deps.dashboard = { link: async () => { issued++; return { ok: true, url: 'x' }; } };
    await handleInteraction(interaction({ commandName: 'dashboard', roles: [] }), t.deps);
    await handleInteraction(interaction({ commandName: 'dashboard', channelId: '123', roles: [ADMIN_ROLE] }), t.deps);
    expect(issued).toBe(0);
  });

  it('says so when the dashboard is not running, and relays the rate refusal', async () => {
    const t = await makeDeps();
    const a = await handleInteraction(interaction({ commandName: 'dashboard' }), t.deps);
    expect(a?.content).toContain('local mode');
    t.deps.dashboard = { link: async () => ({ ok: false, error: 'Too many links.' }) };
    const b = await handleInteraction(interaction({ commandName: 'dashboard' }), t.deps);
    expect(b?.content).toBe('Too many links.');
  });
});

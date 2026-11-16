import { describe, expect, it } from 'vitest';
import { handleInteraction } from './index.js';
import { cmd, makeDeps, text } from './test-helpers.js';

const row = (slug: string, status: 'active' | 'archived', bytes: number) => ({ slug, title: `T ${slug}`, createdBy: 'u', status, bytes, nmBytes: 2048, createdAt: new Date() });
const mk = async () => {
  const archived: [string, string][] = [];
  const t = await makeDeps({ ws: { list: async () => [row('chrome-kit', 'active', 5000), row('old-app', 'archived', 10)], archive: async (s, u) => { archived.push([s, u]); return s === 'chrome-kit'; } } });
  return { t, archived };
};
const set = (v: string, roles?: string[]) => cmd('settings', 'set', { strings: { key: 'ws.enabled', value: v }, ...(roles ? { roles } : {}) });

describe('WS-1: /ws', () => {
  it('list shows slug, status and bytes', async () => {
    const { t } = await mk();
    const r = await handleInteraction(cmd('ws', 'list'), t.deps);
    const s = JSON.stringify(r);
    expect(s).toContain('chrome-kit (active)');
    expect(s).toContain('old-app (archived)');
    expect(s).toContain('4.9 KiB');
    expect(r?.ephemeral).toBe(true);
  });
  it('archive audits with the slug; unknown or active-less slug is refused; bad slug never reaches the service', async () => {
    const { t, archived } = await mk();
    expect(text(await handleInteraction(cmd('ws', 'archive', { strings: { slug: 'chrome-kit' } }), t.deps))).toContain('read-only');
    expect(archived).toEqual([['chrome-kit', 'u1']]);
    expect(t.audits.at(-1)).toMatchObject({ actor: 'user:u1', action: 'ws.archive', outcome: 'chrome-kit' });
    expect(text(await handleInteraction(cmd('ws', 'archive', { strings: { slug: 'nope-app' } }), t.deps))).toContain('No active workspace');
    for (const bad of ['ab', '../etc', 'Bad Name', '1abc']) expect(text(await handleInteraction(cmd('ws', 'archive', { strings: { slug: bad } }), t.deps)), bad).toContain('3 to 40');
    expect(archived).toHaveLength(2);
  });
  it('non-admin and wrong channel are refused; no service call', async () => {
    const { t, archived } = await mk();
    expect(text(await handleInteraction(cmd('ws', 'archive', { strings: { slug: 'chrome-kit' }, roles: [] }), t.deps))).toContain('Only Bot Admins');
    expect(text(await handleInteraction(cmd('ws', 'archive', { strings: { slug: 'chrome-kit' }, channelId: '999' }), t.deps))).toContain('#⚙️-setting');
    expect(archived).toHaveLength(0);
  });
  it('without a service it says so', async () => {
    const t = await makeDeps();
    expect(text(await handleInteraction(cmd('ws', 'list'), t.deps))).toContain('not available');
  });
});

describe('WS-1: /settings ws.enabled', () => {
  it('toggles, audits, is Bot Admin only; junk and no-op refused; caps stay psql-only', async () => {
    const t = await makeDeps();
    expect(t.deps.cfg.get('ws.enabled')).toBe(false);
    expect(text(await handleInteraction(set('true', []), t.deps))).toContain('Only Bot Admins');
    await handleInteraction(set('true'), t.deps);
    expect(t.deps.cfg.get('ws.enabled')).toBe(true);
    expect(t.audits.at(-1)).toMatchObject({ action: 'config.set', tool: 'ws.enabled', outcome: 'ok' });
    expect(text(await handleInteraction(set('maybe'), t.deps))).toContain('true or false');
    expect(text(await handleInteraction(set('true'), t.deps))).toContain('No change');
    await handleInteraction(set('off'), t.deps);
    expect(t.deps.cfg.get('ws.enabled')).toBe(false);
    expect(text(await handleInteraction(cmd('settings', 'set', { strings: { key: 'ws.maxRunsPerDay', value: '9' } }), t.deps))).toContain('the owner sets the ws caps in the database');
  });
  it('turning it on posts the risk notice', async () => {
    const notes: string[] = [];
    const t = await makeDeps({ settings: { notice: async (x) => void notes.push(x), channels: async () => [] } });
    await handleInteraction(set('true'), t.deps);
    expect(notes.join(' ')).toContain('ws.enabled');
  });
});

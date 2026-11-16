import { describe, expect, it, vi } from 'vitest';
import type { ForgeCommandDeps, ForgeDetail, ForgeListItem } from '../../forge/types.js';
import { COMMANDS, handleInteraction } from './index.js';
import { cmd, makeDeps, text } from './test-helpers.js';

/** R7 PLUGIN-FORGE BE2 (spec 5.8, FG-AC23): `/forge list|show|cancel` for a live Bot Admin in #setting. No build, retry or GC command exists. */
const item = (o: Partial<ForgeListItem> = {}): ForgeListItem => ({ id: 3, ideaId: 1, ideaName: 'csvtool', deptId: 'software', status: 'live', projectId: 5, serverSlug: null, lastBuild: null, ...o });
const detail = (o: Partial<ForgeDetail> = {}): ForgeDetail => ({
  id: 3, ideaId: 1, ideaName: 'csvtool', deptId: 'software', status: 'staged', closeReason: null, projectId: 5, projectTitle: 'Proj @everyone [x](https://e.x)', projectStatus: 'active',
  releases: [{ id: 7, status: 'released' }], builds: [{ id: 9, releaseId: 7, status: 'staged', code: null, attempts: 1, image12: 'abcdef012345' }], server: { slug: 'hello', status: 'pending' }, ...o,
});
function fake(over: Partial<ForgeCommandDeps> = {}) {
  const forge: ForgeCommandDeps = {
    list: vi.fn(async () => [item(), item({ id: 2, status: 'staged', serverSlug: 'hello', lastBuild: { id: 9, status: 'staged', code: null } }), item({ id: 1, status: 'cancelled', lastBuild: { id: 4, status: 'failed', code: 'commit_failed' } })]),
    show: vi.fn(async (id: number) => (id === 3 ? detail() : null)),
    cancel: vi.fn(async () => ({ ok: true as const, serverSlug: null, serverStatus: null })),
    ...over,
  };
  return forge;
}
const mk = async (f: ForgeCommandDeps | null = fake()) => { const t = await makeDeps(f ? { forge: f } as never : {}); return t; };

describe('/forge definition', () => {
  it('has exactly list, show and cancel; show and cancel take a required id; no build, retry, gc or approve', () => {
    const c = COMMANDS.find((x) => x.name === 'forge') as unknown as { options: { name: string; options?: { name: string; required?: boolean }[] }[] };
    expect(c.options.map((o) => o.name)).toEqual(['list', 'show', 'cancel']);
    expect(c.options[1]!.options!.map((o) => [o.name, !!o.required])).toEqual([['id', true]]);
    expect(c.options[2]!.options!.map((o) => [o.name, !!o.required])).toEqual([['id', true]]);
  });
});

describe('/forge in #setting for a Bot Admin', () => {
  it('list: private, one field per forge with status, server and last build', async () => {
    const t = await mk();
    const i = cmd('forge', 'list');
    const r = await handleInteraction(i, t.deps);
    expect(i.deferred).toEqual({ ephemeral: true });
    const s = text(r);
    expect(s).toContain('#3');
    expect(s).toContain('csvtool');
    expect(s).toContain('hello');
    expect(s).toMatch(/commit.{1,4}failed/);
    expect((r as { ephemeral?: boolean }).ephemeral).toBe(true);
  });
  it('list with no forges says so', async () => {
    const t = await mk(fake({ list: async () => [] }));
    expect(text(await handleInteraction(cmd('forge', 'list'), t.deps))).toContain('No forges yet');
  });
  it('show: the detail with the project title escaped (no mention or link gets through) and the server line', async () => {
    const t = await mk();
    const s = text(await handleInteraction(cmd('forge', 'show', { numbers: { id: 3 } }), t.deps));
    expect(s).toContain('Forge #3');
    expect(s).toContain('idea #1 csvtool');
    expect(s).toContain('abcdef012345');
    expect(s).toContain('/mcp show slug:hello');
    expect(s).not.toContain('@everyone');
    expect(s).not.toContain('](https://');
    expect(text(await handleInteraction(cmd('forge', 'show', { numbers: { id: 99 } }), t.deps))).toContain('No forge with that number.');
  });
  it('cancel passes the id and the admin; the reply says it was cancelled', async () => {
    const f = fake();
    const t = await mk(f);
    const s = text(await handleInteraction(cmd('forge', 'cancel', { numbers: { id: 3 } }), t.deps));
    expect(f.cancel).toHaveBeenCalledWith({ id: 3, userId: 'u1' });
    expect(s).toContain('Forge #3 is cancelled');
  });
  it('cancel of a staged forge tells the admin the server is untouched and names /mcp disable', async () => {
    const t = await mk(fake({ cancel: async () => ({ ok: true, serverSlug: 'hello', serverStatus: 'pending' }) }));
    const s = text(await handleInteraction(cmd('forge', 'cancel', { numbers: { id: 3 } }), t.deps));
    expect(s).toContain('hello');
    expect(s).toContain('/mcp disable');
  });
  it('cancel refusals use fixed texts: busy, not_open, not_found, exception', async () => {
    for (const [code, frag] of [['busy', 'building right now'], ['not_open', 'already installed or cancelled'], ['not_found', 'No forge with that number'], ['exception', 'nothing was changed']] as const) {
      const t = await mk(fake({ cancel: async () => ({ ok: false, code }) }));
      expect(text(await handleInteraction(cmd('forge', 'cancel', { numbers: { id: 3 } }), t.deps)), code).toContain(frag);
    }
  });
  it('a missing or invalid id never reaches the closure', async () => {
    const f = fake();
    const t = await mk(f);
    for (const numbers of [{}, { id: 0 }, { id: -2 }, { id: 1.5 }] as Record<string, number>[]) text(await handleInteraction(cmd('forge', 'cancel', { numbers }), t.deps));
    expect(f.cancel).not.toHaveBeenCalled();
  });
  it('without the forge closures the commands say they are not available', async () => {
    const t = await mk(null);
    for (const [sub, o] of [['list', {}], ['show', { numbers: { id: 3 } }], ['cancel', { numbers: { id: 3 } }]] as const) expect(text(await handleInteraction(cmd('forge', sub, o), t.deps)), sub).toContain('not available');
  });
});

describe('/forge guard (FG-AC23): the same guard as /release and /mcp', () => {
  it('a non-admin, the wrong channel and another guild never reach the closures', async () => {
    const f = fake();
    const t = await mk(f);
    expect(text(await handleInteraction(cmd('forge', 'cancel', { numbers: { id: 3 }, roles: [] }), t.deps))).toContain('Only Bot Admins');
    expect(text(await handleInteraction(cmd('forge', 'cancel', { numbers: { id: 3 }, channelId: '123456789012345678' }), t.deps))).toContain('#⚙️-setting');
    expect(await handleInteraction(cmd('forge', 'cancel', { numbers: { id: 3 }, guildId: '999' }), t.deps)).toBeNull();
    expect(f.cancel).not.toHaveBeenCalled();
    expect(f.list).not.toHaveBeenCalled();
  });
});

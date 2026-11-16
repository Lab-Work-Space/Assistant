import { describe, expect, it, vi } from 'vitest';
import { makeForgeRequestPort } from './port.js';

/** R7 PLUGIN-FORGE BE2 (spec 3.3 8a-8c, 5.3): the request port composes the repo reads and the switches; it hands out nothing but those closures. */
const counts = (o: Partial<{ forgeBuilds: number; today: number; images: number }> = {}) => ({ forgeBuilds: 0, today: 0, images: 0, ...o });
const mk = (c = counts(), over: Record<string, unknown> = {}) => {
  const repo = { forgeOfProject: vi.fn(async () => ({ id: 3, status: 'live', ideaId: 1, ideaName: 'hello', deptId: 'software' })), counts: vi.fn(async () => c), slugTaken: vi.fn(async () => false), byId: vi.fn(), enqueue: vi.fn() };
  const port = makeForgeRequestPort({ repo: repo as never, enabled: () => true, mcpEnabled: () => false, baseId: `sha256:${'1'.repeat(64)}`, secrets: () => [], ...over } as never);
  return { port, repo };
};

describe('makeForgeRequestPort', () => {
  it('exposes exactly the request-time reads, the switches, the base id and the enqueue closure', () => {
    const { port } = mk();
    expect(Object.keys(port).sort()).toEqual(['baseId', 'capCode', 'enabled', 'enqueue', 'forgeOf', 'mcpEnabled', 'slugTaken']);
    expect(port.baseId).toBe(`sha256:${'1'.repeat(64)}`);
  });
  it('the switches are read at each use', () => {
    let on = true;
    const { port } = mk(counts(), { enabled: () => on, mcpEnabled: () => !on });
    expect(port.enabled()).toBe(true);
    on = false;
    expect(port.enabled()).toBe(false);
    expect(port.mcpEnabled()).toBe(true);
  });
  it('capCode follows the spec order: 3 builds of the forge, then 3 today, then 8 retained images; null below', async () => {
    expect(await mk(counts()).port.capCode(3, 'Asia/Bangkok')).toBeNull();
    expect(await mk(counts({ forgeBuilds: 3, today: 3, images: 8 })).port.capCode(3, 'UTC')).toBe('forge_attempts');
    expect(await mk(counts({ today: 3, images: 8 })).port.capCode(3, 'UTC')).toBe('forge_day_cap');
    expect(await mk(counts({ images: 8 })).port.capCode(3, 'UTC')).toBe('image_cap');
    expect(await mk(counts({ forgeBuilds: 2, today: 2, images: 7 })).port.capCode(3, 'UTC')).toBeNull();
    const { port, repo } = mk();
    await port.capCode(3, 'Asia/Bangkok');
    expect(repo.counts).toHaveBeenCalledWith(3, 'Asia/Bangkok');
  });
  it('forgeOf and slugTaken pass through', async () => {
    const { port, repo } = mk();
    expect(await port.forgeOf(5)).toMatchObject({ id: 3, ideaName: 'hello' });
    expect(repo.forgeOfProject).toHaveBeenCalledWith(5);
    expect(await port.slugTaken('hello', 3)).toBe(false);
    expect(repo.slugTaken).toHaveBeenCalledWith('hello', 3);
  });
});

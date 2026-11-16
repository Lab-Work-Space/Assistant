import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { ChannelMapRepo, DepartmentRepo, PersonaRepo, type Department, type Persona } from './org.js';

let db: TestDb;
beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'), 'up');
});
afterAll(async () => { await db.close(); });

const dept = (id: string): Department => ({ id, name: `N-${id}`, categoryNamePattern: 'p', workChannelId: 'w', color: 255, model: 'm', provider: 'anthropic', enabled: true });

describe('org repos', () => {
  it('DepartmentRepo get/list/upsert', async () => {
    const r = new DepartmentRepo(db.pool);
    await r.upsert(dept('hq'));
    await r.upsert(dept('rnd'));
    await r.upsert({ ...dept('hq'), name: 'HQ2', enabled: false, workChannelId: null });
    expect(await r.get('hq')).toEqual({ ...dept('hq'), name: 'HQ2', enabled: false, workChannelId: null });
    expect((await r.list()).map((d) => d.id)).toEqual(['hq', 'rnd']);
    expect(await r.get('zz')).toBeNull();
  });

  it('PersonaRepo get/list/upsert/delete', async () => {
    const r = new PersonaRepo(db.pool);
    const p: Persona = { id: 'a', deptId: 'hq', name: 'A', avatarUrl: null, promptRef: 'x', model: null, provider: null, tools: ['t1', 't2'], directChannelId: 'd', enabled: true };
    await r.upsert(p);
    await r.upsert({ ...p, id: 'b', deptId: 'rnd', tools: [] });
    await r.upsert({ ...p, name: 'A2', tools: ['t3'] });
    expect(await r.get('a')).toEqual({ ...p, name: 'A2', tools: ['t3'] });
    expect((await r.list()).map((x) => x.id)).toEqual(['a', 'b']);
    expect((await r.list('rnd')).map((x) => x.id)).toEqual(['b']);
    await r.delete('a');
    expect(await r.get('a')).toBeNull();
  });

  it('ChannelMapRepo get/list/upsert/delete', async () => {
    const r = new ChannelMapRepo(db.pool);
    await r.upsert({ channelId: 'c1', deptId: 'hq', isWork: false });
    await r.upsert({ channelId: 'c2', deptId: 'rnd', isWork: true });
    await r.upsert({ channelId: 'c1', deptId: 'hq', isWork: true });
    expect(await r.get('c1')).toEqual({ channelId: 'c1', deptId: 'hq', isWork: true });
    expect((await r.list()).map((x) => x.channelId)).toEqual(['c1', 'c2']);
    await r.delete('c1');
    expect(await r.get('c1')).toBeNull();
  });
});

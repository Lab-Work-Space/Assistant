import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CONFIG_DEFAULTS } from '../../config/defaults.js';
import { ConfigSchema } from '../../config/schema.js';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { MemWorkspaceRepo } from './workspaces.mem.js';
import { WorkspaceRepo } from './workspaces.js';

let db: TestDb;
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const UP = readFileSync(join(dir, '040_workspaces.up.sql'), 'utf8');
const DOWN = readFileSync(join(dir, '040_workspaces.down.sql'), 'utf8');
const UP_DATA = UP.slice(UP.indexOf('UPDATE config'));
const DOWN_DATA = DOWN.slice(DOWN.indexOf('UPDATE config'));
const WS = ['ws_create', 'ws_list', 'ws_read', 'ws_write', 'ws_delete', 'ws_run', 'ws_export'];
const USER = '12345678901234567';
const ROOT = '0a1b2c3d-0000-4000-8000-000000000001';
const ROOT2 = '0a1b2c3d-0000-4000-8000-000000000002';

beforeAll(async () => { db = await freshDb(); await migrate(db.pool, dir, 'up'); });
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  await db.pool.query('DELETE FROM workspaces');
  await db.pool.query('DELETE FROM ws_run_counts');
});

describe('WorkspaceRepo', () => {
  it('create: row defaults, get and list', async () => {
    const r = new WorkspaceRepo(db.pool);
    expect(await r.create('proj-a', 'Project A', 'head:software')).toBe('ok');
    expect(await r.get('proj-a')).toMatchObject({ slug: 'proj-a', title: 'Project A', createdBy: 'head:software', status: 'active', bytes: 0, nmBytes: 0 });
    expect(await r.get('nope')).toBeNull();
    expect((await r.list()).map((x) => x.slug)).toEqual(['proj-a']);
  });
  it('the 5-active cap holds under 12 concurrent creates: exactly 5 succeed', async () => {
    const r = new WorkspaceRepo(db.pool);
    const out = await Promise.all(Array.from({ length: 12 }, (_, i) => r.create(`ws-${String.fromCharCode(97 + i)}`, 't', 'head:software')));
    expect(out.filter((x) => x === 'ok')).toHaveLength(5);
    expect(out.filter((x) => x === 'limit')).toHaveLength(7);
    expect((await db.pool.query("SELECT count(*)::int AS n FROM workspaces WHERE status='active'")).rows[0].n).toBe(5);
  });
  it('a duplicate slug is "exists"; at the cap the answer is "limit"; an archived workspace frees a place but keeps its slug', async () => {
    const r = new WorkspaceRepo(db.pool);
    expect(await r.create('dup', 't', 'head:software')).toBe('ok');
    expect(await r.create('dup', 't', 'head:software')).toBe('exists');
    for (const s of ['bb', 'cc', 'dd', 'ee']) expect(await r.create(s, 't', 'head:software')).toBe('ok');
    expect(await r.create('ff', 't', 'head:software')).toBe('limit');
    expect(await r.archive('dup', USER)).toBe(true);
    expect(await r.archive('dup', USER)).toBe(false);
    expect(await r.create('ff', 't', 'head:software')).toBe('ok');
    expect(await r.create('dup', 't', 'head:software')).toBe('limit'); // full again
    expect(await r.archive('bb', USER)).toBe(true);
    expect(await r.create('dup', 't', 'head:software')).toBe('exists'); // an archived slug stays taken
    expect(await r.get('dup')).toMatchObject({ status: 'archived' });
  });
  it('remove deletes a row (the rollback of a failed mkdir)', async () => {
    const r = new WorkspaceRepo(db.pool);
    await r.create('gone', 't', 'head:software');
    await r.remove('gone');
    expect(await r.get('gone')).toBeNull();
    expect(await r.create('gone', 't', 'head:software')).toBe('ok');
  });
  it('the CHECK constraints refuse a bad slug, a bad creator, another dept, an inconsistent archive', async () => {
    const q = (s: string, p: unknown[]) => db.pool.query(s, p);
    await expect(q("INSERT INTO workspaces (slug, title, created_by) VALUES ('Bad', 't', 'head:software')", [])).rejects.toThrow(/check/i);
    await expect(q("INSERT INTO workspaces (slug, title, created_by) VALUES ('ok-1', 't', 'persona:x')", [])).rejects.toThrow(/check/i);
    await expect(q("INSERT INTO workspaces (slug, title, created_by, dept) VALUES ('ok-2', 't', 'head:software', 'hq')", [])).rejects.toThrow(/check/i);
    await expect(q("INSERT INTO workspaces (slug, title, created_by) VALUES ('ok-3', '', 'head:software')", [])).rejects.toThrow(/check/i);
    await q("INSERT INTO workspaces (slug, title, created_by) VALUES ('ok-4', 't', 'head:software')", []);
    await expect(q("UPDATE workspaces SET status = 'archived' WHERE slug = 'ok-4'", [])).rejects.toThrow(/check/i);
    await expect(q("UPDATE workspaces SET bytes = -1 WHERE slug = 'ok-4'", [])).rejects.toThrow(/check/i);
  });
  it('setUsage keeps nm_bytes when null', async () => {
    const r = new WorkspaceRepo(db.pool);
    await r.create('use', 't', 'head:software');
    await r.setUsage('use', 100, 500);
    await r.setUsage('use', 200, null);
    expect(await r.get('use')).toMatchObject({ bytes: 200, nmBytes: 500 });
  });
  it('claim: tree then day, a refusal rolls both back, caps below 1 refuse without a row', async () => {
    const r = new WorkspaceRepo(db.pool);
    const used = async (scope: string, key: string) => (await db.pool.query('SELECT used FROM ws_run_counts WHERE scope=$1 AND scope_key=$2', [scope, key])).rows[0]?.used ?? 0;
    expect(await r.claim(ROOT, '2026-11-10', 2, 3)).toBe('ok');
    expect(await r.claim(ROOT, '2026-11-10', 2, 3)).toBe('ok');
    expect(await r.claim(ROOT, '2026-11-10', 2, 3)).toBe('tree');
    expect(await used('tree', ROOT)).toBe(2);
    expect(await used('day', '2026-11-10')).toBe(2);
    expect(await r.claim(ROOT2, '2026-11-10', 2, 3)).toBe('ok'); // day = 3
    // day-cap refusal: the tree count of ROOT2 stays at 1 (rolled back)
    expect(await r.claim(ROOT2, '2026-11-10', 2, 3)).toBe('day');
    expect(await used('tree', ROOT2)).toBe(1);
    expect(await used('day', '2026-11-10')).toBe(3);
    expect(await r.claim(ROOT, '2026-11-11', 0, 3)).toBe('tree');
    expect(await r.claim(ROOT, '2026-11-11', 2, 0)).toBe('tree');
    expect(await used('day', '2026-11-11')).toBe(0);
  });
  it('claim: 10 concurrent claims at a tree cap of 3 give exactly 3 starts, and at a day cap of 4 exactly 4', async () => {
    const r = new WorkspaceRepo(db.pool);
    const a = await Promise.all(Array.from({ length: 10 }, () => r.claim(ROOT, '2026-12-01', 3, 100)));
    expect(a.filter((x) => x === 'ok')).toHaveLength(3);
    const b = await Promise.all(Array.from({ length: 10 }, (_, i) => r.claim(`0a1b2c3d-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`, '2026-12-02', 100, 4)));
    expect(b.filter((x) => x === 'ok')).toHaveLength(4);
  });
  it('the scope key CHECK refuses a malformed key', async () => {
    await expect(db.pool.query("INSERT INTO ws_run_counts VALUES ('tree', 'not-a-uuid', 1)")).rejects.toThrow(/check/i);
    await expect(db.pool.query("INSERT INTO ws_run_counts VALUES ('day', '2026-1-1', 1)")).rejects.toThrow(/check/i);
  });
});

describe('migration 040: tools.byDept data update (WS-C20)', () => {
  const put = async (v: unknown) => {
    await db.pool.query("INSERT INTO config (key, value, version, updated_by) VALUES ('tools.byDept', $1::jsonb, 1, 'test') ON CONFLICT (key) DO UPDATE SET value = $1::jsonb, version = 1, updated_by = 'test'", [JSON.stringify(v)]);
  };
  const get = async () => (await db.pool.query("SELECT value, version, updated_by FROM config WHERE key = 'tools.byDept'")).rows[0] as { value: Record<string, unknown>; version: number; updated_by: string };
  const names = (n: number) => Array.from({ length: n }, (_, i) => `tool_${i}`);

  it('a software list of 93 entries gets the 7 names appended (100); the schema still accepts it', async () => {
    const hq = ['web_search', 'fetch_page'];
    await put({ hq, software: names(93), marketing: ['web_search'] });
    await db.pool.query(UP_DATA);
    const r = await get();
    expect(r.value.software).toEqual([...names(93), ...WS]);
    expect(r.value.hq).toEqual(hq);
    expect(r.value.marketing).toEqual(['web_search']);
    expect(r.version).toBe(2);
    expect(r.updated_by).toBe('migration:040');
    expect(ConfigSchema['tools.byDept'].safeParse(r.value).success).toBe(true);
  });
  it('a software list of 94 (would exceed 100) is left unchanged', async () => {
    await put({ software: names(94) });
    await db.pool.query(UP_DATA);
    expect((await get()).value.software).toEqual(names(94));
  });
  it('names already present are not duplicated', async () => {
    await put({ software: ['web_search', 'ws_run', 'ws_read'] });
    await db.pool.query(UP_DATA);
    expect((await get()).value.software).toEqual(['web_search', 'ws_run', 'ws_read', 'ws_create', 'ws_list', 'ws_write', 'ws_delete', 'ws_export']);
  });
  it('an absent software key stays absent (fails closed); other departments are byte-identical', async () => {
    const before = { hq: ['web_search'], marketing: ['a', 'b'], praw: ['*x'] };
    await put(before);
    await db.pool.query(UP_DATA);
    expect((await get()).value).toEqual(before);
  });
  it('an empty object, a non-object value and a non-array software value are untouched', async () => {
    await put({});
    await db.pool.query(UP_DATA);
    expect(await get()).toMatchObject({ value: {}, version: 1, updated_by: 'test' });
    await put(['not', 'an', 'object']);
    await db.pool.query(UP_DATA);
    expect(await get()).toMatchObject({ value: ['not', 'an', 'object'], version: 1 });
    await put({ software: 'oops', hq: ['x'] });
    await db.pool.query(UP_DATA);
    expect((await get()).value).toEqual({ software: 'oops', hq: ['x'] });
  });
  it('no config row at all is fine', async () => {
    await db.pool.query("DELETE FROM config WHERE key = 'tools.byDept'");
    await db.pool.query(UP_DATA);
    await db.pool.query(DOWN_DATA);
    expect((await db.pool.query("SELECT 1 FROM config WHERE key = 'tools.byDept'")).rowCount).toBe(0);
  });
  it('up then down restores the original list (and leaves other departments alone)', async () => {
    const orig = { software: ['web_search', 'fetch_page', 'github_get_me'], hq: ['web_search'], marketing: ['image_generate'] };
    await put(orig);
    await db.pool.query(UP_DATA);
    expect((await get()).value.software).toEqual([...orig.software, ...WS]);
    await db.pool.query(DOWN_DATA);
    const r = await get();
    expect(r.value).toEqual(orig);
    expect(r.updated_by).toBe('migration:040-down');
  });
  it('down on a software list that became empty leaves an empty array, and never touches a non-array', async () => {
    await put({ software: [...WS], hq: ['x'] });
    await db.pool.query(DOWN_DATA);
    expect((await get()).value).toEqual({ software: [], hq: ['x'] });
    await put({ software: 'oops' });
    await db.pool.query(DOWN_DATA);
    expect((await get()).value).toEqual({ software: 'oops' });
  });
  it('the shipped default software list plus ws names equals the defaults (code and migration agree)', () => {
    const def = (CONFIG_DEFAULTS['tools.byDept'] as Record<string, string[]>).software!;
    expect(def.slice(-7)).toEqual(WS);
    expect(def.length).toBeLessThanOrEqual(100);
  });
});

describe('migration 040 down/up through the runner', () => {
  it('drops and recreates both tables', async () => {
    await db.pool.query(DOWN);
    expect((await db.pool.query("SELECT to_regclass('workspaces') AS a, to_regclass('ws_run_counts') AS b")).rows[0]).toEqual({ a: null, b: null });
    await db.pool.query(UP);
    expect((await db.pool.query("SELECT to_regclass('workspaces') AS a, to_regclass('ws_run_counts') AS b")).rows[0].a).not.toBeNull();
  });
});

/** Backend rule 9: the in-memory fake used by the tool unit tests and the SQL repo answer the same cases the same way. */
describe.each([['MemWorkspaceRepo', () => new MemWorkspaceRepo() as Pick<WorkspaceRepo, 'create' | 'remove' | 'get' | 'list' | 'archive' | 'setUsage' | 'claim'>], ['WorkspaceRepo', () => new WorkspaceRepo(db.pool)]])('conformance: %s', (_name, make) => {
  it('5 cap, duplicate, at-cap duplicate is "limit", archive frees a place but keeps the slug, remove frees the slug', async () => {
    const r = make();
    const out: string[] = [];
    for (const s of ['aa', 'bb', 'cc', 'dd', 'ee']) out.push(await r.create(s, 't', 'head:software'));
    out.push(await r.create('ff', 't', 'head:software')); // 6th
    out.push(await r.create('aa', 't', 'head:software')); // duplicate at the cap
    expect(out).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'limit', 'limit']);
    expect(await r.archive('aa', USER)).toBe(true);
    expect(await r.archive('aa', USER)).toBe(false);
    expect(await r.archive('zz', USER)).toBe(false);
    expect(await r.create('aa', 't', 'head:software')).toBe('exists');
    expect(await r.create('ff', 't', 'head:software')).toBe('ok');
    await r.remove('ff');
    expect(await r.get('ff')).toBeNull();
    expect(await r.create('ff', 't', 'head:software')).toBe('ok');
    expect((await r.list()).map((x) => [x.slug, x.status]).sort()).toEqual([['aa', 'archived'], ['bb', 'active'], ['cc', 'active'], ['dd', 'active'], ['ee', 'active'], ['ff', 'active']]);
    await r.setUsage('bb', 10.9, 20);
    await r.setUsage('bb', 30, null);
    expect(await r.get('bb')).toMatchObject({ bytes: 30, nmBytes: 20, status: 'active', title: 't', createdBy: 'head:software' });
  });
  it('claim: tree cap, day cap, day refusal leaves the tree count, caps below 1 refuse', async () => {
    const r = make();
    expect([await r.claim(ROOT, '2026-11-10', 2, 3), await r.claim(ROOT, '2026-11-10', 2, 3), await r.claim(ROOT, '2026-11-10', 2, 3)]).toEqual(['ok', 'ok', 'tree']);
    expect(await r.claim(ROOT2, '2026-11-10', 2, 3)).toBe('ok');
    expect(await r.claim(ROOT2, '2026-11-10', 2, 3)).toBe('day');
    expect(await r.claim(ROOT2, '2026-11-11', 2, 3)).toBe('ok'); // another day: ROOT2 had 1 used, the refused claim did not take its second slot
    expect(await r.claim(ROOT2, '2026-11-11', 2, 3)).toBe('tree'); // now it has 2
    expect(await r.claim(ROOT, '2026-11-12', 0, 3)).toBe('tree');
    expect(await r.claim(ROOT, '2026-11-12', 2, 0)).toBe('tree');
  });
});

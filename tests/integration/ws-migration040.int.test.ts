import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../../db/migrate.js';
import { freshDb, type TestDb } from '../../db/test-helpers.js';
import { ConfigSchema } from '../../config/schema.js';

/** WS-C20: the data step of migration 040 (the exact SQL of the file) on stored tools.byDept: 93 -> 7 added, 94 unchanged, absent/{}/non-array untouched, other depts byte-identical, down restores. */
const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'migrations');
const dataStep = (f: string): string => { const s = readFileSync(join(DIR, f), 'utf8'); return s.slice(s.indexOf('UPDATE config')); };
const UP = dataStep('040_workspaces.up.sql');
const DOWN = dataStep('040_workspaces.down.sql');
const WS = ['ws_create', 'ws_list', 'ws_read', 'ws_write', 'ws_delete', 'ws_run', 'ws_export'];
const names = (n: number, p = 't') => Array.from({ length: n }, (_, i) => `${p}${i}`);

let db: TestDb;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, DIR, 'up'); });
afterAll(async () => { await db.close(); });
beforeEach(async () => { await db.pool.query("DELETE FROM config WHERE key = 'tools.byDept'"); });
const seed = (v: unknown) => db.pool.query("INSERT INTO config(key, value) VALUES ('tools.byDept', $1::jsonb)", [JSON.stringify(v)]);
const get = async () => (await db.pool.query("SELECT value, version, updated_by FROM config WHERE key = 'tools.byDept'")).rows[0] as { value: Record<string, unknown>; version: number; updated_by: string } | undefined;

describe('migration 040 data step on tools.byDept (WS-C20)', () => {
  it('software with 93 entries gets exactly the 7 ws names (100 fits the schema); other departments are untouched', async () => {
    const other = { marketing: ['a', 'b'], rnd: names(5), praw: ['*'] };
    await seed({ software: names(93), ...other });
    await db.pool.query(UP);
    const r = (await get())!;
    const sw = r.value.software as string[];
    expect(sw).toHaveLength(100);
    expect(sw.slice(0, 93)).toEqual(names(93));
    expect(sw.slice(93).sort()).toEqual([...WS].sort());
    expect({ marketing: r.value.marketing, rnd: r.value.rnd, praw: r.value.praw }).toEqual(other);
    expect(r.version).toBe(2);
    expect(r.updated_by).toBe('migration:040');
    expect(ConfigSchema['tools.byDept'].safeParse(r.value).success).toBe(true);
  });
  it('94 entries stay unchanged (fails closed: no ws names; the SQL as written still bumps version, which is harmless)', async () => {
    await seed({ software: names(94), marketing: ['x'] });
    await db.pool.query(UP);
    const r = (await get())!;
    expect(r.value.software).toEqual(names(94));
    expect(r.value.marketing).toEqual(['x']);
  });
  it('a missing software key, {} and a non-array software value are untouched', async () => {
    await seed({ marketing: ['x'] });
    await db.pool.query(UP);
    expect((await get())!.value).toEqual({ marketing: ['x'] });
    await db.pool.query("DELETE FROM config WHERE key = 'tools.byDept'");
    await seed({});
    await db.pool.query(UP);
    expect((await get())!.value).toEqual({});
    expect((await get())!.version).toBe(1);
    await db.pool.query("DELETE FROM config WHERE key = 'tools.byDept'");
    await seed({ software: 'ws_run', marketing: ['x'] });
    await db.pool.query(UP);
    expect((await get())!.value).toEqual({ software: 'ws_run', marketing: ['x'] });
    await db.pool.query("DELETE FROM config WHERE key = 'tools.byDept'");
    await db.pool.query("INSERT INTO config(key, value) VALUES ('tools.byDept', '[1,2]'::jsonb)");
    await db.pool.query(UP);
    expect((await get())!.value).toEqual([1, 2]);
  });
  it('no tools.byDept row at all: no row is created', async () => {
    await db.pool.query(UP);
    expect(await get()).toBeUndefined();
  });
  it('names already present are not duplicated; running up twice adds nothing the second time', async () => {
    await seed({ software: ['x', 'ws_run'] });
    await db.pool.query(UP);
    const once = ((await get())!.value.software as string[]);
    expect(once.filter((n) => n === 'ws_run')).toHaveLength(1);
    expect([...once].sort()).toEqual(['x', ...WS].sort());
    await db.pool.query(UP);
    expect((await get())!.value.software).toEqual(once);
  });
  it('down removes exactly the 7 names and restores the original list; others byte-identical', async () => {
    const orig = { software: names(40), marketing: ['a', 'ws_run'], rnd: [] as string[] };
    await seed(orig);
    await db.pool.query(UP);
    expect((await get())!.value.software as string[]).toHaveLength(47);
    await db.pool.query(DOWN);
    const r = (await get())!;
    expect(r.value).toEqual(orig); // marketing keeps its own 'ws_run' string: down only touches software
    expect(r.updated_by).toBe('migration:040-down');
  });
  it('the up and down tables: down drops both tables, up recreates them', async () => {
    await migrate(db.pool, DIR, 'down');
    expect((await db.pool.query("SELECT to_regclass('workspaces') AS w, to_regclass('ws_run_counts') AS c")).rows[0]).toEqual({ w: null, c: null });
    await migrate(db.pool, DIR, 'up');
    expect((await db.pool.query("SELECT to_regclass('workspaces') AS w, to_regclass('ws_run_counts') AS c")).rows[0]).toEqual({ w: 'workspaces', c: 'ws_run_counts' });
  });
});

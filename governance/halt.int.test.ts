import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigStore } from '../config/store.js';
import { EventBus, type AppEvents } from '../core/events.js';
import { migrate } from '../db/migrate.js';
import { freshDb, type TestDb } from '../db/test-helpers.js';
import { TaskRepo } from '../db/index.js';
import { Halt } from './halt.js';

let db: TestDb;
const stores: ConfigStore[] = [];
beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations'), 'up');
});
afterAll(async () => { await Promise.all(stores.map((s) => s.close())); await db.close(); });

describe('Halt with real ConfigStore', () => {
  it('halt set by a second ConfigStore aborts tracked controllers', async () => {
    const a = await ConfigStore.open(db.pool, new EventBus<AppEvents>());
    const b = await ConfigStore.open(db.pool, new EventBus<AppEvents>());
    stores.push(a, b);
    const h = new Halt(a, new TaskRepo(db.pool), new EventBus<AppEvents>());
    const ac = new AbortController();
    h.track(ac);
    await b.set('halted', true, 'other');
    const t0 = Date.now();
    while (!ac.signal.aborted && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10));
    expect(ac.signal.aborted).toBe(true);
    expect(h.isHalted()).toBe(true);
  });

  // WEBGRANT-1 W-C3c: a halt by any path runs the registered hooks (the app revokes every web grant there), resume does not.
  it('psql-style config halt revokes grants; so does /halt; a hook that throws does not block the halt; resume runs no hook', async () => {
    const a = await ConfigStore.open(db.pool, new EventBus<AppEvents>());
    const b = await ConfigStore.open(db.pool, new EventBus<AppEvents>());
    stores.push(a, b);
    const h = new Halt(a, new TaskRepo(db.pool), new EventBus<AppEvents>());
    await b.set('halted', false, 'reset'); // the test above left the row true
    const wait = async (f: () => boolean) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10)); };
    await wait(() => !h.isHalted());
    let hooks = 0;
    h.onHalted(() => { hooks++; throw new Error('hook failed'); });
    h.onHalted(() => { hooks++; });
    const until = async (f: () => boolean) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 10)); };
    await b.set('halted', true, 'psql'); // another instance / a direct write: no halt.changed on this process
    await until(() => hooks >= 2);
    expect(hooks).toBe(2);
    expect(h.isHalted()).toBe(true);
    await b.set('halted', false, 'psql');
    await until(() => !h.isHalted());
    expect(hooks).toBe(2); // resume restores nothing
    await h.halt('admin'); // /halt: the same hooks, once from halt() (the watcher may add its own run)
    expect(hooks).toBeGreaterThanOrEqual(4);
    await h.resume('admin');
  });

  // G2W-02: resume runs its own hooks (the app revokes every grant that exists then)
  it('resume runs the resume hooks, after the flag is written', async () => {
    const a = await ConfigStore.open(db.pool, new EventBus<AppEvents>());
    stores.push(a);
    const h = new Halt(a, new TaskRepo(db.pool), new EventBus<AppEvents>());
    const seen: boolean[] = [];
    h.onResumed(() => { seen.push(h.isHalted()); });
    h.onResumed(() => { throw new Error('hook failed'); });
    await h.halt('admin');
    expect(seen).toEqual([]);
    await h.resume('admin');
    expect(seen).toEqual([false]);
  });
});

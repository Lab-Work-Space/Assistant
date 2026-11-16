import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LessonRepo } from '../../../db/repos/lessons.js';
import { migrate } from '../../../db/migrate.js';
import { freshDb, type TestDb } from '../../../db/test-helpers.js';
import { setup } from './test-helpers.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'db', 'migrations');
let db: TestDb;
let repo: LessonRepo;
beforeAll(async () => { db = await freshDb(); await migrate(db.pool, dir, 'up'); repo = new LessonRepo(db.pool); });
beforeEach(async () => { await db.pool.query('TRUNCATE lessons RESTART IDENTITY'); });
afterAll(async () => { await db.close(); });

describe('lesson tools against the real repo', () => {
  it('save, list and delete by id; delete_lesson only reaches the model\'s own auto lessons (SQL-level scope)', async () => {
    await repo.add({ text: 'manual', source: 'manual', authorId: 'u9', origin: 'slash' });
    await repo.add({ text: 'other auto', source: 'auto', authorId: 'persona:p1', origin: 'chat' });
    const t = setup({ repo: repo as never });
    const { reg, c } = await t.rig();
    expect((await reg.run('save_lesson', { text: 'mine' }, c)).isError).toBeFalsy();
    const mine = (await repo.list()).find((l) => l.text === 'mine')!;
    expect(mine).toMatchObject({ source: 'auto', authorId: 'head:praw', origin: 'chat', active: true });
    expect((await reg.run('delete_lesson', { id: 1 }, c)).isError).toBe(true);
    expect((await reg.run('delete_lesson', { id: 2 }, c)).isError).toBe(true);
    expect((await repo.list()).map((l) => l.text).sort()).toEqual(['manual', 'mine', 'other auto']);
    expect((await reg.run('delete_lesson', { id: mine.id }, c)).isError).toBeFalsy();
    expect(await repo.list()).toHaveLength(2);
  });

  it('confirmedOnly leaves out a model\'s own auto lessons (the other departments read only human-confirmed ones, K1)', async () => {
    await repo.add({ text: 'by a human', source: 'manual', authorId: 'u9', origin: 'slash' });
    await repo.add({ text: 'by praw', source: 'auto', authorId: 'head:praw', origin: 'chat' });
    const imp = (await repo.add({ text: 'imported', source: 'import', authorId: null, origin: 'import' }))!;
    await repo.setActive(imp.id, true);
    expect(await repo.activeTexts(1000)).toEqual(['imported', 'by praw', 'by a human']);
    expect(await repo.activeTexts(1000, { confirmedOnly: true })).toEqual(['imported', 'by a human']);
  });

  it('setActive flips the flag and reports a missing id', async () => {
    const l = (await repo.add({ text: 'imp', source: 'import', authorId: null, origin: 'import' }))!;
    expect(l.active).toBe(false);
    expect(await repo.setActive(l.id, true)).toBe(true);
    expect(await repo.activeTexts(100)).toEqual(['imp']);
    expect(await repo.setActive(l.id, false)).toBe(true);
    expect(await repo.activeTexts(100)).toEqual([]);
    expect(await repo.setActive(999, true)).toBe(false);
  });
});

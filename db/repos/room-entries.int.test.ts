import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MemRoomEntries } from '../../agents/test-helpers.js';
import { migrate } from '../migrate.js';
import { freshDb, type TestDb } from '../test-helpers.js';
import { BoardMessageRepo } from './board.js';
import { COUNTED_LIFECYCLE_KINDS, NOTE_KINDS, ROOM_LIFECYCLE_MAX, ROOM_TERMINAL_MAX, TERMINAL_KINDS, ROOM_NOTES_MAX, ROOM_RETAIN, RoomEntryRepo, type RoomEntryStore } from './room-entries.js';

let db: TestDb;
beforeAll(async () => {
  db = await freshDb();
  await migrate(db.pool, join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations'), 'up');
});
beforeEach(async () => { await db.pool.query('DELETE FROM room_entries'); });
afterAll(async () => { await db.close(); });

const e = (o: Partial<Parameters<RoomEntryStore['add']>[0]> = {}) => ({ personaId: 'p1', deptId: 'software', kind: 'assigned' as const, taskId: 't1', body: 'b', tainted: false, ...o });

/** Rule 9: the in-memory fake and the real store answer the same cases the same way. */
describe.each([['RoomEntryRepo', () => new RoomEntryRepo(db.pool)], ['MemRoomEntries', () => new MemRoomEntries()]] as const)('%s', (_n, mk) => {
  it('adds, returns the row with its taint and reads back newest-last (recent) and newest-first (last)', async () => {
    const r: RoomEntryStore = mk();
    const a = await r.add(e({ body: 'one', tainted: true }));
    await r.add(e({ body: 'two', kind: 'done' }));
    expect(a).toMatchObject({ personaId: 'p1', deptId: 'software', kind: 'assigned', taskId: 't1', body: 'one', tainted: true, messageId: null });
    expect((await r.recent(['p1'], 8)).map((x) => x.body)).toEqual(['one', 'two']);
    expect((await r.last('p1', ['done', 'assigned'], 1)).map((x) => x.body)).toEqual(['two']);
    expect(await r.recent([], 8)).toEqual([]);
  });

  it('recent reads across several personas, newest 8 only, oldest first', async () => {
    const r: RoomEntryStore = mk();
    for (let i = 0; i < 10; i++) await r.add(e({ personaId: i % 2 ? 'p1' : 'p2', taskId: `t${i}`, body: `n${i}` }));
    await r.add(e({ personaId: 'other', body: 'foreign' }));
    expect((await r.recent(['p1', 'p2'], 8)).map((x) => x.body)).toEqual(['n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9']);
  });

  it('T12: the per-task caps are counted in the store (4 lifecycle lines, 6 idea/decision lines) and refuse with null', async () => {
    const r: RoomEntryStore = mk();
    for (let i = 0; i < ROOM_LIFECYCLE_MAX; i++) expect(await r.add(e({ kind: 'blocked', body: `l${i}` }), { kinds: COUNTED_LIFECYCLE_KINDS, max: ROOM_LIFECYCLE_MAX })).not.toBeNull();
    expect(await r.add(e({ kind: 'assigned' }), { kinds: COUNTED_LIFECYCLE_KINDS, max: ROOM_LIFECYCLE_MAX })).toBeNull();
    // DEFECT-1: the terminal kinds are reserved: a full counted cap never takes the Done line, and only one terminal line per task
    expect(await r.add(e({ kind: 'done', body: 'end' }), { kinds: TERMINAL_KINDS, max: ROOM_TERMINAL_MAX })).not.toBeNull();
    expect(await r.add(e({ kind: 'cancelled' }), { kinds: TERMINAL_KINDS, max: ROOM_TERMINAL_MAX })).toBeNull();
    for (let i = 0; i < ROOM_NOTES_MAX; i++) expect(await r.add(e({ kind: i % 2 ? 'idea' : 'decision', body: `n${i}` }), { kinds: NOTE_KINDS, max: ROOM_NOTES_MAX })).not.toBeNull();
    expect(await r.add(e({ kind: 'idea' }), { kinds: NOTE_KINDS, max: ROOM_NOTES_MAX })).toBeNull();
    expect(await r.add(e({ kind: 'idea', taskId: 't2' }), { kinds: NOTE_KINDS, max: ROOM_NOTES_MAX })).not.toBeNull(); // another task has its own count
  });

  it('retention: the newest ROOM_RETAIN rows per persona survive, another persona is untouched', async () => {
    const r: RoomEntryStore = mk();
    await r.add(e({ personaId: 'keep', body: 'mine' }));
    for (let i = 0; i < ROOM_RETAIN + 5; i++) await r.add(e({ taskId: `t${i}`, body: `n${i}` }));
    const all = await r.recent(['p1'], 1000);
    expect(all).toHaveLength(ROOM_RETAIN);
    expect(all[0]!.body).toBe('n5');
    expect((await r.recent(['keep'], 10)).map((x) => x.body)).toEqual(['mine']);
  }, 30_000);

  it('setMessage stores a snowflake only', async () => {
    const r: RoomEntryStore = mk();
    const a = (await r.add(e()))!;
    await r.setMessage(a.id, 'nope');
    expect((await r.last('p1', ['assigned'], 1))[0]!.messageId).toBeNull();
    await r.setMessage(a.id, '1570000000000000001');
    expect((await r.last('p1', ['assigned'], 1))[0]!.messageId).toBe('1570000000000000001');
  });
});

describe('T8: the room board key fits board_messages (64 chars) for any persona id', () => {
  it('a key of room: + 32 hex stores and reads back', async () => {
    const key = `room:${'a'.repeat(32)}`;
    const b = new BoardMessageRepo(db.pool);
    await b.set(key, { channelId: '1570000000000000001', messageId: '1570000000000000002', digest: null });
    expect((await b.get(key))?.messageId).toBe('1570000000000000002');
    expect(key.length).toBeLessThanOrEqual(64);
  });
});

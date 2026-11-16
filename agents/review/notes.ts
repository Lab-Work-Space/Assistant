import type { DeptNoteRepo } from '../../db/repos/ledger.js';
import type { ActorRef } from '../../company/types.js';
import type { RoomEntryStore } from '../../db/repos/room-entries.js';
import type { ContextNote, RoomContextEntry } from '../../prompts/index.js';

/** Recent notes offered next to the pinned ones; assembleContext caps count, length and the knowledge budget again. */
export const CONTEXT_NOTES = 5;

/** The department's pinned notes and its newest few, oldest first so the newest fact reads last. Department scope only (K11). */
export async function deptNotesFor(notes: Pick<DeptNoteRepo, 'forContext'>, deptId: string): Promise<ContextNote[]> {
  return (await notes.forContext(deptId, CONTEXT_NOTES)).map((n) => ({ text: n.body, tainted: n.tainted, pinned: n.pinned }));
}

/** TEAMTALK-1: entries a run may read (spec OQ3): a persona its own room, a head the last 8 across its department's personas. */
export const ROOM_CONTEXT_ENTRIES = 8;

/** From the database only; a failing read means no room memory for this run, never a failed run. */
export async function roomEntriesFor(
  rooms: Pick<RoomEntryStore, 'recent'>, org: { personasOf(dept: string): { id: string }[] }, actor: ActorRef,
): Promise<RoomContextEntry[]> {
  try {
    const ids = actor.kind === 'persona' ? [actor.personaId] : org.personasOf(actor.dept).map((p) => p.id);
    return (await rooms.recent(ids, ROOM_CONTEXT_ENTRIES)).map((e) => ({ text: `${e.kind}: ${e.body}`, tainted: e.tainted }));
  } catch {
    return [];
  }
}

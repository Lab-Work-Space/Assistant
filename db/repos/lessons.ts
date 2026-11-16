import type { Pool } from '../pool.js';
import type { TaskOrigin } from './tasks.js';

export interface Lesson {
  id: number; text: string; source: 'auto' | 'manual' | 'import'; authorId: string | null; origin: TaskOrigin;
  active: boolean; legacyId: number | null; createdAt: Date; tainted: boolean;
}
/** `origin` and `authorId` are written by the creating code path (P13); imported rows always start inactive. */
export interface NewLesson {
  text: string; source: Lesson['source']; authorId: string | null; origin: TaskOrigin; legacyId?: number | null; tainted?: boolean;
}

const COLS = 'id, text, source, author_id AS "authorId", origin, active, legacy_id AS "legacyId", created_at AS "createdAt", tainted';

export class LessonRepo {
  constructor(private readonly pool: Pool) {}

  /** Null when legacyId already exists. */
  async add(l: NewLesson): Promise<Lesson | null> {
    return (await this.pool.query<Lesson>(
      `INSERT INTO lessons (text, source, author_id, origin, active, legacy_id, tainted) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (legacy_id) DO NOTHING RETURNING ${COLS}`,
      [l.text, l.source, l.authorId, l.origin, l.source !== 'import' && l.origin !== 'import', l.legacyId ?? null, l.tainted ?? false])).rows[0] ?? null;
  }

  async get(id: number): Promise<Lesson | null> {
    return (await this.pool.query<Lesson>(`SELECT ${COLS} FROM lessons WHERE id = $1`, [id])).rows[0] ?? null;
  }

  /** Knowledge cards: the text of one lesson changes; who wrote it and where from stay. */
  async updateText(id: number, text: string, tainted = false): Promise<boolean> {
    return (await this.pool.query('UPDATE lessons SET text = $2, tainted = tainted OR $3 WHERE id = $1', [id, text, tainted])).rowCount === 1;
  }

  async list(opts: { includeInactive?: boolean } = {}): Promise<Lesson[]> {
    return (await this.pool.query<Lesson>(
      `SELECT ${COLS} FROM lessons ${opts.includeInactive ? '' : 'WHERE active'} ORDER BY id DESC`)).rows;
  }

  /**
   * Admin path (isBotAdmin, PF7) passes no scope. A scope limits the DELETE itself (P13), e.g. delete_lesson passes
   * { source: 'auto', authorId: 'head:praw' } so the model can only remove lessons it wrote.
   */
  async remove(id: number, scope: { authorId?: string; source?: Lesson['source']; origin?: TaskOrigin } = {}): Promise<boolean> {
    return (await this.pool.query(
      `DELETE FROM lessons WHERE id = $1 AND ($2::text IS NULL OR author_id = $2) AND ($3::text IS NULL OR source = $3) AND ($4::text IS NULL OR origin = $4)`,
      [id, scope.authorId ?? null, scope.source ?? null, scope.origin ?? null])).rowCount === 1;
  }

  /** PF14: an imported lesson starts inactive; a Bot Admin switches it on (or off). False when the id does not exist. */
  async setActive(id: number, active: boolean): Promise<boolean> {
    return (await this.pool.query('UPDATE lessons SET active = $2 WHERE id = $1', [id, active])).rowCount === 1;
  }

  /**
   * Active lesson texts, newest first, stopping before the first that would push the total past maxChars.
   * `confirmedOnly` (K1): only untainted lessons a human wrote or switched on (`manual`, or an `import` an admin activated), never a model's own
   * `auto` lesson. Departments other than Praw read lessons this way, so a model-written lesson does not spread company-wide unreviewed.
   */
  async activeTexts(maxChars: number, o: { confirmedOnly?: boolean } = {}): Promise<string[]> {
    const rows = (await this.pool.query<{ text: string }>(`SELECT CASE WHEN tainted THEN 'UNVERIFIED: ' || text ELSE text END AS text FROM lessons WHERE active ${o.confirmedOnly ? "AND source IN ('manual', 'import') AND NOT tainted" : ''} ORDER BY id DESC`)).rows;
    const out: string[] = [];
    let used = 0;
    for (const { text } of rows) {
      if (used + text.length > maxChars) break;
      out.push(text);
      used += text.length;
    }
    return out;
  }
}

import { vi } from 'vitest';
import type { Lesson, NewLesson } from '../../../db/repos/lessons.js';
import { FakeConfig } from '../../../governance/test-helpers.js';
import type { PluginDeps } from '../deps.js';
import { webRig } from '../web/test-helpers.js';
import { lessonsGroup } from './index.js';

export const PRAW = { kind: 'head', dept: 'praw' } as const;

/** In-memory LessonRepo with the same scoped-delete semantics as the SQL (for unit tests; the int test uses the real repo). */
export function memLessons(seed: Partial<Lesson>[] = []) {
  const rows: Lesson[] = [];
  let n = 0;
  const mk = (l: Partial<Lesson>): Lesson => ({ id: ++n, text: 't', source: 'auto', authorId: null, origin: 'chat', active: true, legacyId: null, createdAt: new Date(0), tainted: false, ...l });
  for (const s of seed) rows.push(mk(s));
  return {
    rows,
    add: vi.fn(async (l: NewLesson) => { const r = mk({ ...l, active: l.source !== 'import' && l.origin !== 'import' }); rows.push(r); return r; }),
    list: vi.fn(async (o: { includeInactive?: boolean } = {}) => rows.filter((r) => o.includeInactive || r.active).sort((a, b) => b.id - a.id)),
    remove: vi.fn(async (id: number, s: { authorId?: string; source?: string; origin?: string } = {}) => {
      const i = rows.findIndex((r) => r.id === id && (!s.authorId || r.authorId === s.authorId) && (!s.source || r.source === s.source) && (!s.origin || r.origin === s.origin));
      if (i >= 0) rows.splice(i, 1);
      return i >= 0;
    }),
    setActive: vi.fn(async (id: number, active: boolean) => { const r = rows.find((x) => x.id === id); if (r) r.active = active; return !!r; }),
  };
}

export function setup(over: { cfg?: FakeConfig; repo?: ReturnType<typeof memLessons> } = {}) {
  const repo = over.repo ?? memLessons();
  const deps = { env: { guildId: 'g1' }, cfg: over.cfg ?? new FakeConfig(), log: { warn: vi.fn() }, clock: () => 0, lessons: repo } as unknown as PluginDeps;
  const g = lessonsGroup(deps);
  if ('disabled' in g) throw new Error('disabled');
  return { g, repo, rig: (c = {}) => webRig(g.tools, { actor: PRAW, direct: true, origin: 'chat', source: { channelId: 'c1', threadId: null, messageId: null, userId: 'u1', attachments: [] }, ...c }) };
}

import { DEPT_IDS, type DeptId } from '../core/env.js';
import { HANDLE_DEPTS } from './handles.js';

/**
 * Work-style §5 / Gate 1 WS12: duties are a CLOSED, code-defined enum. `create_task` checks enum membership in code; no model and no keyword
 * classifier decides it, and nothing here is read from channel topics, knowledge or model output. The default table is derived from the
 * department descriptions (prompts/heads/*.md); `duties.byDept` (config) may narrow or move duties, but only to values of this enum.
 */
export const DUTY_IDS = [
  'strategy', 'coordination', 'research', 'innovation', 'engineering', 'delivery', 'infrastructure', 'security', 'marketing', 'sales',
  'people', 'finance', 'operations', 'assistance', 'legal',
] as const;
export type DutyId = (typeof DUTY_IDS)[number];

export const isDutyId = (v: unknown): v is DutyId => typeof v === 'string' && (DUTY_IDS as readonly string[]).includes(v);

/** Default table: at most 200 characters per department when joined (checked by a test). */
export const DEFAULT_DUTIES: Readonly<Record<DeptId, readonly DutyId[]>> = {
  hq: ['strategy', 'coordination', 'legal'],
  rnd: ['research', 'innovation'],
  software: ['engineering', 'delivery'],
  it: ['infrastructure', 'security'],
  marketing: ['marketing'],
  sales: ['sales'],
  hr: ['people'],
  finance: ['finance'],
  ops: ['operations'],
  praw: ['assistance'],
};

export type DutyTable = Readonly<Record<string, readonly string[]>>;

/** The handle of a department, from the fixed handle table. */
export const handleOf = (dept: DeptId): string | null => Object.entries(HANDLE_DEPTS).find(([, d]) => d === dept)?.[0] ?? null;

/**
 * Whether `dept` owns `duty`. Null when it does: ok. Otherwise a fixed refusal assembled from code values only (the department id, the enum value
 * and the owner's handle from HANDLE_DEPTS); none of the model's title or description is ever echoed (WS12).
 */
export function dutyRefusal(table: DutyTable, dept: DeptId, duty: DutyId): string | null {
  if (table[dept]?.includes(duty)) return null;
  const owner = DEPT_IDS.find((d) => d !== dept && table[d]?.includes(duty));
  const handle = owner ? handleOf(owner) : null;
  return handle ? `department ${dept} does not own duty ${duty}; the owner is @${handle}` : `department ${dept} does not own duty ${duty}; no department owns it`;
}

/** Code-written duty lines for a head's system prompt (not wrapped content, not from any prompt file or override). */
export function dutyNote(table: DutyTable, dept: DeptId): string {
  const own = table[dept] ?? [];
  const others = DEPT_IDS.filter((d) => d !== dept && handleOf(d) && (table[d]?.length ?? 0) > 0)
    .map((d) => `@${handleOf(d)}: ${table[d]!.join(', ')}`).join('; ');
  return `Duties (a fixed list). Yours: ${own.join(', ') || 'none'}. Work outside it is handed to the owner in one line, with create_task and its duty field set to that duty. Owners: ${others}.`;
}

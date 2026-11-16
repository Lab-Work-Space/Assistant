import type { IncidentRow } from '../db/repos/dept-incidents.js';
import { SAFE_TOOL_NAME } from '../tools/skill-grant.js';
import { BUILD_CODES } from '../forge/texts.js';

/** LEARN-1 (D2, LL-C6). Fixed texts, verbatim from the spec. */
export const INCIDENTS_HEADER = 'Incidents in your department in the last 7 days (counted by code; no task text):';
export const INCIDENTS_HINT = 'If the same problem repeats, you may propose a way of working with skill_propose (it cannot grant tools or change rules).';
/** The whole block, whole lines only. */
export const INCIDENTS_MAX_CHARS = 700;
const TOOL_LINE_MAX = 5;

const KINDS = ['task_blocked', 'task_cancelled', 'tool_errors', 'heal_resolve', 'forge_failed'] as const;
/** The closed code set of each kind (LL-C6): a row outside it is dropped at render time, whatever the database says. */
export const INCIDENT_CODES: Record<(typeof KINDS)[number], readonly string[]> = {
  task_blocked: ['error', 'turns', 'owner', 'budget'],
  task_cancelled: ['cancelled'],
  heal_resolve: ['retry', 'cancel', 'refused'],
  forge_failed: BUILD_CODES,
  tool_errors: ['tool_error', 'error', 'invalid_input', 'refused', 'denied', 'approval_not_owner', 'approval_needs_task'],
};
const BLOCKED_ORDER = ['error', 'turns', 'owner', 'budget'] as const;
const HEAL_ORDER = ['retry', 'cancel', 'refused'] as const;

const validN = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= 100_000;

/**
 * The head's incident block: pure, code text only. Every row is re-validated here (kind, closed code per kind, tool name that is both well-formed and registered, 1..100000 count),
 * so a row that got into the table by any other road still cannot put free text into a prompt. Rows that fail are dropped. At most 700 characters, never contains `UNVERIFIED`;
 * no valid row (or any fault) gives ''. `isKnownTool` is the registry's own lookup.
 */
export function incidentBlock(rows: readonly IncidentRow[], isKnownTool: (name: string) => boolean): string {
  try {
    const blocked = new Map<string, number>();
    const heal = new Map<string, number>();
    const forge = new Map<string, number>();
    let cancelled = 0;
    const tools = new Map<string, { tool: string; code: string; n: number }>();
    for (const r of Array.isArray(rows) ? rows : []) {
      if (!r || typeof r !== 'object' || !validN(r.n)) continue;
      if (!(KINDS as readonly string[]).includes(r.kind) || typeof r.code !== 'string' || !INCIDENT_CODES[r.kind as IncidentRow['kind']].includes(r.code)) continue;
      if (r.kind === 'task_blocked') blocked.set(r.code, (blocked.get(r.code) ?? 0) + r.n);
      else if (r.kind === 'task_cancelled') cancelled += r.n;
      else if (r.kind === 'heal_resolve') heal.set(r.code, (heal.get(r.code) ?? 0) + r.n);
      else if (r.kind === 'forge_failed') forge.set(r.code, (forge.get(r.code) ?? 0) + r.n);
      else {
        if (typeof r.tool !== 'string' || !SAFE_TOOL_NAME.test(r.tool) || !isKnownTool(r.tool)) continue;
        const k = `${r.tool} ${r.code}`;
        const cur = tools.get(k);
        tools.set(k, { tool: r.tool, code: r.code, n: (cur?.n ?? 0) + r.n });
      }
    }
    const lines: string[] = [];
    const items = (m: Map<string, number>, order: readonly string[]) => order.filter((c) => (m.get(c) ?? 0) > 0).map((c) => `${c} ${m.get(c)}`);
    const b = items(blocked, BLOCKED_ORDER);
    if (b.length) lines.push(`- Blocked tasks: ${b.join(', ')}`);
    if (cancelled > 0) lines.push(`- Cancelled tasks: ${cancelled}`);
    const t = [...tools.values()].sort((x, y) => y.n - x.n || x.tool.localeCompare(y.tool) || x.code.localeCompare(y.code)).slice(0, TOOL_LINE_MAX);
    if (t.length) lines.push(`- Tool errors: ${t.map((x) => `${x.tool} ${x.code} ${x.n}`).join('; ')}`);
    const pf = items(forge, BUILD_CODES);
    if (pf.length) lines.push(`- Plugin builds failed: ${pf.join(', ')}`);
    const h = items(heal, HEAL_ORDER);
    if (h.length) lines.push(`- Heal decisions: ${h.join(', ')}`);
    if (!lines.length) return '';
    const all = [INCIDENTS_HEADER, ...lines, INCIDENTS_HINT];
    while (all.length > 2 && all.join('\n').length > INCIDENTS_MAX_CHARS) all.splice(all.length - 2, 1); // whole lines: the least important data line goes first, the hint stays
    let out = all.join('\n');
    if (out.length > INCIDENTS_MAX_CHARS) out = [INCIDENTS_HEADER, ...lines.slice(0, 1)].join('\n'); // cannot happen with the caps above; fail small
    return out.includes('UNVERIFIED') ? '' : out;
  } catch {
    return '';
  }
}

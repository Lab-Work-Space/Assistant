import { redactText } from '../core/logger.js';
import { HIDDEN } from '../discord/embeds/approval.js';
import { INCIDENT_CODES } from './incidents.js';
import { SAFE_TOOL_NAME } from '../tools/skill-grant.js';

/** Hard cap of the whole facts block (SA-1 §3.1). */
export const FACTS_MAX = 6000;
const TITLE_MAX = 80;
const NOTE_MAX = 200;
const SKILL_TITLE_MAX = 100;
const CODE = /^[A-Za-z0-9:_-]{1,40}$/;
const STATUSES = ['done', 'blocked', 'cancelled'] as const;
const ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Shapes of the F1-F8 result sets (GW-C5: no other source). Origin/tainted filtering is the SQL's job; the renderer renders what it gets. */
export type RetroRows = {
  counts: { status: string; n: number }[];
  titles: { status: string; title: string }[];
  toolErrors: { tool: string; outcome: string; n: number }[];
  heal: { action: string; outcome: string | null; n: number }[];
  escalations: { code: string | null; n: number }[];
  skills: { id: string; title: string; version: number }[];
  proposals: { id: number; kind: string; skillId: string; status: string }[];
  notes: { body: string }[];
  /** F9 (LEARN-1): `dept_incidents` kind, code and count; code-built, no text. */
  incidents: { kind: string; code: string; n: number }[];
};
export type RetroOpts = { dept: string; from: string; to: string; tz: string; secrets?: readonly string[] };

const CTRL_RUN = new RegExp('[\\u0000-\\u001f\\u007f\\u0085\\u2028\\u2029]+', 'g');
const n = (v: number): number => (Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0);
const tool = (s: string): string => (SAFE_TOOL_NAME.test(String(s)) ? String(s) : '?');
const code = (s: string | null | undefined): string => (s != null && CODE.test(String(s)) ? String(s) : '?');
const id = (s: string): string => (ID.test(String(s)) ? String(s) : '?');
/** Fold whitespace, strip control characters and HIDDEN, mask secrets, cut. */
const text = (s: string, max: number, secrets: readonly string[]): string =>
  redactText(String(s), secrets).replace(CTRL_RUN, ' ').replace(HIDDEN, '').replace(/\s+/g, ' ').replace(/"/g, "'").trim().slice(0, max).trim();

/** F9 (LEARN-1): `Blocked by reason: error <n>, turns <n>, owner <n>, budget <n>; cancelled <n>.` Codes go through the `code()` guard; only the four reasons are counted, any other code adds nothing to the line. */
function blockedLine(incidents: RetroRows['incidents'] | undefined): string {
  const rows = incidents ?? [];
  const by = (c: string) => rows.filter((r) => r.kind === 'task_blocked' && code(r.code) === c).reduce((a, r) => a + n(r.n), 0);
  const cancelled = rows.filter((r) => r.kind === 'task_cancelled').reduce((a, r) => a + n(r.n), 0);
  return `Blocked by reason: ${['error', 'turns', 'owner', 'budget'].map((c) => `${c} ${by(c)}`).join(', ')}; cancelled ${cancelled}.`;
}

/** Gate 2 answer 10: `Plugin builds failed: <code> <n>, ...` for the failed plugin builds of the department, each code through the closed build-code list (an unknown code adds nothing), in list order. '' when none. */
function forgeLine(incidents: RetroRows['incidents'] | undefined): string {
  const rows = (incidents ?? []).filter((r) => r.kind === 'forge_failed');
  const parts = INCIDENT_CODES.forge_failed.map((c) => ({ c, k: rows.filter((r) => r.code === c).reduce((a, r) => a + n(r.n), 0) })).filter((x) => x.k > 0).map((x) => `${x.c} ${x.k}`);
  return parts.length ? `Plugin builds failed: ${parts.join(', ')}.` : '';
}

/** Pure: the retro facts block (SA-1 §3.1 "Rendering"). Whole block is wrapped as untrusted by the caller; never logs. */
export function retroFacts(rows: RetroRows, o: RetroOpts): string {
  const sec = o.secrets ?? [];
  const sum = (pred: (r: RetroRows['heal'][number]) => boolean) => rows.heal.filter(pred).reduce((a, r) => a + n(r.n), 0);
  const count = (s: string) => rows.counts.filter((r) => r.status === s).reduce((a, r) => a + n(r.n), 0);
  const lines: string[] = [
    `Weekly retro facts for ${id(o.dept)}, ${text(o.from, 10, sec) || '?'}..${text(o.to, 10, sec) || '?'} (${text(o.tz, 40, sec) || '?'}).`,
    `Tasks: ${STATUSES.map((s) => `${s} ${count(s)}`).join(', ')}.`,
    blockedLine(rows.incidents),
    ...(forgeLine(rows.incidents) ? [forgeLine(rows.incidents)] : []),
    `Heal: retries ${sum((r) => r.action === 'task.autoretry')}, wakes ${sum((r) => r.action === 'task.heal.wake')}, decisions retry ${sum((r) => r.action === 'task.heal.resolve' && r.outcome === 'retry')}, cancel ${sum((r) => r.action === 'task.heal.resolve' && r.outcome === 'cancel')}, refused ${sum((r) => r.action === 'task.heal.resolve' && (r.outcome ?? '').startsWith('refused'))}.`,
  ];
  if (rows.titles.length) {
    lines.push('Recent task titles:');
    for (const t of rows.titles) lines.push(`- [${(STATUSES as readonly string[]).includes(t.status) ? t.status : '?'}] "${text(t.title, TITLE_MAX, sec)}"`);
  }
  if (rows.toolErrors.length) {
    lines.push('Tool errors (tool: code count):');
    // G2-GW-03: an unknown_tool row is audited under the name the MODEL chose (registry exec), not a registry name: never rendered
    for (const e of rows.toolErrors) lines.push(`- ${e.outcome === 'unknown_tool' ? '?' : tool(e.tool)}: ${code(e.outcome)} ${n(e.n)}`);
  }
  if (rows.escalations.length) lines.push(`AI approval escalations: ${rows.escalations.map((e) => `${code(e.code)} ${n(e.n)}`).join(', ')}`);
  if (rows.skills.length) {
    lines.push('Active skills:');
    for (const s of rows.skills) lines.push(`- ${id(s.id)} v${n(s.version)} "${text(s.title, SKILL_TITLE_MAX, sec)}"`);
  }
  if (rows.proposals.length) {
    lines.push('Open skill proposals:');
    for (const p of rows.proposals) lines.push(`- #${n(p.id)} ${code(p.kind)} ${id(p.skillId)} (${code(p.status)})`);
  }
  if (rows.notes.length) {
    lines.push('Recent team notes (newest first):');
    for (const t of rows.notes) lines.push(`- "${text(t.body, NOTE_MAX, sec)}"`);
  }
  // whole block <= FACTS_MAX: drop lines from the end (notes go first), whole lines only
  while (lines.length > 1 && lines.join('\n').length > FACTS_MAX) lines.pop();
  return lines.join('\n').slice(0, FACTS_MAX);
}

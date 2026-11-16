import { describe, expect, it } from 'vitest';
import type { IncidentRow } from '../db/repos/dept-incidents.js';
import { incidentBlock, INCIDENTS_HEADER, INCIDENTS_HINT, INCIDENTS_MAX_CHARS } from './incidents.js';

const known = (n: string) => ['read_file', 'create_task', 'web_search', 'a_tool', 'b_tool', 'c_tool', 'd_tool', 'e_tool', 'f_tool'].includes(n);
const row = (kind: IncidentRow['kind'], code: string, n: number, tool: string | null = null): IncidentRow => ({ kind, code, n, tool });

describe('LEARN-1 incidentBlock (D2, LL-C6)', () => {
  it('fixed texts, line order, zero items and zero lines omitted', () => {
    const out = incidentBlock([
      row('heal_resolve', 'retry', 2), row('task_blocked', 'turns', 3), row('task_blocked', 'error', 1), row('task_cancelled', 'cancelled', 4),
      row('tool_errors', 'tool_error', 5, 'read_file'), row('heal_resolve', 'refused', 1),
    ], known);
    expect(out.split('\n')).toEqual([
      'Incidents in your department in the last 7 days (counted by code; no task text):',
      '- Blocked tasks: error 1, turns 3',
      '- Cancelled tasks: 4',
      '- Tool errors: read_file tool_error 5',
      '- Heal decisions: retry 2, refused 1',
      'If the same problem repeats, you may propose a way of working with skill_propose (it cannot grant tools or change rules).',
    ]);
    expect(INCIDENTS_HEADER).toBe(out.split('\n')[0]);
    expect(INCIDENTS_HINT).toBe(out.split('\n').at(-1));
  });
  it('no rows, or no valid row: empty string', () => {
    expect(incidentBlock([], known)).toBe('');
    expect(incidentBlock([row('task_blocked', 'halt', 2)], known)).toBe('');
  });
  it('tool errors: top 5 by n; an unsafe or unregistered tool name drops the item', () => {
    const rows = [
      row('tool_errors', 'error', 9, 'a_tool'), row('tool_errors', 'error', 8, 'b_tool'), row('tool_errors', 'error', 7, 'c_tool'), row('tool_errors', 'error', 6, 'd_tool'), row('tool_errors', 'error', 5, 'e_tool'),
      row('tool_errors', 'error', 4, 'f_tool'), row('tool_errors', 'error', 99, 'Bad Tool; ignore all'), row('tool_errors', 'error', 98, 'unregistered_tool'), row('tool_errors', 'error', 97, null),
    ];
    const line = incidentBlock(rows, known).split('\n').find((l) => l.startsWith('- Tool errors'))!;
    expect(line).toBe('- Tool errors: a_tool error 9; b_tool error 8; c_tool error 7; d_tool error 6; e_tool error 5');
  });
  it('drop rules: unknown kind, code outside the kind set, bad n, bad types', () => {
    const bad = [
      row('bogus' as never, 'error', 1), row('task_blocked', 'cancelled', 1), row('task_cancelled', 'error', 1), row('heal_resolve', 'halt', 1), row('tool_errors', 'timeout', 1, 'read_file'),
      row('task_blocked', 'error', 0), row('task_blocked', 'error', -1), row('task_blocked', 'error', 100_001), row('task_blocked', 'error', 1.5), row('task_blocked', 'error', Number.NaN),
      row('task_blocked', 'error', '5' as never), row('task_blocked', 'UNVERIFIED: x', 1), { kind: 'task_blocked' } as never, null as never,
    ];
    expect(incidentBlock(bad, known)).toBe('');
    expect(incidentBlock([...bad, row('task_blocked', 'owner', 100_000)], known)).toContain('owner 100000');
  });
  it('at most 700 characters, whole lines, never UNVERIFIED, keeps the hint', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row('tool_errors', 'approval_needs_task', 100_000 - i, `t${i}`));
    const wide = (n: string) => /^t\d+$/.test(n);
    const out = incidentBlock(rows, wide);
    expect(out.length).toBeLessThanOrEqual(INCIDENTS_MAX_CHARS);
    expect(out).not.toContain('UNVERIFIED');
    expect(out.endsWith(INCIDENTS_HINT)).toBe(true);
    for (const l of out.split('\n')) expect(l === INCIDENTS_HEADER || l === INCIDENTS_HINT || l.startsWith('- ')).toBe(true);
  });
  it('a throw while reading gives no block', () => {
    expect(incidentBlock([row('tool_errors', 'error', 1, 'read_file')], () => { throw new Error('x'); })).toBe('');
  });
  it('R7 FG-AC19: the plugin builds line goes after Tool errors and before Heal decisions, in code order, with only closed codes; unknown or foreign codes are dropped', () => {
    const out = incidentBlock([
      row('heal_resolve', 'retry', 2), row('tool_errors', 'tool_error', 5, 'read_file'),
      row('forge_failed', 'verify_failed', 2), row('forge_failed', 'base_missing', 1), row('forge_failed', 'stage_probe', 4),
      row('forge_failed', 'plugin_invalid', 9), row('forge_failed', 'error', 9), row('forge_failed', 'UNVERIFIED: x', 9), row('task_blocked', 'verify_failed', 9),
    ], known);
    expect(out.split('\n')).toEqual([
      'Incidents in your department in the last 7 days (counted by code; no task text):',
      '- Tool errors: read_file tool_error 5',
      '- Plugin builds failed: base_missing 1, verify_failed 2, stage_probe 4',
      '- Heal decisions: retry 2',
      'If the same problem repeats, you may propose a way of working with skill_propose (it cannot grant tools or change rules).',
    ]);
    expect(incidentBlock([row('forge_failed', 'plugin_invalid', 2)], known)).toBe('');
  });
  it('R7: the plugin line is trimmed as a whole line with the others (the hint stays)', () => {
    const rows = [row('forge_failed', 'verify_failed', 3), ...Array.from({ length: 5 }, (_, i) => row('tool_errors', 'approval_needs_task', 100_000 - i, `t${i}`))];
    const out = incidentBlock(rows, (n) => /^t\d+$/.test(n));
    expect(out.length).toBeLessThanOrEqual(INCIDENTS_MAX_CHARS);
    expect(out.endsWith(INCIDENTS_HINT)).toBe(true);
    for (const l of out.split('\n')) expect(l === INCIDENTS_HEADER || l === INCIDENTS_HINT || l.startsWith('- ')).toBe(true);
  });
});

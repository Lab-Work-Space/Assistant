import { describe, expect, it } from 'vitest';
import { INPUT_STRING_MAX, inputFlags, buildJudgeUser } from './ai-approver-prompt.js';
import { precheckCall } from './ai-approver.js';
import { ADOPT_OUTSIDE_ORIGINS } from '../db/repos/projects.js';
import { OUTSIDE_ORIGINS } from '../agents/context.js';

/** AUTO-1 (AA-C1, SA-1 3.3): the pure functions project autopilot imports; the approver delegates to the first. */
const describeKinds = (k: Record<string, string | undefined>) => (n: string) => (Object.hasOwn(k, n) ? { kind: k[n] } : undefined);
const d = describeKinds({ web_search: 'read', fetch_page: 'read', clickup_create_task: 'write', clickup_delete_task: 'destructive', config_propose: 'write', doc_create: 'write', image_generate: 'write', kindless: undefined, write_file: 'write' });

describe('precheckCall', () => {
  it('hard-deny classes by name and input', () => {
    expect(precheckCall('', {}, d)).toBe('hard_deny:unknown');
    expect(precheckCall('nope', {}, d)).toBe('hard_deny:unknown');
    expect(precheckCall('kindless', {}, d)).toBe('hard_deny:unknown');
    expect(precheckCall('clickup_delete_task', { taskId: 'x' }, d)).toBe('hard_deny:destructive');
    expect(precheckCall('config_propose', {}, d)).toBe('hard_deny:sensitive');
    expect(precheckCall('image_generate', { prompt: 'x' }, d)).toBe('hard_deny:cost_or_lasting');
    expect(precheckCall('web_search', 'not an object', d)).toBe('hard_deny:input');
  });
  it('web_search and fetch_page heuristics', () => {
    expect(precheckCall('web_search', { query: 'weather in bangkok' }, d)).toBeNull();
    expect(precheckCall('web_search', { query: 'a'.repeat(201) }, d)).toBe('query_heuristic');
    expect(precheckCall('web_search', { query: 'x'.repeat(20) }, d)).toBe('query_heuristic');
    expect(precheckCall('web_search', { query: 'call 0123456789' }, d)).toBe('query_heuristic');
    expect(precheckCall('web_search', { query: 'mail a@b' }, d)).toBe('query_heuristic');
    expect(precheckCall('web_search', { query: 'hello literal-secret-value' }, d, ['literal-secret-value'])).toBe('query_heuristic');
    expect(precheckCall('web_search', { query: 'a​b' }, d)).toBe('query_heuristic');
    expect(precheckCall('fetch_page', { url: 'https://example.com/a?token=abcdefghijklmnopqrstuvwxyz0123456789' }, d)).toBe('url_heuristic');
    expect(precheckCall('fetch_page', { url: 'https://example.com/docs' }, d)).toBeNull();
  });
});

describe('inputFlags', () => {
  it('masked: a secret by key or by literal; inputCut: a field over the cut or nesting too deep; write_file content exempt', () => {
    expect(inputFlags('web_search', { query: 'plain words' })).toEqual({ masked: false, inputCut: false });
    expect(inputFlags('web_search', { query: 'my key is literal-secret-value ok' }, ['literal-secret-value']).masked).toBe(true);
    expect(inputFlags('clickup_create_task', { name: 'x', description: 'y'.repeat(INPUT_STRING_MAX + 1) })).toMatchObject({ inputCut: true, masked: false });
    expect(inputFlags('clickup_create_task', { name: 'x', description: 'y'.repeat(INPUT_STRING_MAX) }).inputCut).toBe(false);
    expect(inputFlags('write_file', { path: 'a.txt', content: 'z'.repeat(5000) }).inputCut).toBe(false);
    let deep: unknown = 'x';
    for (let i = 0; i < 30; i++) deep = { a: deep };
    expect(inputFlags('web_search', deep)).toMatchObject({ inputCut: true, masked: false });
  });
  it('buildJudgeUser reports the same flags (one source)', () => {
    for (const [tool, input] of [['web_search', { query: 'my key is literal-secret-value ok' }], ['clickup_create_task', { name: 'x', description: 'y'.repeat(2000) }], ['write_file', { path: 'a', content: 'z'.repeat(5000) }]] as const) {
      const j = buildJudgeUser({ tool, kind: 'write', description: 'd', requestedBy: 'head:hq', depth: 0, tainted: false, aiTree: 0, aiDay: 0, reason: 'r', title: 't', toolInput: input, secrets: ['literal-secret-value'] });
      expect({ masked: j.masked, inputCut: j.inputCut }).toEqual(inputFlags(tool, input, ['literal-secret-value']));
    }
  });
});

describe('adoption outside origins', () => {
  it('mirror the context taint list exactly', () => {
    expect([...ADOPT_OUTSIDE_ORIGINS].sort()).toEqual([...OUTSIDE_ORIGINS].sort());
  });
});

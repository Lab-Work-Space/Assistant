import { describe, expect, it, vi } from 'vitest';
import { skillToolAllowed } from '../skill-grant.js';
import { builtinTools } from './index.js';
import { PROJECT_TOOL_NAMES, projectTools } from './projects.js';

const ok = { title: 'T', goal: 'G', deadline: '2026-12-31', budget: { maxLocalCalls: 10, maxUsd: 1 } };

describe('projectTools (AUTO-1 BE2)', () => {
  const propose = vi.fn(async (): Promise<{ ok: true; id: number; text: string } | { ok: false; error: string }> => ({ ok: true, id: 3, text: 'Project proposal #3 sent' }));
  const plugin = projectTools({ projects: { propose } as never })[0] as unknown as { name: string; kind?: string; requiresApproval(): boolean; inputSchema: { safeParse(x: unknown): { success: boolean } }; run(i: unknown, c: unknown): Promise<{ content: string; isError?: boolean }> };

  it('registers exactly project_propose, kindless, never asking for approval, and not through builtinTools()', () => {
    expect([...PROJECT_TOOL_NAMES]).toEqual(['project_propose', 'project_task']);
    expect(plugin.name).toBe('project_propose');
    expect(plugin.kind).toBeUndefined();
    expect(plugin.requiresApproval()).toBe(false);
    expect(builtinTools().map((t) => t.name)).not.toContain('project_propose');
  });
  it('project_task is the second plugin: kindless, never asking, strict input', () => {
    const t = projectTools({ projects: {} as never })[1] as unknown as { name: string; kind?: string; requiresApproval(): boolean; inputSchema: { safeParse(x: unknown): { success: boolean } } };
    expect(t.name).toBe('project_task');
    expect(t.kind).toBeUndefined();
    expect(t.requiresApproval()).toBe(false);
    const p = (o: Record<string, unknown>) => t.inputSchema.safeParse({ projectId: 1, title: 'T', instruction: 'I', ...o }).success;
    expect(p({})).toBe(true);
    expect(p({ projectId: 0 })).toBe(false);
    expect(p({ title: '' })).toBe(false);
    expect(p({ title: 'x'.repeat(201) })).toBe(false);
    expect(p({ instruction: 'x'.repeat(4001) })).toBe(false);
    expect(p({ extra: 1 })).toBe(false);
  });
  it('a core builtin name cannot be granted by a skill', () => {
    const env = { registered: () => [...PROJECT_TOOL_NAMES], builtins: () => [...PROJECT_TOOL_NAMES], kindOf: () => 'write' as const };
    for (const n of PROJECT_TOOL_NAMES) expect(skillToolAllowed(n, env)).toBe(false);
  });
  it('the input is strict: bounds on title, goal, deadline format, budget, adopt; unknown keys are refused', () => {
    const p = (o: Record<string, unknown>) => plugin.inputSchema.safeParse({ ...ok, ...o }).success;
    expect(p({})).toBe(true);
    expect(p({ adopt: ['abcdef12', 'abcdef12-aaaa-bbbb-cccc-0123456789ab'] })).toBe(true);
    expect(p({ title: '' })).toBe(false);
    expect(p({ title: 'x'.repeat(101) })).toBe(false);
    expect(p({ goal: 'x'.repeat(1001) })).toBe(false);
    expect(p({ deadline: '12/31/2026' })).toBe(false);
    expect(p({ budget: { maxLocalCalls: 0, maxUsd: 1 } })).toBe(false);
    expect(p({ budget: { maxLocalCalls: 1.5, maxUsd: 1 } })).toBe(false);
    expect(p({ budget: { maxLocalCalls: 100001, maxUsd: 1 } })).toBe(false);
    expect(p({ budget: { maxLocalCalls: 1, maxUsd: 1001 } })).toBe(false);
    expect(p({ budget: { maxLocalCalls: 1, maxUsd: -1 } })).toBe(false);
    expect(p({ budget: { maxLocalCalls: 1, maxUsd: 1, extra: 1 } })).toBe(false);
    expect(p({ adopt: ['short'] })).toBe(false);
    expect(p({ adopt: ['abcdef1G'] })).toBe(false);
    expect(p({ adopt: Array(21).fill('abcdef12') })).toBe(false);
    expect(p({ extra: 1 })).toBe(false);
  });
  it('run hands the actor, the run taint and the task taint to the service and returns its text or its fixed error', async () => {
    const ctx = { actor: { kind: 'head', dept: 'hq' }, tainted: () => true, task: { tainted: false } };
    expect(await plugin.run(ok, ctx)).toEqual({ content: 'Project proposal #3 sent' });
    expect(propose).toHaveBeenCalledWith(ctx.actor, { tainted: true, task: { tainted: false } }, ok);
    propose.mockResolvedValueOnce({ ok: false, error: 'Only the CEO can propose a project.' });
    const r = await plugin.run(ok, { ...ctx, task: null });
    expect(r).toMatchObject({ content: 'Only the CEO can propose a project.', isError: true });
    expect(propose).toHaveBeenLastCalledWith(ctx.actor, { tainted: true, task: null }, ok);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { CTO, MemNotes, MemTasks, auditSpy, newBus, runCtxBase, seededOrg } from '../agents/test-helpers.js';
import { Limits } from '../governance/limits.js';
import { FakeConfig } from '../governance/test-helpers.js';
import { ToolRegistry } from './registry.js';
import type { ToolContext, ToolPlugin } from './types.js';

/** R6 MCP-1 BE2 (spec 5.8, MC-C10 register part, MC-C14 admin registry): the registry's external lookup. */
const R = 'mcp_r_ab_x';
const W = 'mcp_w_ab_y';

async function ctx(names: string[]) {
  const tasks = new MemTasks();
  const spy = auditSpy();
  const org = Object.assign(await seededOrg(), { toolsFor: () => names });
  const approvals = { needsApproval: () => false, request: vi.fn(async () => ({}) as never) };
  const c: ToolContext = { actor: CTO, task: null, ...runCtxBase(), org, tasks, approvals, limits: new Limits(new FakeConfig(), tasks), bus: newBus(), notes: new MemNotes(), audit: spy.audit };
  return { c, spy };
}
const plug = (name: string, o: Partial<ToolPlugin<Record<string, unknown>>> = {}): ToolPlugin<Record<string, unknown>> => ({
  name, description: `d ${name}`, inputSchema: z.object({ q: z.string() }).strict(), requiresApproval: () => false, kind: 'read', untrustedOutput: true, untrustedSource: 'mcp',
  run: vi.fn(async () => ({ content: 'out' })), ...o,
});
const ext = (m: Record<string, ToolPlugin<Record<string, unknown>>>) => ({ get: (n: string) => m[n], names: () => Object.keys(m) });

describe('ToolRegistry opts.external', () => {
  it('resolves an mcp_ name through exec, kindOf, describe, has, untrustedOf and specsFor; the result is wrapped as source mcp', async () => {
    const p = plug(R);
    const reg = new ToolRegistry({ halt: { isHalted: () => false }, external: ext({ [R]: p }) });
    const { c } = await ctx([R]);
    const res = await reg.run(R, { q: 'hi' }, c);
    expect(res.isError).not.toBe(true);
    expect(res.content).toContain('out');
    expect(res.content).toContain('mcp');
    expect(p.run).toHaveBeenCalledTimes(1);
    expect(reg.kindOf(R)).toBe('read');
    expect(reg.describe(R)).toEqual({ kind: 'read', description: `d ${R}` });
    expect(reg.has(R)).toBe(true);
    expect(reg.untrustedOf(R)).toBe(true);
    expect(reg.specsFor([R]).map((s) => s.name)).toEqual([R]);
  });
  it('names() stays static (never lists an external name); externalNames() lists them', () => {
    const reg = new ToolRegistry({ halt: { isHalted: () => false }, external: ext({ [R]: plug(R), [W]: plug(W) }) });
    expect(reg.names()).toEqual([]);
    expect(reg.externalNames()).toEqual([R, W]);
    expect(new ToolRegistry({ halt: { isHalted: () => false } }).externalNames()).toEqual([]);
  });
  it('register() refuses every mcp_ name, with or without external, and still accepts others', () => {
    for (const reg of [new ToolRegistry({ halt: { isHalted: () => false } }), new ToolRegistry({ halt: { isHalted: () => false }, external: ext({}) })]) {
      for (const n of [R, 'mcp_x', 'mcp_', 'mcp_R_ab_x']) expect(() => reg.register(plug(n)), n).toThrow(/mcp_/);
      expect(() => reg.register(plug('plain_tool'))).not.toThrow();
      expect(reg.names()).toEqual(['plain_tool']);
    }
  });
  it('MC-C14: a registry built without external (the admin registry) never resolves an mcp name', async () => {
    const reg = new ToolRegistry({ halt: { isHalted: () => false } });
    const { c, spy } = await ctx([R]);
    const res = await reg.run(R, { q: 'hi' }, c);
    expect(res).toMatchObject({ isError: true });
    expect(res.content).toMatch(/unknown tool/);
    expect(spy.entries.at(-1)).toMatchObject({ tool: R, outcome: 'unknown_tool' });
    expect(reg.has(R)).toBe(false);
    expect(reg.kindOf(R)).toBeUndefined();
    expect(reg.describe(R)).toBeUndefined();
    expect(reg.specsFor([R])).toEqual([]);
  });
  it('external is consulted only for mcp_ names; a static tool is never shadowed and an external get for a plain name is never asked', async () => {
    const get = vi.fn(() => plug('respond'));
    const reg = new ToolRegistry({ halt: { isHalted: () => false }, external: { get, names: () => [] } });
    reg.register(plug('respond', { description: 'static' }));
    expect(reg.describe('respond')?.description).toBe('static');
    expect(get).not.toHaveBeenCalled();
  });
  it('an external plugin whose own name differs from the asked name is not resolved', async () => {
    const reg = new ToolRegistry({ halt: { isHalted: () => false }, external: ext({ [R]: plug('mcp_r_ab_other') }) });
    expect(reg.has(R)).toBe(false);
    const { c } = await ctx([R]);
    expect((await reg.run(R, { q: 'x' }, c)).content).toMatch(/unknown tool/);
  });
  it('a throwing external lookup fails closed (unknown tool), never an exception', async () => {
    const reg = new ToolRegistry({ halt: { isHalted: () => false }, external: { get: () => { throw new Error('boom'); }, names: () => { throw new Error('boom'); } } });
    const { c } = await ctx([R]);
    expect((await reg.run(R, { q: 'x' }, c)).content).toMatch(/unknown tool/);
    expect(reg.has(R)).toBe(false);
    expect(reg.externalNames()).toEqual([]);
  });
  it('the allowlist still applies: a name outside org.toolsFor is denied before the plugin is touched', async () => {
    const p = plug(R);
    const reg = new ToolRegistry({ halt: { isHalted: () => false }, external: ext({ [R]: p }) });
    const { c, spy } = await ctx([]);
    expect((await reg.run(R, { q: 'x' }, c)).content).toMatch(/not allowed/);
    expect(spy.entries.at(-1)).toMatchObject({ outcome: 'denied' });
    expect(p.run).not.toHaveBeenCalled();
  });
  it('BE1 note: with no pin, precheck and run receive the same validated value object', async () => {
    const seen: object[] = [];
    const p = plug(R, { precheck: async (i) => { seen.push(i); return null; }, run: async (i) => { seen.push(i); return { content: 'ok' }; } });
    const reg = new ToolRegistry({ halt: { isHalted: () => false }, external: ext({ [R]: p }) });
    const { c } = await ctx([R]);
    await reg.run(R, { q: 'x' }, c);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });
});

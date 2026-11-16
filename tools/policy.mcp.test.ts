import { describe, expect, it } from 'vitest';
import { FakeConfig } from '../governance/test-helpers.js';
import { createToolPolicy } from './policy.js';

/** R6 MCP-1 BE2 (spec 5.8, MCP-AC16): every widening path drops `mcp_`; only the host's per-department grants add it, and only while `mcp.enabled` is on. */
const R = 'mcp_r_ab_x';
const W = 'mcp_w_ab_y';
const BUILTIN = ['respond'];
const PLUGINS = ['web_search', 'fetch_page'];
const mk = (o: { cfg?: FakeConfig; registered?: string[]; mcpFor?: (d: string) => readonly string[]; on?: () => unknown; kindOf?: (n: string) => 'read' | 'write' | undefined } = {}) =>
  createToolPolicy(o.cfg ?? new FakeConfig(), () => o.registered ?? [...BUILTIN, ...PLUGINS], () => BUILTIN, o.kindOf ?? (() => undefined), o.mcpFor, o.on);

describe('the policy drops mcp_ names from every widening source', () => {
  it('the praw "*", prompt meta, tools.byDept and skill tools never grant an mcp_ name, even when it is "registered"', () => {
    const p = mk({
      cfg: new FakeConfig({ 'tools.byDept': { praw: [R], software: [W] } }),
      registered: [...BUILTIN, ...PLUGINS, R, W], kindOf: () => 'read',
    });
    expect(p.effective('praw', ['*', R]).sort()).toEqual(['fetch_page', 'respond', 'web_search']);
    expect(p.effective('software', [W, 'respond'], [R, W])).not.toContain(W);
    expect(p.effective('software', [W, 'respond'], [R, W])).not.toContain(R);
    expect(p.effective('software', ['respond'], [R])).toEqual(['respond']);
  });
  it('a builtins list that contains an mcp_ name still grants nothing of it', () => {
    const p = createToolPolicy(new FakeConfig(), () => ['respond', R], () => ['respond', R]);
    expect(p.effective('praw', ['*', R])).toEqual(['respond']);
  });
});

describe('mcpFor adds the granted names when mcp.enabled is on', () => {
  it('adds the names of the department, for a head and for praw, deduped and sorted by the host', () => {
    const p = mk({ mcpFor: (d) => (d === 'software' ? [R, W, R] : d === 'praw' ? [W] : []), on: () => true });
    expect(p.effective('software', ['respond'])).toEqual(expect.arrayContaining(['respond', R, W]));
    expect(p.effective('software', ['respond']).filter((n) => n === R)).toHaveLength(1);
    expect(p.effective('praw', ['*'])).toContain(W);
    expect(p.effective('praw', ['*'])).not.toContain(R);
    expect(p.effective('hq', [])).not.toContain(R);
  });
  it('anything but exactly true is off: false, undefined, "true", 1, and a throwing read', () => {
    for (const on of [() => false, () => undefined, () => 'true', () => 1, () => { throw new Error('read'); }, undefined]) {
      const p = mk({ mcpFor: () => [R], ...(on ? { on } : {}) });
      expect(p.effective('software', ['respond']), String(on)).not.toContain(R);
    }
  });
  it('a throwing mcpFor grants nothing and leaves the rest of the list intact', () => {
    const p = mk({ mcpFor: () => { throw new Error('host'); }, on: () => true });
    expect(p.effective('software', ['respond']).sort()).toEqual(['fetch_page', 'respond', 'web_search']);
  });
  it('only well-formed external names are added (a plain name or a malformed mcp_ name from mcpFor is dropped)', () => {
    const p = mk({ mcpFor: () => ['web_search', 'clickup_delete_task', 'mcp_x', 'mcp_R_ab_x', `${R}\n`, R], on: () => true });
    const out = p.effective('software', []);
    expect(out).toContain(R);
    for (const bad of ['clickup_delete_task', 'mcp_x', 'mcp_R_ab_x', `${R}\n`]) expect(out).not.toContain(bad);
  });
  it('the registered list is not consulted for mcp names: names() may stay static', () => {
    const p = mk({ registered: ['respond'], mcpFor: () => [R], on: () => true });
    expect(p.effective('software', ['respond'])).toEqual(['respond', R]);
  });
});

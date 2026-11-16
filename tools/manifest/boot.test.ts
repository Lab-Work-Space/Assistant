import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { isNonSensitiveTool } from '../../discord/approval/approval-rooms.js';
import { precheckCall } from '../../governance/ai-approver.js';
import { isAlwaysCard } from '../autopilot.js';
import { pluginGroups, registerGroups, type GroupFactory } from '../plugins/index.js';
import type { PluginDeps } from '../plugins/deps.js';
import { ToolRegistry } from '../registry.js';
import type { ToolPlugin } from '../types.js';
import { withTestClasses } from '../../tests/fakes/tool-classes.js';
import { assertDeclared, assertRegistryDeclared, MAIN_GROUPS } from './assert.js';
import * as catalog from './catalog.js';
import { CATALOG_NAMES, DERIVED, classOf } from './catalog.js';
import { SENSITIVE_TOOL } from './floor.js';
import { FAIL_CLOSED, WRITE } from './types.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const deps = {} as PluginDeps;
const tool = (name: string, kind?: 'read' | 'write' | 'destructive'): ToolPlugin<unknown> => ({ name, description: name, ...(kind ? { kind } : {}), inputSchema: z.object({}), requiresApproval: () => false, run: async () => ({ content: 'ok' }) });
const reg = (...ts: ToolPlugin<unknown>[]): ToolRegistry => {
  const r = new ToolRegistry({ halt: { isHalted: () => false } });
  for (const t of ts) r.register(t);
  return r;
};
/** Runs `f` with a factory appended to the real `pluginGroups` (so it counts as a declared-group factory), then restores the array. */
function withPluginFactory<T>(f: GroupFactory, run: () => T): T {
  pluginGroups.push(f);
  try { return run(); } finally { pluginGroups.splice(pluginGroups.indexOf(f), 1); }
}

describe('boot refuses an undeclared or mismatched plugin tool (registerGroups, spec 3.4)', () => {
  it('a pluginGroups tool that no manifest declares throws with the manifest path, and nothing is registered', () => {
    const r = reg();
    const f: GroupFactory = () => ({ id: 'web', tools: [tool('zz_undeclared', 'read')] });
    expect(() => withPluginFactory(f, () => registerGroups(r, [f], deps))).toThrow('tool zz_undeclared in group web is not declared in tools/plugins/web/manifest.ts');
    expect(r.names()).toEqual([]);
  });
  it('a declared name under the wrong group throws', () => {
    const f: GroupFactory = () => ({ id: 'forum', tools: [tool('web_search', 'read')] });
    expect(() => withPluginFactory(f, () => registerGroups(reg(), [f], deps))).toThrow(/web_search in group forum is declared in group web/);
  });
  it('a declared name with the wrong kind throws', () => {
    const f: GroupFactory = () => ({ id: 'web', tools: [tool('web_search', 'write')] });
    expect(() => withPluginFactory(f, () => registerGroups(reg(), [f], deps))).toThrow(/web_search in group web is declared with kind read but has kind write/);
  });
  it('a declared tool with the right group and kind registers', () => {
    const r = reg();
    const f: GroupFactory = () => ({ id: 'web', tools: [tool('web_search', 'read')] });
    expect(withPluginFactory(f, () => registerGroups(r, [f], deps)).enabled).toEqual(['web']);
    expect(r.names()).toEqual(['web_search']);
  });
  it('PM-C10: a test group (not in pluginGroups) may not reuse a declared name, and any other stub name is accepted (and stays fail-closed)', () => {
    expect(() => registerGroups(reg(), [() => ({ id: 'test', tools: [tool('web_search', 'read')] })], deps)).toThrow(/reuses a declared tool name/);
    const r = reg();
    registerGroups(r, [() => ({ id: 'test', tools: [tool('stub_write', 'write')] })], deps);
    expect(r.names()).toEqual(['stub_write']);
    expect(classOf('stub_write')).toBe(FAIL_CLOSED);
  });
  it('the real pluginGroups all pass the declaration check (every tool a real group builds is declared)', async () => {
    const { realRegistry } = await import('../autopilot.golden.harness.js');
    expect((await realRegistry()).names().length).toBeGreaterThan(80);
  });
});

describe('PM-C4: the whole-registry declaration check', () => {
  it('assertDeclared passes a declared builtin and refuses an undeclared one, a wrong group and a wrong kind', () => {
    expect(() => assertDeclared(reg(tool('respond')), ['respond'], 'builtin')).not.toThrow();
    expect(() => assertDeclared(reg(tool('zz_builtin')), ['zz_builtin'], 'builtin')).toThrow(/zz_builtin in group builtin is not declared/);
    expect(() => assertDeclared(reg(tool('respond')), ['respond'], 'admin')).toThrow(/declared in group builtin but registered by group admin/);
    // a name declared under a plugin group but registered at a core site is refused (group equality, PM-C4)
    expect(() => assertDeclared(reg(tool('web_search', 'read')), ['web_search'], 'builtin')).toThrow(/declared in group web but registered by group builtin/);
    expect(() => assertDeclared(reg(tool('respond', 'write')), ['respond'], 'builtin')).toThrow(/declared with kind null but registered with kind write/);
  });
  it('assertRegistryDeclared covers every name of the registry: a stray registered tool refuses the boot unless it came from a test group', () => {
    const stray = reg(tool('respond'), tool('zz_stray'));
    expect(() => assertRegistryDeclared({ names: () => stray.names(), kindOf: (n) => stray.kindOf(n) }, MAIN_GROUPS)).toThrow(/zz_stray is registered but not declared/);
    expect(() => assertRegistryDeclared({ names: () => stray.names(), kindOf: (n) => stray.kindOf(n) }, MAIN_GROUPS, new Set(['zz_stray']))).not.toThrow(/zz_stray/);
  });
  it('the admin registry is checked against the admin group only; a plugin name there is refused', () => {
    const a = reg(tool('web_search', 'read'));
    expect(() => assertRegistryDeclared({ names: () => a.names(), kindOf: (n) => a.kindOf(n) }, ['admin'])).toThrow(/declared in group web, which this registry does not allow/);
    expect(MAIN_GROUPS).not.toContain('admin');
    expect(MAIN_GROUPS).toContain('builtin');
  });
  it('app.ts runs both checks after the last registration, and the admin one after adminRegistry.register', () => {
    const src = readFileSync(path.join(root, 'app.ts'), 'utf8');
    expect(src).toContain("assertDeclared(tools, coreToolNames, 'builtin');");
    expect(src.indexOf('const coreToolNames = [...tools.names()]')).toBeLessThan(src.indexOf('const groups = registerGroups(tools,'));
    expect(src).toContain('assertRegistryDeclared(tools, MAIN_GROUPS, testToolNames);');
    expect(src.indexOf('adminRegistry.register(t);')).toBeLessThan(src.indexOf("assertRegistryDeclared(adminRegistry, ['admin'])"));
    const lastToolsRegister = Math.max(...[...src.matchAll(/\btools\.register\(/g)].map((m) => m.index!), ...[...src.matchAll(/registerGroups\(tools,/g)].map((m) => m.index!));
    expect(src.indexOf('assertRegistryDeclared(tools, MAIN_GROUPS')).toBeGreaterThan(lastToolsRegister);
  });
  it('PM-C4: main.ts calls createApp(env) with no groups option', () => {
    const src = readFileSync(path.join(root, 'main.ts'), 'utf8');
    expect(src).toMatch(/createApp\(env\)/);
    expect(src).not.toMatch(/createApp\([^)]*groups/);
  });
});

describe('unknown names are fail-closed at every denial', () => {
  const UNKNOWN = ['mcp_x', 'stub_write', 'zz_unknown', 'schedule_zz', 'x'];
  it('classOf answers FAIL_CLOSED, which is sensitive, always a card and cost_or_lasting', () => {
    for (const n of UNKNOWN) expect(classOf(n), n).toBe(FAIL_CLOSED);
    expect(FAIL_CLOSED).toMatchObject({ sensitive: true, autopilot: 'always_card', aiReview: 'cost_or_lasting', approval: 'central', treeGrant: false });
  });
  it('isNonSensitiveTool is false, isAlwaysCard is true, and the AI reviewer hard-denies it (declared as a write)', () => {
    for (const n of UNKNOWN) {
      expect(isNonSensitiveTool(n), n).toBe(false);
      expect(isAlwaysCard(n), n).toBe(true);
      expect(precheckCall(n, {}, () => ({ kind: 'write' })), n).toBe('hard_deny:sensitive');
    }
  });
  it('an unknown name is on no grant list', () => {
    for (const n of UNKNOWN) for (const k of ['treeGrant', 'noApproval', 'botTalk', 'ownWaive'] as const) expect(DERIVED[k], `${n} ${k}`).not.toContain(n);
    for (const n of UNKNOWN) expect(Object.hasOwn(DERIVED.deptOnly, n), n).toBe(false);
  });
  it('a declared tool is non-sensitive only when it declares sensitive:false and the floor does not match; the floor wins over a declaration', () => {
    for (const n of CATALOG_NAMES) expect(isNonSensitiveTool(n), n).toBe(classOf(n).sensitive === false && !SENSITIVE_TOOL.test(n));
  });
});

describe('PM-C9: the catalog mock seam', () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (['node_modules', '.git', 'dist', 'coverage'].includes(f)) return [];
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') || p.endsWith('.mts') || p.endsWith('.js') ? [p] : [];
  });
  const ALLOWED = [
    'tests/integration/tool-approval.int.test.ts', 'tests/integration/tool-approval.batching.int.test.ts', 'tests/integration/approval-batch-app.int.test.ts', 'tests/integration/task-admin.tester.int.test.ts',
    'tests/integration/praw-schedule.int.test.ts', 'tests/integration/web-grant-acceptance.int.test.ts', 'tests/integration/approvals.int.test.ts', 'tests/integration/ai-approver.int.test.ts', 'tests/integration/tree-grant-acceptance.int.test.ts', // the last one is not in spec 5.3: PM-C10 forced it (its stubs reused declared names); see the BE2 handoff
  ];
  const all = walk(root).map((p) => path.relative(root, p));
  it('vi.mock of the catalog appears only in the allowlisted integration test files', () => {
    const mocking = all.filter((p) => p !== 'tools/manifest/boot.test.ts' && p !== 'tests/fakes/tool-classes.ts' && /vi\.mock\(\s*['"][^'"]*tools\/manifest\/catalog(?:\.js)?['"]/.test(readFileSync(path.join(root, p), 'utf8'))).sort();
    expect(mocking).toEqual([...ALLOWED].sort());
  });
  it('no vitest config or setup file mocks, imports or names the catalog or the fake', () => {
    for (const p of all.filter((f) => /^(?:vitest\.[\w.-]+|tests\/setup[\w.-]*|vitest\.setup[\w.-]*)\.(?:ts|js|mts)$/.test(f))) expect(readFileSync(path.join(root, p), 'utf8'), p).not.toMatch(/manifest\/catalog|tool-classes/);
  });
  it('no product (non-test) file imports tests/fakes/', () => {
    // the files tsconfig.build.json compiles into the product: everything except its exclude list
    const product = all.filter((p) => !p.startsWith('tests/') && !/(?:\.test|\.harness)\.ts$/.test(p) && !/(?:^|\/)(?:test-helpers|multi-helpers)\.ts$/.test(p) && !/-fixture\.ts$/.test(p) && p !== 'vitest.config.ts');
    for (const p of product) expect(readFileSync(path.join(root, p), 'utf8'), p).not.toMatch(/from\s+['"][^'"]*tests\/fakes\//);
  });
  it('withTestClasses wraps classOf only: DERIVED, the names and the digest are the real ones, and a stub never joins a list', () => {
    const w = withTestClasses(catalog, { stub_write: { ...WRITE, sensitive: false, group: 'test' } });
    expect(w.classOf('stub_write')).toMatchObject({ sensitive: false, group: 'test', treeGrant: false });
    expect(w.classOf('web_search')).toBe(classOf('web_search'));
    expect(w.classOf('zz_other')).toBe(FAIL_CLOSED);
    expect(w.DERIVED).toBe(DERIVED);
    expect(w.CATALOG_NAMES).toBe(CATALOG_NAMES);
    expect(w.CATALOG_DIGEST).toBe(catalog.CATALOG_DIGEST);
    for (const k of ['treeGrant', 'noApproval', 'botTalk', 'ownWaive', 'alwaysCard', 'moneyDoc', 'costOrLasting'] as const) expect(w.DERIVED[k]).not.toContain('stub_write');
  });
  it('withTestClasses refuses a declared name, a floor-matching name and an mcp_ name', () => {
    const c = { ...WRITE, sensitive: false, group: 'test' };
    expect(() => withTestClasses(catalog, { web_search: c })).toThrow(/declared in the catalog/);
    expect(() => withTestClasses(catalog, { github_zz: c })).toThrow(/sensitive floor/);
    expect(() => withTestClasses(catalog, { mcp_zz: c })).toThrow(/mcp_/);
  });
});

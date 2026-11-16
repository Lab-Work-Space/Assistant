import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADMIN_TOOL_NAMES } from '../../admin/names.js';
import { SENSITIVE_TOOL as ROOMS_SENSITIVE_TOOL, isNonSensitiveTool } from '../../discord/approval/approval-rooms.js';
import { COST_OR_LASTING_TOOLS, MONEY_DOC_TOOLS } from '../../governance/ai-approver.js';
import { AUTOPILOT_ALWAYS_CARD, AUTOPILOT_OWN_WAIVE, isAlwaysCard } from '../autopilot.js';
import { CLICKUP_WORKSPACE_WRITE_NAMES } from '../plugins/clickup/workspace-write.js';
import { DEPT_ONLY } from '../policy.js';
import { BOT_TALK_TOOLS, NO_APPROVAL_TOOLS } from '../policy-approval.js';
import { TREE_GRANT_TOOLS } from '../tree-grant-tools.js';
import * as catalogModule from './catalog.js';
import { CATALOG_DIGEST, CATALOG_NAMES, DERIVED, EXTERNAL_PREFIX, buildCatalog, classOf } from './catalog.js';
import { MCP_NAME, MCP_READ, MCP_WRITE, mcpClassOf } from './external.js';
import { SENSITIVE_TOOL } from './floor.js';
import { DESTRUCTIVE, FAIL_CLOSED, NOKIND, READ, WRITE, defineManifest, type ManifestEntry, type ToolClass } from './types.js';

const root = new URL('../../', import.meta.url);
const privileged = JSON.parse(readFileSync(new URL('tools/manifest/privileged.json', root), 'utf8')) as Record<string, unknown>;
const matrix = JSON.parse(readFileSync(new URL('tools/__golden__/decision-matrix.json', root), 'utf8')) as Record<string, unknown>;
const sorted = (a: readonly string[]): string[] => [...a].sort();

describe('PM-C2 (i): every DERIVED view equals privileged.json (the reviewed membership file) and the consumer constants are those views', () => {
  it('each derived list deep-equals privileged.json', () => {
    for (const k of ['treeGrant', 'noApproval', 'botTalk', 'ownWaive', 'alwaysCard', 'moneyDoc', 'costOrLasting'] as const) expect(DERIVED[k], k).toEqual(privileged[k]);
    expect(DERIVED.deptOnly).toEqual(privileged['deptOnly']);
    expect(Object.keys(DERIVED.deptOnly)).toEqual(Object.keys(privileged['deptOnly'] as object));
  });
  it('privileged.json is sorted, and its key set is exactly the derived views plus sensitiveFalse', () => {
    expect(Object.keys(privileged).sort()).toEqual(['alwaysCard', 'botTalk', 'costOrLasting', 'deptOnly', 'moneyDoc', 'noApproval', 'ownWaive', 'sensitiveFalse', 'treeGrant']);
    for (const [k, v] of Object.entries(privileged)) if (Array.isArray(v)) expect(v, k).toEqual(sorted(v as string[]));
  });
  it('BE2: every consumer constant IS the derived view (same frozen array/object), so the old literals live only in privileged.json and the decision matrix', () => {
    expect(TREE_GRANT_TOOLS).toBe(DERIVED.treeGrant);
    expect(NO_APPROVAL_TOOLS).toBe(DERIVED.noApproval);
    expect(BOT_TALK_TOOLS).toBe(DERIVED.botTalk);
    expect(AUTOPILOT_OWN_WAIVE).toBe(DERIVED.ownWaive);
    expect(AUTOPILOT_ALWAYS_CARD).toBe(DERIVED.alwaysCard);
    expect(MONEY_DOC_TOOLS).toBe(DERIVED.moneyDoc);
    expect(COST_OR_LASTING_TOOLS).toBe(DERIVED.costOrLasting);
    expect(DEPT_ONLY).toBe(DERIVED.deptOnly);
    for (const l of [TREE_GRANT_TOOLS, NO_APPROVAL_TOOLS, BOT_TALK_TOOLS, AUTOPILOT_OWN_WAIVE, AUTOPILOT_ALWAYS_CARD, MONEY_DOC_TOOLS, COST_OR_LASTING_TOOLS, DEPT_ONLY]) expect(Object.isFrozen(l)).toBe(true);
    expect(DERIVED.costOrLasting.filter((n) => n.startsWith('schedule_'))).toEqual(['schedule_add', 'schedule_list', 'schedule_remove']);
  });
});

describe('CATALOG_DIGEST (R5 reads it)', () => {
  const fields = (c: ToolClass) => ({ aiReview: c.aiReview, approval: c.approval, autopilot: c.autopilot, deptOnly: c.deptOnly, group: c.group, kind: c.kind, sensitive: c.sensitive, treeGrant: c.treeGrant });
  // R6: the canonical array ends with one final element, the two external profiles (keys in the existing order)
  const canonical = (names: readonly string[], of: (n: string) => ToolClass): string => JSON.stringify([...names.map((n) => [n, fields(of(n))]), ['@external', { r: fields(MCP_READ), w: fields(MCP_WRITE) }]]);
  it('is the sha256 of the canonical, name-sorted JSON of every declared class, recomputed here from classOf alone', () => {
    expect(CATALOG_DIGEST).toMatch(/^[0-9a-f]{64}$/);
    expect(CATALOG_DIGEST).toBe(createHash('sha256').update(canonical(sorted(CATALOG_NAMES), classOf)).digest('hex'));
  });
  it('changes when any one field of any one entry changes, and when a name is added or removed; is independent of manifest order', () => {
    const base = { a_tool: { ...WRITE, sensitive: false }, b_tool: { ...READ, sensitive: false } };
    const d = (m: Record<string, ManifestEntry>, g = 'g'): string => buildCatalog([defineManifest(g, m)]).digest;
    const ref = d(base);
    expect(d({ ...base, a_tool: { ...base.a_tool, sensitive: true } })).not.toBe(ref);
    expect(d({ ...base, a_tool: { ...base.a_tool, treeGrant: true } })).not.toBe(ref);
    expect(d({ ...base, a_tool: { ...base.a_tool, aiReview: 'cost_or_lasting' } })).not.toBe(ref);
    expect(d({ ...base, a_tool: { ...base.a_tool, autopilot: 'always_card' } })).not.toBe(ref);
    expect(d({ ...base, a_tool: { ...base.a_tool, deptOnly: 'software' } })).not.toBe(ref);
    expect(d({ ...base, a_tool: { ...base.a_tool, kind: 'destructive' } })).not.toBe(ref);
    expect(d(base, 'other')).not.toBe(ref);
    expect(d({ a_tool: base.a_tool })).not.toBe(ref);
    expect(buildCatalog([defineManifest('g', { b_tool: base.b_tool }), defineManifest('g', { a_tool: base.a_tool })]).digest).toBe(ref);
  });
});

describe('PM-C3: sensitivity', () => {
  it('privileged.sensitiveFalse is exactly the catalog names declared sensitive:false', () => {
    expect(sorted(CATALOG_NAMES.filter((n) => !classOf(n).sensitive))).toEqual(privileged['sensitiveFalse']);
  });
  it('the floor implies sensitive for every name (V4), and for every name that existed at 6e85f0f sensitive equals the floor', () => {
    for (const n of CATALOG_NAMES) if (SENSITIVE_TOOL.test(n)) expect(classOf(n).sensitive, n).toBe(true);
    for (const n of Object.keys(matrix)) if (CATALOG_NAMES.includes(n)) expect(classOf(n).sensitive, n).toBe(SENSITIVE_TOOL.test(n));
  });
  it('domain: ADMIN names and the B7 sample names are sensitive, except discord_read', () => {
    for (const n of ADMIN_TOOL_NAMES) expect(isNonSensitiveTool(n), n).toBe(n === 'discord_read');
    for (const n of ['github_create_issue', 'devjob_start', 'code_edit', 'deploy_site', 'site_publish', 'knowledge_edit', 'prompt_set', 'config_set', 'admin_op', 'perm_apply', 'server_create_channel', 'mod_timeout', 'moderate_user', 'ban_member', 'kick_member', 'welcome_set', 'save_lesson', 'delete_lesson', 'GITHUB_X']) expect(isNonSensitiveTool(n), n).toBe(false);
  });
  it('the floor is the same object the rooms module re-exports, and it is frozen and still works', () => {
    expect(ROOMS_SENSITIVE_TOOL).toBe(SENSITIVE_TOOL);
    expect(Object.isFrozen(SENSITIVE_TOOL)).toBe(true);
    expect(() => { (SENSITIVE_TOOL as unknown as { test: unknown }).test = () => false; }).toThrow();
    expect(() => { (SENSITIVE_TOOL as unknown as Record<string, unknown>)['source'] = 'x'; }).toThrow();
    expect(Object.keys(SENSITIVE_TOOL)).toEqual(['test']);
    expect((SENSITIVE_TOOL as unknown as { compile?: unknown }).compile).toBeUndefined();
    expect((SENSITIVE_TOOL as unknown as { source?: unknown }).source).toBeUndefined();
    expect(SENSITIVE_TOOL.test('GITHUB_x')).toBe(true);
    expect(SENSITIVE_TOOL.test('github_x')).toBe(true);
    expect(SENSITIVE_TOOL.test('web_search')).toBe(false);
  });
});

describe('PM-C6 / PM-C7: admin and ClickUp bindings', () => {
  it('every ADMIN_TOOL_NAMES name is in the catalog with group admin, and every admin entry is in ADMIN_TOOL_NAMES', () => {
    for (const n of ADMIN_TOOL_NAMES) expect(classOf(n).group, n).toBe('admin');
    expect(sorted(CATALOG_NAMES.filter((n) => classOf(n).group === 'admin'))).toEqual(sorted(ADMIN_TOOL_NAMES));
  });
  it('the clickup entries declared own_waive are exactly CLICKUP_WORKSPACE_WRITE_NAMES', () => {
    expect(sorted(CATALOG_NAMES.filter((n) => classOf(n).group === 'clickup' && classOf(n).autopilot === 'own_waive'))).toEqual(sorted(CLICKUP_WORKSPACE_WRITE_NAMES));
  });
});

describe('catalog basics', () => {
  it('names are sorted and unique; the digest is 64 hex and stable across builds', () => {
    expect(CATALOG_NAMES).toEqual(sorted(CATALOG_NAMES));
    expect(new Set(CATALOG_NAMES).size).toBe(CATALOG_NAMES.length);
    expect(CATALOG_DIGEST).toMatch(/^[0-9a-f]{64}$/);
    expect(EXTERNAL_PREFIX).toBe('mcp_');
  });
  it('an unknown name gets FAIL_CLOSED (sensitive, always a card, hard-denied by the reviewer)', () => {
    for (const n of ['zz_unknown', 'stub_write', 'mcp_x', '', '__proto__', 'constructor', 'toString']) expect(classOf(n), n).toBe(FAIL_CLOSED);
    expect(FAIL_CLOSED).toEqual({ group: '', kind: null, sensitive: true, approval: 'central', deptOnly: null, treeGrant: false, autopilot: 'always_card', aiReview: 'cost_or_lasting' });
  });
  it('a few entries are the plain preset, and the privileged ones differ from it exactly as listed', () => {
    expect(classOf('fetch_page')).toEqual({ group: 'web', ...READ, sensitive: false, autopilot: 'own_waive' });
    expect(classOf('clickup_delete_task')).toEqual({ group: 'clickup', ...DESTRUCTIVE, sensitive: false });
    expect(classOf('create_task')).toEqual({ group: 'builtin', ...NOKIND, sensitive: false });
  });
});

describe('PM-C1: the class source can not be changed', () => {
  const snapshot = () => JSON.stringify({ all: CATALOG_NAMES.map((n) => classOf(n)), unknown: classOf('zz_unknown'), derived: DERIVED, names: CATALOG_NAMES, digest: CATALOG_DIGEST, presets: [READ, WRITE, DESTRUCTIVE, NOKIND, FAIL_CLOSED] });
  it('no export is a Map, and every reachable object is frozen', () => {
    for (const [k, v] of Object.entries(catalogModule)) expect(v instanceof Map, k).toBe(false);
    for (const n of CATALOG_NAMES) expect(Object.isFrozen(classOf(n)), n).toBe(true);
    for (const o of [FAIL_CLOSED, READ, WRITE, DESTRUCTIVE, NOKIND, DERIVED, DERIVED.deptOnly, CATALOG_NAMES, ...Object.values(DERIVED).filter(Array.isArray)]) expect(Object.isFrozen(o)).toBe(true);
  });
  it('set, delete, define and prototype writes on every reachable object throw (strict mode) and nothing changes', () => {
    const before = snapshot();
    const entry = classOf('pin_message') as { -readonly [K in keyof ToolClass]: ToolClass[K] };
    const attempts: (() => unknown)[] = [
      () => { entry.sensitive = true; },
      () => { entry.treeGrant = false; },
      () => { delete (entry as unknown as Record<string, unknown>)['group']; },
      () => Object.defineProperty(entry, 'approval', { value: 'no_approval' }),
      () => Object.defineProperty(entry, 'extra', { value: 1 }),
      () => Object.setPrototypeOf(entry, null),
      () => { (classOf('zz_unknown') as { sensitive: boolean }).sensitive = false; },
      () => { (FAIL_CLOSED as { autopilot: string }).autopilot = 'default'; },
      () => { delete (FAIL_CLOSED as unknown as Record<string, unknown>)['sensitive']; },
      () => { (READ as { approval: string }).approval = 'bot_talk'; },
      () => { (WRITE as { treeGrant: boolean }).treeGrant = true; },
      () => { (DERIVED as unknown as { treeGrant: string[] }).treeGrant = []; },
      () => (DERIVED.treeGrant as string[]).push('evil_tool'),
      () => { (DERIVED.noApproval as string[])[0] = 'evil_tool'; },
      () => (DERIVED.ownWaive as string[]).pop(),
      () => (DERIVED.alwaysCard as string[]).length = 0,
      () => (DERIVED.costOrLasting as string[]).sort(),
      () => { (DERIVED.deptOnly as Record<string, string>)['evil_tool'] = 'software'; },
      () => { delete (DERIVED.deptOnly as Record<string, string>)['ws_run']; },
      () => (CATALOG_NAMES as string[]).push('evil_tool'),
      () => { (catalogModule as unknown as { classOf: unknown }).classOf = () => FAIL_CLOSED; },
      () => { (catalogModule as unknown as { DERIVED: unknown }).DERIVED = {}; },
    ];
    for (const [i, a] of attempts.entries()) expect(a, `attempt ${i}`).toThrow();
    expect(snapshot()).toBe(before);
    expect(classOf('zz_unknown')).toEqual({ group: '', kind: null, sensitive: true, approval: 'central', deptOnly: null, treeGrant: false, autopilot: 'always_card', aiReview: 'cost_or_lasting' });
    expect(classOf('pin_message').treeGrant).toBe(true);
  });
  it('a built catalog keeps its own copy: changing the input manifest later changes nothing', () => {
    const m = { a_tool: { group: 'g', ...WRITE, sensitive: false } } as Record<string, ToolClass>;
    const c = buildCatalog([m]);
    (m['a_tool'] as { treeGrant: boolean }).treeGrant = true;
    expect(c.classOf('a_tool').treeGrant).toBe(false);
    expect(c.derived.treeGrant).toEqual([]);
  });
  it('defineManifest freezes its result and every entry', () => {
    const m = defineManifest('g', { a_tool: { ...READ, sensitive: false } });
    expect(Object.isFrozen(m)).toBe(true);
    expect(Object.isFrozen(m['a_tool'])).toBe(true);
    expect(() => { (m as Record<string, unknown>)['b_tool'] = {}; }).toThrow();
  });
});

describe('PM-C12: no setter', () => {
  it('catalog.ts exports exactly the read-only API; no exported name sounds like a mutator and no export touches module state', () => {
    expect(Object.keys(catalogModule).sort()).toEqual(['CATALOG_DIGEST', 'CATALOG_NAMES', 'DERIVED', 'EXTERNAL_PREFIX', 'buildCatalog', 'classOf']);
    const src = readFileSync(new URL('tools/manifest/catalog.ts', root), 'utf8');
    expect(src.match(/^export (?:async )?function \w+/gm)).toEqual(['export function buildCatalog']);
    expect(src).not.toMatch(/export\s+(?:let|var)\b/);
    expect(src).not.toMatch(/\b(?:setClass|register|extend|override|install|mutate)\w*\s*[=(]/);
  });
  it('buildCatalog returns an independent catalog and never touches the module one', () => {
    const before = CATALOG_DIGEST;
    const c = buildCatalog([defineManifest('g', { a_tool: { ...WRITE, sensitive: false, treeGrant: true } })]);
    expect(c.classOf('a_tool').treeGrant).toBe(true);
    expect(classOf('a_tool')).toBe(FAIL_CLOSED);
    expect(DERIVED.treeGrant).not.toContain('a_tool');
    expect(CATALOG_DIGEST).toBe(before);
  });
});

describe('load-time validation V1 to V10 (a failure throws)', () => {
  const E = (o: Partial<ManifestEntry>): ManifestEntry => ({ ...WRITE, sensitive: false, ...o });
  const one = (name: string, o: Partial<ManifestEntry>, group = 'g') => () => buildCatalog([defineManifest(group, { [name]: E(o) })]);
  it('accepts a plain entry', () => expect(one('a_tool', {})).not.toThrow());
  it('V1: bad names', () => {
    for (const n of ['A_tool', '1tool', '_tool', 'a-tool', 'a tool', 'a'.repeat(65), '', 'tool.x', 'tool\n']) expect(one(n, {}), JSON.stringify(n)).toThrow(/V1/);
    expect(one('a'.repeat(64), {})).not.toThrow();
  });
  it('V2: a name declared twice across manifests', () => {
    const a = defineManifest('g1', { dup_tool: E({}) });
    const b = defineManifest('g2', { dup_tool: E({}) });
    expect(() => buildCatalog([a, b])).toThrow(/dup_tool V2/);
  });
  it('V3: the mcp_ prefix', () => expect(one('mcp_thing', {})).toThrow(/V3/));
  it('V4: sensitive:false for a floor name', () => {
    expect(one('github_new', {})).toThrow(/V4/);
    expect(one('skill_new', {})).toThrow(/V4/);
    expect(one('github_new', { sensitive: true })).not.toThrow();
    expect(one('plain_new', { sensitive: true })).not.toThrow();
  });
  it('V5: treeGrant needs write, not sensitive, central, non-admin', () => {
    expect(one('a_tool', { treeGrant: true })).not.toThrow();
    expect(one('a_tool', { ...READ, treeGrant: true })).toThrow(/V5/);
    expect(one('a_tool', { ...DESTRUCTIVE, treeGrant: true })).toThrow(/V5/);
    expect(one('a_tool', { ...NOKIND, treeGrant: true })).toThrow(/V5/);
    expect(one('a_tool', { treeGrant: true, sensitive: true })).toThrow(/V5/);
    expect(one('a_tool', { treeGrant: true, approval: 'no_approval' })).toThrow(/V[56]/);
    expect(one('a_tool', { treeGrant: true }, 'admin')).toThrow(/V5/);
  });
  it('V6: a non-central approval needs write, sensitive:false and no treeGrant', () => {
    for (const approval of ['no_approval', 'bot_talk'] as const) {
      expect(one('a_tool', { approval })).not.toThrow();
      expect(one('a_tool', { ...READ, approval })).toThrow(/V6/);
      expect(one('a_tool', { ...DESTRUCTIVE, approval })).toThrow(/V6/);
      expect(one('a_tool', { ...NOKIND, approval })).toThrow(/V6/);
      expect(one('a_tool', { approval, sensitive: true })).toThrow(/V6/);
      expect(one('a_tool', { approval, treeGrant: true })).toThrow(/V[56]/);
    }
  });
  it('V7: own_waive needs a kind and sensitive:false', () => {
    expect(one('a_tool', { autopilot: 'own_waive' })).not.toThrow();
    expect(one('a_tool', { autopilot: 'own_waive', sensitive: true })).toThrow(/V7/);
    expect(one('a_tool', { ...NOKIND, autopilot: 'own_waive' })).toThrow(/V7/);
    expect(one('a_tool', { autopilot: 'always_card', sensitive: true })).not.toThrow();
  });
  it('V8: deptOnly is null or a non-empty string', () => {
    expect(one('a_tool', { deptOnly: 'software' })).not.toThrow();
    expect(one('a_tool', { deptOnly: '' })).toThrow(/V8/);
    expect(one('a_tool', { deptOnly: 5 as never })).toThrow(/V8/);
    expect(one('a_tool', { deptOnly: undefined as never })).toThrow(/V8/);
  });
  it('V9: schedule_ names need cost_or_lasting', () => {
    expect(one('schedule_x', {})).toThrow(/V9/);
    expect(one('schedule_x', { aiReview: 'money_doc' })).toThrow(/V9/);
    expect(one('schedule_x', { aiReview: 'cost_or_lasting' })).not.toThrow();
    expect(one('schedulex', {})).not.toThrow();
  });
  it('V10: an admin entry keeps every default', () => {
    expect(one('a_tool', { ...NOKIND, sensitive: true }, 'admin')).not.toThrow();
    for (const o of [{ autopilot: 'always_card' }, { deptOnly: 'software' }, { aiReview: 'cost_or_lasting' }, { aiReview: 'money_doc' }] as Partial<ManifestEntry>[]) expect(one('a_tool', { ...NOKIND, sensitive: true, ...o }, 'admin'), JSON.stringify(o)).toThrow(/V10/);
    for (const o of [{ approval: 'no_approval' }, { autopilot: 'own_waive' }] as Partial<ManifestEntry>[]) expect(one('a_tool', { ...NOKIND, sensitive: true, ...o }, 'admin'), JSON.stringify(o)).toThrow(/V6|V7/);
  });
});

describe('PM-C4 (test part): main.ts never passes groups to createApp', () => {
  it('every createApp call in main.ts has the single argument env', () => {
    const src = readFileSync(new URL('main.ts', root), 'utf8');
    const calls = [...src.matchAll(/\bcreateApp\s*\(([^)]*)\)/g)].map((m) => m[1]!.trim());
    expect(calls).toEqual(['env']);
    expect(src).not.toMatch(/\bgroups\b/);
  });
});

describe('R6 MCP-1 / MC-C10 / MCP-AC02: external (MCP) class profiles', () => {
  it('valid names get the two frozen profiles; everything else under mcp_ or near it is FAIL_CLOSED', () => {
    expect(classOf('mcp_r_ab_x')).toBe(MCP_READ);
    expect(classOf('mcp_w_ab_x')).toBe(MCP_WRITE);
    expect(classOf('mcp_r_probe_some_tool_9')).toBe(MCP_READ);
    const long = `mcp_r_${'a'.repeat(16)}_${'x'.repeat(41)}`;
    expect(long.length).toBeGreaterThan(63);
    for (const n of ['mcp_R_ab_x', 'mcp_r_ab_x\n', 'mcp_r_ab_X', '\uFF4Dcp_r_ab_x', 'mcp_r_a_b', 'mcp_x_ab_c', 'mcp_x', 'mcp_', 'mcp_r_ab_', 'mcp_r_ab_1x', 'mcp_r_a-b_x', 'mcp_r_ab_x y', long, `mcp_r_${'a'.repeat(17)}_x`, 'MCP_r_ab_x', ' mcp_r_ab_x']) expect(classOf(n), JSON.stringify(n)).toBe(FAIL_CLOSED);
    for (const n of ['zz_unknown', '__proto__', 'constructor', 'toString', 'mcpx_r_ab_x']) expect(classOf(n), n).toBe(FAIL_CLOSED);
    expect(mcpClassOf('write_file')).toBeNull();
    expect(mcpClassOf('mcp_x')).toBe(FAIL_CLOSED);
  });
  it('the profiles are exactly the spec table, frozen, sensitive, and never always-waivable', () => {
    expect(MCP_READ).toEqual({ group: 'mcp', kind: 'read', sensitive: true, approval: 'central', deptOnly: null, treeGrant: false, autopilot: 'default', aiReview: 'cost_or_lasting' });
    expect(MCP_WRITE).toEqual({ group: 'mcp', kind: 'write', sensitive: true, approval: 'central', deptOnly: null, treeGrant: false, autopilot: 'always_card', aiReview: 'cost_or_lasting' });
    expect(Object.isFrozen(MCP_READ) && Object.isFrozen(MCP_WRITE)).toBe(true);
    expect(MCP_NAME.test('mcp_r_ab_x')).toBe(true);
    expect(isAlwaysCard('mcp_w_ab_x')).toBe(true);
    expect(isAlwaysCard('mcp_r_ab_x')).toBe(false);
    expect(isNonSensitiveTool('mcp_r_ab_x')).toBe(false);
    expect(isNonSensitiveTool('mcp_w_ab_x')).toBe(false);
    for (const l of [AUTOPILOT_OWN_WAIVE, DERIVED.ownWaive, DERIVED.alwaysCard, DERIVED.treeGrant, DERIVED.noApproval, DERIVED.botTalk, DERIVED.moneyDoc, DERIVED.costOrLasting, CATALOG_NAMES]) expect(l.filter((n) => n.startsWith('mcp_')), 'no mcp name joins a static list').toEqual([]);
  });
  it('privileged.json is unchanged by R6 (no mcp name, same keys)', () => {
    expect(JSON.stringify(privileged)).not.toContain('mcp_');
  });
  it('V3 still refuses a static manifest that declares an mcp_ name, in any build', () => {
    expect(() => buildCatalog([defineManifest('g', { mcp_r_ab_x: { ...READ, sensitive: true } })])).toThrow(/V3/);
    expect(() => buildCatalog([defineManifest('g', { mcp_zz: { ...READ, sensitive: true } })])).toThrow(/V3/);
  });
  it('every build carries the same @external suffix: the digest of an empty catalog is the sha256 of the suffix alone', () => {
    const empty = buildCatalog([]);
    expect(empty.digest).toBe(createHash('sha256').update(JSON.stringify([['@external', { r: { aiReview: 'cost_or_lasting', approval: 'central', autopilot: 'default', deptOnly: null, group: 'mcp', kind: 'read', sensitive: true, treeGrant: false }, w: { aiReview: 'cost_or_lasting', approval: 'central', autopilot: 'always_card', deptOnly: null, group: 'mcp', kind: 'write', sensitive: true, treeGrant: false } }]])).digest('hex'));
    expect(empty.classOf('mcp_w_ab_x')).toBe(MCP_WRITE);
    expect(empty.names).toEqual([]);
    expect(empty.derived.alwaysCard).toEqual([]);
  });
});

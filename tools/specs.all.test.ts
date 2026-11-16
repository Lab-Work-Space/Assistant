import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { adminTools } from '../admin/tools.js';
import { buildSnapshot, modelView } from '../mcp/snapshot.js';
import { McpError } from '../mcp/errors.js';
import { builtinTools, growTools, knowledgeTools, projectTools, releaseTools, skillTools } from './builtin/index.js';
import { pluginGroups } from './plugins/index.js';
import type { PluginDeps } from './plugins/deps.js';
import { ToolRegistry } from './registry.js';
import type { ToolPlugin } from './types.js';

// SCHEMA-ALL-1: API400-1 hit one tool (knowledge_propose). This builds EVERY tool the app can register and checks the exact spec specsFor hands the Claude API.
// Documented (Messages API, tool use): `name` matches ^[a-zA-Z0-9_-]{1,64}$ and `input_schema` is a JSON Schema object with `type: "object"`; the API rejects a tool without it
// (tools.N.custom.input_schema.type: Field required). oneOf/anyOf/allOf/enum/not at the TOP level are refused by the API in practice (API400-1). No description length cap is documented;
// DESC_GUARD below is only a regression guard against a runaway description (every tool is far below it today).
const DESC_GUARD = 10_000;
const NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const TOP_BANNED = ['oneOf', 'anyOf', 'allOf', 'not', 'if', 'then', 'else', 'enum', 'const'];

/** A stand-in for any dependency: every property and call yields another stand-in, so a factory can build its tools without real services. */
const stub = (): any => new Proxy(function () { /* stand-in */ }, { get: (_t, p) => (p === 'then' ? undefined : p === Symbol.toPrimitive ? () => 'x' : stub()), apply: () => stub() });

function allTools(): { group: string; tool: ToolPlugin<any> }[] {
  const out: { group: string; tool: ToolPlugin<any> }[] = [];
  const add = (group: string, ts: readonly ToolPlugin<any>[]) => ts.forEach((tool) => out.push({ group, tool }));
  add('builtin', builtinTools());
  add('knowledge', knowledgeTools(stub()));
  add('skill', skillTools(stub()));
  add('grow', growTools(stub()));
  add('project', projectTools(stub()));
  add('release', releaseTools(stub()));
  add('admin', adminTools({ console: stub(), deploy: stub(), code: stub() }));
  const deps = { env: stub(), cfg: stub(), log: stub(), port: stub(), clock: () => 0, reminders: stub(), jobs: stub(), watches: stub(), lessons: stub(), clickup: stub(), clickupUsage: stub(), clickupSecrets: [], github: stub(), net: stub(), browser: stub(), metered: stub(), vision: stub(), halt: stub(), music: stub(), org: stub(), provenance: stub(), renderer: stub(), docsDir: '/nonexistent/docs', mediaGen: stub(), incidents: stub(), workspaceRoot: '/nonexistent/ws', ws: stub(), wsSecrets: [] } as unknown as PluginDeps;
  for (const f of pluginGroups) {
    const g = f(deps);
    if ('disabled' in g) throw new Error(`group ${g.id} did not build with stub deps: ${g.disabled}`);
    add(g.id, g.tools);
  }
  return out;
}

const refsResolve = (schema: Record<string, unknown>): string[] => {
  const defs = new Set(Object.keys((schema['$defs'] ?? {}) as object).map((k) => `#/$defs/${k}`));
  const bad: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (typeof v !== 'object' || v === null) return;
    for (const [k, x] of Object.entries(v)) {
      if (k === '$ref' && typeof x === 'string' && x !== '#' && !defs.has(x)) bad.push(x);
      else walk(x);
    }
  };
  walk(schema);
  return bad;
};

function checkSpec(s: { name: string; description: string; inputSchema: object }): void {
  const sc = s.inputSchema as Record<string, unknown>;
  expect(s.name, 'name').toMatch(NAME);
  expect(s.description.trim().length, `${s.name} description`).toBeGreaterThan(0);
  expect(s.description.length, `${s.name} description length`).toBeLessThanOrEqual(DESC_GUARD);
  expect(sc['type'], `${s.name} input_schema.type`).toBe('object');
  for (const k of TOP_BANNED) expect(sc[k], `${s.name} top-level ${k}`).toBeUndefined();
  expect(JSON.parse(JSON.stringify(sc)), `${s.name} JSON round trip`).toEqual(sc);
  expect(refsResolve(sc), `${s.name} dangling $ref`).toEqual([]);
  expect(sc['$schema'], `${s.name} $schema`).toBeUndefined();
}

describe('SCHEMA-ALL-1: every registerable tool gives the Claude API a valid spec', () => {
  const tools = allTools();
  const reg = new ToolRegistry({ halt: { isHalted: () => false } });
  for (const { tool } of tools) reg.register(tool);

  it('covers a real set of tools across every group (a group that builds nothing is a hole)', () => {
    expect(new Set(tools.map((t) => t.tool.name)).size).toBe(tools.length);
    expect(tools.length).toBeGreaterThan(60);
    const groups = new Set(tools.map((t) => t.group));
    for (const g of ['builtin', 'knowledge', 'skill', 'grow', 'project', 'release', 'admin', 'clickup', 'github', 'web', 'media', 'docs', 'ws']) expect(groups.has(g), g).toBe(true);
    expect(reg.names().length).toBe(tools.length);
  });

  it('specsFor returns one valid spec per tool', () => {
    const specs = reg.specsFor(reg.names());
    expect(specs.length).toBe(tools.length);
    for (const s of specs) checkSpec(s);
  });
});

describe('SCHEMA-ALL-1: the MCP conversion never lets an unsafe top-level shape reach the API', () => {
  const t = (inputSchema: unknown) => [{ name: 'tool', description: 'd', inputSchema }];
  const opts = { slug: 'ab', toolClass: 'read' as never };
  const refuses = (inputSchema: unknown) => { try { buildSnapshot(t(inputSchema), opts); } catch (e) { return e instanceof McpError; } return false; };
  const hostile: unknown[] = [
    { oneOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { b: { type: 'string' } } }] },
    { type: 'object', oneOf: [{ type: 'object' }] }, { anyOf: [{ type: 'object' }] }, { type: 'object', anyOf: [] }, { allOf: [{ type: 'object' }] }, { not: { type: 'string' } },
    { type: 'object', enum: [1] }, { type: 'object', const: {} }, { type: 'object', if: {}, then: {}, else: {} }, { type: ['object', 'null'] }, { type: 'string' }, {}, null, [], 'x', { $ref: '#/$defs/x', $defs: {} },
  ];
  it('each hostile top-level shape is refused (E_SCHEMA), never converted', () => {
    for (const h of hostile) expect(refuses(h), JSON.stringify(h)).toBe(true);
  });
  it('an accepted schema is a plain top-level object in the model view', () => {
    const b = buildSnapshot(t({ type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }), opts);
    const v = modelView(b.entries[0]!);
    checkSpec({ name: v.name, description: v.description, inputSchema: v.schema });
    expect(z.toJSONSchema(b.entries[0]!.schema, { io: 'input' })).toMatchObject({ type: 'object' });
    const empty = modelView(buildSnapshot(t({ type: 'object' }), opts).entries[0]!);
    expect((empty.schema as Record<string, unknown>)['type']).toBe('object');
  });
});

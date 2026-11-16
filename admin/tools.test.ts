import { describe, expect, it } from 'vitest';
import { renderSystem } from '../providers/claude-code-local/protocol.js';
import { toGeminiRequest } from '../providers/gemini/convert.js';
import { ToolRegistry } from '../tools/registry.js';
import type { AdminConsole } from './console.js';
import { ADMIN_TOOL_NAMES } from './names.js';
import { ADMIN_OP_NAMES, adminTools } from './tools.js';
import { AdminOp } from './ops.js';

function registry(calls: unknown[] = []) {
  const c = { proposeConfig: async (_w: unknown, raw: unknown) => (calls.push(['config', raw]), { ok: true, text: 'ok' }), proposeOp: async (_w: unknown, raw: unknown) => (calls.push(['op', raw]), { ok: true, text: 'ok' }), proposePerm: async (_w: unknown, raw: unknown) => (calls.push(['perm', raw]), { ok: true, text: 'ok' }) } as unknown as AdminConsole;
  const r = new ToolRegistry({ halt: { isHalted: () => false } });
  for (const t of adminTools({ console: c })) r.register(t);
  return r;
}
const specs = () => registry().specsFor([...ADMIN_TOOL_NAMES]);

type Node = Record<string, unknown>;
/** Every schema node Gemini sees must say what it is (a type, or a union of typed members), and arrays need typed items. */
function untypedNodes(n: unknown, path = '$'): string[] {
  if (typeof n !== 'object' || n === null) return [];
  const o = n as Node;
  const out: string[] = [];
  if (!('type' in o) && !('anyOf' in o)) out.push(path);
  if (o.type === 'ARRAY' && !o.items) out.push(`${path}.items(missing)`);
  for (const [k, v] of Object.entries((o.properties as Node | undefined) ?? {})) out.push(...untypedNodes(v, `${path}.${k}`));
  if (o.items) out.push(...untypedNodes(o.items, `${path}[]`));
  for (const [i, m] of ((o.anyOf as unknown[] | undefined) ?? []).entries()) out.push(...untypedNodes(m, `${path}|${i}`));
  return out;
}

describe('admin tool schemas survive every provider', () => {
  it('there are exactly the five tools, with plain object input schemas', () => {
    expect(specs().map((s) => s.name).sort()).toEqual([...ADMIN_TOOL_NAMES].sort());
    for (const s of specs()) expect(s.inputSchema).toMatchObject({ type: 'object' });
  });

  it('Gemini conversion does not throw and leaves no untyped node (no union, no z.unknown on the wire)', () => {
    const req = toGeminiRequest({ model: 'gemini-3.8-flash', system: 's', messages: [], tools: specs(), maxTokens: 100 });
    expect(req.functionDeclarations.map((d) => d.name).sort()).toEqual([...ADMIN_TOOL_NAMES].sort());
    for (const d of req.functionDeclarations) {
      const params = (d as { parameters?: unknown }).parameters;
      expect(untypedNodes(params, d.name), d.name).toEqual([]);
      expect(JSON.stringify(params)).not.toContain('anyOf'); // flat: nothing for a provider to choke on
    }
    expect(JSON.stringify(req)).toContain('valueJson');
  });

  it('claude-code-local renders the catalogue with every tool and its schema', () => {
    const text = renderSystem({ model: 'm', system: 's', messages: [], tools: specs(), maxTokens: 1 });
    for (const n of ADMIN_TOOL_NAMES) expect(text).toContain(`"name":"${n}"`);
    expect(text).toContain('opsJson');
  });

  it('the op names on the wire are exactly the admin ops, and the argument text is validated in code', async () => {
    expect(ADMIN_OP_NAMES).toEqual(AdminOp.options.map((o) => o.shape.op.value));
    expect(ADMIN_OP_NAMES).toHaveLength(23); // 19 + the four skill ops (SK14)
    const calls: unknown[] = [];
    const r = registry(calls);
    const ctx = { actor: { kind: 'head', dept: 'praw' }, task: null, source: { userId: '900000000000000001' }, tainted: () => false, run: { tainted: () => false, markTainted() {}, knownUrls: new Set() }, org: { toolsFor: () => [...ADMIN_TOOL_NAMES] }, audit: async () => undefined, tasks: {} } as never;
    const ok = await r.run('admin_op_propose', { op: 'holiday_add', args: '{"date":"2026-12-31","name":"NYE"}' }, ctx);
    expect(ok.isError).toBeUndefined();
    expect(calls).toEqual([['op', { date: '2026-12-31', name: 'NYE', op: 'holiday_add' }]]);
    // the op name cannot be overridden from args, bad JSON and non-objects come back as errors
    await r.run('admin_op_propose', { op: 'holiday_add', args: '{"op":"provider_default","date":"2026-12-31"}' }, ctx);
    expect((calls.at(-1) as [string, { op: string }])[1].op).toBe('holiday_add');
    expect((await r.run('admin_op_propose', { op: 'holiday_add', args: '{nope' }, ctx)).isError).toBe(true);
    expect((await r.run('admin_op_propose', { op: 'holiday_add', args: '[1,2]' }, ctx)).isError).toBe(true);
    expect((await r.run('admin_op_propose', { op: 'provider_add', args: '{}' }, ctx)).isError).toBe(true);
    expect((await r.run('perm_propose', { opsJson: '{"not":"an array"}' }, ctx)).content).toContain('JSON array');
    expect((await r.run('config_propose', { changes: [{ key: 'budget.taskUsd', valueJson: 'oops' }] }, ctx)).content).toContain('not valid JSON');
    await r.run('config_propose', { changes: [{ key: 'schedule.timezone', valueJson: '"Asia/Tokyo"' }, { key: 'limits.depth', valueJson: '4' }] }, ctx);
    expect(calls.at(-1)).toEqual(['config', { changes: [{ key: 'schedule.timezone', value: 'Asia/Tokyo' }, { key: 'limits.depth', value: 4 }] }]);
  });

  it('the permission tool lists the safe bit values so the model can write them', () => {
    const d = specs().find((s) => s.name === 'perm_propose')!.description;
    expect(d).toContain('ViewChannel=1024');
    expect(d).toContain('PinMessages=');
    expect(d).not.toContain('ManageRoles=');
  });
});

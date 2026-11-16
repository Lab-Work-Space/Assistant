import { describe, expect, it } from 'vitest';
import { classOf } from '../tools/manifest/catalog.js';
import { MCP_NAME } from '../tools/manifest/external.js';
import { McpError } from './errors.js';
import { ORIG_NAME, SLUG, mcpName, normalizeNames, normalizeTool } from './names.js';

const code = (f: () => unknown): string | undefined => { try { f(); } catch (e) { return e instanceof McpError ? e.code : 'other'; } return undefined; };

describe('MCP-AC03: name normalization (spec 5.2)', () => {
  it.each([
    ['echo', 'echo'], ['Echo', 'echo'], ['add.numbers', 'add_numbers'], ['a--b', 'a_b'], ['get-Weather.v2', 'get_weather_v2'], ['_x_', 'x'], ['a__b___c', 'a_b_c'], ['x-', 'x'], ['A1', 'a1'],
  ])('%s -> %s', (orig, want) => { expect(normalizeTool(orig)).toBe(want); });
  it.each(['9lives', '', '-', '___', '1', 'a'.repeat(41), 'x'.repeat(64)])('%j does not normalize into the tool part', (orig) => { expect(normalizeTool(orig)).toBeNull(); });
  it('the original name rule and the slug rule', () => {
    for (const n of ['a', 'A_b.c-d', 'x'.repeat(64)]) expect(ORIG_NAME.test(n), n).toBe(true);
    for (const n of ['', 'x'.repeat(65), 'a b', 'a/b', 'café', 'a\n', 'ａbc']) expect(ORIG_NAME.test(n), JSON.stringify(n)).toBe(false);
    for (const s of ['ab', 'a1', 'a'.repeat(16)]) expect(SLUG.test(s), s).toBe(true);
    for (const s of ['a', 'A1', 'a_b', '1a', 'a'.repeat(17), 'a-b', 'ab\n']) expect(SLUG.test(s), JSON.stringify(s)).toBe(false);
  });
  it('mcpName builds a name the closed class table accepts, 63 characters at most, with the class from the prefix', () => {
    const n = mcpName('read', 'a'.repeat(16), `a${'b'.repeat(39)}`);
    expect(n).toHaveLength(63);
    expect(MCP_NAME.test(n)).toBe(true);
    expect(classOf(mcpName('write', 'ab', 'x')).kind).toBe('write');
    expect(classOf(mcpName('read', 'ab', 'x')).kind).toBe('read');
  });
  it('normalizeNames: E_NAME for any original name that fails either rule, E_COLLISION when two normalize alike or repeat, the whole entry refused', () => {
    expect(normalizeNames(['echo', 'add.numbers'], 'write', 'srv')).toEqual([{ orig: 'echo', tool: 'echo', name: 'mcp_w_srv_echo' }, { orig: 'add.numbers', tool: 'add_numbers', name: 'mcp_w_srv_add_numbers' }]);
    expect(code(() => normalizeNames(['ok', 'Bad Name'], 'read', 'srv'))).toBe('E_NAME');
    expect(code(() => normalizeNames(['9x'], 'read', 'srv'))).toBe('E_NAME');
    expect(code(() => normalizeNames(['a.b', 'a_b'], 'read', 'srv'))).toBe('E_COLLISION');
    expect(code(() => normalizeNames(['A-B', 'a.b'], 'read', 'srv'))).toBe('E_COLLISION');
    expect(code(() => normalizeNames(['a', 'a'], 'read', 'srv'))).toBe('E_COLLISION');
  });
  it('a server cannot pick another class or another slug through a tool name', () => {
    const [n] = normalizeNames(['r_other_x'], 'read', 'srv');
    expect(n!.name).toBe('mcp_r_srv_r_other_x');
    expect(MCP_NAME.exec(n!.name)).not.toBeNull();
    expect(classOf(n!.name).kind).toBe('read');
  });
});

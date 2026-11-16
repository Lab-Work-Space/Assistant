import { describe, expect, it } from 'vitest';
import { NON_SELF_MODIFIABLE, isNonSelfModifiable } from './paths.js';

/** R6 MCP-1 BE2 (spec 6, MCP-AC26): the MCP guarantee cannot be edited by a dev job. */
describe('MCP-AC26: NON_SELF_MODIFIABLE holds the MCP paths', () => {
  it('the four spec entries are in the list', () => {
    for (const p of ['mcp/', 'db/repos/mcp.ts', 'discord/commands/mcp.ts', 'tests/fixtures/mcp/']) expect(NON_SELF_MODIFIABLE, p).toContain(p);
  });
  it.each([
    'mcp/admin.ts', 'mcp/sandbox.ts', 'mcp/boundary.test.ts', 'mcp/wiring.test.ts', 'MCP/Admin.ts', 'db/repos/mcp.ts', 'discord/commands/mcp.ts', 'tests/fixtures/mcp/echo-server.mjs',
    'tools/manifest/external.ts',
  ])('%s is refused', (p) => {
    expect(isNonSelfModifiable(p)).toBe(true);
  });
  it('a sibling that is not part of the guarantee stays editable', () => {
    expect(isNonSelfModifiable('discord/commands/provider.ts')).toBe(false);
    expect(isNonSelfModifiable('db/repos/mcpx.ts')).toBe(false);
  });
});

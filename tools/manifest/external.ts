import { FAIL_CLOSED, type ToolClass } from './types.js';
/** R6 MCP-1: the closed class table for external (MCP) tools. The DB row picks a profile only through the name prefix; it never defines a class. */
export const MCP_NAME = /^mcp_[rw]_[a-z][a-z0-9]{1,15}_[a-z][a-z0-9_]{0,39}$/;
export const MCP_READ: ToolClass = Object.freeze({ group: 'mcp', kind: 'read', sensitive: true, approval: 'central', deptOnly: null, treeGrant: false, autopilot: 'default', aiReview: 'cost_or_lasting' } as const);
export const MCP_WRITE: ToolClass = Object.freeze({ group: 'mcp', kind: 'write', sensitive: true, approval: 'central', deptOnly: null, treeGrant: false, autopilot: 'always_card', aiReview: 'cost_or_lasting' } as const);
/** null: not an external name (the caller falls through to FAIL_CLOSED). */
export function mcpClassOf(name: string): ToolClass | null {
  if (!MCP_NAME.test(name)) return name.startsWith('mcp_') ? FAIL_CLOSED : null;
  return name[4] === 'r' ? MCP_READ : MCP_WRITE;
}

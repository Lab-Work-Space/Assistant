import { MCP_NAME } from '../tools/manifest/external.js';
import type { McpClass } from '../db/repos/mcp.js';
import { McpError } from './errors.js';

export const SLUG = /^[a-z][a-z0-9]{1,15}$/;
export const ORIG_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const TOOL_PART = /^[a-z][a-z0-9_]{0,39}$/;

/** Spec 5.2: lower-case, `.` and `-` become `_`, runs of `_` collapse, trimmed of `_`; null when the result is not `^[a-z][a-z0-9_]{0,39}$`. */
export function normalizeTool(orig: string): string | null {
  if (!ORIG_NAME.test(orig)) return null;
  const t = orig.toLowerCase().replace(/[.-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return TOOL_PART.test(t) ? t : null;
}

/** `mcp_<r|w>_<slug>_<tool>`; throws when the result is not an external name (never reachable for a validated slug and tool). */
export function mcpName(cls: McpClass, slug: string, tool: string): string {
  const n = `mcp_${cls === 'read' ? 'r' : 'w'}_${slug}_${tool}`;
  if (!SLUG.test(slug) || !MCP_NAME.test(n) || n.length > 63) throw new McpError('E_NAME');
  return n;
}

export interface NamedTool { orig: string; tool: string; name: string }

/** E_NAME for a name that fails either rule; E_COLLISION (the whole entry refused) when two normalize alike or repeat. */
export function normalizeNames(origs: readonly string[], cls: McpClass, slug: string): NamedTool[] {
  const seen = new Set<string>();
  const out: NamedTool[] = [];
  for (const orig of origs) {
    const tool = normalizeTool(orig);
    if (tool === null) throw new McpError('E_NAME');
    if (seen.has(tool)) throw new McpError('E_COLLISION');
    seen.add(tool);
    out.push({ orig, tool, name: mcpName(cls, slug, tool) });
  }
  return out;
}

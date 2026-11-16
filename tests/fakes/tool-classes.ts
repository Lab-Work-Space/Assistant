// R4 PM-C9: the test-only seam for the tool catalog. An integration test that registers a stub tool (through the `o.groups` seam) gives it a class with a
// file-local `vi.mock('<rel>/tools/manifest/catalog.js', async (orig) => withTestClasses(await orig(), { stub_write: { ...WRITE, sensitive: false, group: 'test' } }))`.
// It wraps `classOf` ONLY: DERIVED, the names and the digest are the real ones, so a stub never joins a privileged list. Product code never imports this file
// and an allowlist test limits `vi.mock` of the catalog to the files named in the R4 spec section 5.3.
import { SENSITIVE_TOOL } from '../../tools/manifest/floor.js';
import { FAIL_CLOSED, type ToolClass } from '../../tools/manifest/types.js';

interface CatalogModule {
  readonly classOf: (name: string) => ToolClass;
  readonly CATALOG_NAMES: readonly string[];
}

/** Returns the catalog module with `classOf` answering `extra[name]` for the stub names. Refuses a name the catalog declares, the floor matches, or that starts with `mcp_`. */
export function withTestClasses<M extends CatalogModule>(orig: M, extra: Readonly<Record<string, ToolClass>>): M {
  const declared = new Set(orig.CATALOG_NAMES);
  for (const n of Object.keys(extra)) {
    if (declared.has(n)) throw new Error(`withTestClasses: ${n} is declared in the catalog; a stub may not take a declared name`);
    if (SENSITIVE_TOOL.test(n)) throw new Error(`withTestClasses: ${n} matches the sensitive floor`);
    if (n.startsWith('mcp_')) throw new Error(`withTestClasses: ${n} starts with mcp_`);
  }
  const stubs = new Map(Object.entries(extra).map(([n, c]) => [n, Object.freeze({ ...c })]));
  return { ...orig, classOf: (name: string): ToolClass => stubs.get(name) ?? orig.classOf(name) ?? FAIL_CLOSED };
}

// R4 PM-C4: the boot-time declaration check. Every registered name must be in the catalog with the group it came from and the kind the registry holds.
// A failure throws, so a boot with an undeclared or mismatched tool is refused (the error names a code constant, never input).
import { classOf, CATALOG_NAMES } from './catalog.js';

export interface DeclRegistry {
  names(): string[];
  kindOf(name: string): string | undefined;
}

const declared = new Set<string>(CATALOG_NAMES);
/** Every group of the main registry (the builtin group plus the plugin folders): all declared groups except 'admin'. */
export const MAIN_GROUPS: readonly string[] = [...new Set(CATALOG_NAMES.map((n) => classOf(n).group).filter((g) => g !== 'admin'))].sort();

/** Throws unless every name in `names` is declared in group `group` with a kind equal to `reg.kindOf(name) ?? null`. */
export function assertDeclared(reg: Pick<DeclRegistry, 'kindOf'>, names: readonly string[], group: string): void {
  for (const n of names) {
    if (!declared.has(n)) throw new Error(`tool ${n} in group ${group} is not declared in the tool manifest (add it to the manifest of group ${group})`);
    const c = classOf(n);
    if (c.group !== group) throw new Error(`tool ${n} is declared in group ${c.group} but registered by group ${group}`);
    if (c.kind !== (reg.kindOf(n) ?? null)) throw new Error(`tool ${n} in group ${group} is declared with kind ${String(c.kind)} but registered with kind ${String(reg.kindOf(n) ?? null)}`);
  }
}

/**
 * The whole-registry check (Gate 1 PM-C4): every name in `reg` must be declared with an equal kind. The group is not known per name here, so it is checked against the
 * set of groups the caller allows (builtin and plugin groups for the main registry; 'admin' for the admin registry). `skip` holds names that came from `o.groups` (test seam).
 */
export function assertRegistryDeclared(reg: DeclRegistry, allowedGroups: readonly string[], skip: ReadonlySet<string> = new Set()): void {
  for (const n of reg.names()) {
    if (skip.has(n)) continue;
    if (!declared.has(n)) throw new Error(`tool ${n} is registered but not declared in the tool manifest`);
    const c = classOf(n);
    if (!allowedGroups.includes(c.group)) throw new Error(`tool ${n} is declared in group ${c.group}, which this registry does not allow`);
    if (c.kind !== (reg.kindOf(n) ?? null)) throw new Error(`tool ${n} is declared with kind ${String(c.kind)} but registered with kind ${String(reg.kindOf(n) ?? null)}`);
  }
}

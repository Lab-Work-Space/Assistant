import { DERIVED } from './manifest/catalog.js';

/**
 * TREEGRANT-1 (S3, TG-C1): the tools "Approve the whole task" may waive the central approval for. R4: a frozen view of the checked-in manifest (every entry with `treeGrant: true`
 * in tools/plugins/<x>/manifest.ts or tools/builtin/manifest.ts); the list is not edited here. A new tool, a plugin tool, a config value or model text can never join it:
 * joining needs a manifest entry (V5 limits it to a non-sensitive central write) AND the same diff in tools/manifest/privileged.json, both protected from bot self-modification
 * (devjob NON_SELF_MODIFIABLE). Anything undeclared always asks. Imports only the catalog (a chain of leaf modules) so the card renderer can read the list without the tool side.
 */
export const TREE_GRANT_TOOLS: readonly string[] = DERIVED.treeGrant;

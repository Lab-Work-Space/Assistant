// R4 PLUGIN-MANIFEST: the declared class of every tool in this group. Imports types only (an allowlist test enforces it).
// pin_message: the tree grant may waive the central approval.
import { WRITE, defineManifest } from '../../manifest/types.js';

export const manifest = defineManifest('pin', {
  pin_message: { ...WRITE, sensitive: false, treeGrant: true },
});

// R4 PLUGIN-MANIFEST: the declared class of every tool in this group. Imports types only (an allowlist test enforces it).
// write_file: the tree grant may waive the central approval.
import { READ, WRITE, defineManifest } from '../../manifest/types.js';

export const manifest = defineManifest('workspace', {
  list_files: { ...READ, sensitive: false },
  read_file: { ...READ, sensitive: false },
  write_file: { ...WRITE, sensitive: false, treeGrant: true },
});

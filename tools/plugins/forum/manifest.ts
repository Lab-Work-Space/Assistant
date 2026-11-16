// R4 PLUGIN-MANIFEST: the declared class of every tool in this group. Imports types only (an allowlist test enforces it).
// forum_post: the tree grant may waive the central approval.
import { READ, WRITE, defineManifest } from '../../manifest/types.js';

export const manifest = defineManifest('forum', {
  forum_read: { ...READ, sensitive: false },
  forum_post: { ...WRITE, sensitive: false, treeGrant: true },
});

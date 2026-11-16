// R4 PLUGIN-MANIFEST: the declared class of every tool in this group. Imports types only (an allowlist test enforces it).
// doc_create: tree grant. diagram_create: a write never asks (RF27).
import { WRITE, defineManifest } from '../../manifest/types.js';

export const manifest = defineManifest('docs', {
  doc_create: { ...WRITE, sensitive: false, treeGrant: true },
  diagram_create: { ...WRITE, sensitive: false, approval: 'no_approval' },
});

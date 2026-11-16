// R4 PLUGIN-MANIFEST: the declared class of every tool in this group. Imports types only (an allowlist test enforces it).
// save_lesson and delete_lesson are sensitive (SENSITIVE_TOOL, G2WS-03).
import { READ, WRITE, defineManifest } from '../../manifest/types.js';

export const manifest = defineManifest('lessons', {
  save_lesson: { ...WRITE, sensitive: true },
  list_lessons: { ...READ, sensitive: false },
  delete_lesson: { ...WRITE, sensitive: true },
});

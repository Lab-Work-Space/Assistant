// R4 PLUGIN-MANIFEST: the declared class of every tool in this group. Imports types only (an allowlist test enforces it).
// watch_add and watch_remove: AI reviewer hard-denies (cost or lasting).
import { READ, WRITE, defineManifest } from '../../manifest/types.js';

export const manifest = defineManifest('watch', {
  watch_add: { ...WRITE, sensitive: false, aiReview: 'cost_or_lasting' },
  watch_list: { ...READ, sensitive: false },
  watch_remove: { ...WRITE, sensitive: false, aiReview: 'cost_or_lasting' },
});

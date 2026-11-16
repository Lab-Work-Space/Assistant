// R4 PLUGIN-MANIFEST: the declared class of every tool in this group. Imports types only (an allowlist test enforces it).
// Every schedule_ name is cost_or_lasting (V9; closes the prefix hole).
import { READ, WRITE, defineManifest } from '../../manifest/types.js';

export const manifest = defineManifest('schedule', {
  schedule_add: { ...WRITE, sensitive: false, aiReview: 'cost_or_lasting' },
  schedule_list: { ...READ, sensitive: false, aiReview: 'cost_or_lasting' },
  schedule_remove: { ...WRITE, sensitive: false, aiReview: 'cost_or_lasting' },
});

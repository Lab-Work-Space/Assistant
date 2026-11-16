// R4 PLUGIN-MANIFEST: the declared class of every tool in this group. Imports types only (an allowlist test enforces it).
// add_reminder and cancel_reminder: AI reviewer hard-denies (cost or lasting).
import { READ, WRITE, defineManifest } from '../../manifest/types.js';

export const manifest = defineManifest('reminders', {
  add_reminder: { ...WRITE, sensitive: false, aiReview: 'cost_or_lasting' },
  cancel_reminder: { ...WRITE, sensitive: false, aiReview: 'cost_or_lasting' },
  list_reminders: { ...READ, sensitive: false },
});

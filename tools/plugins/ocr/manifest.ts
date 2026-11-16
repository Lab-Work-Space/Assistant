// R4 PLUGIN-MANIFEST: the declared class of every tool in this group. Imports types only (an allowlist test enforces it).
// sheets_append_receipt: AI reviewer hard-denies (money document).
import { READ, WRITE, defineManifest } from '../../manifest/types.js';

export const manifest = defineManifest('ocr', {
  ocr_image: { ...READ, sensitive: false },
  read_image: { ...READ, sensitive: false },
  extract_receipt: { ...READ, sensitive: false },
  sheets_append_receipt: { ...WRITE, sensitive: false, aiReview: 'money_doc' },
});

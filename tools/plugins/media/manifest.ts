// R4 PLUGIN-MANIFEST: the declared class of every tool in this group. Imports types only (an allowlist test enforces it).
// image_generate and video_generate: AI reviewer hard-denies (cost).
import { WRITE, defineManifest } from '../../manifest/types.js';

export const manifest = defineManifest('media', {
  image_generate: { ...WRITE, sensitive: false, aiReview: 'cost_or_lasting' },
  video_generate: { ...WRITE, sensitive: false, aiReview: 'cost_or_lasting' },
});
